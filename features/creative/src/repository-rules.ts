import { parseBoundary } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { GenerationCostObservation, GenerationStatus } from "./types.js";
import { costSchema, digestGenerationRequest, failure, sameEvidence, statusSchema, success } from "./rules.js";

/** Validate bounded durable intent before parsing nested parameters. @complexity O(n log n), bounded request. */
export function validateStatus(required: { status: GenerationStatus }): Outcome<GenerationStatus> {
  if (required.status === null || typeof required.status !== "object") return failure({ code: "invalid_input", message: "Generation status is required" });
  const digest = digestGenerationRequest({ request: required.status.request });
  if (!digest.ok) return digest;
  const parsed = parseBoundary({ schema: statusSchema, input: required.status });
  if (!parsed.ok) return parsed;
  if (parsed.value.generationId !== parsed.value.request.operationId) return failure({ code: "conflict", message: "Generation identity must bind its operation" });
  if (parsed.value.request.argumentsDigest !== digest.value) return failure({ code: "conflict", message: "Stored generation digest does not match" });
  if (parsed.value.quote.argumentsDigest !== digest.value) return failure({ code: "conflict", message: "Stored quote does not bind the request" });
  if (parsed.value.quote.modelConfigurationDigest !== parsed.value.request.configurationDigest) return failure({ code: "conflict", message: "Stored quote configuration does not bind the request" });
  if (parsed.value.approval.quoteId !== parsed.value.quote.quoteId) return failure({ code: "conflict", message: "Stored assessment does not bind the quote" });
  return parsed;
}
/** Protect original reviewed evidence and a durable reservation from replacement. @complexity O(n log n), bounded intent. */
export function validateReplacement(required: { previous: GenerationStatus; next: GenerationStatus; expectedRevision: number }): Outcome<void> {
  if (required.previous.revision !== required.expectedRevision) return failure({ code: "conflict", message: "Generation revision changed" });
  if (!sameEvidence({ left: required.previous.request, right: required.next.request })) return failure({ code: "conflict", message: "Original generation arguments are immutable" });
  if (!sameEvidence({ left: required.previous.quote, right: required.next.quote })) return failure({ code: "conflict", message: "Original generation quote is immutable" });
  if (!sameEvidence({ left: required.previous.approval, right: required.next.approval })) return failure({ code: "conflict", message: "Original safety assessment is immutable" });
  if (required.previous.reservationId !== null && required.previous.reservationId !== required.next.reservationId) return failure({ code: "conflict", message: "Generation reservation cannot be replaced or released" });
  if (required.previous.state === "cancelled" && required.next.state !== "cancelled") return failure({ code: "conflict", message: "Local cancellation cannot be undone" });
  return validateDispatchReplacement(required);
}
/** Once transport may have run, storage cannot reopen the intent for another submit. @complexity O(1). */
function validateDispatchReplacement(required: { previous: GenerationStatus; next: GenerationStatus }): Outcome<void> {
  if (required.previous.asyncOperationId !== null && required.next.asyncOperationId !== required.previous.asyncOperationId) return failure({ code: "conflict", message: "Async operation identity cannot be replaced" });
  if (required.next.dispatchState === "queued" && required.next.reservationId !== null) return failure({ code: "conflict", message: "Reserved generation cannot be requeued" });
  if (required.previous.dispatchState === "submitted" && required.next.dispatchState !== "submitted") return failure({ code: "conflict", message: "Submitted generation cannot be redispatched" });
  if (required.previous.state === "succeeded" && required.next.state !== "succeeded") return failure({ code: "conflict", message: "Confirmed generation cannot lose its outcome" });
  return success({ value: undefined });
}
/** Cost identities are immutable; corrections append a distinct record linked to an earlier charge. @complexity O(n) lookup by adapter. */
export function validateCostLink(required: { cost: GenerationCostObservation; status: GenerationStatus; previous?: GenerationCostObservation; correction?: GenerationCostObservation }): Outcome<void> {
  const parsed = parseBoundary({ schema: costSchema, input: required.cost });
  if (!parsed.ok) return parsed;
  if (required.cost.generationId !== required.status.generationId) return failure({ code: "conflict", message: "Cost generation does not match" });
  if (required.cost.operationId !== required.status.request.operationId) return failure({ code: "conflict", message: "Cost operation does not match generation" });
  if (required.previous !== undefined && !sameEvidence({ left: required.previous, right: required.cost })) return failure({ code: "conflict", message: "Observation identity already binds different cost" });
  if (required.cost.kind !== "correction") return success({ value: undefined });
  if (required.correction === undefined) return failure({ code: "conflict", message: "Correction must reference an existing observation" });
  if (required.correction.generationId !== required.cost.generationId) return failure({ code: "conflict", message: "Correction crosses generation boundary" });
  if (required.correction.amount.currency !== required.cost.amount.currency) return failure({ code: "conflict", message: "Correction changes currency" });
  return success({ value: undefined });
}
