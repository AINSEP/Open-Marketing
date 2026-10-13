import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAesGcmSecretSealer, createCredentialKeyring } from "../index.js";
import { configuration, reference, value } from "./fixtures.js";

/** Characterize the committed 3e2648f wire algorithm independently of Jini.
 * A compatibility regression is detected even if new seal/open agree with each other.
 */
function committedEnvelope(required: { plaintext: string }) {
  const master = new Uint8Array(32).fill(7);
  const key = new Uint8Array(hkdfSync("sha256", master, configuration.hkdfSalt, "om.credentials.key.v1:1", 32));
  const nonce = new Uint8Array(12).fill(3);
  const aad = JSON.stringify(["om.credentials.aes-gcm.v1", "owner", "workspace", "connection", 1]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(required.plaintext, "utf8"), cipher.final()]);
  return { ciphertext: ["gcm1", Buffer.from(nonce).toString("base64url"), cipher.getAuthTag().toString("base64url"), bytes.toString("base64url")].join("."), aadDigest: createHash("sha256").update(aad).digest("hex"), version: 1 };
}

describe("Jini AES-GCM preserves committed OM ciphertext", () => {
  it("opens the old format and produces byte-identical ciphertext for fixed entropy", async () => {
    const port = createAesGcmSecretSealer({ configuration, keyring: createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }) }), randomBytes: input => new Uint8Array(input.size).fill(3) });
    const old = committedEnvelope({ plaintext: "legacy-token" });
    expect(value({ outcome: await port.open({ reference, secret: old }) })).toBe("legacy-token");
    expect(value({ outcome: await port.seal({ reference, plaintext: "legacy-token" }) })).toEqual(old);
  });
  it("rejects noncanonical base64, short nonces and truncated authentication tags", async () => {
    const port = createAesGcmSecretSealer({ configuration, keyring: createCredentialKeyring({ loadMaster: async () => ({ ok: true, value: new Uint8Array(32).fill(7) }) }), randomBytes: input => new Uint8Array(input.size).fill(3) });
    const old = committedEnvelope({ plaintext: "legacy-token" });
    const parts = old.ciphertext.split(".");
    const invalid = [parts.map((part, index) => index === 1 ? part + "=" : part).join("."), [parts[0], "Aw", parts[2], parts[3]].join("."), [parts[0], parts[1], "Aw", parts[3]].join(".")];
    for (const ciphertext of invalid) expect(await port.open({ reference, secret: { ...old, ciphertext } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
