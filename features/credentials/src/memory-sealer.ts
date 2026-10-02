import { createHash } from "node:crypto";
import { z } from "zod";
import type { SecretSealerPort } from "./ports.js";
import { authenticatedData, boundary, failure, referenceSchema, secretSchema } from "./rules.js";

/** Test-only opaque vault; plaintext remains in test process memory, never in ciphertext.
 * Not encryption and must not be composed in production. @complexity O(1) lookup, O(entries) space.
 */
export function createMemorySecretSealer(required: { maxEntries?: number }): SecretSealerPort {
  const vault = new Map<string, { binding: string; plaintext: string }>();
  let sequence = 0;
  return {
    async seal(input, options) {
      return boundary({ run: async () => {
        if (!referenceSchema.safeParse(input.reference).success || !z.string().min(1).max(65536).safeParse(input.plaintext).success) return failure({ code: "invalid_input" });
        if (Buffer.byteLength(input.plaintext) > 65536) return failure({ code: "invalid_input" });
        if (vault.size >= (required.maxEntries ?? 10000)) return failure({ code: "limit_exceeded" });
        const binding = authenticatedData({ reference: input.reference });
        const ciphertext = `memory-secret-${++sequence}`;
        vault.set(ciphertext, { binding, plaintext: input.plaintext });
        return { ok: true, value: { ciphertext, version: input.reference.version, aadDigest: createHash("sha256").update(binding).digest("hex") } };
      } }, options);
    },
    async open(input, options) {
      return boundary({ run: async () => {
        if (!referenceSchema.safeParse(input.reference).success || !secretSchema.safeParse(input.secret).success) return failure({ code: "invalid_input" });
        const binding = authenticatedData({ reference: input.reference });
        const entry = vault.get(input.secret.ciphertext);
        if (!entry || entry.binding !== binding) return failure({ code: "forbidden" });
        if (input.secret.version !== input.reference.version || input.secret.aadDigest !== createHash("sha256").update(binding).digest("hex")) return failure({ code: "forbidden" });
        return { ok: true, value: entry.plaintext };
      } }, options);
    },
  };
}
