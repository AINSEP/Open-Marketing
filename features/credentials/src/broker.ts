import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CredentialAuditPort, CredentialBrokerPort, CredentialLockPort, CredentialRefreshPort, CredentialRepoPort, SecretSealerPort } from "./ports.js";
import type { CredentialRecord, CredentialReference, SealedSecret } from "./types.js";
import { withCredentialLock } from "./locks.js";
import { boundary, brokerSchema, failure, recordSchema, sameScope, secretSchema } from "./rules.js";

interface BrokerDependencies { repo: CredentialRepoPort; locks: CredentialLockPort; audit: CredentialAuditPort; sealer: SecretSealerPort; refresh?: CredentialRefreshPort }
interface BrokerUse { context: CallContext; reference: CredentialReference; operationId: string }

/** Host-only sealed credential capability. Rechecks scope/status/version under the same lock
 * used by revocation, after audit and refresh. Call at dispatch, never at confirmation.
 * @complexity O(1) repository calls plus bounded cryptography/provider refresh.
 * @tradeoffs Returned ciphertext is a capability for trusted server egress only; a transport
 * must not retain it for later dispatch. Multi-process serialization requires a shared lock.
 */
export function createCredentialBroker(required: BrokerDependencies): CredentialBrokerPort {
  return {
    async use(input, options) {
      return boundary({ run: async () => {
        if (!brokerSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (input.context.principal.kind !== "service") return failure({ code: "forbidden" });
        if (!sameScope({ left: input.context.scope, right: input.reference.scope })) return failure({ code: "forbidden" });
        const snapshot = structuredClone(input);
        return withCredentialLock({ locks: required.locks, reference: snapshot.reference, run: () => useLocked({ dependencies: required, input: snapshot }, options) }, options);
      } }, options);
    },
  };
}
/** Lookup inside serialization; stale callers cannot trigger a second refresh. @complexity O(1) lookups. */
async function useLocked(required: { dependencies: BrokerDependencies; input: BrokerUse }, optional?: CallOptions): Promise<Outcome<SealedSecret>> {
  const record = await readCurrent({ repo: required.dependencies.repo, input: required.input }, optional);
  if (!record.ok) return record;
  const refreshed = await maybeRefresh({ dependencies: required.dependencies, input: required.input, record: record.value }, optional);
  if (!refreshed.ok) return refreshed;
  const audit = await required.dependencies.audit.record({ context: required.input.context, operation: "credentials.use", connectionId: required.input.reference.connectionId }, optional);
  if (!audit.ok) return audit;
  const input = { ...required.input, reference: refreshed.value.reference };
  const final = await readCurrent({ repo: required.dependencies.repo, input }, optional);
  if (!final.ok) return final;
  const authenticated = await required.dependencies.sealer.open({ reference: final.value.reference, secret: final.value.secret }, optional);
  if (!authenticated.ok) return authenticated;
  const current = await readCurrent({ repo: required.dependencies.repo, input }, optional);
  if (!current.ok) return current;
  if (current.value.secret.ciphertext !== final.value.secret.ciphertext) return failure({ code: "conflict" });
  return { ok: true, value: structuredClone(current.value.secret) };
}
/** Validate repository output and current authority. @complexity O(record size), bounded schemas. */
async function readCurrent(required: { repo: CredentialRepoPort; input: BrokerUse }, optional?: CallOptions): Promise<Outcome<CredentialRecord>> {
  const loaded = await required.repo.getSecret({ context: required.input.context, connectionId: required.input.reference.connectionId }, optional);
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "unauthenticated", message: "Connection unavailable; reconnect required" });
  const parsed = recordSchema.safeParse(loaded.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const record = parsed.data;
  if (record.summary.status !== "connected" || record.reference.connectionId !== required.input.reference.connectionId) return failure({ code: "forbidden" });
  if (!sameScope({ left: record.reference.scope, right: required.input.context.scope })) return failure({ code: "forbidden" });
  if (record.reference.version !== required.input.reference.version) return failure({ code: "conflict", message: "Credential version changed; resolve current connection" });
  return { ok: true, value: record };
}
/** Provider decides expiry. Refresh failure indicating revoked authorization requires reconnect.
 * Successful refresh must return sealed next-version data. @complexity O(1) writes plus provider work.
 */
async function maybeRefresh(required: { dependencies: BrokerDependencies; input: BrokerUse; record: CredentialRecord }, optional?: CallOptions): Promise<Outcome<CredentialRecord>> {
  if (!required.dependencies.refresh || required.record.reference.connectionId.startsWith("oauth-client.")) return { ok: true, value: required.record };
  const refreshed = await required.dependencies.refresh.refresh({ context: required.input.context, record: required.record }, optional);
  if (!refreshed.ok) {
    const marked = await markFailedRefresh({ dependencies: required.dependencies, context: required.input.context, record: required.record, code: refreshed.error.code });
    if (!marked.ok) return marked;
    return refreshed;
  }
  if (!refreshed.value) return { ok: true, value: required.record };
  return storeRefresh({ dependencies: required.dependencies, context: required.input.context, record: required.record, secret: refreshed.value }, optional);
}
/** Revocation from provider becomes a useful typed public status; transient failures retain authority state. @complexity O(1). */
async function markFailedRefresh(required: { dependencies: BrokerDependencies; context: CallContext; record: CredentialRecord; code: string }): Promise<Outcome<void>> {
  if (required.code !== "unauthenticated" && required.code !== "forbidden") return { ok: true, value: undefined };
  const marked = await required.dependencies.repo.requireReconnect({ context: required.context, connectionId: required.record.reference.connectionId });
  if (!marked.ok) return marked;
  return { ok: true, value: undefined };
}
/** Authenticate next-version ciphertext before CAS; never overwrite a revoked record.
 * Once a provider rotated its refresh token, finish persistence despite caller cancellation.
 * Later dispatch checks still honor cancellation. @complexity O(ciphertext length).
 */
async function storeRefresh(required: { dependencies: BrokerDependencies; context: CallContext; record: CredentialRecord; secret: SealedSecret }, optional?: CallOptions): Promise<Outcome<CredentialRecord>> {
  if (!secretSchema.safeParse(required.secret).success) return failure({ code: "protocol_mismatch" });
  const reference = { ...required.record.reference, version: required.record.reference.version + 1 };
  const opened = await required.dependencies.sealer.open({ reference, secret: required.secret });
  if (!opened.ok) return opened;
  const stored = await required.dependencies.repo.store({ context: required.context, reference, secret: required.secret, pluginId: required.record.summary.pluginId });
  if (!stored.ok) return stored;
  return { ok: true, value: { summary: stored.value, reference, secret: required.secret } };
}
