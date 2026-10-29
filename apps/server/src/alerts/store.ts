/** Durable server-local notices and acknowledgements; all SQL is scoped and append-only. */
import { z } from 'zod';
import { approverRefSchema, callContextSchema, epochSchema, idSchema, pageQuerySchema, parseBoundary } from '@open-marketing/contracts';
import type { ApproverRef, CallContext, ClockPort, IdPort, Outcome, Page, PageQuery, UnitOfWork } from '@open-marketing/contracts';
import { alertFailure, alertCandidateSchema, type AlertCandidate } from './rules.js';
import { ALERT_EMAIL_DEFINITION_DIGEST, enqueueAlertEmail } from './email.js';

export const alertNoticeSchema = z.strictObject({ noticeId: idSchema, createdAt: epochSchema, candidate: alertCandidateSchema,
    acknowledgement: z.strictObject({ at: epochSchema, approver: approverRefSchema }).nullable() });
export type AlertNotice = z.infer<typeof alertNoticeSchema>;
const cursorSchema = z.strictObject({ createdAt: epochSchema, noticeId: idSchema });
const listInput = z.strictObject({ context: callContextSchema,
    query: pageQuerySchema.extend({ cursor: z.string().min(1).max(4096).regex(/^[A-Za-z0-9_-]+$/).optional() }) });
/** Feed tools share the store's bounded query/cursor validation. */
export const alertQuerySchema = listInput.shape.query;
const ackInput = z.strictObject({ context: callContextSchema, noticeId: idSchema, approver: approverRefSchema, now: epochSchema });
const appendInput = z.strictObject({ context: callContextSchema, candidates: z.array(alertCandidateSchema).max(300), now: epochSchema,
    email: z.strictObject({ senderConnectionId: idSchema }).optional() });
const rowSchema = z.object({ notice_id: idSchema, created_at: epochSchema, candidate: z.string().max(32768),
    acknowledged_at: epochSchema.nullable(), approver: z.string().max(2048).nullable() });

/** Decode database evidence without trusting JSON or partial acknowledgement columns. O(b), <=35KB. */
function noticeFromRow({ row }: { row: unknown }): AlertNotice {
    const value = rowSchema.parse(row);
    const acknowledgement = value.acknowledged_at === null ? null : { at: value.acknowledged_at, approver: JSON.parse(value.approver!) };
    if ((value.acknowledged_at === null) !== (value.approver === null)) throw new Error('Incomplete acknowledgement');
    return alertNoticeSchema.parse({ noticeId: value.notice_id, createdAt: value.created_at,
        candidate: JSON.parse(value.candidate), acknowledgement });
}
/** A bounded canonical cursor; reject invalid JSON/shape before opening SQL. O(b), <=4KiB. */
function decodeCursor(required: { cursor?: string }): Outcome<z.infer<typeof cursorSchema> | null> {
    if (!required.cursor) return { ok: true, value: null };
    try {
        const bytes = Buffer.from(required.cursor, 'base64url');
        if (bytes.toString('base64url') !== required.cursor) throw new Error('Noncanonical cursor');
        return parseBoundary({ schema: cursorSchema, input: JSON.parse(bytes.toString('utf8')) });
    } catch { return alertFailure({ code: 'invalid_input', message: 'Invalid alert cursor' }); }
}
/** Keep the serialized page below the tool cap, with at least one bounded notice.
 * Cursor follows the last included notice even when bytes stop the page before the row limit.
 * @complexity <=100 serializations of <=100KiB prospective pages; no additional SQL.
 */
function noticePage(required: { rows: readonly unknown[]; limit: number }): Page<AlertNotice> {
    let page: Page<AlertNotice> = { items: [], cursor: null };
    for (const row of required.rows.slice(0, required.limit)) {
        const notice = noticeFromRow({ row });
        const items = [...page.items, notice];
        const cursor = required.rows.length > items.length
            ? Buffer.from(JSON.stringify({ createdAt: notice.createdAt, noticeId: notice.noticeId })).toString('base64url') : null;
        const next = { items, cursor };
        if (page.items.length > 0 && Buffer.byteLength(JSON.stringify(next), 'utf8') > 60000) break;
        page = next;
    }
    return page;
}
/** Scoped keyset page, including acknowledged notices. Unknown cursors cannot escape scope.
 * Returns invalid_input or unavailable; no mutation.
 * @example listAlerts({ context, query: { limit: 20 }, unit })
 * @complexity O(log n + limit) indexed SQL, <=101 rows and <=100 returned notices.
 */
