import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CreativeDependencies } from "./lifecycle.js";
import type { GenerationStatus, GenerationCostObservation } from "./types.js";
import { evidenceId, failure, provenance, sameEvidence, statusSchema, success } from "./rules.js";

/** Refresh durable provider evidence, settle observed charges and import bytes idempotently.
 * Every step is replayable after partial failure; no failure/cancellation releases a reservation.
 * @complexity O(c) port calls for c <=100 observations, one asset import.
 */
export async function refreshJob(required: { deps: CreativeDependencies; context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const original = await required.deps.repo.get(required, optional);
  if (!original.ok) return original;
  if (original.value.dispatchState === "queued") return original;
  const observed = await required.deps.generation.status(required, optional);
  if (!observed.ok) return observed;
  const parsed = parseBoundary({ schema: statusSchema, input: observed.value });
  if (!parsed.ok) return parsed;
  if (!matchesIntent({ original: original.value, observed: parsed.value })) return failure({ code: "protocol_mismatch", message: "Capability status changed original intent" });
  const status: GenerationStatus = { ...original.value, operation: parsed.value.operation, providerJobId: parsed.value.providerJobId, actualCost: parsed.value.actualCost, costs: parsed.value.costs, asyncOperationId: parsed.value.asyncOperationId,
    state: original.value.state === "cancelled" ? "cancelled" : parsed.value.state };
  const saved = await required.deps.repo.save({ context: required.context, status }, optional);
  if (!saved.ok) return saved;
  const costs = await recordCosts({ ...required, status: saved.value }, optional);
  if (!costs.ok) return costs;
  const evidence = await required.deps.assets.recordProvenance({ context: required.context, provenance: provenance({ status: saved.value }) }, optional);
  if (!evidence.ok) return evidence;
  return importResult({ ...required, status: saved.value }, optional);
}
function matchesIntent(required: { original: GenerationStatus; observed: GenerationStatus }): boolean {
  if (required.original.generationId !== required.observed.generationId) return false;
  if (!sameEvidence({ left: required.original.request, right: required.observed.request })) return false;
  return sameEvidence({ left: required.original.quote, right: required.observed.quote });
}
async function recordCosts(required: { deps: CreativeDependencies; context: CallContext; status: GenerationStatus }, optional?: CallOptions): Promise<Outcome<void>> {
  for (const cost of observations({ status: required.status })) {
    const recorded = await recordCost({ ...required, cost }, optional);
    if (!recorded.ok) return recorded;
  }
  return success({ value: undefined });
}
function observations(required: { status: GenerationStatus }): readonly GenerationCostObservation[] {
  const status = required.status;
  if (status.actualCost === null || status.costs.length > 0) return status.costs;
  return [{ observationId: evidenceId({ generationId: status.generationId, kind: "actual" }), generationId: status.generationId, operationId: status.request.operationId, amount: status.actualCost, kind: "actual" }];
}
async function recordCost(required: { deps: CreativeDependencies; context: CallContext; status: GenerationStatus; cost: GenerationCostObservation }, optional?: CallOptions): Promise<Outcome<void>> {
  if (required.cost.generationId !== required.status.generationId || required.cost.operationId !== required.status.request.operationId) return failure({ code: "protocol_mismatch", message: "Cost observation belongs to another generation" });
  const appended = await required.deps.repo.appendCost({ context: required.context, cost: required.cost }, optional);
  if (!appended.ok) return appended;
  const media = await required.deps.assets.recordCost({ context: required.context, cost: required.cost }, optional);
  if (!media.ok) return media;
  if (required.cost.kind === "estimated") return success({ value: undefined });
  if (required.status.reservationId === null) return failure({ code: "conflict", message: "Observed cost has no safety reservation" });
  return required.deps.safety.settle({ context: required.context, reservationId: required.status.reservationId, cost: required.cost }, optional);
}
async function importResult(required: { deps: CreativeDependencies; context: CallContext; status: GenerationStatus }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const status = required.status;
  if (status.operation?.result === null || status.operation?.result === undefined) return success({ value: status });
  if (status.operation.status !== "succeeded") return success({ value: status });
  const imported = await required.deps.assets.import({ context: required.context, generationId: status.generationId, operationId: status.request.operationId, output: { kind: "bytes", result: status.operation.result }, provenance: provenance({ status }) }, optional);
  if (!imported.ok) return imported;
  const recorded = await required.deps.assets.recordProvenance({ context: required.context, provenance: provenance({ status, assetId: imported.value.assetId }) }, optional);
  if (!recorded.ok) return recorded;
  const assetIds = [...new Set([...status.assetIds, imported.value.assetId])];
  return required.deps.repo.save({ context: required.context, status: { ...status, assetIds } }, optional);
}

/** Reconcile a bounded page after worker/recovery activity; cursor lets a host cover all durable rows.
 * @complexity O(k*c), k <=100 and c <=100, with no unbounded per-tick scan.
 */
export async function reconcilePage(required: { deps: CreativeDependencies; context: CallContext; limit: number; cursor?: string }, optional?: CallOptions): Promise<Outcome<string | null>> {
  const page = await required.deps.repo.list(required, optional);
  if (!page.ok) return page;
  for (const status of page.value.items) {
    const refreshed = await refreshJob({ deps: required.deps, context: required.context, generationId: status.generationId }, optional);
    if (!refreshed.ok) return refreshed;
  }
  return success({ value: page.value.cursor });
}
