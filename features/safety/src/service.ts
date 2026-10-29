import type { Outcome, CallContext, CallOptions, ClockPort, IdPort, ObserverPort, ConfirmationCard, ServiceContext, HaltStopPermit } from "@open-marketing/contracts";
import { confirmationCardSchema, effectEnvelopeSchema, haltStopRequestSchema, scopeSchema, idSchema } from "@open-marketing/contracts";
import type { SafetyRepoPort, SpendPolicyPort, ConfirmationExchangePort, VerifiedEffectResolverPort, PlatformLimitEvidencePort, AccountDispatchLockPort, SafetyAuditPort } from "./ports.js";
import type { CampaignConstituent, EffectRequest, FrozenDispatchRequest, DispatchPermit, DispatchAdmission, SafetyService, GenerationAuthorization, GenerationReservation } from "./types.js";
import { allowanceEditSchema, choices, classify, digestArguments, dispatchRequestSchema, effectRequestSchema, evidenceSchema, failure, freezeJson, generationAssessmentSchema, sameValue, settlementSchema, success, validContext } from "./rules.js";
type Dependencies = { repo: SafetyRepoPort; policy: SpendPolicyPort; confirmations: ConfirmationExchangePort; effects: VerifiedEffectResolverPort; platformLimits: PlatformLimitEvidencePort; accountLocks: AccountDispatchLockPort; clock: ClockPort; ids: IdPort; audit: SafetyAuditPort };
type Options = { observer?: ObserverPort; policyRevision?: number; evidenceMaxAgeMs?: number; permitTtlMs?: number; haltServiceId?: string; costServiceId?: string };
const GENERATION_LOCK_KEY = "@om:generation-allowance";
type Runtime = { dependencies: Dependencies; options: Options };
/** Observe typed outcomes without raw payloads. Port exceptions become explicit unavailable values. @complexity O(1) plus injected bounded effect. */
async function boundary<T>(required: { runtime: Runtime; context: CallContext; operation: string; execute: (required: { context: CallContext }) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
 try {
  if (!validContext({ context: required.context })) return failure({ code: "invalid_input", message: "Invalid safety context" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Safety operation cancelled" });
  const context = freezeJson({ value: structuredClone(required.context) });
  const outcome = await required.execute({ context });
  required.runtime.options.observer?.observe({ operation: required.operation, outcome: outcome.ok ? "ok" : outcome.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId });
  return outcome;
 } catch { return failure({ code: "unavailable", message: "Safety dependency failed; reconcile any submitted operation" }); }
}
/** Freeze once at the boundary. Values and digest must agree before any approval or effects. @complexity O(n log n), O(n) space, <=64KiB. */
function validateEffect(required: { request: EffectRequest }): Outcome<EffectRequest> {
 const digest = digestArguments({ arguments: required.request?.arguments });
 if (!digest.ok) return digest;
 const parsed = effectRequestSchema.safeParse(required.request);
 if (!parsed.success || parsed.data.envelope.argumentsDigest !== digest.value) return failure({ code: "invalid_input", message: "Effect arguments or fingerprint invalid" });
 return success({ value: structuredClone(parsed.data) });
}
/** Host mapping must equal the frozen envelope. Reverification occurs on every dispatch. @complexity O(n log n), bounded DTO; two injected calls. */
async function verifyEffect(required: { runtime: Runtime; context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<void>> {
 const resolved = await required.runtime.dependencies.effects.resolve({ context: required.context, request: required.request }, optional);
 if (!resolved.ok) return resolved;
 if (!effectEnvelopeSchema.safeParse(resolved.value).success || !sameValue({ left: resolved.value, right: required.request.envelope })) return failure({ message: "Effect differs from current host-verified binding" });
 const policy = await required.runtime.dependencies.policy.assess({ context: required.context, envelope: resolved.value }, optional);
 if (!policy.ok) return policy;
 return policy.value.allowed === true ? success({ value: undefined }) : failure({ message: "Current spendability policy denied operation" });
}
/** Generation is an exception only for pure generation writes, never ad spend/destruction/service effects. @complexity O(e), e <=10. */
function eligibleGeneration(required: { request: EffectRequest }): boolean {
 const effects = required.request.envelope.effects;
 return required.request.envelope.accountId === null && !!required.request.generation && effects.includes("generation") && effects.every(effect => effect === "generation" || effect === "write");
}
/** Classify using the atomic repo's current allowance and verified quote provenance. @complexity O(g); bounded two port calls. */
async function approvalClassification(required: { runtime: Runtime; context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<ConfirmationCard["classification"]>> {
 if (!required.request.envelope.effects.includes("generation")) return success({ value: classify(required.request) });
 if (!eligibleGeneration(required)) return failure({ message: "Generation cannot downgrade other effects or omit cost provenance" });
 const generation = required.request.generation!;
 if (generation.request.argumentsDigest !== required.request.envelope.argumentsDigest || generation.request.operationId !== required.request.envelope.operationId || generation.request.connectionId !== required.request.envelope.connectionId) return failure({ message: "Generation differs from reviewed operation" });
 const quote = await required.runtime.dependencies.effects.verifyGenerationQuote({ context: required.context, ...generation, pluginDigest: required.request.pluginDigest, schemaFingerprint: required.request.schemaFingerprint }, optional);
 if (!quote.ok) return quote;
 const assessment = await required.runtime.dependencies.repo.assessGeneration({ context: required.context, ...generation }, optional);
 if (!assessment.ok) return assessment;
 if (assessment.value.kind === "denied") return failure({ message: assessment.value.reason });
 return success({ value: assessment.value.kind === "normal_write" ? "generation" : "spend" });
}
/** Platform evidence independently binds account, age, window, currency, semantics and implementation. Nominal average budgets are insufficient. @complexity O(1) DTO checks; one evidence read. */
async function dispatchAdmission(required: { runtime: Runtime; context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<DispatchAdmission>> {
 const now = required.runtime.dependencies.clock.now({});
 const expiresAt = now + (required.runtime.options.permitTtlMs ?? 30_000);
 const envelope = required.request.envelope;
 if (envelope.moneyExposure === null && !envelope.effects.includes("ad_spend")) return success({ value: { maximum: null, window: null, expiresAt } });
 if (!envelope.accountId || !envelope.moneyExposure || !envelope.requiredLimit) return failure({ message: "Exact spend lacks bounded account authority" });
 const evidence = await required.runtime.dependencies.platformLimits.get({ context: required.context, accountId: envelope.accountId }, optional);
 if (!evidence.ok) return evidence;
 if (!evidenceSchema.safeParse(evidence.value).success) return failure({ message: "Invalid platform cap evidence" });
 if (!evidenceMatches({ runtime: required.runtime, request: required.request, evidence: evidence.value, now })) return failure({ message: "Missing, stale, incomparable or insufficient cap evidence" });
 return success({ value: { maximum: envelope.requiredLimit.amount, window: evidence.value.window, expiresAt: Math.min(expiresAt, evidence.value.window.end, evidence.value.observedAt + (required.runtime.options.evidenceMaxAgeMs ?? 60_000)) } });
}
/** Compare cap DTOs without treating approval as platform proof. @complexity O(1). */
function evidenceMatches(required: { runtime: Runtime; request: EffectRequest; evidence: import("./types.js").PlatformLimitEvidence; now: number }): boolean {
 const envelope = required.request.envelope;
 const limit = envelope.requiredLimit!;
 const exposure = envelope.moneyExposure!;
 const evidence = required.evidence;
 const identity = evidence.accountId === envelope.accountId && evidence.evidenceId === limit.evidenceId && evidence.pluginDigest === required.request.pluginDigest;
 const fresh = evidence.observedAt <= required.now && required.now - evidence.observedAt < (required.runtime.options.evidenceMaxAgeMs ?? 60_000) && evidence.window.start <= required.now && evidence.window.end > required.now;
 const amount = evidence.amount.currency === limit.amount.currency && exposure.amount.currency === limit.amount.currency && evidence.amount.minorUnits <= limit.amount.minorUnits && exposure.amount.minorUnits <= limit.amount.minorUnits;
 const window = exposure.window.start >= evidence.window.start && exposure.window.end <= evidence.window.end;
 return identity && fresh && amount && window && evidence.semantics !== "average_budget" && evidence.semantics === limit.semantics;
}
/** Card adapter output is tainted and cannot add broad spend choices or alter reviewed values. @complexity O(n log n), bounded JSON. */
function validCard(required: { card: ConfirmationCard; request: EffectRequest; classification: ConfirmationCard["classification"]; now: number }): boolean {
 const parsed = confirmationCardSchema.safeParse(required.card);
 if (!parsed.success) return false;
 const card = parsed.data;
 return card.expiresAt > required.now && card.operationId === required.request.envelope.operationId && card.argumentsDigest === required.request.envelope.argumentsDigest && card.classification === required.classification && sameValue({ left: card.arguments, right: required.request.arguments }) && sameValue({ left: card.allowedChoices, right: choices({ classification: required.classification, grantable: !!required.request.operationScope }) });
}
/** Generate one review card; presentation creates no authority. @complexity O(n log n + g), bounded ports. */
async function prepare(required: { runtime: Runtime; context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<ConfirmationCard>> {
 const validated = validateEffect(required);
 if (!validated.ok) return validated;
 const input = { ...required, request: validated.value };
 const verified = input.request.pausedCampaignCalls ? await verifyCampaignApproval(input, optional) : await verifyEffect(input, optional);
 if (!verified.ok) return verified;
 const classification = await approvalClassification(input, optional);
 if (!classification.ok) return classification;
 const card = await required.runtime.dependencies.confirmations.present({ context: input.context, request: input.request, policyRevision: required.runtime.options.policyRevision ?? 0, classification: classification.value }, optional);
 if (!card.ok) return card;
 return validCard({ card: card.value, request: input.request, classification: classification.value, now: required.runtime.dependencies.clock.now({}) }) ? card : failure({ message: "Confirmation adapter changed review or authority" });
}
/** Dispatch rechecks binding, policy, confirmation and current financial state under one account barrier. @complexity O(n log n + r+g), bounded ports. */
async function admit(required: { runtime: Runtime; context: CallContext; request: FrozenDispatchRequest }, optional?: CallOptions): Promise<Outcome<DispatchPermit>> {
 const verified = await verifyEffect({ ...required, request: stripDispatch(required) }, optional);
 if (!verified.ok) return verified;
 const classification = await approvalClassification(required, optional);
 if (!classification.ok) return classification;
 if (!isReadOnly({ request: required.request })) {
  const authority = await required.runtime.dependencies.confirmations.verify({ context: required.context, request: required.request, classification: classification.value }, optional);
  if (!authority.ok) return authority;
 }
 const audited = await required.runtime.dependencies.audit.record({ context: required.context, operationId: required.request.envelope.operationId, outcome: "dispatch_admission" }, optional);
 if (!audited.ok) return audited;
 if (required.request.generation) return admitGeneration(required, optional);
 const admission = await dispatchAdmission(required, optional);
 if (!admission.ok) return admission;
 return required.runtime.dependencies.repo.reserve({ context: required.context, request: required.request, admission: admission.value }, optional);
}
/** Translate atomic generation accounting to the generic permit; cap policy remains independent for ads. @complexity O(g), bounded repo calls. */
async function admitGeneration(required: { runtime: Runtime; context: CallContext; request: FrozenDispatchRequest }, optional?: CallOptions): Promise<Outcome<DispatchPermit>> {
 const generation = required.request.generation!;
 const assessment = await required.runtime.dependencies.repo.assessGeneration({ context: required.context, ...generation }, optional);
 if (!assessment.ok) return assessment;
 if (assessment.value.kind === "denied") return failure({ message: assessment.value.reason });
 const reserved = await required.runtime.dependencies.repo.reserveGeneration({ context: required.context, ...generation, expectedKind: assessment.value.kind, expectedRevision: assessment.value.allowanceRevision }, optional);
 if (!reserved.ok) return reserved;
 return success({ value: { operationId: generation.request.operationId, argumentsDigest: generation.request.argumentsDigest, approvalId: required.request.approvalId, expiresAt: Math.min(required.runtime.dependencies.clock.now({}) + (required.runtime.options.permitTtlMs ?? 30_000), generation.quote.expiresAt), reservationId: reserved.value.reservationId } });
}
/** Authority is checked after durable reservation immediately before handoff; slow storage cannot outlive a short approval. @complexity O(n log n+g), bounded host/evidence calls. */
async function recheckAuthority(required: { runtime: Runtime; context: CallContext; request: FrozenDispatchRequest }, optional?: CallOptions): Promise<Outcome<void>> {
 const verified = await verifyEffect({ ...required, request: stripDispatch(required) }, optional);
 if (!verified.ok) return verified;
 if (isReadOnly(required)) return success({ value: undefined });
 const classification = await approvalClassification(required, optional);
 if (!classification.ok) return classification;
 return required.runtime.dependencies.confirmations.verify({ context: required.context, request: required.request, classification: classification.value }, optional);
}
/** Freeze before awaiting the lock, then hold it through optional transport handoff. No permit alone bypasses this boundary. @complexity O(n log n+r+g); O(1) queue metadata. */
async function dispatchLocked<T>(required: { runtime: Runtime; context: CallContext; request: FrozenDispatchRequest; dispatch: (required: { context: CallContext; permit: DispatchPermit; request: FrozenDispatchRequest }) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
 const parsed = dispatchRequestSchema.safeParse(required.request);
 if (!parsed.success || parsed.data.policyRevision !== (required.runtime.options.policyRevision ?? 0) || parsed.data.pausedCampaignCalls) return failure({ message: "Invalid dispatch: campaign cards authorize constituents only, under the current policy" });
 const frozen = freezeJson({ value: structuredClone(parsed.data) });
 const validated = validateEffect({ request: stripDispatch({ request: frozen }) });
 if (!validated.ok) return validated;
 const lock = await required.runtime.dependencies.accountLocks.acquire({ context: required.context, accountId: frozen.generation ? GENERATION_LOCK_KEY : frozen.envelope.accountId ?? `connection:${frozen.envelope.connectionId}` }, optional);
 if (!lock.ok) return lock;
 try {
  const permit = await admit({ runtime: required.runtime, context: required.context, request: frozen }, optional);
  if (!permit.ok) return permit;
  const current = await recheckAuthority({ runtime: required.runtime, context: required.context, request: frozen }, optional);
  if (!current.ok) return current;
  if (optional?.signal?.aborted || permit.value.expiresAt <= required.runtime.dependencies.clock.now({})) return failure({ code: "expired", message: "Dispatch cancelled or expired before handoff" });
  return await required.dispatch({ context: required.context, permit: permit.value, request: frozen });
 } finally {
  const released = await required.runtime.dependencies.accountLocks.release({ lockId: lock.value.lockId });
  if (!released.ok) throw new Error("Safety barrier release failed");
 }
}
/** Remove dispatch-only fields when validating the original effect DTO. @complexity O(1). */
function stripDispatch(required: { request: FrozenDispatchRequest }): EffectRequest {
 const { approvalId: _approval, policyRevision: _revision, campaignApproval: _campaign, ...request } = required.request;
 return request;
}
/** Prepare every frozen child before presenting one owning spend card. Only non-serving writes
 * are eligible: activation retains its independent exact spend card and cap checks.
 * @complexity <=16 sequential host verifications, O(b) space for <=64KiB total reviewed JSON. */
async function verifyCampaignApproval(required: { runtime: Runtime; context: CallContext; request: EffectRequest }, optional?: CallOptions): Promise<Outcome<void>> {
 const { request } = required;
 const calls = request.pausedCampaignCalls!;
 const root = request.envelope;
 if (root.effects.length !== 1 || root.effects[0] !== "ad_spend" || root.accountId !== null || root.moneyExposure !== null || root.requiredLimit !== null || request.generation || request.operationScope) return failure({ message: "Invalid owning paused campaign approval" });
 if (!sameValue({ left: request.arguments.calls, right: calls }) || new Set(calls.map(call => call.envelope.operationId)).size !== calls.length) return failure({ message: "Campaign review differs from exact constituents" });
 for (const call of calls) {
  const validated = validateCampaignCall({ call, operationId: root.operationId });
  if (!validated.ok) return validated;
  const verified = await verifyEffect({ ...required, request: call }, optional);
  if (!verified.ok) return verified;
 }
 return success({ value: undefined });
}
/** Closed non-serving writes cannot borrow campaign authority for activation or spend.
 * @complexity O(b) digest validation for a bounded constituent; pure. */
function validateCampaignCall(required: { call: CampaignConstituent; operationId: string }): Outcome<EffectRequest> {
 const envelope = required.call.envelope;
 if (envelope.operationId === required.operationId || !envelope.accountId || envelope.effects.length !== 1 || envelope.effects[0] !== "write" || envelope.moneyExposure !== null || envelope.requiredLimit !== null) return failure({ message: "Paused campaign constituents must be non-serving writes" });
 return validateEffect({ request: required.call });
}
/** Convert authenticated service context to ordinary scope/trace propagation. @complexity O(1). */
function serviceContext(required: { context: ServiceContext & { readonly runId?: string } }): CallContext {
 return { scope: required.context.scope, principal: { kind: "service", serviceId: required.context.serviceId }, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId };
}
/** Stop requires a closed backend DTO, current local halt epoch and verified scoped existing entities. @complexity O(e), e <=100; bounded port calls. */
async function stop(required: { runtime: Runtime; context: ServiceContext; request: Parameters<SafetyService["authorizeHaltStop"]>[0]["request"] }, optional?: CallOptions): Promise<Outcome<HaltStopPermit>> {
 const parsed = haltStopRequestSchema.safeParse(required.request);
 if (!parsed.success || required.context.serviceId !== required.runtime.options.haltServiceId || !sameValue({ left: required.context.scope, right: parsed.data.scope })) return failure({ message: "Stop requires configured backend service and closed scoped payload" });
 const request = freezeJson({ value: structuredClone(parsed.data) });
 const verified = await required.runtime.dependencies.effects.verifyHaltStop({ context: required.context, request }, optional);
 if (!verified.ok) return verified;
 const context = serviceContext(required);
 const halted = await required.runtime.dependencies.repo.getHalt({ context, accountId: request.adAccountId }, optional);
 if (!halted.ok) return halted;
 if (halted.value.haltId !== request.haltId || halted.value.epoch !== request.haltEpoch) return failure({ message: "Stop does not name current local halt" });
 const digest = digestArguments({ arguments: { adAccountId: request.adAccountId, entityIds: request.entityIds, action: request.action } });
 if (!digest.ok || digest.value !== request.argumentsDigest) return failure({ message: "Stop arguments differ from frozen digest" });
 const audit = await required.runtime.dependencies.audit.record({ context, operationId: request.operationId, outcome: "halt_stop_admitted" }, optional);
 if (!audit.ok) return audit;
 return success({ value: { kind: "halt-stop", request, expiresAt: required.runtime.dependencies.clock.now({}) + (required.runtime.options.permitTtlMs ?? 30_000) } });
}
/** Server-owned exact approvals and accounting. Inputs/ports are frozen or validated; runtime dependencies are injected. @example service.withDispatch({ context, request: approvedCall, dispatch: serverTransport }) @complexity Each path O(n log n+r+g), all state and payload bounds enforced by adapters. */
export function createSafetyService(required: Dependencies, optional: Options = {}): SafetyService {
 const runtime = { dependencies: required, options: optional };
 return {
  async prepareApproval(input, options) { return boundary({ runtime, context: input.context, operation: "safety.prepareApproval", execute: ({ context }) => prepare({ runtime, ...input, context }, options) }, options); },
  async authorizeDispatch(input, options) { return boundary({ runtime, context: input.context, operation: "safety.authorizeDispatch", execute: ({ context }) => dispatchLocked({ runtime, ...input, context, dispatch: async ({ permit }) => success({ value: permit }) }, options) }, options); },
  async withDispatch(input, options) { return boundary({ runtime, context: input.context, operation: "safety.withDispatch", execute: ({ context }) => dispatchLocked({ runtime, ...input, context }, options) }, options); },
  async haltAccount(input, options) { return boundary({ runtime, context: input.context, operation: "safety.haltAccount", execute: ({ context }) => haltLocked({ runtime, ...input, context }, options) }, options); },
  async authorizeHaltStop(input, options) { return boundary({ runtime, context: serviceContext(input), operation: "safety.authorizeHaltStop", execute: ({ context }) => stop({ runtime, ...input, context: asServiceContext({ context }) }, options) }, options); },
  async getGenerationAllowance(input, options) { return boundary({ runtime, context: input.context, operation: "safety.getGenerationAllowance", execute: ({ context }) => required.repo.getGenerationAllowance({ context }, options) }, options); },
  async setGenerationAllowance(input, options) { return boundary({ runtime, context: input.context, operation: "safety.setGenerationAllowance", execute: ({ context }) => setAllowanceLocked({ runtime, context, settings: structuredClone(input.settings) }, options) }, options); },
  async assessGeneration(input, options) { return boundary({ runtime, context: input.context, operation: "safety.assessGeneration", execute: async ({ context }) => {
   const parsed = generationAssessmentSchema.safeParse({ ...input, context });
   if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid generation quote" });
   const verified = await required.effects.verifyGenerationQuote(parsed.data, options);
   if (!verified.ok) return verified;
   return required.repo.assessGeneration(parsed.data, options);
  } }, options); },
  async reserveGeneration(input, options) { return boundary({ runtime, context: input.context, operation: "safety.reserveGeneration", execute: ({ context }) => reserveGeneration({ runtime, ...input, context }, options) }, options); },
  async settleGeneration(input, options) { return boundary({ runtime, context: serviceContext(input), operation: "safety.settleGeneration", execute: ({ context }) => settleLocked({ runtime, context: asServiceContext({ context }), settlement: structuredClone(input.settlement) }, options) }, options); },
 };
}
/** Halt commits locally under the transport barrier. Later audit failure never clears the durable halt. @complexity O(1) queue plus bounded transaction. */
async function haltLocked(required: { runtime: Runtime; context: CallContext; adAccountId: string }, optional?: CallOptions): Promise<Outcome<import("./types.js").HaltReceipt>> {
 if (!idSchema.safeParse(required.adAccountId).success || !validContext({ context: required.context, ownerOnly: true })) return failure({ message: "Halt requires scoped owner" });
 const lock = await required.runtime.dependencies.accountLocks.acquire({ context: required.context, accountId: required.adAccountId }, optional);
 if (!lock.ok) return lock;
 try {
  const halted = await required.runtime.dependencies.repo.halt({ context: required.context, adAccountId: required.adAccountId }, optional);
  if (!halted.ok) return halted;
  const audited = await required.runtime.dependencies.audit.record({ context: required.context, operationId: halted.value.haltId, outcome: "local_halt_remote_pending" }, optional);
  return audited.ok ? halted : audited;
 } finally {
  const released = await required.runtime.dependencies.accountLocks.release({ lockId: lock.value.lockId });
  if (!released.ok) throw new Error("Safety barrier release failed");
 }
}
/** Generation calls enter the generic approval/barrier path; one exact request carries quote and configuration. @complexity O(g+n log n), bounded transactions. */
async function reserveGeneration(required: { runtime: Runtime; context: CallContext; authorization: GenerationAuthorization }, optional?: CallOptions): Promise<Outcome<GenerationReservation>> {
 const authorization = required.authorization;
 if (!sameValue({ left: authorization.dispatch.generation, right: { request: authorization.request, quote: authorization.quote } })) return failure({ message: "Generation authorization differs from reviewed call" });
 return dispatchLocked({ runtime: required.runtime, context: required.context, request: authorization.dispatch, dispatch: async ({ permit }) => required.runtime.dependencies.repo.getGenerationReservation({ context: required.context, reservationId: permit.reservationId }, optional) }, optional);
}
/** Read admission never follows an unannotated or mixed-effect path. @complexity O(1). */
function isReadOnly(required: { request: EffectRequest }): boolean {
 return required.request.envelope.effects.length === 1 && required.request.envelope.effects[0] === "read" && required.request.envelope.moneyExposure === null && required.request.envelope.requiredLimit === null;
}

/** Preserve the authenticated service identity while forwarding the frozen scope. @complexity O(1). */
function asServiceContext(required: { context: CallContext }): ServiceContext & { readonly runId?: string } {
 return { scope: required.context.scope, serviceId: required.context.principal.kind === "service" ? required.context.principal.serviceId : "", correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId };
}
/** Settings serialize with generation handoff; a completed edit cannot race a stale grant across egress. @complexity O(s), one scoped barrier and atomic repo edit. */
async function setAllowanceLocked(required: { runtime: Runtime; context: CallContext; settings: Parameters<SafetyService["setGenerationAllowance"]>[0]["settings"] }, optional?: CallOptions): Promise<Outcome<Parameters<SafetyService["setGenerationAllowance"]>[0]["settings"]>> {
 if (!allowanceEditSchema.safeParse({ context: required.context, settings: required.settings }).success || !validContext({ context: required.context, ownerOnly: true })) return failure({ message: "Settings require scoped owner" });
 return allowanceBarrier({ runtime: required.runtime, context: required.context, execute: async () => {
  const audit = await required.runtime.dependencies.audit.record({ context: required.context, operationId: `allowance:${required.settings.revision}`, outcome: "allowance_edit_requested" }, optional);
  if (!audit.ok) return audit;
  return required.runtime.dependencies.repo.setGenerationAllowance({ context: required.context, settings: required.settings }, optional);
 } }, optional);
}
/** Cost updates serialize with generation handoff, including discrepancy blocks. @complexity O(g), one scoped barrier and append-only settlement. */
async function settleLocked(required: { runtime: Runtime; context: ServiceContext; settlement: Parameters<SafetyService["settleGeneration"]>[0]["settlement"] }, optional?: CallOptions): Promise<Outcome<void>> {
 if (required.context.serviceId !== required.runtime.options.costServiceId || !settlementSchema.safeParse(required.settlement).success) return failure({ message: "Settlement requires configured cost observer service" });
 const context = serviceContext(required);
 return allowanceBarrier({ runtime: required.runtime, context, execute: () => required.runtime.dependencies.repo.settleGeneration({ context, settlement: required.settlement }, optional) }, optional);
}
/** One generation barrier covers reservations, settings and actual-charge observations for a scope. @complexity O(1) queue plus bounded injected operation. */
async function allowanceBarrier<T>(required: { runtime: Runtime; context: CallContext; execute: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
 const lock = await required.runtime.dependencies.accountLocks.acquire({ context: required.context, accountId: GENERATION_LOCK_KEY }, optional);
 if (!lock.ok) return lock;
 try { return await required.execute(); }
 finally {
  const released = await required.runtime.dependencies.accountLocks.release({ lockId: lock.value.lockId });
  if (!released.ok) throw new Error("Safety barrier release failed");
 }
}
