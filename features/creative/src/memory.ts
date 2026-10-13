import { createHash } from "node:crypto";
import { generationCostQuoteSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, GenerationApprovalRequirement, GenerationCostQuote, Outcome } from "@open-marketing/contracts";
import type { CreativeAssetPort, CreativeAuditPort, CreativeJobPort, CreativeObserverPort, CreativeRepoPort, CreativeSpendPort, GenerationCapabilityPort } from "./ports.js";
import type { GenerationCostObservation, GenerationProvenance, GenerationStatus } from "./types.js";
import { costSchema, evidenceId, failure, freezeValue, generationOutputSchema, pollRequestSchema, provenanceSchema, receipt, sameEvidence, scopedKey, success, validContext } from "./rules.js";
import { validateStatus } from "./repository-rules.js";
export { createMemoryCreativeRepo } from "./memory-repo.js";
export type { MemoryCreativeRepo, MemoryCreativeRepoState } from "./memory-repo.js";

/** Scripted capability double; tests control provider observations without rebuilding Jini's polling algorithm. */
export interface MemoryGenerationCapability extends GenerationCapabilityPort {
  setStatus(required: { context: CallContext; status: GenerationStatus }): void;
  readonly calls: { readonly context: CallContext; readonly operation: string }[];
}
/** No vendor effect. Quote/status fixtures are scoped; absent capability returns a useful connect/install error.
 * @complexity O(1) keyed scripted operations, O(n) fixture cloning.
 */
export function createMemoryGenerationCapability(required: { repo?: CreativeRepoPort; quote?: GenerationCostQuote; statuses?: Map<string, GenerationStatus> }): MemoryGenerationCapability {
  const statuses = required.statuses ?? new Map<string, GenerationStatus>();
  const calls: { context: CallContext; operation: string }[] = [];
  return {
    calls,
    setStatus(input) { statuses.set(scopedKey({ context: input.context, id: input.status.generationId }), structuredClone(input.status)); },
    async quote(input) {
      calls.push({ context: input.context, operation: "quote" });
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      if (required.quote === undefined) return failure({ code: "unavailable", message: "Connect or install a generation capability" });
      return parseBoundary({ schema: generationCostQuoteSchema, input: structuredClone(required.quote) });
    },
    async generate(input) {
      calls.push({ context: input.context, operation: "generate" });
      if (required.repo === undefined) return failure({ code: "unavailable", message: "Generation double requires a repository" });
      const intent = await required.repo.get(input);
      if (!intent.ok) return intent;
      if (intent.value.state === "cancelled") return failure({ code: "cancelled", message: "Generation is locally cancelled" });
      if (intent.value.reservationId === null) return failure({ code: "forbidden", message: "Generation has no durable safety reservation" });
      if (!sameEvidence({ left: intent.value.request, right: input.request }) || !sameEvidence({ left: intent.value.quote, right: input.quote })) return failure({ code: "conflict", message: "Dispatch changed original intent" });
      if (intent.value.asyncOperationId !== null) return failure({ code: "conflict", message: "Generation already handed off; reconcile instead of resubmitting" });
      const asyncOperationId = evidenceId({ generationId: scopedKey({ context: input.context, id: input.generationId }), kind: "async" });
      const saved = await required.repo.save({ context: input.context, status: { ...intent.value, asyncOperationId } });
      if (!saved.ok) return saved;
      const status = statuses.get(scopedKey({ context: input.context, id: input.generationId })) ?? saved.value;
      return success({ value: { ...receipt({ status }), asyncOperationId } });
    },
    async status(input) {
      calls.push({ context: input.context, operation: "status" });
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const status = statuses.get(scopedKey({ context: input.context, id: input.generationId }));
      if (status !== undefined) return validateStatus({ status: structuredClone(status) });
      if (required.repo === undefined) return failure({ code: "unavailable", message: "Generation not found" });
      return required.repo.get(input);
    },
    async pollDue(input) {
      calls.push({ context: input.context, operation: "pollDue" });
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const parsed = parseBoundary({ schema: pollRequestSchema, input: input.request });
      if (!parsed.ok) return parsed;
      return success({ value: { claimed: 0, completed: 0, failed: 0, pending: 0, unknown: 0 } });
    },
    async recover(input) {
      calls.push({ context: input.context, operation: "recover" });
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      return success({ value: { leasesReleased: 0, deadlineExpired: 0, unknownCrashGap: 0, resubmittable: [] } });
    },
    async cancel(input) {
      calls.push({ context: input.context, operation: "cancel" });
      if (required.repo === undefined) return failure({ code: "unavailable", message: "Generation not found" });
      const status = await required.repo.get(input);
      if (!status.ok) return status;
      return success({ value: { ...status.value, state: "cancelled" } });
    },
  };
}

