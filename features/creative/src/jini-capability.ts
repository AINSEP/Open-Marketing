import { z } from "zod";
import { generationCostQuoteSchema, moneySchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, ClockPort, Outcome } from "@open-marketing/contracts";
import type { AsyncOperationRecord, AsyncOperationStore, OperationRuntimeDeps, PollDueParams, StartOperationParams, startOperation, pollDueOperations, recoverAfterRestart } from "@jini-ai/integrations/media-providers";
import type { CreativeRepoPort, GenerationCapabilityPort } from "./ports.js";
import type { GenerationRequest, GenerationStatus, GenerationCostObservation } from "./types.js";
import { costSchema, evidenceId, failure, operationSchema, pollRequestSchema, receipt, sameEvidence, scopedKey, success, validContext, validateQuote } from "./rules.js";

/** The plugin supplies public Jini functions; creative performs no runtime import of the vendor catalogue. */
export type JiniGenerationRuntime = { readonly startOperation: typeof startOperation; readonly pollDueOperations: typeof pollDueOperations; readonly recoverAfterRestart: typeof recoverAfterRestart };
/** Generic admitted plugin binding; provider-specific builders, signers and configuration remain in the plugin.
 * store MUST be scoped to the supplied context, including reconcileOnBoot. httpClient MUST be guarded and bounded.
 * Poll signing must recheck server policy/credential admission on every call; polling is read-only.
 */
export type JiniGenerationBinding = {
  readonly pluginDigest: string;
  readonly configurationDigest: string;
  readonly deps: Omit<OperationRuntimeDeps, "clock" | "newId"> & { readonly httpClient: NonNullable<OperationRuntimeDeps["httpClient"]> };
  readonly start: Omit<StartOperationParams<unknown>, "ownerRef" | "maxAttempts" | "deadlineMs">;
  readonly poll: Pick<PollDueParams, "adapters" | "resolveContext">;
  /** Bounded plugin acknowledgment that submit reached transport (or definitively stopped).
   * Jini can return pending before its signer finishes; keep safety's barrier until this acknowledgment.
   */
  readonly awaitHandoff: () => Promise<Outcome<void>>;
};
/** Host callbacks use object signatures; the legacy Jini ABIs are contained and covered by adapter tests. */
export type JiniGenerationHost = {
  readonly quote: (required: { context: CallContext; request: GenerationRequest }) => Promise<Outcome<GenerationStatus["quote"]>>;
  readonly resolve: (required: { context: CallContext; request?: GenerationRequest }) => Promise<Outcome<JiniGenerationBinding>>;
  readonly costs: (required: { context: CallContext; request: GenerationRequest; operation: AsyncOperationRecord }) => Promise<Outcome<{ readonly actualCost: GenerationStatus["actualCost"]; readonly costs: readonly GenerationCostObservation[] }>>;
};
const observedCostsSchema = z.strictObject({ actualCost: moneySchema.nullable(), costs: z.array(costSchema).max(100) });

/** Adapter over the RELEASED durable Jini start/poll/recover algorithms. No second polling engine/outbox.
 * @param required Runtime/host bindings, scoped repo and injected clock; no defaults read globals.
 * @returns Capability usable by a server worker independent of an agent or UI session.
 * @complexity O(k) polling for k <=100; Jini recovery is O(n) in the scoped durable store.
 */
