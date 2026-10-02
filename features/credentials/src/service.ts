import type { CallContext, CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import type { CredentialRepoPort, SecretSealerPort, KeyringPort, OAuthClientPort, CredentialLockPort, CredentialAuditPort, CredentialObserverPort } from "./ports.js";
import type { ConnectChallenge, ConnectRequest, ConnectionSummary, CredentialService, CredentialReference, SealedSecret, VerifiedOAuthCallback } from "./types.js";
import { withCredentialLock } from "./locks.js";
import { boundary, callbackSchema, challengeSchema, connectSchema, failure, lookupSchema, revocationSchema, sameScope, secretSchema, summarySchema } from "./rules.js";

interface PendingConnection { context: CallContext; request: ConnectRequest; challenge: ConnectChallenge }
interface ServiceDependencies {
  repo: CredentialRepoPort; sealer: SecretSealerPort; keyring: KeyringPort;
  oauth: OAuthClientPort; clock: ClockPort; locks: CredentialLockPort; audit: CredentialAuditPort;
}

/** Inert server lifecycle factory. Bound transactions expire and are consumed before exchange.
 * A reconnect uses a new connection ID; revoked IDs are never resurrected.
 * @complexity O(pending transactions) on begin, O(1) on completion/revocation; cap 256.
 */
export function createCredentialService(required: ServiceDependencies, optional?: { observer?: CredentialObserverPort }): CredentialService {
  const pending = new Map<string, PendingConnection>();
  let inFlight = 0;
  return {
    async beginConnect(input, options) {
      return boundary({ run: async () => {
        if (!connectSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (!isOwner({ context: input.context })) return failure({ code: "forbidden" });
        expirePending({ pending, now: required.clock.now({}) });
        if (pending.size + inFlight >= 256) return failure({ code: "limit_exceeded" });
        inFlight++;
        try {
          return await beginConnection({ dependencies: required, pending, input, observer: optional?.observer }, options);
        } finally { inFlight--; }
      } }, options);
    },
    async completeConnect(input, options) {
      return boundary({ run: async () => {
        if (!callbackSchema.safeParse(input.callback).success) return failure({ code: "invalid_input" });
        const callback = structuredClone(input.callback);
        const entry = pending.get(callback.transactionId);
        if (!entry) return failure({ code: "expired" });
        pending.delete(callback.transactionId);
        if (entry.challenge.expiresAt <= required.clock.now({})) return failure({ code: "expired" });
        if (!matchesCallback({ entry, callback })) return failure({ code: "forbidden" });
        return completeConnection({ dependencies: required, entry, callback }, options);
      } }, options);
    },
    async revoke(input, options) {
      return boundary({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (!isOwner({ context: input.context })) return failure({ code: "forbidden" });
        const snapshot = structuredClone(input);
        const reference = { scope: snapshot.context.scope, connectionId: snapshot.connectionId, version: 1 };
        return withCredentialLock({ locks: required.locks, reference, run: () => revokeConnection({ dependencies: required, input: snapshot }, options) }, options);
      } }, options);
    },
  };
}

/** Authenticated owner/scope agreement; agent principals cannot connect/revoke. @complexity O(1). */
function isOwner(required: { context: CallContext }): boolean {
  return required.context.principal.kind === "owner" && required.context.principal.ownerId === required.context.scope.ownerId;
}
/** Bounded expiry scan uses only injected time. @complexity O(pending count), at most 256. */
function expirePending(required: { pending: Map<string, PendingConnection>; now: number }): void {
  for (const [id, entry] of required.pending) {
    if (entry.challenge.expiresAt <= required.now) required.pending.delete(id);
  }
}
/** Require HTTPS authorization and S256; provider remains responsible for generating/persisting PKCE. @complexity O(URL length). */
export function validChallenge(required: { challenge: ConnectChallenge; now: number; redirectUri: string }): boolean {
  if (!challengeSchema.safeParse(required.challenge).success) return false;
  if (required.challenge.expiresAt <= required.now || required.challenge.expiresAt > required.now + 600000) return false;
  const url = new URL(required.challenge.authorizationUrl);
  const query = url.searchParams;
  return validAuthorizationParameters({ url }) && url.protocol === "https:" && !url.username && !url.password && !url.hash
    && query.get("code_challenge_method") === "S256"
    && /^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "")
    && /^[A-Za-z0-9_-]{32,256}$/.test(query.get("state") ?? "")
    && query.get("redirect_uri") === required.redirectUri;
}
/** Compare exact registered redirect and opaque state, before provider exchange. @complexity O(URL length). */
function matchesCallback(required: { entry: PendingConnection; callback: VerifiedOAuthCallback }): boolean {
  const state = new URL(required.entry.challenge.authorizationUrl).searchParams.get("state");
  return state === required.callback.state && required.entry.request.returnUri === required.callback.redirectUri;
}
/** Lock through sealed validation, audit and storage; failed exchange never reports connected. @complexity O(1) repository operations. */
async function completeConnection(required: { dependencies: ServiceDependencies; entry: PendingConnection; callback: VerifiedOAuthCallback }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
  const reference: CredentialReference = { scope: required.entry.context.scope, connectionId: required.callback.transactionId, version: 1 };
  return withCredentialLock({ locks: required.dependencies.locks, reference, run: async () => {
    const secret = await required.dependencies.oauth.complete({ callback: required.callback }, optional);
    if (!secret.ok) return secret;
    return persistConnection({ dependencies: required.dependencies, entry: required.entry, reference, secret: secret.value }, optional);
  } }, optional);
}
/** Authenticate provider ciphertext before repository write; audit includes no payload. @complexity O(ciphertext length). */
async function persistConnection(required: { dependencies: ServiceDependencies; entry: PendingConnection; reference: CredentialReference; secret: SealedSecret }, optional?: CallOptions): Promise<Outcome<ConnectionSummary>> {
  if (!secretSchema.safeParse(required.secret).success) return failure({ code: "protocol_mismatch" });
  const opened = await required.dependencies.sealer.open({ reference: required.reference, secret: required.secret }, optional);
  if (!opened.ok) return opened;
  const context = required.entry.context;
  const recorded = await required.dependencies.audit.record({ context, connectionId: required.reference.connectionId, operation: "credentials.connect" }, optional);
  if (!recorded.ok) return recorded;
  const stored = await required.dependencies.repo.store({ context, reference: required.reference, secret: required.secret, pluginId: required.entry.request.pluginId }, optional);
  if (!stored.ok) return stored;
  return validateStoredSummary({ summary: stored.value, entry: required.entry });
}
/** Observer receives only fixed metadata; telemetry failure cannot affect lifecycle. @complexity O(1). */
function observe(required: { observer?: CredentialObserverPort; context: CallContext; operation: string }): void {
  try {
    required.observer?.observe({ operation: required.operation, outcome: "succeeded", correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId });
  } catch { /* Telemetry is non-authoritative. */ }
}