/** Inspectable media double; data is cloned before storage and returns stable asset identities. */
export interface MemoryCreativeAsset extends CreativeAssetPort {
  readonly imports: Map<string, { readonly assetId: string; readonly digest: string }>;
  readonly provenance: Map<string, GenerationProvenance>;
  readonly costs: Map<string, GenerationCostObservation>;
}
/** Deduplicates import by scoped generation and cost by observation identity. Does not fetch URLs.
 * @complexity O(n) bounded output hashing, O(1) map operations.
 */
export function createMemoryCreativeAsset(required: Record<string, never>): MemoryCreativeAsset {
  const imports = new Map<string, { assetId: string; digest: string }>();
  const provenance = new Map<string, GenerationProvenance>();
  const costs = new Map<string, GenerationCostObservation>();
  return {
    imports, provenance, costs,
    async import(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const output = parseBoundary({ schema: generationOutputSchema, input: input.output });
      if (!output.ok) return output;
      const evidence = parseBoundary({ schema: provenanceSchema, input: input.provenance });
      if (!evidence.ok) return evidence;
      if (evidence.value.generationId !== input.generationId || evidence.value.operationId !== input.operationId) return failure({ code: "conflict", message: "Media provenance does not bind generation" });
      const key = scopedKey({ context: input.context, id: input.generationId });
      const digest = createHash("sha256").update(JSON.stringify(output.value)).digest("hex");
      const existing = imports.get(key);
      if (existing !== undefined && existing.digest !== digest) return failure({ code: "conflict", message: "Generation already imported different output" });
      const assetId = evidenceId({ generationId: key, kind: "asset" });
      imports.set(key, { assetId, digest });
      return success({ value: { assetId } });
    },
    async recordProvenance(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const parsed = parseBoundary({ schema: provenanceSchema, input: input.provenance });
      if (!parsed.ok) return parsed;
      const key = scopedKey({ context: input.context, id: evidenceId({ generationId: parsed.value.generationId, kind: parsed.value.assetId ?? "pending" }) });
      return appendEvidence({ map: provenance, key, value: parsed.value });
    },
    async recordCost(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const parsed = parseBoundary({ schema: costSchema, input: input.cost });
      if (!parsed.ok) return parsed;
      return appendEvidence({ map: costs, key: scopedKey({ context: input.context, id: input.cost.observationId }), value: parsed.value });
    },
  };
}
function appendEvidence<T>(required: { map: Map<string, T>; key: string; value: T }): Outcome<void> {
  const previous = required.map.get(required.key);
  if (previous !== undefined && !sameEvidence({ left: previous, right: required.value })) return failure({ code: "conflict", message: "Evidence identity is immutable" });
  required.map.set(required.key, structuredClone(required.value));
  return success({ value: undefined });
}

/** Test-only job double requires its repository; production uses the single transactional jobs outbox. */
export interface MemoryCreativeJob extends CreativeJobPort { readonly jobs: Map<string, { readonly jobId: string; readonly argumentsDigest: string }> }
/** Commits intent before returning a stable job ID. Scripted enqueue failure leaves no intent.
 * @complexity O(n) bounded intent comparison/cloning; keyed deduplication.
 */
