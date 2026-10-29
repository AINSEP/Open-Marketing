/** Connection-bound owner mail through a host-owned, guarded sender; one lifetime reservation. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MailerSendResult, OutboundEmail } from '@jini-ai/platform/mail';
import { callContextSchema, digestSchema, epochSchema, idSchema, parseBoundary } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createSqlJobRepo, type JobRequest } from '@open-marketing/jobs';
import { formRetryPolicy } from '../composition/forms.js';
import { alertFailure, alertCandidateSchema, type AlertCandidate } from './rules.js';
import { resolveAlertSender, type ProviderReaders } from './provider-settings.js';

/** Fixed bounded notification definition; changes require a new explicit definition digest. */
export const ALERT_EMAIL_DEFINITION_DIGEST = createHash('sha256').update('om.alerts.email.v1').digest('hex');

/** Host admission/revision/credential fences apply before egress. Egress only after
 * `await reserve()` returns `{ ok: true, value: 'reserved' }`; otherwise return a fixed refusal
 * with no egress and no `unknown` flag. A reservation alone conveys no dispatch authority.
 * @example mail.send({ context, pluginId, connectionId, idempotencyKey, message, reserve });
 */
export type AlertMailPort = { send(required: {
    context: CallContext; pluginId: string; connectionId: string; idempotencyKey: string; message: OutboundEmail;
    reserve(): ReturnType<typeof reserveAlertEmail>;
}): Promise<MailerSendResult> };
/** Composition supplies the owner email/timezone and current installed-state reader. */
export type AlertEmailDependencies = Pick<ProviderReaders, 'agentPluginState'> & { mail: AlertMailPort; timezone: string; ownerEmail?: string };

/** ID-only durable intent, bound to the approved notification definition; no grant is embedded. */
export const alertEmailPayloadSchema = z.strictObject({ noticeId: idSchema, definitionDigest: digestSchema, senderConnectionId: idSchema });
export type AlertEmailPayload = z.infer<typeof alertEmailPayloadSchema>;
const enqueueInput = z.strictObject({ context: callContextSchema, payload: alertEmailPayloadSchema });
const reserveInput = z.strictObject({ context: callContextSchema, noticeId: idSchema, now: epochSchema, timezone: z.string().min(1).max(100) });

/** Pure scoped notice identity, shared by enqueue and worker validation after payload parsing.
 * Trace changes do not create another delivery; a changed definition conflicts. O(b), bounded IDs.
 * @example alertEmailJob({ context, payload: { noticeId, definitionDigest, senderConnectionId } })
 */
export function alertEmailJob(required: { context: CallContext; payload: AlertEmailPayload }): JobRequest {
    const { context, payload } = required;
    const identity = createHash('sha256').update(JSON.stringify([context.scope.ownerId, context.scope.workspaceId, payload.noticeId, payload.senderConnectionId])).digest('hex');
    const argumentsDigest = createHash('sha256').update(JSON.stringify([payload.noticeId, payload.definitionDigest, payload.senderConnectionId])).digest('hex');
    return { handler: 'alerts.email', operationId: identity, idempotencyKey: 'alerts.email:' + identity, argumentsDigest, payload };
}

/** Validate intent, binding and addresses before reading the scoped notice or invoking mail.
 * No database transaction spans delivery. The host must honour the late reservation contract.
 * @example await dispatchAlertEmail({ context, payload, unit, clock, alertEmail });
 * @complexity One binding resolution and one scoped notice SELECT; bounded fixed content and one send.
 */
