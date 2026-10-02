import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { CreativeRepoPort } from "./ports.js";
import type { GenerationStatus, GenerationCostObservation } from "./types.js";
import { failure, scopedKey, success, validContext } from "./rules.js";
import { validateCostLink, validateReplacement, validateStatus } from "./repository-rules.js";

/** Test-only shared state permits restarting a service without losing the reference records. */
export type MemoryCreativeRepoState = { readonly statuses: Map<string, GenerationStatus>; readonly costs: Map<string, GenerationCostObservation> };
/** Inspectable double; snapshots are copies and cannot mutate stored evidence. */
export interface MemoryCreativeRepo extends CreativeRepoPort {
  costObservations(required: { context: CallContext; generationId: string }): readonly GenerationCostObservation[];
}
/** Reference scoped repository. Atomic claims execute synchronously before returning their promise.
 * @param required Optional shared state for restart tests; no production persistence claim.
 * @returns Repository with immutable intent, CAS and deduplicated append-only costs.
 * @complexity O(1) keyed mutations; O(n log n) list, n <=10000 records.
 */
export function createMemoryCreativeRepo(required: { state?: MemoryCreativeRepoState }): MemoryCreativeRepo {
  const state = required.state ?? { statuses: new Map(), costs: new Map() };
  return {
    async save(input) { return saveMemory({ state, ...input }); },
    async get(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const status = state.statuses.get(scopedKey({ context: input.context, id: input.generationId }));
      if (status === undefined) return failure({ code: "unavailable", message: "Generation not found" });
      return success({ value: structuredClone(status) });
    },
    async claimDispatch(input) { return claimMemory({ state, ...input }); },
    async list(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) return failure({ code: "invalid_input", message: "Invalid generation page limit" });
      const prefix = scopedKey({ context: input.context, id: "" }).slice(0, -3);
      const items = [...state.statuses.entries()].filter(([key]) => key.startsWith(prefix)).map(([, status]) => status).sort((left, right) => compareGeneration({ left, right }));
      const page = items.filter(status => input.cursor === undefined || status.generationId > input.cursor).slice(0, input.limit + 1);
      const selected = page.slice(0, input.limit);
      return success({ value: { items: structuredClone(selected), cursor: page.length > input.limit ? selected[selected.length - 1].generationId : null } });
    },
    async appendCost(input) { return appendMemoryCost({ state, ...input }); },
    costObservations(input) {
      const prefix = scopedKey({ context: input.context, id: "" }).slice(0, -3);
      return structuredClone([...state.costs.entries()].filter(([key, cost]) => key.startsWith(prefix) && cost.generationId === input.generationId).map(([, cost]) => cost));
    },
  };
}
/** Foreign Array.sort ABI is isolated here; shared tests assert lexical pagination. */
function compareGeneration(required: { left: GenerationStatus; right: GenerationStatus }): number {
  if (required.left.generationId < required.right.generationId) return -1;
  if (required.left.generationId > required.right.generationId) return 1;
  return 0;
}
function saveMemory(required: { state: MemoryCreativeRepoState; context: CallContext; status: GenerationStatus; expectedRevision?: number }): Outcome<GenerationStatus> {
  if (!validContext(required)) return failure({ code: "forbidden", message: "Invalid creative scope" });
  const parsed = validateStatus(required);
  if (!parsed.ok) return parsed;
  const key = scopedKey({ context: required.context, id: parsed.value.generationId });
  const previous = required.state.statuses.get(key);
  if (previous === undefined) return insertMemory({ ...required, key, status: parsed.value });
  const valid = validateReplacement({ previous, next: parsed.value, expectedRevision: required.expectedRevision ?? parsed.value.revision });
  if (!valid.ok) return valid;
  const status = { ...parsed.value, revision: previous.revision + 1 };
  required.state.statuses.set(key, structuredClone(status));
  return success({ value: structuredClone(status) });
}
function insertMemory(required: { state: MemoryCreativeRepoState; key: string; status: GenerationStatus; expectedRevision?: number }): Outcome<GenerationStatus> {
  if (required.expectedRevision !== undefined && required.expectedRevision !== -1) return failure({ code: "conflict", message: "Generation does not exist at expected revision" });
  if (required.state.statuses.size >= 10000) return failure({ code: "limit_exceeded", message: "Memory generation capacity reached" });
  const status = { ...required.status, revision: 0 };
  required.state.statuses.set(required.key, structuredClone(status));
  return success({ value: structuredClone(status) });
}
function claimMemory(required: { state: MemoryCreativeRepoState; context: CallContext; generationId: string }): Outcome<{ claimed: boolean; status: GenerationStatus }> {
  if (!validContext(required)) return failure({ code: "forbidden", message: "Invalid creative scope" });
  const key = scopedKey({ context: required.context, id: required.generationId });
  const current = required.state.statuses.get(key);
  if (current === undefined) return failure({ code: "unavailable", message: "Generation not found" });
  if (current.dispatchState !== "queued" || current.state === "cancelled") return success({ value: { claimed: false, status: structuredClone(current) } });
  const status: GenerationStatus = { ...current, dispatchState: "dispatching", revision: current.revision + 1 };
  required.state.statuses.set(key, status);
  return success({ value: { claimed: true, status: structuredClone(status) } });
}
function appendMemoryCost(required: { state: MemoryCreativeRepoState; context: CallContext; cost: GenerationCostObservation }): Outcome<void> {
  if (!validContext(required)) return failure({ code: "forbidden", message: "Invalid creative scope" });
  const status = required.state.statuses.get(scopedKey({ context: required.context, id: required.cost.generationId }));
  if (status === undefined) return failure({ code: "unavailable", message: "Generation not found" });
  const key = scopedKey({ context: required.context, id: required.cost.observationId });
  const correction = required.state.costs.get(scopedKey({ context: required.context, id: required.cost.correctionOf ?? "" }));
  const linked = validateCostLink({ cost: required.cost, status, previous: required.state.costs.get(key), correction });
  if (!linked.ok) return linked;
  required.state.costs.set(key, structuredClone(required.cost));
  return success({ value: undefined });
}
