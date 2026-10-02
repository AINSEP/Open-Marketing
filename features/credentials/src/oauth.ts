import { timingSafeEqual } from "node:crypto";
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { OAuthClientPort } from "./ports.js";
import type { ConnectRequest, CredentialReference, SealedSecret, VerifiedOAuthCallback } from "./types.js";
import { boundary, callbackSchema, connectSchema, failure, secretSchema } from "./rules.js";
import { validChallenge } from "./service.js";

/** Host implements these bindings using published Jini exports. PKCE and provider HTTP remain
 * in that adapter/plugin, with guarded egress, deadlines and encrypted pending PKCE storage.
 */
export interface OAuthHostBindings {
  authorize(required: { context: CallContext; request: ConnectRequest; reference: CredentialReference }, optional?: CallOptions): Promise<Outcome<{ authorizationUrl: string; expiresAt: number }>>;
  exchange(required: { context: CallContext; request: ConnectRequest; reference: CredentialReference; callback: VerifiedOAuthCallback }, optional?: CallOptions): Promise<Outcome<SealedSecret>>;
}
interface PendingOAuth { context: CallContext; request: ConnectRequest; reference: CredentialReference; state: string; expiresAt: number }

/** Bound OAuth lifecycle adapter. Validates exact redirects, S256, state, expiry and one-shot use.
 * In-memory OM bindings deliberately expire on server restart. Injected Jini binding owns PKCE.
 * @complexity O(pending count) on begin, O(1) completion; cap includes in-flight authorizations.
 */
export function createBoundOAuthClient(required: {
  bindings: OAuthHostBindings; clock: ClockPort; ids: IdPort;
  allowedReturnUris: readonly string[]; allowedAuthorizationOrigins: readonly string[];
  maxPending?: number;
}): OAuthClientPort {
  const pending = new Map<string, PendingOAuth>();
  let inFlight = 0;
  return {
    async begin(input, options) {
      return boundary({ run: async () => {
        if (!connectSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (!required.allowedReturnUris.includes(input.request.returnUri)) return failure({ code: "forbidden" });
        prune({ pending, now: required.clock.now({}) });
        if (pending.size + inFlight >= (required.maxPending ?? 256)) return failure({ code: "limit_exceeded" });
        inFlight++;
        try {
          return await authorize({ dependencies: required, pending, input }, options);
        } finally { inFlight--; }
      } }, options);
    },
    async complete(input, options) {
      return boundary({ run: async () => {
        if (!callbackSchema.safeParse(input.callback).success) return failure({ code: "invalid_input" });
        const entry = pending.get(input.callback.transactionId);
        if (!entry) return failure({ code: "expired" });
        pending.delete(input.callback.transactionId);
        if (entry.expiresAt <= required.clock.now({})) return failure({ code: "expired" });
        if (!equalState({ expected: entry.state, actual: input.callback.state }) || entry.request.returnUri !== input.callback.redirectUri) return failure({ code: "forbidden" });
        const exchanged = await required.bindings.exchange({ context: entry.context, request: entry.request, reference: entry.reference, callback: input.callback }, options);
        if (!exchanged.ok) return exchanged;
        if (!secretSchema.safeParse(exchanged.value).success) return failure({ code: "protocol_mismatch" });
        return exchanged;
      } }, options);
    },
  };
}
/** Persist OM binding only after the host supplies an admitted challenge. @complexity O(URL length). */
async function authorize(required: {
  dependencies: Parameters<typeof createBoundOAuthClient>[0]; pending: Map<string, PendingOAuth>;
  input: { context: CallContext; request: ConnectRequest };
}, optional?: CallOptions): Promise<Outcome<import("./types.js").ConnectChallenge>> {
  const input = structuredClone(required.input);
  const transactionId = required.dependencies.ids.next({});
  const reference = { scope: input.context.scope, connectionId: transactionId, version: 1 };
  const result = await required.dependencies.bindings.authorize({ ...input, reference }, optional);
  if (!result.ok) return result;
  const challenge = { transactionId, ...result.value };
  if (!validChallenge({ challenge, now: required.dependencies.clock.now({}), redirectUri: input.request.returnUri })) return failure({ code: "protocol_mismatch" });
  const url = new URL(challenge.authorizationUrl);
  if (!required.dependencies.allowedAuthorizationOrigins.includes(url.origin)) return failure({ code: "forbidden" });
  if (required.pending.has(transactionId)) return failure({ code: "conflict" });
  required.pending.set(transactionId, { ...input, reference, state: url.searchParams.get("state")!, expiresAt: challenge.expiresAt });
  return { ok: true, value: challenge };
}
/** Constant-time opaque-state comparison after length validation. @complexity O(state length). */
function equalState(required: { expected: string; actual: string }): boolean {
  const expected = Buffer.from(required.expected);
  const actual = Buffer.from(required.actual);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
/** Bounded expiry cleanup; no timers. @complexity O(pending count). */
function prune(required: { pending: Map<string, PendingOAuth>; now: number }): void {
  for (const [id, entry] of required.pending) {
    if (entry.expiresAt <= required.now) required.pending.delete(id);
  }
}
