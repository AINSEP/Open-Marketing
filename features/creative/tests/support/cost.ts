import type { GenerationStatus, GenerationCostObservation } from "../../index.js";
/** A stable observed charge for ledger and settlement contract assertions. */
export function costFor(required: { status: GenerationStatus; observationId?: string }): GenerationCostObservation {
  return { observationId: required.observationId ?? "charge", generationId: required.status.generationId, operationId: required.status.request.operationId, amount: { minorUnits: 100, currency: "USD" }, kind: "actual" };
}
