import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CreativeDependencies } from "./lifecycle.js";
import type { GenerationCompletion, GenerationOutput, GenerationStatus, GenerationCostObservation } from "./types.js";
import { evidenceId, failure, generationCompletionSchema, provenance, sameEvidence, scopedKey, success } from "./rules.js";
import { validateStatus } from "./repository-rules.js";

/** Refresh durable provider evidence, settle observed charges and import bytes idempotently.
 * Every step is replayable after partial failure; no failure/cancellation releases a reservation.
 * @complexity O(c) port calls for c <=100 observations, one asset import.
 */
export async function refreshJob(required: { deps: CreativeDependencies; context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const original = await required.deps.repo.get(required, optional);
  if (!original.ok) return original;
  if (original.value.dispatchState === "queued") return original;
  // Media adapters must recheck current authority before fetching a verified URL again.
  if (original.value.verifiedCompletion !== undefined) return finishProjection({ ...required, status: original.value }, optional);
  const observed = await required.deps.generation.status(required, optional);
  if (!observed.ok) return observed;
  const parsed = validateStatus({ status: observed.value });
  if (!parsed.ok) return parsed;
  if (!matchesIntent({ original: original.value, observed: parsed.value })) return failure({ code: "protocol_mismatch", message: "Capability status changed original intent" });
  const evidence = validateObservation({ ...required, original: original.value, observed: parsed.value });
  if (!evidence.ok) return evidence;
  const status = projectObservation({ original: original.value, observed: parsed.value });
  const saved = await required.deps.repo.save({ context: required.context, status }, optional);
  if (!saved.ok) return saved;
  return finishProjection({ ...required, status: saved.value }, optional);
}
/** Replay evidence/import stages after a partial failure, with stable identities.
 * @complexity O(c + b), c <=100 costs, b <=16MiB output; URL import may use guarded egress.
 */
async function finishProjection(required: { deps: CreativeDependencies; context: CallContext; status: GenerationStatus }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const costs = await recordCosts(required, optional);
  if (!costs.ok) return costs;
  const recorded = await required.deps.assets.recordProvenance({ context: required.context, provenance: provenance({ status: required.status }) }, optional);
  if (!recorded.ok) return recorded;
  return importResult(required, optional);
}

/** Accept only server-verified output for the existing terminal operation and durable handle.
 * Persists evidence before import; local cancellation and the original Jini row are preserved.
 * @returns Scoped status or explicit invalid_input/forbidden/conflict/port failure.
 * @complexity O(b + c), bounded output and <=100 costs; never submits/polls the provider.
 */
export async function ingestVerifiedCompletion(required: { deps: CreativeDependencies; context: CallContext; generationId: string; completion: GenerationCompletion }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const parsed = parseBoundary({ schema: generationCompletionSchema, input: required.completion });
  if (!parsed.ok) return parsed;
  const current = await required.deps.repo.get(required, optional);
  if (!current.ok) return current;
  const valid = validateCompletion({ context: required.context, status: current.value, completion: parsed.value });
  if (!valid.ok) return valid;
  const saved = await required.deps.repo.save({ context: required.context, status: { ...current.value, verifiedCompletion: parsed.value,
    state: current.value.state === "cancelled" ? "cancelled" : "succeeded" } }, optional);
  if (!saved.ok) return saved;
  return finishProjection({ ...required, status: saved.value }, optional);
}
/** Require an owned terminal row with an acknowledged handle; prompt matching is never evidence.
 * @complexity O(b) comparison for bounded output; no I/O.
 */
function validateCompletion(required: { context: CallContext; status: GenerationStatus; completion: GenerationCompletion }): Outcome<void> {
  const { status, completion } = required;
  const operation = status.operation;
  if (status.dispatchState !== "submitted" || status.reservationId === null || operation === null) return failure({ code: "conflict", message: "Generation has no durable submitted operation" });
  if (operation.ownerRef !== scopedKey({ context: required.context, id: status.generationId })) return failure({ code: "forbidden", message: "Completion belongs to another scope" });
  if (completion.asyncOperationId !== status.asyncOperationId || operation.id !== completion.asyncOperationId) return failure({ code: "conflict", message: "Completion operation mismatch" });
  if (completion.providerJobId !== status.providerJobId || operation.state?.jobId !== completion.providerJobId) return failure({ code: "conflict", message: "Completion requires the original provider handle" });
  return validateTerminalCompletion({ status, completion });
}
/** Late ingestion is separate from Jini transitions and never replaces conflicting verified evidence. @complexity O(b), bounded output. */
function validateTerminalCompletion(required: { status: GenerationStatus; completion: GenerationCompletion }): Outcome<void> {
  const { status, completion } = required;
  const operation = status.operation!;
  if (operation.status !== "unknown" && operation.status !== "failed") return failure({ code: "conflict", message: "Active or succeeded operations use normal reconciliation" });
  if (operation.result !== null) return failure({ code: "conflict", message: "Terminal operation already contains output" });
  if (status.verifiedCompletion !== undefined && JSON.stringify(status.verifiedCompletion) !== JSON.stringify(completion)) return failure({ code: "conflict", message: "Verified completion is immutable" });
  return success({ value: undefined });
}
/** Keep local scheduling/cancellation authority while copying validated vendor evidence. @complexity O(c) bounded costs. */
function projectObservation(required: { original: GenerationStatus; observed: GenerationStatus }): GenerationStatus {
  return { ...required.original, operation: required.observed.operation, providerJobId: required.observed.providerJobId,
    actualCost: required.observed.actualCost, costs: observations({ status: required.observed }), asyncOperationId: required.observed.asyncOperationId,
    dispatchState: required.observed.operation === null ? required.original.dispatchState : "submitted",
    state: required.original.state === "cancelled" ? "cancelled" : required.observed.state };
}
/** Reject an entire tainted observation before any projection, ledger or media writes.
 * @complexity O(c) time/space for c <=100 cost identities.
 */
function validateObservation(required: { context: CallContext; original: GenerationStatus; observed: GenerationStatus }): Outcome<void> {
  const operation = required.observed.operation;
  if (operation !== null && (operation.id !== required.observed.asyncOperationId || operation.ownerRef !== scopedKey({ context: required.context, id: required.original.generationId }))) return failure({ code: "forbidden", message: "Observed operation does not belong to this generation" });
  const identities = new Map<string, GenerationCostObservation>(required.original.costs.map(cost => [cost.observationId, cost]));
  for (const cost of observations({ status: required.observed })) {
    if (cost.generationId !== required.original.generationId || cost.operationId !== required.original.request.operationId) return failure({ code: "protocol_mismatch", message: "Observed cost belongs to another generation" });
    const previous = identities.get(cost.observationId);
    if (previous !== undefined && !sameEvidence({ left: previous, right: cost })) return failure({ code: "conflict", message: "Observation repeats conflicting cost identity" });
    identities.set(cost.observationId, cost);
  }
  return success({ value: undefined });
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
  if (status.actualCost === null || status.costs.some(cost => cost.kind !== "estimated")) return status.costs;
  return [...status.costs, { observationId: evidenceId({ generationId: status.generationId, kind: "actual" }), generationId: status.generationId, operationId: status.request.operationId, amount: status.actualCost, kind: "actual" }];
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
/** Reuse output with stable asset identities; URL retries require current admission before import.
 * @complexity O(b + c) bounded evidence and one media import; failures leave stored evidence replayable. */
async function importResult(required: { deps: CreativeDependencies; context: CallContext; status: GenerationStatus }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const status = required.status;
  const output = completedOutput({ status });
  if (output === null) return success({ value: status });
  if (output.kind === "url") {
    const authority = await verifyUrlImport(required, optional);
    if (!authority.ok) return authority;
  }
  const imported = await required.deps.assets.import({ context: required.context, generationId: status.generationId, operationId: status.request.operationId, output, provenance: provenance({ status }) }, optional);
  if (!imported.ok) return imported;
  const recorded = await required.deps.assets.recordProvenance({ context: required.context, provenance: provenance({ status, assetId: imported.value.assetId }) }, optional);
  if (!recorded.ok) return recorded;
  const assetIds = [...new Set([...status.assetIds, imported.value.assetId])];
  return required.deps.repo.save({ context: required.context, status: { ...status, assetIds } }, optional);
}
/** Resolve current server capability admission before URL egress, including verified-output retries.
 * Byte replay stays local. Status must still identify the original intent and provider handle.
 * @complexity O(b + c) validated status, one admitted capability lookup; no submit or reservation.
 */
async function verifyUrlImport(required: { deps: CreativeDependencies; context: CallContext; status: GenerationStatus }, optional?: CallOptions): Promise<Outcome<void>> {
  const observed = await required.deps.generation.status({ context: required.context, generationId: required.status.generationId }, optional);
  if (!observed.ok) return observed;
  const parsed = validateStatus({ status: observed.value });
  if (!parsed.ok) return parsed;
  if (!matchesIntent({ original: required.status, observed: parsed.value })) return failure({ code: "protocol_mismatch", message: "URL import capability changed original intent" });
  if (parsed.value.asyncOperationId !== required.status.asyncOperationId || parsed.value.providerJobId !== required.status.providerJobId) return failure({ code: "conflict", message: "URL import requires the original provider handle" });
  return validateObservation({ ...required, original: required.status, observed: parsed.value });
}
/** Independent verification supplies output without mutating an unknown Jini terminal row. @complexity O(1). */
function completedOutput(required: { status: GenerationStatus }): GenerationOutput | null {
  if (required.status.verifiedCompletion !== undefined) return required.status.verifiedCompletion.output;
  const operation = required.status.operation;
  if (operation?.status !== "succeeded" || operation.result === null) return null;
  return { kind: "bytes", result: operation.result };
}

/** Reconcile a bounded page; an individual projection failure never stalls the cursor.
 * Failed rows retain their evidence and are retried on the next sweep, with correlated diagnostics.
 * @complexity O(k*(c + b)), k <=100 rows, c <=100 costs, b <=16MiB output; no unbounded scan.
 */
export async function reconcilePage(required: { deps: CreativeDependencies; context: CallContext; limit: number; cursor?: string }, optional?: CallOptions): Promise<Outcome<string | null>> {
  const page = await required.deps.repo.list(required, optional);
  if (!page.ok) return page;
  for (const status of page.value.items) {
    if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Reconciliation cancelled" });
    await reconcileGeneration({ deps: required.deps, context: required.context, generationId: status.generationId }, optional);
  }
  return success({ value: page.value.cursor });
}

/** Contain typed and opaque per-row adapter failures; diagnostics cannot block the next row.
 * @complexity One bounded refresh, O(c + b) time/space inherited from projection.
 */
async function reconcileGeneration(required: { deps: CreativeDependencies; context: CallContext; generationId: string }, optional?: CallOptions): Promise<void> {
  let outcome: Outcome<GenerationStatus>;
  try { outcome = await refreshJob(required, optional); }
  catch { outcome = failure({ code: "unavailable", message: "Generation projection unavailable" }); }
  if (outcome.ok) return;
  try {
    required.deps.observer?.observe({ operation: "creative.reconcileGeneration", outcome: outcome.error.code,
      correlationId: required.context.correlationId, traceId: required.context.traceId,
      ...(required.context.runId === undefined ? {} : { runId: required.context.runId }) });
  } catch { /* A diagnostic failure must not starve later generations. */ }
}