/** Reserve capacity before awaited authorization; bind a detached owner/request snapshot. @complexity O(1) plus provider work. */
async function beginConnection(required: { dependencies: ServiceDependencies; pending: Map<string, PendingConnection>; input: { context: CallContext; request: ConnectRequest }; observer?: CredentialObserverPort }, optional?: CallOptions): Promise<Outcome<ConnectChallenge>> {
  const input = structuredClone(required.input);
  const begun = await required.dependencies.oauth.begin(input, optional);
  if (!begun.ok) return begun;
  if (!validChallenge({ challenge: begun.value, now: required.dependencies.clock.now({}), redirectUri: input.request.returnUri })) return failure({ code: "protocol_mismatch" });
  if (required.pending.has(begun.value.transactionId)) return failure({ code: "conflict" });
  required.pending.set(begun.value.transactionId, structuredClone({ ...input, challenge: begun.value }));
  observe({ observer: required.observer, context: input.context, operation: "credentials.beginConnect" });
  return begun;
}

/** Only known authorization fields reach public challenge DTOs; reject duplicates and secret fields. @complexity O(query fields), bounded URL length. */
function validAuthorizationParameters(required: { url: URL }): boolean {
  const allowed = new Set(["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method", "resource", "prompt", "access_type"]);
  const keys = Array.from(required.url.searchParams.keys());
  return keys.length === new Set(keys).size && keys.every(key => allowed.has(key)) && required.url.searchParams.get("response_type") === "code";
}

/** Public result validation forbids plaintext additions even from a replacement repository. @complexity O(summary length). */
function validateStoredSummary(required: { summary: ConnectionSummary; entry: PendingConnection }): Outcome<ConnectionSummary> {
  if (!summarySchema.safeParse(required.summary).success) return failure({ code: "protocol_mismatch" });
  if (!sameScope({ left: required.summary.scope, right: required.entry.context.scope })) return failure({ code: "protocol_mismatch" });
  if (required.summary.connectionId !== required.entry.challenge.transactionId || required.summary.pluginId !== required.entry.request.pluginId || required.summary.status !== "connected") return failure({ code: "protocol_mismatch" });
  return { ok: true, value: structuredClone(required.summary) };
}

/** Revoke locally before recording receipt metadata; audit failure does not restore authority. @complexity O(1) writes. */
async function revokeConnection(required: { dependencies: ServiceDependencies; input: { context: CallContext; connectionId: string } }, optional?: CallOptions): Promise<Outcome<import("./types.js").RevocationReceipt>> {
  const revoked = await required.dependencies.repo.revoke(required.input, optional);
  if (!revoked.ok) return revoked;
  if (!revocationSchema.safeParse(revoked.value).success || revoked.value.connectionId !== required.input.connectionId) return failure({ code: "protocol_mismatch" });
  const recorded = await required.dependencies.audit.record({ ...required.input, operation: "credentials.revoked" });
  if (!recorded.ok) return recorded;
  return revoked;
}