export function createJiniGenerationCapability(required: { runtime: JiniGenerationRuntime; host: JiniGenerationHost; repo: CreativeRepoPort; clock: ClockPort }): GenerationCapabilityPort {
  return {
    async quote(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      return adapterBoundary({ run: async () => {
        const quote = await required.host.quote(input);
        if (!quote.ok) return quote;
        return parseBoundary({ schema: generationCostQuoteSchema, input: quote.value });
      } });
    },
    async generate(input) { return adapterBoundary({ run: () => startGeneration({ ...required, ...input }) }); },
    async status(input) { return adapterBoundary({ run: () => generationStatus({ ...required, ...input }) }); },
    async pollDue(input) {
      const parsed = parseBoundary({ schema: pollRequestSchema, input: input.request });
      if (!parsed.ok) return parsed;
      return adapterBoundary({ run: async () => {
        const binding = await resolveBinding({ ...required, context: input.context });
        if (!binding.ok) return binding;
        const deps = runtimeDeps({ ...required, binding: binding.value, context: input.context });
        const stats = await required.runtime.pollDueOperations({ ...deps, ...binding.value.poll, leaseOwner: parsed.value.leaseOwner, leaseMs: parsed.value.leaseMs }, { limit: parsed.value.limit });
        return success({ value: stats });
      } });
    },
    async recover(input) {
      return adapterBoundary({ run: async () => {
        const binding = await resolveBinding({ ...required, context: input.context });
        if (!binding.ok) return binding;
        const deps = runtimeDeps({ ...required, binding: binding.value, context: input.context, includeSubmitted: true });
        const recovered = await required.runtime.recoverAfterRestart({ ...deps, adapters: binding.value.poll.adapters }, { now: required.clock.now({}) });
        // Idempotency alone is not renewed authority. Never resubmit these IDs automatically.
        return success({ value: recovered });
      } });
    },
    async cancel(input) {
      const original = await required.repo.get(input);
      if (!original.ok) return original;
      // The durable local marker is read by claimDue's filter; no vendor stop/refund is asserted.
      return required.repo.save({ context: input.context, status: { ...original.value, state: "cancelled" } });
    },
  };
}
/** Opaque runtime/host failures are mapped at this adapter edge, retaining unknown dispatch outcomes. */
async function adapterBoundary<T>(required: { run: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.run(); }
  catch { return failure({ code: "unavailable", message: "Generation runtime unavailable; reconcile possible charge", retryable: false }); }
}
async function resolveBinding(required: { host: JiniGenerationHost; context: CallContext; request?: GenerationRequest }): Promise<Outcome<JiniGenerationBinding>> {
  if (!validContext(required)) return failure({ code: "forbidden", message: "Invalid creative scope" });
  const binding = await required.host.resolve({ context: required.context, request: required.request });
  if (!binding.ok) return failure({ code: binding.error.code, message: "Connect or install the admitted generation capability" });
  if (typeof binding.value.deps.httpClient?.send !== "function") return failure({ code: "forbidden", message: "Generation requires the server guarded HTTP client" });
  return binding;
}
async function startGeneration(required: { runtime: JiniGenerationRuntime; host: JiniGenerationHost; repo: CreativeRepoPort; clock: ClockPort; context: CallContext; request: GenerationRequest; quote: GenerationStatus["quote"]; generationId: string }): Promise<Outcome<ReturnType<typeof receipt>>> {
  const original = await required.repo.get(required);
  if (!original.ok) return original;
  if (original.value.state === "cancelled") return failure({ code: "cancelled", message: "Generation is locally cancelled" });
  if (original.value.reservationId === null) return failure({ code: "forbidden", message: "Generation has no durable safety reservation" });
  if (!sameEvidence({ left: original.value.request, right: required.request }) || !sameEvidence({ left: original.value.quote, right: required.quote })) return failure({ code: "conflict", message: "Generation handoff changed original intent" });
  const quote = validateQuote({ ...required, now: required.clock.now({}) });
  if (!quote.ok) return quote;
  const binding = await resolveBinding(required);
  if (!binding.ok) return binding;
  if (binding.value.pluginDigest !== required.quote.pluginDigest || binding.value.configurationDigest !== required.request.configurationDigest) return failure({ code: "conflict", message: "Admitted plugin/configuration changed since quote" });
  if (original.value.asyncOperationId !== null) return failure({ code: "conflict", message: "Generation already handed off; reconcile instead of resubmitting" });
  return submitOperation({ ...required, original: original.value, binding: binding.value });
}
async function submitOperation(required: { runtime: JiniGenerationRuntime; repo: CreativeRepoPort; clock: ClockPort; context: CallContext; request: GenerationRequest; original: GenerationStatus; binding: JiniGenerationBinding }): Promise<Outcome<ReturnType<typeof receipt>>> {
  const ownerRef = scopedKey({ context: required.context, id: required.original.generationId });
  const operationId = evidenceId({ generationId: ownerRef, kind: "async" });
  const deps = runtimeDeps({ ...required, generationId: required.original.generationId });
  const existing = await deps.store.get({ id: operationId });
  if (existing !== null) return failure({ code: "conflict", message: "Async operation already exists; reconcile instead of resubmitting" });
  const saved = await required.repo.save({ context: required.context, status: { ...required.original, asyncOperationId: operationId } });
  if (!saved.ok) return saved;
  const remaining = required.request.deadlineAt - required.clock.now({});
  if (remaining <= 0) return failure({ code: "expired", message: "Generation deadline expired before submit" });
  const { graceMs, ...start } = required.binding.start;
  const started = await required.runtime.startOperation({ ...deps, ...start, ownerRef }, { maxAttempts: required.request.maxAttempts, deadlineMs: remaining, ...(graceMs === undefined ? {} : { graceMs }) });
  const handoff = await required.binding.awaitHandoff();
  if (!handoff.ok) return handoff;
  if (started.operationId !== operationId) return failure({ code: "protocol_mismatch", message: "Runtime did not preserve stable operation identity" });
  const stored = await deps.store.get({ id: operationId });
  return success({ value: { generationId: saved.value.generationId, operationId: saved.value.request.operationId, asyncOperationId: operationId, status: stored?.status === "succeeded" && stored.result !== null ? "succeeded" : "pending" } });
}
async function generationStatus(required: { host: JiniGenerationHost; repo: CreativeRepoPort; context: CallContext; generationId: string }): Promise<Outcome<GenerationStatus>> {
  const original = await required.repo.get(required);
  if (!original.ok) return original;
  if (original.value.dispatchState === "queued") return original;
  const binding = await resolveBinding({ ...required, request: original.value.request });
  if (!binding.ok) return binding;
  const expectedOwner = scopedKey({ context: required.context, id: required.generationId });
  const operationId = original.value.asyncOperationId ?? evidenceId({ generationId: expectedOwner, kind: "async" });
  const stored = await binding.value.deps.store.get({ id: operationId });
  if (stored === null) return success({ value: unknownOperationStatus({ original: original.value }) });
  const parsed = parseBoundary({ schema: operationSchema, input: stored });
  if (!parsed.ok) return parsed;
  if (parsed.value.ownerRef !== expectedOwner || parsed.value.id !== operationId) return failure({ code: "forbidden", message: "Async operation scope mismatch" });
  const costs = await required.host.costs({ context: required.context, request: original.value.request, operation: parsed.value });
  if (!costs.ok) return costs;
  const observed = parseBoundary({ schema: observedCostsSchema, input: costs.value });
  if (!observed.ok) return observed;
  return success({ value: projectOperationStatus({ original: original.value, operation: parsed.value, costs: observed.value }) });
}
/** An absent provider row proves neither no charge nor a refund. @complexity O(1). */
function unknownOperationStatus(required: { original: GenerationStatus }): GenerationStatus {
  return { ...required.original, state: required.original.state === "cancelled" ? "cancelled" : "unknown" };
}
/** Preserve local cancellation and original evidence while translating a validated Jini observation. @complexity O(1). */
function projectOperationStatus(required: { original: GenerationStatus; operation: ReturnType<typeof operationSchema.parse>; costs: { actualCost: GenerationStatus["actualCost"]; costs: readonly GenerationCostObservation[] } }): GenerationStatus {
  return { ...required.original, operation: required.operation, asyncOperationId: required.operation.id, providerJobId: required.operation.state?.jobId ?? null,
    state: required.original.state === "cancelled" ? "cancelled" : operationState({ operation: required.operation }), actualCost: required.costs.actualCost, costs: required.costs.costs };
}
/** Jini transport failure/attempt exhaustion is not proof of no vendor effect. @complexity O(1). */
function operationState(required: { operation: AsyncOperationRecord }): GenerationStatus["state"] {
  switch (required.operation.status) {
    case "submitted": return "pending";
    case "polling": return "running";
    case "succeeded": return "succeeded";
    case "unknown": return "unknown";
    case "failed":
      if (required.operation.error?.code === undefined) return "unknown";
      if (["ATTEMPTS_EXHAUSTED", "NO_ADAPTER"].includes(required.operation.error.code)) return "unknown";
      return "failed";
    default: { const impossible: never = required.operation.status; throw new Error("Unsupported operation status: " + impossible); }
  }
}
function runtimeDeps(required: { binding: JiniGenerationBinding; clock: ClockPort; repo: CreativeRepoPort; context: CallContext; generationId?: string; includeSubmitted?: boolean }): OperationRuntimeDeps {
  const identity = scopedKey({ context: required.context, id: required.generationId ?? "worker" });
  return { ...required.binding.deps, store: localSchedulingStore({ store: required.binding.deps.store, repo: required.repo, context: required.context, includeSubmitted: required.includeSubmitted }),
    clock: () => required.clock.now({}), newId: () => evidenceId({ generationId: identity, kind: "async" }) };
}
/** Foreign AsyncOperationStore ABI is intentionally preserved only in this narrow wrapper.
 * Local cancellation filters leased rows before Jini can build/sign/fetch a poll request.
 * @complexity O(k) repository reads for k claimed operations; store scoping belongs to host.
 */
