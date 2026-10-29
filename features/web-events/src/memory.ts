import { digestSchema, epochSchema } from "@open-marketing/contracts";
import type { CallContext, ClockPort, Outcome } from "@open-marketing/contracts";
import type { WebEventRepoPort } from "./ports.js";
import type { AttributionTouch, Visit, WebEvent } from "./types.js";
import { bindVisit, boundary, checkVisitReplay, failure, replayDigest, storedEvent, validateBinding, validateContext, validateRead, validateRecord, validateSubject, validateVisit } from "./rules.js";

type Record = { event: WebEvent; touch: AttributionTouch; digest: string };
/** Instance-owned double; synchronous state changes are atomic and output is cloned.
 * @complexity Appends O(e), visit uniqueness O(v), reads O(e log e); instance records e/v.
 * @example createMemoryWebEventRepo({ clock }).saveVisit({ context, visit })
 */
export function createMemoryWebEventRepo(required: { clock: ClockPort }): WebEventRepoPort {
  const records = new Map<string, Record>();
  const visits = new Map<string, Visit>();
  const cursors = new Map<string, number>();
  return {
    async lastHeartbeat(input, options) {
      const invalid = validateContext({ context: input.context, options });
      if (invalid) return invalid;
      if (!digestSchema.safeParse(input.destinationId).success) return failure({ code: "invalid_input" });
      const receipts = scopedRecords({ records, context: input.context }).filter(record => record.event.properties.destinationId === input.destinationId).map(record => record.event.receivedAt);
      return { ok: true, value: receipts.reduce<number | null>((latest, receipt) => latest === null ? receipt : Math.max(latest, receipt), null) };
    },
    async recordTouch(input, options) {
      const invalid = validateRecord({ ...input, options });
      if (invalid) return invalid;
      return boundary({ options, work: async () => {
        const key = scopedKey({ context: input.context, id: input.event.eventId });
        const digest = replayDigest(input);
        const existing = records.get(key);
        if (existing) return existing.digest === digest ? { ok: true, value: structuredClone(existing.touch) } : failure({ code: "conflict" });
        return appendRecord({ records, cursors, ...input, clock: required.clock, digest, key });
      } });
    },
    async saveVisit(input, options) {
      const invalidContext = validateContext({ context: input.context, options });
      if (invalidContext) return invalidContext;
      return boundary({ options, work: async () => {
        const invalid = validateVisit({ ...input, now: required.clock.now({}), options });
        if (invalid) return invalid;
        const key = scopedKey({ context: input.context, id: input.visit.visitId });
        const existing = visits.get(key);
        if (existing) return checkVisitReplay({ existing, visit: input.visit });
        if (input.visit.subjectId !== null || anonymousExists({ visits, context: input.context, anonymousId: input.visit.anonymousId })) return failure({ code: "conflict" });
        visits.set(key, structuredClone(input.visit));
        return { ok: true, value: structuredClone(input.visit) };
      } });
    },
    async bindVisitor(input, options) {
      const invalid = validateBinding({ ...input, options });
      if (invalid) return invalid;
      return boundary({ options, work: async () => {
        const key = scopedKey({ context: input.context, id: input.visitId });
        const result = bindVisit({ visit: visits.get(key), subjectId: input.subjectId, now: required.clock.now({}) });
        if (!result.ok) return result;
        visits.set(key, structuredClone(result.value));
        return { ok: true, value: structuredClone(result.value) };
      } });
    },
    async touchesFor(input, options) {
      const invalid = validateRead({ ...input, options });
      if (invalid) return invalid;
      const anonymousIds = boundAnonymousIds({ visits, ...input });
      const touches = scopedRecords({ records, context: input.context }).filter(record => matchesSubject({ event: record.event, anonymousIds, subjectId: input.subjectId })).map(record => record.touch).filter(touch => touch.occurredAt >= input.window.start && touch.occurredAt < input.window.end);
      touches.sort(compareTouches);
      return { ok: true, value: structuredClone(touches.slice(0, input.limit)) };
    },
    async purgeSubject(input, options) {
      const invalid = validateSubject({ ...input, options });
      if (invalid) return invalid;
      const anonymousIds = boundAnonymousIds({ visits, ...input });
      for (const record of scopedRecords({ records, context: input.context })) {
        if (matchesSubject({ event: record.event, anonymousIds, subjectId: input.subjectId })) record.touch = { ...record.touch, clickIdentifiers: {} };
      }
      for (const [key, visit] of visits) {
        if (key.startsWith(scopePrefix(input)) && visit.subjectId === input.subjectId) visits.delete(key);
      }
      return { ok: true, value: undefined };
    },
  };
}
function scopePrefix(required: { context: CallContext }): string { return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]) + ":"; }
function scopedKey(required: { context: CallContext; id: string }): string { return scopePrefix(required) + required.id; }
function scopedRecords(required: { records: Map<string, Record>; context: CallContext }): Record[] { return [...required.records].filter(([key]) => key.startsWith(scopePrefix(required))).map(([, value]) => value); }
function anonymousExists(required: { visits: Map<string, Visit>; context: CallContext; anonymousId: string }): boolean {
  return [...required.visits].some(([key, visit]) => key.startsWith(scopePrefix(required)) && visit.anonymousId === required.anonymousId);
}
function boundAnonymousIds(required: { visits: Map<string, Visit>; context: CallContext; subjectId: string }): Set<string> {
  return new Set([...required.visits].filter(([key, visit]) => key.startsWith(scopePrefix(required)) && visit.subjectId === required.subjectId).map(([, visit]) => visit.anonymousId));
}
/** Direct subject identity takes precedence; a visit never merges different subjects. */
function matchesSubject(required: { event: WebEvent; subjectId: string; anonymousIds: Set<string> }): boolean {
  if (required.event.subjectId !== undefined) return required.event.subjectId === required.subjectId;
  return required.event.anonymousId !== undefined && required.anonymousIds.has(required.event.anonymousId);
}
/** Foreign Array.sort ABI; explicit lexical ordering matches SQLite BINARY collation. */
function compareTouches(left: AttributionTouch, right: AttributionTouch): number {
  if (left.occurredAt !== right.occurredAt) return right.occurredAt - left.occurredAt;
  return left.touchId > right.touchId ? -1 : Number(left.touchId < right.touchId);
}
/** No state mutation occurs until uniqueness, clock and cursor checks pass.
 * @complexity O(e) touch-ID uniqueness scan, then constant-size append. */
function appendRecord(required: { records: Map<string, Record>; cursors: Map<string, number>; context: CallContext; event: WebEvent; touch: AttributionTouch; clock: ClockPort; digest: string; key: string }): Outcome<AttributionTouch> {
  if (scopedRecords(required).some(record => record.touch.touchId === required.touch.touchId)) return failure({ code: "conflict" });
  const prefix = scopePrefix(required);
  const cursor = (required.cursors.get(prefix) ?? 0) + 1;
  const receivedAt = required.clock.now({});
  if (!epochSchema.safeParse(receivedAt).success || !epochSchema.safeParse(cursor).success) return failure({ code: "unavailable" });
  const event = storedEvent({ event: structuredClone(required.event), receivedAt, cursor });
  required.records.set(required.key, { event, touch: structuredClone(required.touch), digest: required.digest });
  required.cursors.set(prefix, cursor);
  return { ok: true, value: structuredClone(required.touch) };
}
