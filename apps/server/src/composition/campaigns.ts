/** Local fixture backend and transactional campaign adapter over the ONE jobs outbox. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { callContextSchema, idSchema, boundedJsonSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createCampaignService } from '@open-marketing/campaigns';
import type { CampaignRepoPort, CampaignJobPort, CampaignJob, CampaignSafetyPort, CampaignCapabilityPort } from '@open-marketing/campaigns';
import { createSqlJobRepo, jobTenant, JobStoreError } from '@open-marketing/jobs';
import type { JobsSqlSession } from '@open-marketing/jobs';
import type { SafetyRepoPort } from '@open-marketing/safety';
import { digestArguments } from '@open-marketing/safety';
import type { AuditService } from '@open-marketing/audit';
import { catalogAuditPort } from './catalog.js';
import { jobsDatabase, formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';

const payloadSchema = z.object({ intent: z.object({ kind: z.literal('create'), campaignId: idSchema }) });
// Match CampaignJobPort and its memory double: get/claim take a key, finish adds only status.
const jobKeySchema = z.strictObject({ context: callContextSchema, operationId: idSchema });
const jobFinishSchema = jobKeySchema.extend({ status: z.enum(['submitted', 'unknown']) });
type Input = Parameters<CampaignJobPort['get']>[0];
/** Journals each campaign transition in the existing append-only jobs attempt table. */
async function journal(required: { session: JobsSqlSession; id: string; tenantId: string; event: string; state: string; now: number }): Promise<void> {
    await required.session.query({ sql: 'INSERT INTO job_attempt (job_id, sequence, tenant_id, attempt, event_type, state, observed_at, evidence_id) SELECT $1, COALESCE(MAX(sequence),0)+1, $2, 1, $3, $4, $5, NULL FROM job_attempt WHERE job_id=$1',
        parameters: [required.id, required.tenantId, required.event, required.state, required.now] });
}
/** Creation intent is the job's immutable payload. Enqueue and reserved lease commit atomically;
 * the generic worker cannot take this inline campaign operation. Expired claims reconcile.
 * No launch enqueue is authorized in this local binding. @complexity Constant bounded queries. */