function localSchedulingStore(required: { store: AsyncOperationStore; repo: CreativeRepoPort; context: CallContext; includeSubmitted?: boolean }): AsyncOperationStore {
  return {
    create: required.store.create.bind(required.store), get: required.store.get.bind(required.store),
    update: required.store.update.bind(required.store), listByOwner: required.store.listByOwner.bind(required.store),
    releaseLease: required.store.releaseLease.bind(required.store), reconcileOnBoot: required.store.reconcileOnBoot.bind(required.store),
    async claimDue(input, options) {
      const claimed = await required.store.claimDue(input, options);
      const rows: AsyncOperationRecord[] = [];
      for (const row of claimed) {
        const disposition = await localPollDisposition({ ...required, row });
        if (disposition === "poll") rows.push(row);
        else await suppressLocalClaim({ store: required.store, row, leaseOwner: input.leaseOwner, disposition });
      }
      return rows;
    },
  };
}
/** Cancelled rows are deferred rather than marked refunded/failed; otherwise they can starve due work.
 * Lease fencing keeps a stale cancellation filter from changing a newer worker's schedule. @complexity O(1) store calls.
 */
async function suppressLocalClaim(required: { store: AsyncOperationStore; row: AsyncOperationRecord; leaseOwner: string; disposition: "stop" | "skip" }): Promise<void> {
  if (required.disposition === "stop") await required.store.update({ id: required.row.id, patch: { nextPollAt: Number.MAX_SAFE_INTEGER } }, { options: { leaseOwner: required.leaseOwner } });
  await required.store.releaseLease({ id: required.row.id, leaseOwner: required.leaseOwner });
}
/** Decide local scheduling from validated ownership and the durable marker; performs no vendor call. @complexity O(1) repo reads. */
async function localPollDisposition(required: { repo: CreativeRepoPort; context: CallContext; row: AsyncOperationRecord; includeSubmitted?: boolean }): Promise<"poll" | "stop" | "skip"> {
  const parsed = operationSchema.safeParse(required.row);
  if (!parsed.success) return "skip";
  let owner: unknown;
  try { owner = JSON.parse(parsed.data.ownerRef); }
  catch { return "skip"; }
  const scopedOwner = z.tuple([z.string(), z.string(), z.string()]).safeParse(owner);
  if (!scopedOwner.success) return "skip";
  const expected = scopedKey({ context: required.context, id: scopedOwner.data[2] });
  if (expected !== parsed.data.ownerRef) return "skip";
  const status = await required.repo.get({ context: required.context, generationId: scopedOwner.data[2] });
  if (!status.ok) return "skip";
  if (status.value.state === "cancelled") return "stop";
  // A submit still in flight or left in a crash gap has no poll handle. Recovery may inspect it.
  if (parsed.data.status === "submitted" && required.includeSubmitted !== true) return "skip";
  return "poll";
}
