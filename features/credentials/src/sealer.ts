import { createHash, hkdfSync } from "node:crypto";
import { AesGcmSecretSealer } from "@jini-ai/platform/secrets";
import type { KeyringPort as JiniKeyringPort, SealedSecret as JiniSealedSecret } from "@jini-ai/platform/secrets";
import { z } from "zod";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import type { KeyringPort, SecretSealerPort } from "./ports.js";
import type { KeyringConfiguration, SealedSecret } from "./types.js";
import { authenticatedData, boundary, configurationSchema, failure, referenceSchema, secretSchema } from "./rules.js";

/** Versioned HKDF keys from an injected master loader; no env/filesystem access here.
 * Loader enforces OS permissions and configuration. @complexity O(master + salt length).
 */
export function createCredentialKeyring(required: { loadMaster: (required: { configuration: KeyringConfiguration }, optional?: CallOptions) => Promise<Outcome<Uint8Array>> }): KeyringPort {
  return {
    async resolve(input, options) {
      return boundary({ run: async () => {
        if (!configurationSchema.safeParse(input.configuration).success) return failure({ code: "invalid_input" });
        if (!referenceSchema.shape.version.safeParse(input.version).success) return failure({ code: "invalid_input" });
        const master = await required.loadMaster({ configuration: input.configuration }, options);
        if (!master.ok) return master;
        if (master.value.length !== 32) return failure({ code: "unavailable" });
        const key = hkdfSync("sha256", master.value, input.configuration.hkdfSalt, `om.credentials.key.v1:${input.version}`, 32);
        return { ok: true, value: new Uint8Array(key) };
      } }, options);
    },
  };
}
const sealSchema = z.strictObject({ reference: referenceSchema, plaintext: z.string().min(1).max(65536) });
const openSchema = z.strictObject({ reference: referenceSchema, secret: secretSchema });

/** Published Jini AES-GCM behind OM's existing `gcm1.nonce.tag.ciphertext` envelope.
 * Injected keys/nonces preserve the committed format and HKDF layout. No ambient I/O.
 * Wrong scope/key/version/format fails closed; plaintext is bounded to 64 KiB UTF-8.
 * @complexity Time/space O(plaintext bytes), bounded to 64 KiB.
 * @example createAesGcmSecretSealer({ keyring, configuration, randomBytes })
 */
export function createAesGcmSecretSealer(required: {
  keyring: KeyringPort; configuration: KeyringConfiguration;
  randomBytes: (required: { size: number }) => Uint8Array;
}): SecretSealerPort {
  return {
    async seal(input, options) {
      return boundary({ run: async () => {
        const parsed = sealSchema.safeParse(input);
        if (!parsed.success || Buffer.byteLength(parsed.data.plaintext) > 65536) return failure({ code: "invalid_input" });
        input = parsed.data;
        const key = await required.keyring.resolve({ configuration: required.configuration, version: input.reference.version }, options);
        if (!key.ok) return key;
        if (key.value.length !== 32) return failure({ code: "unavailable" });
        const aad = authenticatedData({ reference: input.reference });
        const sealer = jiniSealer({ key: key.value, version: input.reference.version, randomBytes: required.randomBytes });
        const sealed = await sealer.seal({ plaintext: input.plaintext, key: { keyId: String(input.reference.version) }, aad });
        const combined = Buffer.from(sealed.ciphertext, "base64");
        const ciphertext = ["gcm1", Buffer.from(sealed.nonce, "base64").toString("base64url"), combined.subarray(-16).toString("base64url"), combined.subarray(0, -16).toString("base64url")].join(".");
        return { ok: true, value: { ciphertext, version: input.reference.version, aadDigest: createHash("sha256").update(aad).digest("hex") } };
      } }, options);
    },
    async open(input, options) {
      return boundary({ run: async () => {
        const parsed = openSchema.safeParse(input);
        if (!parsed.success) return failure({ code: "invalid_input" });
        input = parsed.data;
        const aad = authenticatedData({ reference: input.reference });
        if (!matchesBinding({ secret: input.secret, version: input.reference.version, aad })) return failure({ code: "forbidden" });
        const key = await required.keyring.resolve({ configuration: required.configuration, version: input.reference.version }, options);
        if (!key.ok) return key;
        return decrypt({ secret: input.secret, key: key.value, aad, randomBytes: required.randomBytes });
      } }, options);
    },
  };
}
/** Reject binding mismatches before decrypting. @complexity O(AAD length). */
function matchesBinding(required: { secret: SealedSecret; version: number; aad: string }): boolean {
  return required.secret.version === required.version && required.secret.aadDigest === createHash("sha256").update(required.aad).digest("hex");
}
/** Authenticate bounded canonical ciphertext; failures never contain provider data. @complexity O(ciphertext length). */
async function decrypt(required: { secret: SealedSecret; key: Uint8Array; aad: string; randomBytes: (required: { size: number }) => Uint8Array }): Promise<Outcome<string>> {
  const parts = required.secret.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "gcm1") return failure({ code: "forbidden" });
  const bytes = parts.slice(1).map(part => Buffer.from(part, "base64url"));
  if (bytes.some((part, index) => part.toString("base64url") !== parts[index + 1])) return failure({ code: "forbidden" });
  if (bytes[0].length !== 12 || bytes[1].length !== 16 || bytes[2].length > 65536) return failure({ code: "forbidden" });
  try {
    const sealed: JiniSealedSecret = { keyId: String(required.secret.version), alg: "aes-256-gcm", nonce: bytes[0].toString("base64"), ciphertext: Buffer.concat([bytes[2], bytes[1]]).toString("base64") };
    const sealer = jiniSealer({ key: required.key, version: required.secret.version, randomBytes: required.randomBytes });
    return { ok: true, value: await sealer.open({ sealed }, { aad: required.aad }) };
  } catch {
    return failure({ code: "forbidden" });
  }
}

/** Bridge an already resolved OM key to Jini's handle API without deriving it twice.
 * The exact derivation request is checked; this bridge cannot become a signing keyring.
 * @complexity Time/space O(key bytes), fixed 32 bytes.
 */
function jiniSealer(required: { key: Uint8Array; version: number; randomBytes: (required: { size: number }) => Uint8Array }): AesGcmSecretSealer {
  const key = required.key.slice();
  const keyId = String(required.version);
  const keyring: JiniKeyringPort = {
    async activeKey() { return { keyId }; },
    async derive(input) {
      if (input.workspaceId !== "secret-sealer" || input.purpose !== "secret-sealer.v1" || input.info !== keyId) throw new Error("Unsupported credential key purpose");
      return key.slice();
    },
    async deriveSigningSecret() { throw new Error("Credential encryption key cannot sign"); },
  };
  return new AesGcmSecretSealer({ keyring }, { randomBytesFn: input => required.randomBytes({ size: input.byteLength }) });
}