export async function dispatchAlertEmail(required: {
    context: CallContext; payload: AlertEmailPayload; unit: UnitOfWork; clock: ClockPort; alertEmail?: AlertEmailDependencies;
}): Promise<MailerSendResult> {
    const parsed = parseBoundary({ schema: enqueueInput, input: { context: required.context, payload: required.payload } });
    if (!parsed.ok || parsed.value.payload.definitionDigest !== ALERT_EMAIL_DEFINITION_DIGEST)
        return emailRefusal({ code: 'invalid_input', message: 'Invalid alert email definition or payload' });
    if (!required.alertEmail) return emailRefusal({ code: 'not_implemented', message: 'Alert email sender not bound' });
    const { context, payload } = parsed.value;
    const sender = await resolveAlertSender({ context, unit: required.unit, agentPluginState: required.alertEmail.agentPluginState });
    if (!sender.ok) return emailRefusal({ code: 'unavailable', message: 'Alert sender unavailable' });
    if (sender.value === null || sender.value.connectionId !== payload.senderConnectionId)
        return emailRefusal({ code: 'not_implemented', message: 'Alert email sender not bound' });
    const from = z.email().max(254).safeParse(sender.value.alertFrom);
    const to = z.email().max(254).safeParse(required.alertEmail.ownerEmail);
    if (!from.success || !to.success) return emailRefusal({ code: 'invalid_input', message: 'Alert email addresses unavailable or invalid' });
    const notice = await readEmailNotice({ context, unit: required.unit, noticeId: payload.noticeId });
    if (!notice.ok) return emailRefusal({ code: notice.error.code, message: notice.error.message });
    const timezone = required.alertEmail.timezone;
    return required.alertEmail.mail.send({ context, pluginId: sender.value.pluginId, connectionId: sender.value.connectionId,
        idempotencyKey: alertEmailJob({ context, payload }).idempotencyKey,
        message: { workspaceId: context.scope.workspaceId, from: { email: from.data }, to: { email: to.data },
            subject: 'Open Marketing alert: ' + notice.value.kind, text: emailText({ candidate: notice.value }) },
        reserve: () => reserveAlertEmail({ context, noticeId: payload.noticeId, unit: required.unit, clock: required.clock, timezone }) });
}

/** Fixed email-ABI refusal for local validation/storage failures, with no unknown flag. */
function emailRefusal(required: { code: string; message: string }): MailerSendResult {
    return { ok: false, retryable: false, errorCode: required.code, message: required.message };
}

