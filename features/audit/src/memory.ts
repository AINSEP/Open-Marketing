import type { CallContext, ClockPort, IdPort, ObserverEvent, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { AuditRepoPort, AuditRedactorPort } from "./ports.js";
import type { AuditEntry, AuditPage, AuditQuery, AuditReceipt } from "./types.js";
import { allocateReceipt, correctionAllowed, scopeKey } from "./repository-rules.js";
import { failure, validateAppend, validateList } from "./validation.js";
import { withholdReferences } from "./redactor.js";
import { observe } from "./observation.js";

type MemoryRow = { entry: AuditEntry; receipt: AuditReceipt; context: CallContext };
type MemoryScope = { rows: MemoryRow[]; byId: Map<string, MemoryRow> };

/** Instance-local double with no persistence claim. IDs and time are always injected.
 * Test capacity defaults to 10,000 entries; reaching it fails without deleting history.
 * @example createMemoryAuditRepo({ clock, ids }, { maxEntries: 1000 });
 * @complexity O(1) append, O(n) list for n <=maxEntries; O(n*r) retained evidence.
 */
export function createMemoryAuditRepo(required: { clock: ClockPort; ids: IdPort }, optional?: {
  observer?: ObserverPort; maxEntries?: number;
}): AuditRepoPort {
  const scopes = new Map<string, MemoryScope>();
  const allocatedIds = new Set<string>();
  const maxEntries = optional?.maxEntries ?? 10_000;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new TypeError("Invalid audit test capacity");
  return {
    async append(input, options) {
      const parsed = validateAppend({ input }, options);
      if (!parsed.ok) return parsed;
      try {
        const result = memoryAppend({ ...required, ...parsed.value, scopes, allocatedIds, maxEntries });
        observe({ observer: optional?.observer, context: parsed.value.context, operation: "audit.memory.append", outcome: result });
        return result;
      } catch { return failure({ code: "unavailable" }); }
    },
    async list(input, options) {
      const parsed = validateList({ input }, options);
      if (!parsed.ok) return parsed;
      const result = memoryList({ ...parsed.value, scopes });
      observe({ observer: optional?.observer, context: parsed.value.context, operation: "audit.memory.list", outcome: result });
      return result;
    },
  };
}

/** Mutate only after every guard passes; cloned snapshots cannot be changed by a caller.
 * @complexity O(r) snapshot, O(1) indexed correction/ID checks.
 */
function memoryAppend(required: {
  context: CallContext; entry: AuditEntry; clock: ClockPort; ids: IdPort;
  scopes: Map<string, MemoryScope>; allocatedIds: Set<string>; maxEntries: number;
}): Outcome<AuditReceipt> {
  const key = scopeKey(required);
  const scope = required.scopes.get(key) ?? { rows: [], byId: new Map<string, MemoryRow>() };
  const target = scope.byId.get(required.entry.correctionOf ?? "");
  if (!correctionAllowed({ entry: required.entry, target: target?.entry })) return failure({ code: "invalid_input" });
  if (required.allocatedIds.size >= required.maxEntries) return failure({ code: "limit_exceeded" });
  const receipt = allocateReceipt(required);
  if (!receipt.ok) return receipt;
  if (required.allocatedIds.has(receipt.value.entryId)) return failure({ code: "conflict" });
  const row = structuredClone({ entry: required.entry, receipt: receipt.value, context: required.context });
  scope.rows.push(row);
  scope.byId.set(row.receipt.entryId, row);
  required.allocatedIds.add(row.receipt.entryId);
  required.scopes.set(key, scope);
  return { ok: true, value: structuredClone(row.receipt) };
}

/** A cursor must belong to both the scope and operation filter; invalid cursors never restart a scan.
 * @complexity O(n), O(p*r) output, p <=100.
 */
function memoryList(required: { context: CallContext; query: AuditQuery; scopes: Map<string, MemoryScope> }): Outcome<AuditPage> {
  const scope = required.scopes.get(scopeKey(required));
  const rows = (scope?.rows ?? []).filter(row => required.query.operationId === undefined || row.entry.operationId === required.query.operationId);
  let start = 0;
  if (required.query.cursor !== undefined) {
    const index = rows.findIndex(row => row.receipt.entryId === required.query.cursor);
    if (index < 0) return failure({ code: "invalid_input" });
    start = index + 1;
  }
  const selected = rows.slice(start, start + required.query.limit);
  const cursor = start + selected.length < rows.length ? selected[selected.length - 1].receipt.entryId : null;
  return { ok: true, value: structuredClone({ items: selected.map(row => row.entry), cursor }) };
}

/** Local conservative double: withhold references, preserve lineage. No secret-detector claim.
 * @example createMemoryAuditRedactor({}); @complexity O(r), r <=64.
 */
export function createMemoryAuditRedactor(required: Record<string, never>): AuditRedactorPort {
  return { async redact(input, optional) { return withholdReferences(input, optional); } };
}

/** Captured diagnostics are cloned; bounded test history fails loudly rather than growing indefinitely.
 * @example const observer = createMemoryAuditObserver({}); observer.events({});
 * @complexity O(1) observe, O(n) snapshot, n <=10,000.
 */
export function createMemoryAuditObserver(required: Record<string, never>): ObserverPort & {
  events(required: Record<string, never>): readonly ObserverEvent[];
} {
  const events: ObserverEvent[] = [];
  return {
    observe(event) {
      if (events.length >= 10_000) throw new RangeError("Audit observer test capacity reached");
      events.push(structuredClone(event));
    },
    events() { return structuredClone(events); },
  };
}
