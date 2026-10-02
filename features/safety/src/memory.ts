import type { CallContext, ClockPort, IdPort, Outcome, Scope, ServiceContext, GenerationCostQuote } from "@open-marketing/contracts";
import { effectEnvelopeSchema, haltStopRequestSchema } from "@open-marketing/contracts";
import type { AccountDispatchLockPort, SafetyAuditPort, SpendPolicyPort, VerifiedEffectResolverPort, PlatformLimitEvidencePort, SafetyRepoPort } from "./ports.js";
import type { EffectRequest, FrozenGenerationRequest, PlatformLimitEvidence } from "./types.js";
import { evidenceSchema, failure, sameValue, scopeKey, success, validContext } from "./rules.js";
import { createMemoryStateStore } from "./memory-store.js";
import { createSafetyRepository } from "./repository.js";
export { createMemoryConfirmationExchange } from "./confirmation.js";
/** Memory double shares domain repository rules with SQL. @example createMemorySafetyRepo({ clock, ids, ownerTimezone: "America/Los_Angeles" }) @complexity O(s) per transaction; <=10,000 journal records. */
export function createMemorySafetyRepo(required: { clock: ClockPort; ids: IdPort; ownerTimezone: string }): SafetyRepoPort {
 return createSafetyRepository({ ...required, store: createMemoryStateStore(required) });
}
/** Policy double admits ordinary effects, refuses unbounded/misclassified financial and service calls. @complexity O(e), bounded e <=10. */
export function createMemorySpendPolicy(required: { allowed?: boolean }): SpendPolicyPort {
 return { async assess(input) {
  if (!validContext(input) || !effectEnvelopeSchema.safeParse(input.envelope).success) return failure({ code: "invalid_input", message: "Invalid policy envelope" });
  if (required.allowed === false) return success({ value: { allowed: false, reason: "policy_denied" } });
  const effects = input.envelope.effects;
  if (effects.includes("halt_stop") || effects.includes("conversion")) return success({ value: { allowed: false, reason: "typed_service_path_required" } });
  if (effects.includes("ad_spend") && (!input.envelope.accountId || !input.envelope.moneyExposure || !input.envelope.requiredLimit)) return success({ value: { allowed: false, reason: "unbounded_spend" } });
  if (effects.includes("read") && effects.length > 1) return success({ value: { allowed: false, reason: "contradictory_read" } });
  return success({ value: { allowed: true } });
 } };
}
export type VerifiedEffectFixture = { readonly scope: Scope; readonly request: EffectRequest; readonly envelope: EffectRequest["envelope"] };
export type VerifiedQuoteFixture = { readonly scope: Scope; readonly request: FrozenGenerationRequest; readonly quote: GenerationCostQuote; readonly pluginDigest: string; readonly schemaFingerprint: string };
export type VerifiedStopFixture = { readonly context: ServiceContext; readonly request: Parameters<VerifiedEffectResolverPort["verifyHaltStop"]>[0]["request"] };
/** Allowlisted host fixtures. Exact scope/fingerprint/content matching means caller hints cannot grant effects or stop access. @complexity O(f*n log n), fixtures bounded at composition <=10,000, n <=64KiB. */
export function createMemoryVerifiedEffectResolver(required: { effects?: readonly VerifiedEffectFixture[]; quotes?: readonly VerifiedQuoteFixture[]; stops?: readonly VerifiedStopFixture[] }): VerifiedEffectResolverPort {
 const fixtureCount = (required.effects?.length ?? 0) + (required.quotes?.length ?? 0) + (required.stops?.length ?? 0);
 if (fixtureCount > 10_000) throw new Error("Verified fixtures exceed composition bound");
 const fixtures = structuredClone(required);
 return {
  async resolve(input) {
   const fixture = fixtures.effects?.find(value => sameValue({ left: value.scope, right: input.context.scope }) && sameValue({ left: value.request, right: input.request }));
   if (!fixture || !effectEnvelopeSchema.safeParse(fixture.envelope).success) return failure({ message: "No current verified effect binding" });
   return success({ value: structuredClone(fixture.envelope) });
  },
  async verifyGenerationQuote(input) {
   const fixture = fixtures.quotes?.find(value => sameValue({ left: value.scope, right: input.context.scope }) && sameValue({ left: value.request, right: input.request }) && sameValue({ left: value.quote, right: input.quote }));
   if (!fixture) return failure({ message: "No verified pricing provenance" });
   if (input.pluginDigest && fixture.pluginDigest !== input.pluginDigest) return failure({ message: "Pricing plugin changed" });
   if (input.schemaFingerprint && fixture.schemaFingerprint !== input.schemaFingerprint) return failure({ message: "Pricing schema changed" });
   if (fixture.pluginDigest !== input.quote.pluginDigest) return failure({ message: "Quote has forged plugin fingerprint" });
   return success({ value: undefined });
  },
  async verifyHaltStop(input) {
   if (!haltStopRequestSchema.safeParse(input.request).success) return failure({ code: "invalid_input", message: "Stop payload is not closed" });
   const fixture = fixtures.stops?.find(value => sameValue({ left: value.context.scope, right: input.context.scope }) && value.context.serviceId === input.context.serviceId && sameValue({ left: value.request, right: input.request }));
   return fixture ? success({ value: undefined }) : failure({ message: "Unverified stop binding, service, or existing entities" });
  },
 };
}
/** Scoped evidence double, missing data fails closed. @complexity O(f), fixture list bounded by composition. */
export function createMemoryPlatformLimitEvidence(required: { evidence?: readonly { scope: Scope; evidence: PlatformLimitEvidence }[] }): PlatformLimitEvidencePort {
 if ((required.evidence?.length ?? 0) > 10_000) throw new Error("Evidence fixtures exceed composition bound");
 const fixtures = structuredClone(required.evidence ?? []);
 return { async get(input) {
  const fixture = fixtures.find(value => sameValue({ left: value.scope, right: input.context.scope }) && value.evidence.accountId === input.accountId);
  if (!fixture || !evidenceSchema.safeParse(fixture.evidence).success) return failure({ message: "No valid platform limit evidence" });
  return success({ value: structuredClone(fixture.evidence) });
 } };
}
/** Wait for a barrier or cancellation; the foreign AbortSignal ABI is wrapped and removed. @complexity O(1). */
async function waitForLock(required: { previous: Promise<void>; signal?: AbortSignal }): Promise<boolean> {
 if (!required.signal) { await required.previous; return true; }
 if (required.signal.aborted) return false;
 const cancelled = Promise.withResolvers<boolean>();
 const listener = () => cancelled.resolve(false);
 required.signal.addEventListener("abort", listener, { once: true });
 try { return await Promise.race([required.previous.then(() => true), cancelled.promise]); }
 finally { required.signal.removeEventListener("abort", listener); }
}
/** FIFO process-local barrier double with bounded waiters; production must share one server-owned barrier. @example locks.acquire({ context, accountId }, { signal }) @complexity O(1) per request, <=100 waiters/key. */
export function createMemoryAccountDispatchLock(required: { ids: IdPort }): AccountDispatchLockPort {
 const tails = new Map<string, Promise<void>>();
 const counts = new Map<string, number>();
 const active = new Map<string, { key: string; done: ReturnType<typeof Promise.withResolvers<void>> }>();
 return {
  async acquire(input, optional) {
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid lock scope" });
   const key = JSON.stringify([scopeKey(input), input.accountId]);
   const count = counts.get(key) ?? 0;
   if (count >= 100) return failure({ code: "limit_exceeded", message: "Too many account waiters" });
   counts.set(key, count + 1);
   const previous = tails.get(key) ?? Promise.resolve();
   const done = Promise.withResolvers<void>();
   tails.set(key, done.promise);
   const acquired = await waitForLock({ previous, signal: optional?.signal });
   if (!acquired) { void previous.then(() => releaseTail({ key, done, tails, counts })); return failure({ code: "cancelled", message: "Lock acquisition cancelled" }); }
   const lockId = required.ids.next({});
   if (active.has(lockId)) { releaseTail({ key, done, tails, counts }); return failure({ code: "conflict", message: "Duplicate lock identifier" }); }
   active.set(lockId, { key, done });
   return success({ value: { lockId } });
  },
  async release(input) {
   const lock = active.get(input.lockId);
   if (!lock) return failure({ code: "conflict", message: "Lock not owned or already released" });
   active.delete(input.lockId);
   releaseTail({ ...lock, tails, counts });
   return success({ value: undefined });
  },
 };
}
/** Advance one queue link after its predecessor, never on early cancellation. @complexity O(1). */
function releaseTail(required: { key: string; done: ReturnType<typeof Promise.withResolvers<void>>; tails: Map<string, Promise<void>>; counts: Map<string, number> }): void {
 required.done.resolve();
 required.counts.set(required.key, (required.counts.get(required.key) ?? 1) - 1);
 if (required.tails.get(required.key) === required.done.promise) { required.tails.delete(required.key); required.counts.delete(required.key); }
}
/** Append-only audit double; receipts do not expose a mutable backing array. @complexity O(1) append, O(a) read; <=10,000 events. */
export function createMemorySafetyAudit(required: { fail?: boolean }): SafetyAuditPort & { read(required: Record<string, never>): readonly Parameters<SafetyAuditPort["record"]>[0][] } {
 const entries: Parameters<SafetyAuditPort["record"]>[0][] = [];
 return {
  async record(input) {
   if (required.fail || entries.length >= 10_000) return failure({ code: "unavailable", message: "Audit unavailable" });
   if (!validContext(input)) return failure({ code: "invalid_input", message: "Invalid audit context" });
   entries.push(structuredClone(input));
   return success({ value: undefined });
  },
  read() { return structuredClone(entries); },
 };
}