/** Decode one scoped notice; SQL and stored evidence never escape fixed errors. O(b), <=32KiB. */
async function readEmailNotice(required: { context: CallContext; unit: UnitOfWork; noticeId: string }): Promise<Outcome<Exclude<AlertCandidate, { kind: 'weekly_report' }>>> {
    try {
        return await required.unit.transaction({ work: async ({ session }) => {
            const result = await session.query({ text: 'SELECT candidate FROM server_alert_notice WHERE owner_id=$1 AND workspace_id=$2 AND notice_id=$3',
                values: [required.context.scope.ownerId, required.context.scope.workspaceId, required.noticeId] });
            if (!result.rows.length) return alertFailure({ code: 'forbidden', message: 'Alert unavailable' });
            const candidate = z.string().max(32768).parse(result.rows[0]!.candidate);
            const parsed = alertCandidateSchema.safeParse(JSON.parse(candidate));
            if (!parsed.success) return alertFailure({ code: 'invalid_input', message: 'Invalid alert notice' });
            if (parsed.data.kind === 'weekly_report') return alertFailure({ code: 'not_implemented', message: 'Weekly report email not enabled' });
            return { ok: true, value: parsed.data };
        } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert notice unavailable' }); }
}

/** Only fixed text crosses the mail boundary; reasons and other vendor strings are never included. */
function emailText(required: { candidate: Exclude<AlertCandidate, { kind: 'weekly_report' }> }): string {
    switch (required.candidate.kind) {
        case 'approval_waiting': return 'An approval is waiting. Open Open Marketing to review.';
        case 'ad_disapproved': return 'An ad was disapproved. Open Open Marketing to review.';
        case 'pacing': return 'Campaign spending needs review. Open Open Marketing to review.';
        default: { const exhaustive: never = required.candidate; return exhaustive; }
    }
}

/** Queue one delivery per scoped notice/connection in the existing outbox; a changed definition conflicts.
 * A new connection permits re-queue. Rebinding the SAME connection ID does not re-queue.
 * Returns validation, scope, conflict or storage failures; reservations remain notice-scoped.
 * @example enqueueAlertEmail({ context, noticeId, definitionDigest, senderConnectionId, unit, clock, ids })
 * @complexity One indexed notice read and one bounded outbox enqueue in the same transaction.
 */
export async function enqueueAlertEmail(required: {
    context: CallContext; noticeId: string; definitionDigest: string; senderConnectionId: string; unit: UnitOfWork; clock: ClockPort; ids: IdPort;
}): Promise<Outcome<void>> {
    const parsed = parseBoundary({ schema: enqueueInput, input: { context: required.context,
        payload: { noticeId: required.noticeId, definitionDigest: required.definitionDigest, senderConnectionId: required.senderConnectionId } } });
    if (!parsed.ok) return parsed;
    const { context, payload } = parsed.value;
    try {
        return await required.unit.transaction({ work: async ({ session }): Promise<Outcome<void>> => {
            const notice = await session.query({ text: 'SELECT notice_id FROM server_alert_notice WHERE owner_id=$1 AND workspace_id=$2 AND notice_id=$3',
                values: [context.scope.ownerId, context.scope.workspaceId, payload.noticeId] });
            if (!notice.rows.length) return alertFailure({ code: 'forbidden', message: 'Alert unavailable' });
            const repo = createSqlJobRepo({ database: session, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
            const queued = await repo.enqueue({ context, job: alertEmailJob({ context, payload }) });
            return queued.ok ? { ok: true, value: undefined } : queued;
        } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert email scheduling unavailable' }); }
}

/** Validate the timezone and encode its calendar date as a day ordinal, without reading time.
 * The local_day column stores the owner-local day ordinal. O(1) time/space.
 * Invalid timezones/dates return invalid_input before any SQL.
 */
function emailDay(required: { now: number; timezone: string }): Outcome<number> {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: required.timezone,
            year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(required.now);
        const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return parseBoundary({ schema: epochSchema, input: Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day)) / 86400000 });
    } catch { return alertFailure({ code: 'invalid_input', message: 'Invalid alert email timezone or date' }); }
}

/** Consume one of 20 owner-wide local daily slots, once per scoped notice for its entire lifetime.
 * Only `reserved` means a new attempt; `existing` MUST NOT authorize another send, even after an
 * uncertain outcome or daily rollover. A future sender must recheck current ServiceGrant/admission
 * immediately before reserving and egress. Missing notice/cap/storage failures deny progress.
 * @example reserveAlertEmail({ context, noticeId, unit, clock, timezone })
 * @complexity Indexed notice/replay reads and an atomic insert over <=20 owner/day slots.
 */
export async function reserveAlertEmail(required: {
    context: CallContext; noticeId: string; unit: UnitOfWork; clock: ClockPort; timezone: string;
}): Promise<Outcome<'reserved' | 'existing'>> {
    const parsed = parseBoundary({ schema: reserveInput, input: { context: required.context, noticeId: required.noticeId, now: required.clock.now({}), timezone: required.timezone } });
    if (!parsed.ok) return parsed;
    const { context, noticeId, now } = parsed.value;
    const day = emailDay(parsed.value);
    if (!day.ok) return day;
    const values = [context.scope.ownerId, context.scope.workspaceId, noticeId];
    try {
        return await required.unit.transaction({ work: async ({ session }): Promise<Outcome<'reserved' | 'existing'>> => {
            const existing = await session.query({ text: 'SELECT notice_id FROM server_alert_email_reservation WHERE owner_id=$1 AND workspace_id=$2 AND notice_id=$3', values });
            if (existing.rows.length) return { ok: true, value: 'existing' };
            const notice = await session.query({ text: 'SELECT notice_id FROM server_alert_notice WHERE owner_id=$1 AND workspace_id=$2 AND notice_id=$3', values });
            if (!notice.rows.length) return alertFailure({ code: 'forbidden', message: 'Alert unavailable' });
            const inserted = await session.query({ text: `INSERT INTO server_alert_email_reservation
                (owner_id,workspace_id,notice_id,local_day,daily_slot,reserved_at)
                SELECT $1,$2,$3,$4,COALESCE(MAX(daily_slot),0)+1,$5 FROM server_alert_email_reservation
                WHERE owner_id=$1 AND local_day=$4 HAVING COALESCE(MAX(daily_slot),0)<20
                RETURNING notice_id`, values: [...values, day.value, now] });
            if (!inserted.rows.length) return alertFailure({ code: 'limit_exceeded', message: 'Owner alert email daily cap reached' });
            return { ok: true, value: 'reserved' };
        } });
    } catch { return alertFailure({ code: 'unavailable', message: 'Alert email reservation unavailable' }); }
}