export async function listAlerts(required: { context: CallContext; query: PageQuery; unit: UnitOfWork }): Promise<Outcome<Page<AlertNotice>>> {
    const parsed = parseBoundary({ schema: listInput, input: { context: required.context, query: required.query } });
    if (!parsed.ok) return parsed;
    const { context, query } = parsed.value;
    const cursor = decodeCursor({ cursor: query.cursor });
    if (!cursor.ok) return cursor;
    try {
        return await required.unit.transaction({ work: async ({ session }) => {
            const rows = await session.query({ text: `SELECT n.notice_id,n.created_at,n.candidate,a.acknowledged_at,a.approver
                FROM server_alert_notice n LEFT JOIN server_alert_ack a
                ON a.owner_id=n.owner_id AND a.workspace_id=n.workspace_id AND a.notice_id=n.notice_id
                WHERE n.owner_id=$1 AND n.workspace_id=$2 AND (n.created_at,n.notice_id)>($3,$4)
                ORDER BY n.created_at,n.notice_id LIMIT $5`,
                values: [context.scope.ownerId, context.scope.workspaceId, cursor.value?.createdAt ?? -1,
                    cursor.value?.noticeId ?? '', query.limit + 1] });
            return { ok: true, value: noticePage({ rows: rows.rows, limit: query.limit }) };
        } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert listing unavailable' }); }
}
/** Append once, retaining dedup identity after acknowledgement. A supplied session joins its root.
 * Returns inserted count, invalid_input or unavailable; any failed batch rolls back.
 * Bound emails enqueue in the SAME transaction; any failed enqueue rolls the entire batch back.
 * @example appendAlerts({ context, candidates, unit, clock, ids }, { email: { senderConnectionId } })
 * @complexity <=300 inserts plus one notice read/outbox enqueue per new bound notice, in one transaction.
 */
export async function appendAlerts(required: { context: CallContext; candidates: readonly AlertCandidate[]; unit: UnitOfWork; clock: ClockPort; ids: IdPort },
    optional?: { email?: { senderConnectionId: string } }): Promise<Outcome<number>> {
    const parsed = parseBoundary({ schema: appendInput, input: { context: required.context, candidates: required.candidates, now: required.clock.now({}), email: optional?.email } });
    if (!parsed.ok) return parsed;
    const { context, candidates, now, email } = parsed.value;
    try {
        return await required.unit.transaction({ work: async ({ session }): Promise<Outcome<number>> => {
            let inserted = 0;
            for (const candidate of candidates) {
                const noticeId = idSchema.parse(required.ids.next({}));
                const row = await session.query({ text: `INSERT INTO server_alert_notice
                    (owner_id,workspace_id,notice_id,dedup_key,created_at,candidate) VALUES ($1,$2,$3,$4,$5,$6)
                    ON CONFLICT (owner_id,workspace_id,dedup_key) DO NOTHING RETURNING notice_id`,
                    values: [context.scope.ownerId, context.scope.workspaceId, noticeId, candidate.dedupKey, now, JSON.stringify(candidate)] });
                if (!row.rows.length) continue;
                inserted++;
                if (!email) continue;
                const queued = await enqueueAlertEmail({ ...required, context, noticeId, unit: session,
                    definitionDigest: ALERT_EMAIL_DEFINITION_DIGEST, senderConnectionId: email.senderConnectionId });
                if (!queued.ok) return queued;
            }
            return { ok: true, value: inserted };
        } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert append unavailable' }); }
}
/** Direct owner action. The authenticated inbound adapter MUST derive approver server-side.
 * Repeated acknowledgements retain the original actor/time. No notice deletion or external effect.
 * @example acknowledgeAlert({ context, noticeId, approver, unit, clock })
 * @complexity One indexed insert-select and optional existence read, O(log n).
 */
export async function acknowledgeAlert(required: { context: CallContext; noticeId: string; approver: ApproverRef; unit: UnitOfWork; clock: ClockPort }): Promise<Outcome<void>> {
    const parsed = parseBoundary({ schema: ackInput, input: { context: required.context, noticeId: required.noticeId,
        approver: required.approver, now: required.clock.now({}) } });
    if (!parsed.ok) return parsed;
    const { context, noticeId, approver, now } = parsed.value;
    if (context.principal.kind !== 'owner' || context.principal.ownerId !== context.scope.ownerId)
        return alertFailure({ code: 'forbidden', message: 'Owner acknowledgement required' });
    if (approver.kind === 'local_token' && approver.ownerId !== context.scope.ownerId)
        return alertFailure({ code: 'forbidden', message: 'Acknowledgement identity mismatch' });
    try {
        return await required.unit.transaction({ work: async ({ session }) => {
            const values = [context.scope.ownerId, context.scope.workspaceId, noticeId];
            const found = await session.query({ text: 'SELECT notice_id FROM server_alert_notice WHERE owner_id=$1 AND workspace_id=$2 AND notice_id=$3', values });
            if (!found.rows.length) return alertFailure({ code: 'forbidden', message: 'Alert unavailable' });
            await session.query({ text: `INSERT INTO server_alert_ack (owner_id,workspace_id,notice_id,acknowledged_at,approver)
                VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, values: [...values, now, JSON.stringify(approver)] });
            return { ok: true, value: undefined };
        } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert acknowledgement unavailable' }); }
}