export function bindCampaignJobs(required: { unit: UnitOfWork; repo: CampaignRepoPort; clock: ClockPort; ids: IdPort; observer: ObserverPort }): CampaignJobPort {
    const database = jobsDatabase(required);
    const outbox = createSqlJobRepo({ database, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy }).outbox;
    /** Strict scoped-key read; rejects extra fields before I/O. Returns immutable intent or null.
     * @complexity Constant bounded queries and O(n) bounded intent bytes/space. */
    async function get(input: Input): Promise<Outcome<CampaignJob | null>> {
        if (!jobKeySchema.safeParse(input).success) return localFailure({ code: 'invalid_input', message: 'Invalid campaign job key' });
        const rows = await database.transaction({ execute: ({ session }) => session.query({ sql: 'SELECT id FROM job WHERE tenant_id=$1 AND idempotency_key=$2 AND operation=$3', parameters: [jobTenant(input), 'campaign:' + input.operationId, 'campaign.create'] }) });
        const row = z.array(z.object({ id: idSchema })).max(1).parse(rows.rows)[0];
        if (!row) return { ok: true, value: null };
        const stored = await outbox.get({ tenantId: jobTenant(input), id: row.id });
        if (!stored) return localFailure({ message: 'Campaign job disappeared' });
        const job = z.object({ payload: z.object({ intent: boundedJsonSchema }) }).parse(JSON.parse(stored.payload));
        const payload = payloadSchema.parse(job.payload);
        const record = await required.repo.get({ context: input.context, campaignId: payload.intent.campaignId });
        if (!record.ok) return record;
        if (!record.value) return localFailure({ message: 'Campaign intent unavailable' });
        const intent = { kind: 'create' as const, campaignId: payload.intent.campaignId, draft: record.value.draft };
        const digest = digestArguments({ arguments: intent });
        const savedDigest = digestArguments({ arguments: job.payload.intent });
        if (!digest.ok || !savedDigest.ok || digest.value !== savedDigest.value || record.value.draft.operationId !== input.operationId) return localFailure({ code: 'conflict', message: 'Campaign intent changed' });
        const states = { leased: 'queued', dispatching: 'dispatching', succeeded: 'submitted', reconcile: 'unknown' } as const;
        const status = states[stored.state as keyof typeof states];
        if (!status) return localFailure({ code: 'conflict', message: 'Campaign job is not dispatchable' });
        return { ok: true, value: { jobId: stored.id, scope: input.context.scope, operationId: input.operationId,
            argumentsDigest: stored.requestDigest, intent, status } };
    }
    const ports: CampaignJobPort = {
        async enqueue(input) {
            if (input.intent.kind !== 'create') return localFailure({ code: 'forbidden', message: 'I-2: exact launch outbox binding required' });
            // Campaign jobs bind SHA-256 of schema-ordered draft JSON, independently of safety's tool digest.
            const digest = createHash('sha256').update(JSON.stringify(input.intent.draft)).digest('hex');
            if (digest !== input.argumentsDigest || input.intent.draft.operationId !== input.operationId) return localFailure({ code: 'conflict', message: 'Campaign creation identity mismatch' });
            return database.transaction({ context: input.context, execute: async ({ session }) => {
                const joined = createSqlJobRepo({ database: { transaction: ({ execute }) => execute({ session }) }, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
                const queued = await joined.enqueue({ context: input.context, job: { handler: 'campaign.create', operationId: input.operationId,
                    idempotencyKey: 'campaign:' + input.operationId, argumentsDigest: input.argumentsDigest, payload: { intent: input.intent } } });
                if (!queued.ok) throw new JobStoreError({ code: queued.error.code, message: "Campaign enqueue failed" });
                const reserved = await session.query({ sql: "UPDATE job SET state='leased', attempts=1, lease_token=$1, lease_expires_at=$2 WHERE id=$3 AND tenant_id=$4 AND state='pending' AND attempts=0 RETURNING id",
                    parameters: [required.ids.next({}), required.clock.now({}) + 60000, queued.value.jobId, jobTenant(input)] });
                if (reserved.rows.length) await journal({ session, id: queued.value.jobId, tenantId: jobTenant(input), event: 'claim', state: 'leased', now: required.clock.now({}) });
                return { ok: true, value: { jobId: queued.value.jobId } };
            } });
        }, get,
        async claim(input) {
            const current = await get(input);
            if (!current.ok || !current.value) return current;
            const stored = await outbox.get({ tenantId: jobTenant(input), id: current.value.jobId });
            if (!stored?.leaseToken) return { ok: true, value: null };
            const claimed = await outbox.beginDispatch({ tenantId: jobTenant(input), id: stored.id, token: stored.leaseToken, now: required.clock.now({}) });
            return claimed ? get(input) : { ok: true, value: null };
        },
        async finish(input) {
            if (!jobFinishSchema.safeParse(input).success) return localFailure({ code: 'invalid_input', message: 'Invalid campaign job completion' });
            const current = await get({ context: input.context, operationId: input.operationId });
            if (!current.ok) return current;
            if (!current.value || current.value.status === 'queued') return localFailure({ code: 'conflict', message: 'Unclaimed campaign cannot finish' });
            return database.transaction({ context: input.context, execute: async ({ session }) => {
                const state = input.status === 'submitted' ? 'succeeded' : 'reconcile';
                const saved = await session.query({ sql: "UPDATE job SET state=$1, lease_token=NULL, lease_expires_at=NULL WHERE id=$2 AND tenant_id=$3 AND state IN ('dispatching','reconcile','succeeded') RETURNING id",
                    parameters: [state, current.value!.jobId, jobTenant(input)] });
                if (!saved.rows.length) return localFailure({ code: 'conflict', message: 'Campaign claim changed' });
                await journal({ session, id: current.value!.jobId, tenantId: jobTenant(input), event: 'complete', state, now: required.clock.now({}) });
                return { ok: true, value: undefined };
            } });
        },
    };
    return { enqueue: input => campaignBoundary({ ...required, context: input.context, execute: () => ports.enqueue(input) }),
        get: input => campaignBoundary({ ...required, context: input.context, execute: () => ports.get(input) }),
        claim: input => campaignBoundary({ ...required, context: input.context, execute: () => ports.claim(input) }),
        finish: input => campaignBoundary({ ...required, context: input.context, execute: () => ports.finish(input) }) };
}
/** Map port/driver faults to typed values and payload-free correlated diagnostics. */
async function campaignBoundary<T>(required: { context: CallContext; observer: ObserverPort; execute: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
    let result: Outcome<T>;
    try { result = await required.execute(); }
    catch (error) { result = localFailure({ code: error instanceof JobStoreError ? error.code : 'unavailable', message: 'Campaign jobs boundary unavailable' }); }
    try { required.observer.observe({ operation: 'server.campaign.jobs', outcome: result.ok ? 'ok' : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); } catch { /* Diagnostics cannot change intent. */ }
    return result;
}
/** Only the explicitly named sandbox account/connection/creative is admitted. Local halt is
 * rechecked on creation and immediately before the fixture handoff; launch is always denied. */
function sandboxCampaignSafety(required: { safety: SafetyRepoPort }): CampaignSafetyPort {
    async function authorize(input: Parameters<CampaignSafetyPort['authorizeCreation']>[0]): Promise<Outcome<{ permitId: string }>> {
        if (input.draft.accountId !== 'sandbox-account' || input.draft.connectionId !== 'sandbox-campaigns') return localFailure({ code: 'forbidden', message: 'Local drafts require sandbox-account and sandbox-campaigns' });
        const current = await required.safety.snapshot({ context: input.context, accountId: input.draft.accountId });
        if (!current.ok) return current;
        if (current.value.halted) return localFailure({ code: 'forbidden', message: 'Sandbox account halted' });
        return { ok: true, value: { permitId: 'sandbox:' + input.draft.operationId } };
    }
    return { authorizeCreation: authorize,
        async dispatchCreation(input) { const permit = await authorize(input); return permit.ok ? input.execute(permit.value) : permit; },
        async authorize() { return localFailure({ code: 'forbidden', message: 'I-2: exact launch binding required' }); },
        async dispatchLaunch() { return localFailure({ code: 'forbidden', message: 'I-2: exact launch binding required' }); },
    };
}
/** Fixture readback is derived from the persisted paused draft and labelled as sandbox evidence. */
function sandboxCampaignBackend(required: { repo: CampaignRepoPort; clock: ClockPort }): CampaignCapabilityPort {
    return { async createPaused(input) { return { ok: true, value: { campaignId: input.campaignId, desiredState: 'paused', observedState: 'paused' } }; },
        async launch() { return localFailure({ code: 'forbidden', message: 'Local fixture cannot launch' }); },
        async readState(input) {
            const record = await required.repo.get({ context: input.context, campaignId: input.campaignId });
            if (!record.ok) return record;
            if (!record.value) return localFailure({ message: 'Sandbox campaign unavailable' });
            return { ok: true, value: { state: { campaignId: input.campaignId, state: 'paused', observedAt: required.clock.now({}), providerReference: 'sandbox:' + input.campaignId },
                hierarchy: [{ entityId: input.campaignId, state: 'paused' }], complete: true, operationId: record.value.draft.operationId } };
        } };
}
/** Real campaign service and repository, single durable jobs outbox, explicit local fixture ports.
 * Fixture creative ID is sandbox-creative and its digest is SHA-256 of ["sandbox-creative"]. */
export function bindSandboxCampaigns(required: { unit: UnitOfWork; repo: CampaignRepoPort; safety: SafetyRepoPort; clock: ClockPort; ids: IdPort; observer: ObserverPort; audit: AuditService }) {
    return createCampaignService({ ...required, jobs: bindCampaignJobs(required), safety: sandboxCampaignSafety(required),
        capabilities: sandboxCampaignBackend(required), audit: catalogAuditPort(required), assets: { async resolve({ creativeIds }) {
            if (creativeIds.length !== 1 || creativeIds[0] !== 'sandbox-creative') return localFailure({ code: 'unavailable', message: 'Local fixture creative is sandbox-creative' });
            const digest = digestArguments({ arguments: ['sandbox-creative'] });
            return digest.ok ? { ok: true, value: { creativeDigest: digest.value } } : digest;
        } },
    }, { observer: required.observer });
}
