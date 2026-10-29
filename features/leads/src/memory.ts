import type { CallContext, Page } from "@open-marketing/contracts";
import type { LeadsRepoPort } from "./ports.js";
import { appendSchema, checkAppend, checkCapture, failure, getSchema, historySchema, listSchema, parseInput, purgeSchema, repoCaptureSchema } from "./schemas.js";
import type { Lead, LeadStageEvent } from "./schemas.js";

/** Instance-owned reference adapter; synchronous mutation is atomic before the promise yields.
 * Reads/capture/purge scan O(n) stored rows; inbox sorting O(n log n), responses <=100.
 * Outputs are detached. No runtime registry or service lifecycle.
 * @example const repo = createMemoryLeadsRepo({}); */
export function createMemoryLeadsRepo(_required: Record<string, never>): LeadsRepoPort {
  const leads = new Map<string, Lead>();
  const events = new Map<string, LeadStageEvent>();
  return {
    async capture(input, options) {
      const parsed = parseInput({ schema: repoCaptureSchema, input }, options);
      if (!parsed.ok) return parsed;
      const { context, lead, event } = parsed.value;
      const existing = [...leads.values()].find(item => sameScope({ context, value: item }) && item.source.kind === lead.source.kind && item.source.ref === lead.source.ref) ?? null;
      const checked = checkCapture({ input: parsed.value, existing });
      if (!checked.ok) return checked;
      if (existing) return { ok: true, value: structuredClone(existing) };
      if (leads.has(key({ context, id: lead.leadId })) || events.has(key({ context, id: event.eventId }))) return failure({ code: "conflict" });
      leads.set(key({ context, id: lead.leadId }), lead);
      events.set(key({ context, id: event.eventId }), event);
      return { ok: true, value: structuredClone(lead) };
    },
    async appendStage(input, options) {
      const parsed = parseInput({ schema: appendSchema, input }, options);
      if (!parsed.ok) return parsed;
      const value = parsed.value;
      const current = leads.get(key({ context: value.context, id: value.leadId })) ?? null;
      const previous = events.get(key({ context: value.context, id: value.event.eventId })) ?? null;
      const checked = checkAppend({ input: value, current, previous });
      if (!checked.ok) return checked;
      if (!previous) {
        leads.set(key({ context: value.context, id: value.leadId }), checked.value);
        events.set(key({ context: value.context, id: value.event.eventId }), value.event);
      }
      return { ok: true, value: structuredClone(checked.value) };
    },
    async get(input, options) {
      const parsed = parseInput({ schema: getSchema, input }, options);
      if (!parsed.ok) return parsed;
      return { ok: true, value: structuredClone(leads.get(key({ context: parsed.value.context, id: parsed.value.leadId })) ?? null) };
    },
    async list(input, options) {
      const parsed = parseInput({ schema: listSchema, input }, options);
      if (!parsed.ok) return parsed;
      const { context, query } = parsed.value;
      const rows = [...leads.values()].filter(lead => sameScope({ context, value: lead }) && (!query.stage || lead.stage === query.stage) && lead.leadId > (query.page.cursor ?? ""));
      rows.sort((left, right) => left.leadId < right.leadId ? -1 : 1);
      return { ok: true, value: page({ rows, limit: query.page.limit, cursors: rows.map(lead => lead.leadId) }) };
    },
    async history(input, options) {
      const parsed = parseInput({ schema: historySchema, input }, options);
      if (!parsed.ok) return parsed;
      const { context, leadId, page: query } = parsed.value;
      const rows = [...events.values()].filter(event => sameScope({ context, value: event }) && event.leadId === leadId && event.revision > Number(query.cursor ?? 0));
      rows.sort((left, right) => left.revision - right.revision);
      return { ok: true, value: page({ rows, limit: query.limit, cursors: rows.map(event => String(event.revision)) }) };
    },
    async purgeSubject(input, options) {
      const parsed = parseInput({ schema: purgeSchema, input }, options);
      if (!parsed.ok) return parsed;
      for (const [id, lead] of leads) {
        if (sameScope({ context: parsed.value.context, value: lead }) && lead.subjectId === parsed.value.subjectId) leads.set(id, { ...lead, subjectId: null, erased: true });
      }
      return { ok: true, value: undefined };
    },
  };
}
/** Tuple encoding avoids ambiguous scope/ID concatenation. */
function key(required: { context: CallContext; id: string }): string { return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId, required.id]); }
function sameScope(required: { context: CallContext; value: { scope: CallContext["scope"] } }): boolean { return required.context.scope.ownerId === required.value.scope.ownerId && required.context.scope.workspaceId === required.value.scope.workspaceId; }
/** Copy a bounded page; only emit a cursor when another row exists. */
function page<T>(required: { rows: T[]; limit: number; cursors: string[] }): Page<T> { return { items: structuredClone(required.rows.slice(0, required.limit)), cursor: required.rows.length > required.limit ? required.cursors[required.limit - 1] : null }; }