export function createMemoryCreativeJob(required: { repo?: CreativeRepoPort; reject?: boolean }): MemoryCreativeJob {
  const jobs = new Map<string, { jobId: string; argumentsDigest: string }>();
  return {
    jobs,
    async enqueue(input) {
      if (required.reject) return failure({ code: "unavailable", message: "Scripted outbox failure" });
      if (required.repo === undefined) return failure({ code: "unavailable", message: "Job double requires a repository" });
      if (input.operationId !== input.intent.request.operationId || input.argumentsDigest !== input.intent.request.argumentsDigest) return failure({ code: "conflict", message: "Outbox identity does not bind intent" });
      const existing = await required.repo.get({ context: input.context, generationId: input.intent.generationId });
      if (existing.ok) return duplicateJob({ previous: existing.value, next: input.intent, context: input.context });
      if (existing.error.code !== "unavailable") return existing;
      const saved = await required.repo.save({ context: input.context, status: input.intent, expectedRevision: -1 });
      if (!saved.ok) return concurrentJob({ repo: required.repo, context: input.context, intent: input.intent, outcome: saved });
      const key = scopedKey({ context: input.context, id: input.operationId });
      const jobId = evidenceId({ generationId: key, kind: "job" });
      jobs.set(key, { jobId, argumentsDigest: input.argumentsDigest });
      return success({ value: { jobId } });
    },
  };
}
/** A concurrent enqueue winner is reused only when its original arguments match. @complexity O(n), bounded intent. */
async function concurrentJob(required: { repo: CreativeRepoPort; context: CallContext; intent: GenerationStatus; outcome: Extract<Outcome<GenerationStatus>, { ok: false }> }): Promise<Outcome<{ jobId: string }>> {
  if (required.outcome.error.code !== "conflict") return required.outcome;
  const winner = await required.repo.get({ context: required.context, generationId: required.intent.generationId });
  if (!winner.ok) return winner;
  return duplicateJob({ previous: winner.value, next: required.intent, context: required.context });
}
function duplicateJob(required: { previous: GenerationStatus; next: GenerationStatus; context: CallContext }): Outcome<{ jobId: string }> {
  if (!sameEvidence({ left: required.previous.request, right: required.next.request })) return failure({ code: "conflict", message: "Operation already binds different arguments" });
  return success({ value: { jobId: evidenceId({ generationId: scopedKey({ context: required.context, id: required.previous.generationId }), kind: "job" }) } });
}

/** Scripted authority double; no allowance arithmetic is duplicated in creative. */
export interface MemoryCreativeSpend extends CreativeSpendPort { readonly reservations: Map<string, string>; readonly settlements: Map<string, GenerationCostObservation> }
/** Assessment kind and final dispatch permission are separate fixtures; assessment alone never permits dispatch.
 * @complexity O(1) keyed authority and settlement; callback cost belongs to caller.
 */
export function createMemoryCreativeSpend(required: { kind?: GenerationApprovalRequirement["kind"]; dispatchAllowed?: boolean }): MemoryCreativeSpend {
  const reservations = new Map<string, string>();
  const settlements = new Map<string, GenerationCostObservation>();
  return {
    reservations, settlements,
    async assess(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      return success({ value: { kind: required.kind ?? "normal_write", reason: "scripted safety assessment", quoteId: input.quote.quoteId, allowanceRevision: 0, dispatchDay: "2026-10-02" } });
    },
    async withDispatch(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      if (required.dispatchAllowed === false || required.kind === "denied") return failure({ code: "forbidden", message: "Scripted dispatch authority denied" });
      const key = scopedKey({ context: input.context, id: input.request.operationId });
      const reservationId = evidenceId({ generationId: key, kind: "reservation" });
      reservations.set(key, reservationId);
      return input.dispatch(freezeValue({ value: { reservationId } }));
    },
    async settle(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const key = scopedKey({ context: input.context, id: input.cost.operationId });
      if (reservations.get(key) !== input.reservationId) return failure({ code: "conflict", message: "Unknown generation reservation" });
      const parsed = parseBoundary({ schema: costSchema, input: input.cost });
      if (!parsed.ok) return parsed;
      return appendEvidence({ map: settlements, key: scopedKey({ context: input.context, id: input.cost.observationId }), value: input.cost });
    },
  };
}

/** Inspectable audit double; appends without rewriting prior events. */
export interface MemoryCreativeAudit extends CreativeAuditPort { readonly events: { readonly context: CallContext; readonly operationId: string; readonly outcome: string }[] }
/** Append-only trace evidence for deterministic tests. @complexity O(1) bounded event cloning. */
export function createMemoryCreativeAudit(required: Record<string, never>): MemoryCreativeAudit {
  const events: MemoryCreativeAudit["events"] = [];
  return { events, async record(input) { events.push(structuredClone(input)); return success({ value: undefined }); } };
}
/** Passive observation double with no runtime singleton. @complexity O(1) append. */
export function createMemoryCreativeObserver(required: Record<string, never>): CreativeObserverPort & { readonly events: Parameters<CreativeObserverPort["observe"]>[0][] } {
  const events: Parameters<CreativeObserverPort["observe"]>[0][] = [];
  return { events, observe(input) { events.push(structuredClone(input)); } };
}
