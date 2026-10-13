import { generationApprovalRequirementSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { CreativeRepoPort, CreativeJobPort, CreativeSpendPort, GenerationCapabilityPort, CreativeAssetPort, CreativeAuditPort, CreativeObserverPort } from "./ports.js";
import type { GenerationRequest, GenerationReceipt, GenerationStatus } from "./types.js";
import { dispatchReceiptSchema, failure, freezeValue, parseGeneration, receipt, sameEvidence, success, validateQuote } from "./rules.js";

/** Dependencies supplied by the server; core never constructs an adapter or scheduler. */
export type CreativeDependencies = { repo: CreativeRepoPort; generation: GenerationCapabilityPort; assets: CreativeAssetPort; jobs: CreativeJobPort; safety: CreativeSpendPort; clock: ClockPort; ids: IdPort; audit: CreativeAuditPort; observer?: CreativeObserverPort };

/** Prepare immutable intent and atomically enqueue through the ONE outbox adapter.
 * No vendor generation is performed here. A repeated operation binds the full original request.
 * @complexity O(n log n) bounded arguments, constant port calls.
 */
export async function requestGeneration(required: { deps: CreativeDependencies; context: CallContext; request: GenerationRequest }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>> {
  const parsed = parseGeneration({ ...required, now: required.deps.clock.now({}) });
  if (!parsed.ok) return parsed;
  const request = freezeValue({ value: parsed.value });
  const existing = await required.deps.repo.get({ context: required.context, generationId: request.operationId }, optional);
  if (existing.ok) return existingReceipt({ status: existing.value, request });
  if (existing.error.code !== "unavailable") return existing;
  const quoted = await required.deps.generation.quote({ context: required.context, request }, optional);
  if (!quoted.ok) return quoted;
  const quote = validateQuote({ request, quote: quoted.value, now: required.deps.clock.now({}) });
  if (!quote.ok) return quote;
  const assessed = await required.deps.safety.assess({ context: required.context, request, quote: freezeValue({ value: quote.value }) }, optional);
  if (!assessed.ok) return assessed;
  const approval = parseBoundary({ schema: generationApprovalRequirementSchema, input: assessed.value });
  if (!approval.ok) return approval;
  if (approval.value.quoteId !== quote.value.quoteId) return failure({ code: "conflict", message: "Safety assessment references a different quote" });
  if (approval.value.kind === "denied") return failure({ code: "forbidden", message: "Safety denied generation" });
  const intent = freezeValue({ value: makeIntent({ request, quote: quote.value, approval: approval.value }) });
  const queued = await required.deps.jobs.enqueue({ context: required.context, operationId: request.operationId, argumentsDigest: request.argumentsDigest, intent }, optional);
  if (!queued.ok) return queued;
  return success({ value: receipt({ status: intent }) });
}
function makeIntent(required: { request: GenerationRequest; quote: GenerationStatus["quote"]; approval: GenerationStatus["approval"] }): GenerationStatus {
  return { generationId: required.request.operationId, state: "pending", request: required.request, approval: required.approval,
    dispatchState: "queued", reservationId: null, asyncOperationId: null, revision: 0, operation: null,
    providerJobId: null, assetIds: [], quote: required.quote, actualCost: null, costs: [] };
}
function existingReceipt(required: { status: GenerationStatus; request: GenerationRequest }): Outcome<GenerationReceipt> {
  if (!sameEvidence({ left: required.status.request, right: required.request })) return failure({ code: "conflict", message: "Operation already binds different generation arguments" });
  if (required.status.state === "cancelled") return failure({ code: "cancelled", message: "Generation is locally cancelled" });
  return success({ value: receipt({ status: required.status }) });
}

/** Claim once, recheck safety and persist the reservation BEFORE handing off to the plugin.
 * A crash with a dispatch claim is reconciled, never blindly resubmitted.
 * @complexity O(n) cloning of bounded intent, constant durable port calls.
 */
export async function dispatchGeneration(required: { deps: CreativeDependencies; context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>> {
  const claimed = await required.deps.repo.claimDispatch(required, optional);
  if (!claimed.ok) return claimed;
  const status = freezeValue({ value: claimed.value.status });
  if (status.state === "cancelled") return failure({ code: "cancelled", message: "Generation is locally cancelled" });
  if (!claimed.value.claimed) return duplicateDispatch({ status });
  const deadline = parseGeneration({ context: required.context, request: status.request, now: required.deps.clock.now({}) });
  if (!deadline.ok) return resetClaim({ ...required, status, outcome: deadline }, optional);
  const bound = validateQuote({ request: status.request, quote: status.quote, now: required.deps.clock.now({}) });
  if (!bound.ok) return resetClaim({ ...required, status, outcome: bound }, optional);
  const authorized = await required.deps.safety.withDispatch({
    context: required.context, request: status.request, quote: status.quote,
    dispatch: args => submitReserved({ ...required, status, reservationId: args.reservationId }, optional),
  }, optional);
  if (!authorized.ok) return resetClaim({ ...required, status, outcome: authorized }, optional);
  return authorized;
}
function duplicateDispatch(required: { status: GenerationStatus }): Outcome<GenerationReceipt> {
  if (required.status.dispatchState === "dispatching") return failure({ code: "conflict", message: "Dispatch outcome requires reconciliation" });
  return success({ value: receipt({ status: required.status }) });
}
async function submitReserved(required: { deps: CreativeDependencies; context: CallContext; generationId: string; status: GenerationStatus; reservationId: string }, optional?: CallOptions): Promise<Outcome<GenerationReceipt>> {
  const reservation = parseBoundary({ schema: idSchema, input: required.reservationId });
  if (!reservation.ok) return reservation;
  const saved = await required.deps.repo.save({ context: required.context, status: { ...required.status, reservationId: required.reservationId } }, optional);
  if (!saved.ok) return saved;
  const submitted = await required.deps.generation.generate({ context: required.context, request: saved.value.request, quote: saved.value.quote, generationId: saved.value.generationId }, optional);
  if (!submitted.ok) return submitted;
  const parsed = parseBoundary({ schema: dispatchReceiptSchema, input: submitted.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.generationId !== saved.value.generationId || parsed.value.operationId !== saved.value.request.operationId) return failure({ code: "protocol_mismatch", message: "Generation receipt does not bind the submitted intent" });
  const current = await required.deps.repo.get({ context: required.context, generationId: saved.value.generationId }, optional);
  if (!current.ok) return current;
  const projected = await required.deps.repo.save({ context: required.context, status: { ...current.value, dispatchState: "submitted", asyncOperationId: parsed.value.asyncOperationId } }, optional);
  if (!projected.ok) return projected;
  return parsed;
}
/** Only a claim with no durable reservation can be returned to the queue. Reserved errors remain unknown. */
async function resetClaim<T>(required: { deps: CreativeDependencies; context: CallContext; generationId: string; status: GenerationStatus; outcome: Outcome<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  const current = await required.deps.repo.get(required, optional);
  if (!current.ok) return current;
  const reserved = current.value.reservationId !== null;
  const saved = await required.deps.repo.save({ context: required.context, status: { ...current.value, dispatchState: reserved ? "dispatching" : "queued", state: current.value.state === "cancelled" ? "cancelled" : (reserved ? "unknown" : "pending") } }, optional);
  if (!saved.ok) return saved;
  return required.outcome;
}

/** Record one audit event with trace IDs after each boundary operation; observer is passive. @complexity O(1). */
export async function recordOutcome<T>(required: { deps: CreativeDependencies; context: CallContext; operationId: string; operation: string; outcome: Outcome<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  const result = required.outcome.ok ? "ok" : required.outcome.error.code;
  required.deps.observer?.observe({ operation: required.operation, outcome: result, correlationId: required.context.correlationId, traceId: required.context.traceId, ...(required.context.runId === undefined ? {} : { runId: required.context.runId }) });
  const audited = await required.deps.audit.record({ context: required.context, operationId: required.operationId, outcome: required.operation + ":" + result }, optional);
  if (!audited.ok) return audited;
  return required.outcome;
}
