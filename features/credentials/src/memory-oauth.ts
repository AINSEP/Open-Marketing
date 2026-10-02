import { createHash } from "node:crypto";
import type { ClockPort } from "@open-marketing/contracts";
import type { OAuthClientPort, SecretSealerPort } from "./ports.js";
import { createBoundOAuthClient } from "./oauth.js";
import { createMemorySecretSealer } from "./memory-sealer.js";

/** Deterministic OAuth double. HTTPS endpoint, PKCE/state and token values are fixtures;
 * never use in production. Shares validation with the bound host adapter. @complexity O(1).
 */
export function createMemoryOAuthClient(required: { clock?: ClockPort; sealer?: SecretSealerPort; allowedReturnUris?: readonly string[] }): OAuthClientPort {
  const clock = required.clock ?? { now() { return 0; } };
  const sealer = required.sealer ?? createMemorySecretSealer({});
  let sequence = 0;
  return createBoundOAuthClient({
    clock, ids: { next() { return `test-connection-${++sequence}`; } },
    allowedReturnUris: required.allowedReturnUris ?? ["https://studio.example/callback"],
    allowedAuthorizationOrigins: ["https://oauth.example"],
    bindings: {
      async authorize(input) {
        const state = createHash("sha256").update(input.reference.connectionId).digest("base64url");
        const url = new URL("https://oauth.example/authorize");
        url.searchParams.set("state", state);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("redirect_uri", input.request.returnUri);
        url.searchParams.set("code_challenge", "A".repeat(43));
        url.searchParams.set("code_challenge_method", "S256");
        return { ok: true, value: { authorizationUrl: url.href, expiresAt: clock.now({}) + 300000 } };
      },
      async exchange(input, options) {
        return sealer.seal({ reference: input.reference, plaintext: "test-access-token" }, options);
      },
    },
  });
}
