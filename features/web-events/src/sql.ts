import { digestSchema, epochSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { WebEventRepoPort } from "./ports.js";
import type { AttributionTouch, Visit, WebEvent } from "./types.js";
import { bindVisit, boundary, checkVisitReplay, storedEventSchema, failure, replayDigest, storedDigestSchema, storedEvent, touchSchema, validateBinding, validateContext, validateRead, validateRecord, validateSubject, validateVisit, visitSchema } from "./rules.js";

type SessionInput = { session: SqlSession; context: CallContext };
type SqlOptions = { pool: UnitOfWork; clock: ClockPort };
type StoredRecord = { event: WebEvent; touch: AttributionTouch; digest: string };
const recordSelect = "SELECT e.payload, e.semantic_digest, e.event_id, e.subject_id, e.anonymous_id, e.occurred_at, e.cursor, t.touch_id, t.link_id, t.campaign_id, t.click_identifiers FROM web_event e JOIN web_touch t ON t.owner_id = e.owner_id AND t.workspace_id = e.workspace_id AND t.event_id = e.event_id";
const subjectPredicate = "(e.subject_id = $3 OR (e.subject_id IS NULL AND EXISTS (SELECT 1 FROM web_visit v WHERE v.owner_id = e.owner_id AND v.workspace_id = e.workspace_id AND v.anonymous_id = e.anonymous_id AND v.subject_id = $3)))";

/** Inert durable repository. The injected owner serializes writers and rolls back failed Outcomes.
 * A supplied SqlSession joins the caller's transaction; no connections/migrations are constructed.
 * @complexity Indexed writes O(log n); subject/window read bounded to 100 rows, sorted by time/ID.
 * @example createSqlWebEventRepo({ pool, clock }).touchesFor({ context, subjectId, window, limit: 100 })
 */
export function createSqlWebEventRepo(required: SqlOptions): WebEventRepoPort {
  return {
    async lastHeartbeat(input, options) {
      const invalid = validateContext({ context: input.context, options });
      if (invalid) return invalid;
      if (!digestSchema.safeParse(input.destinationId).success) return failure({ code: "invalid_input" });
      return transaction({ ...required, options, work: async session => {
        // Scoped payload scan until measured volume justifies a dedicated index/migration.
        const result = await session.query({ text: "SELECT payload FROM web_event WHERE owner_id = $1 AND workspace_id = $2 AND json_extract(payload, '$.properties.destinationId') = $3 ORDER BY json_extract(payload, '$.receivedAt') DESC LIMIT 1", values: [...scopeValues(input), input.destinationId] });
        if (result.rows.length === 0) return { ok: true, value: null };
        const payload = result.rows[0].payload;
        if (typeof payload !== "string" || payload.length > 20000) return failure({ code: "unavailable" });
        const event = storedEventSchema.safeParse(JSON.parse(payload));
        if (!event.success || event.data.properties.destinationId !== input.destinationId) return failure({ code: "unavailable" });
        return { ok: true, value: event.data.receivedAt };
      } });
    },
    async recordTouch(request, options) {
      const invalid = validateRecord({ ...request, options });
      if (invalid) return invalid;
      const input = structuredClone({ context: request.context, event: request.event, touch: request.touch });
      return transaction({ ...required, options, work: async session => {
        const existing = await readRecord({ session, ...input });
        if (!existing.ok) return existing;
        const digest = replayDigest(input);
        if (existing.value) return existing.value.digest === digest ? { ok: true, value: existing.value.touch } : failure({ code: "conflict" });
        return insertRecord({ session, ...input, digest, clock: required.clock });
      } });
    },
    async saveVisit(request, options) {
      const invalidContext = validateContext({ context: request.context, options });
      if (invalidContext) return invalidContext;
      const visit = visitSchema.safeParse(request.visit);
      if (!visit.success) return failure({ code: "invalid_input" });
      const input = { context: structuredClone(request.context), visit: visit.data };
      return transaction({ ...required, options, work: async session => {
        const invalid = validateVisit({ ...input, now: required.clock.now({}), options });
        if (invalid) return invalid;
        const existing = await readVisit({ session, context: input.context, visitId: input.visit.visitId });
        if (!existing.ok) return existing;
        if (existing.value) return checkVisitReplay({ existing: existing.value, visit: input.visit });
        if (input.visit.subjectId !== null) return failure({ code: "conflict" });
        const result = await session.query({ text: "INSERT INTO web_visit (owner_id, workspace_id, visit_id, anonymous_id, subject_id, expires_at) VALUES ($1, $2, $3, $4, NULL, $5) ON CONFLICT DO NOTHING RETURNING visit_id", values: [...scopeValues(input), input.visit.visitId, input.visit.anonymousId, input.visit.expiresAt] });
        if (result.rows.length !== 1) return failure({ code: "conflict" });
        return { ok: true, value: structuredClone(input.visit) };
      } });
    },
    async bindVisitor(request, options) {
      const invalid = validateBinding({ ...request, options });
      if (invalid) return invalid;
      const input = structuredClone({ context: request.context, visitId: request.visitId, subjectId: request.subjectId });
      return transaction({ ...required, options, work: async session => {
        const existing = await readVisit({ session, ...input });
        if (!existing.ok) return existing;
        const bound = bindVisit({ visit: existing.value, subjectId: input.subjectId, now: required.clock.now({}) });
        if (!bound.ok) return bound;
        await session.query({ text: "UPDATE web_visit SET subject_id = $3 WHERE owner_id = $1 AND workspace_id = $2 AND visit_id = $4", values: [...scopeValues(input), input.subjectId, input.visitId] });
        return bound;
      } });
    },
    async touchesFor(request, options) {
      const invalid = validateRead({ ...request, options });
      if (invalid) return invalid;
      const input = structuredClone({ context: request.context, subjectId: request.subjectId, window: request.window, limit: request.limit });
      return transaction({ ...required, options, work: async session => {
        const result = await session.query({ text: recordSelect + " WHERE e.owner_id = $1 AND e.workspace_id = $2 AND " + subjectPredicate + " AND e.occurred_at >= $4 AND e.occurred_at < $5 ORDER BY e.occurred_at DESC, t.touch_id COLLATE BINARY DESC LIMIT $6", values: [...scopeValues(input), input.subjectId, input.window.start, input.window.end, input.limit] });
        return decodeTouches({ rows: result.rows });
      } });
    },
    async purgeSubject(request, options) {
      const invalid = validateSubject({ ...request, options });
      if (invalid) return invalid;
      const input = structuredClone({ context: request.context, subjectId: request.subjectId });
      return transaction({ ...required, options, work: async session => {
        await session.query({ text: "UPDATE web_touch SET click_identifiers = '{}' WHERE owner_id = $1 AND workspace_id = $2 AND event_id IN (SELECT e.event_id FROM web_event e WHERE e.owner_id = $1 AND e.workspace_id = $2 AND " + subjectPredicate + ")", values: [...scopeValues(input), input.subjectId] });
        await session.query({ text: "DELETE FROM web_visit WHERE owner_id = $1 AND workspace_id = $2 AND subject_id = $3", values: [...scopeValues(input), input.subjectId] });
        return { ok: true, value: undefined };
      } });
    },
  };
}
function scopeValues(required: { context: CallContext }): string[] { return [required.context.scope.ownerId, required.context.scope.workspaceId]; }
/** Cancellation at root exit yields a failed Outcome so the owner rolls back partial writes. */
async function transaction<T>(required: SqlOptions & { options?: CallOptions; work: (session: SqlSession) => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  return boundary({ options: required.options, work: () => required.pool.transaction({ work: async ({ session }) => {
    const result = await required.work(session);
    if (required.options?.signal?.aborted) return failure({ code: "cancelled" });
    return result;
  } }) });
}
/** Scoped event-ID lookup supplies the original replay result; malformed storage fails closed. */
async function readRecord(required: SessionInput & { event: WebEvent }): Promise<Outcome<StoredRecord | undefined>> {
  const result = await required.session.query({ text: recordSelect + " WHERE e.owner_id = $1 AND e.workspace_id = $2 AND e.event_id = $3", values: [...scopeValues(required), required.event.eventId] });
  if (result.rows.length === 0) return { ok: true, value: undefined };
  return decodeRecord({ row: result.rows[0] });
}
/** SQL JSON/columns are tainted: reject malformed data, PII envelope keys and metadata drift. */
function decodeRecord(required: { row: Record<string, unknown> }): Outcome<StoredRecord> {
  const row = required.row;
  if (typeof row.payload !== "string" || row.payload.length > 20000 || typeof row.click_identifiers !== "string" || row.click_identifiers.length > 16384) return failure({ code: "unavailable" });
  const event = storedEventSchema.safeParse(JSON.parse(row.payload));
  const touch = touchSchema.safeParse({ touchId: row.touch_id, eventId: row.event_id, occurredAt: row.occurred_at, linkId: row.link_id, campaignId: row.campaign_id, clickIdentifiers: JSON.parse(row.click_identifiers) });
  if (!event.success || !touch.success || !storedDigestSchema.safeParse(row.semantic_digest).success) return failure({ code: "unavailable" });
  if (!metadataMatches({ row, event: event.data as WebEvent, touch: touch.data })) return failure({ code: "unavailable" });
  return { ok: true, value: { event: event.data as WebEvent, touch: touch.data as AttributionTouch, digest: row.semantic_digest as string } };
}
/** Indexed authority/identity columns must agree with the sanitized immutable envelope. */
function metadataMatches(required: { row: Record<string, unknown>; event: WebEvent; touch: AttributionTouch }): boolean {
  const { event, row, touch } = required;
  const eventColumnsMatch = event.eventId === row.event_id && (event.subjectId ?? null) === row.subject_id && (event.anonymousId ?? null) === row.anonymous_id && event.occurredAt === row.occurred_at && event.cursor === row.cursor;
  return eventColumnsMatch && touch.linkId === (event.properties.linkId ?? null) && touch.campaignId === (event.properties.campaignId ?? null);
}
/** Decode the bounded bulk result without returning a partial attribution list on corruption. */
function decodeTouches(required: { rows: Record<string, unknown>[] }): Outcome<readonly AttributionTouch[]> {
  const touches: AttributionTouch[] = [];
  for (const row of required.rows) {
    const decoded = decodeRecord({ row });
    if (!decoded.ok) return decoded;
    touches.push(decoded.value.touch);
  }
  return { ok: true, value: touches };
}
/** Scoped visit lookup distinguishes absence from malformed persisted token metadata. */
async function readVisit(required: SessionInput & { visitId: string }): Promise<Outcome<Visit | undefined>> {
  const result = await required.session.query({ text: "SELECT visit_id, anonymous_id, subject_id, expires_at FROM web_visit WHERE owner_id = $1 AND workspace_id = $2 AND visit_id = $3", values: [...scopeValues(required), required.visitId] });
  if (result.rows.length === 0) return { ok: true, value: undefined };
  const row = result.rows[0];
  const visit = visitSchema.safeParse({ visitId: row.visit_id, scope: required.context.scope, anonymousId: row.anonymous_id, subjectId: row.subject_id, expiresAt: row.expires_at });
  return visit.success ? { ok: true, value: visit.data } : failure({ code: "unavailable" });
}
/** Append immutable IDs/digest and mutable click row together; scoped cursor is assigned here. */
async function insertRecord(required: SessionInput & { event: WebEvent; touch: AttributionTouch; digest: string; clock: ClockPort }): Promise<Outcome<AttributionTouch>> {
  const duplicate = await required.session.query({ text: "SELECT touch_id FROM web_touch WHERE owner_id = $1 AND workspace_id = $2 AND touch_id = $3", values: [...scopeValues(required), required.touch.touchId] });
  if (duplicate.rows.length !== 0) return failure({ code: "conflict" });
  const receivedAt = required.clock.now({});
  if (!epochSchema.safeParse(receivedAt).success) return failure({ code: "unavailable" });
  const sequence = await required.session.query({ text: "INSERT INTO web_event_cursor (owner_id, workspace_id, cursor) VALUES ($1, $2, 1) ON CONFLICT (owner_id, workspace_id) DO UPDATE SET cursor = cursor + 1 RETURNING cursor", values: scopeValues(required) });
  const cursor = sequence.rows[0]?.cursor;
  if (!epochSchema.safeParse(cursor).success) return failure({ code: "unavailable" });
  const event = storedEvent({ event: required.event, receivedAt, cursor: cursor as number });
  await required.session.query({ text: "INSERT INTO web_event (owner_id, workspace_id, event_id, subject_id, anonymous_id, occurred_at, cursor, semantic_digest, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", values: [...scopeValues(required), event.eventId, event.subjectId ?? null, event.anonymousId ?? null, event.occurredAt, event.cursor, required.digest, JSON.stringify(event)] });
  await required.session.query({ text: "INSERT INTO web_touch (owner_id, workspace_id, touch_id, event_id, link_id, campaign_id, click_identifiers) VALUES ($1, $2, $3, $4, $5, $6, $7)", values: [...scopeValues(required), required.touch.touchId, event.eventId, required.touch.linkId, required.touch.campaignId, JSON.stringify(required.touch.clickIdentifiers)] });
  return { ok: true, value: structuredClone(required.touch) };
}
