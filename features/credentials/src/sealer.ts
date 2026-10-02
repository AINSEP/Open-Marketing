import { createCipheriv, createDecipheriv, createHash, hkdfSync } from "node:crypto";
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

/** AES-256-GCM with injected keys/nonces; `gcm1.nonce.tag.ciphertext` uses base64url.
 * Wrong scope/key/version/format fails closed. @complexity O(plaintext), bounded to 64 KiB UTF-8.
 */
export function createAesGcmSecretSealer(required: {
  keyring: KeyringPort; configuration: KeyringConfiguration;
  randomBytes: (required: { size: number }) => Uint8Array;
}): SecretSealerPort {
  return {
    async seal(input, options) {
      return boundary({ run: async () => {
        if (!sealSchema.safeParse(input).success || Buffer.byteLength(input.plaintext) > 65536) return failure({ code: "invalid_input" });
        const key = await required.keyring.resolve({ configuration: required.configuration, version: input.reference.version }, options);
        if (!key.ok) return key;
        const nonce = required.randomBytes({ size: 12 });
        if (nonce.length !== 12 || key.value.length !== 32) return failure({ code: "unavailable" });
        const aad = authenticatedData({ reference: input.reference });
        const cipher = createCipheriv("aes-256-gcm", key.value, nonce);
        cipher.setAAD(Buffer.from(aad));
        const bytes = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
        const ciphertext = ["gcm1", Buffer.from(nonce).toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join(".");
        return { ok: true, value: { ciphertext, version: input.reference.version, aadDigest: createHash("sha256").update(aad).digest("hex") } };
      } }, options);
    },
    async open(input, options) {
      return boundary({ run: async () => {
        if (!openSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const aad = authenticatedData({ reference: input.reference });
        if (!matchesBinding({ secret: input.secret, version: input.reference.version, aad })) return failure({ code: "forbidden" });
        const key = await required.keyring.resolve({ configuration: required.configuration, version: input.reference.version }, options);
        if (!key.ok) return key;
        return decrypt({ secret: input.secret, key: key.value, aad });
      } }, options);
    },
  };
}
/** Reject binding mismatches before decrypting. @complexity O(AAD length). */
function matchesBinding(required: { secret: SealedSecret; version: number; aad: string }): boolean {
  return required.secret.version === required.version && required.secret.aadDigest === createHash("sha256").update(required.aad).digest("hex");
}
/** Authenticate bounded canonical ciphertext; failures never contain provider data. @complexity O(ciphertext length). */
function decrypt(required: { secret: SealedSecret; key: Uint8Array; aad: string }): Outcome<string> {
  const parts = required.secret.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== "gcm1") return failure({ code: "forbidden" });
  const bytes = parts.slice(1).map(part => Buffer.from(part, "base64url"));
  if (bytes.some((part, index) => part.toString("base64url") !== parts[index + 1])) return failure({ code: "forbidden" });
  if (bytes[0].length !== 12 || bytes[1].length !== 16 || bytes[2].length > 65536) return failure({ code: "forbidden" });
  try {
    const cipher = createDecipheriv("aes-256-gcm", required.key, bytes[0]);
    cipher.setAAD(Buffer.from(required.aad));
    cipher.setAuthTag(bytes[1]);
    return { ok: true, value: Buffer.concat([cipher.update(bytes[2]), cipher.final()]).toString("utf8") };
  } catch {
    return failure({ code: "forbidden" });
  }
}
