/** Local fixture backend and transactional campaign adapter over the ONE jobs outbox. */
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { callContextSchema, idSchema, boundedJsonSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createCampaignService, neutralCampaignLaunchSchema } from '@open-marketing/campaigns';
import type { NeutralCampaignLaunch } from '@open-marketing/campaigns';
import type { CampaignRepoPort, CampaignJobPort, CampaignJob, CampaignSafetyPort, CampaignCapabilityPort } from '@open-marketing/campaigns';
import { createSqlJobRepo, jobTenant, JobStoreError } from '@open-marketing/jobs';
import type { JobsSqlSession } from '@open-marketing/jobs';
import type { CampaignConstituent, ConfirmationExchangePort, DispatchPermit, EffectRequest, FrozenDispatchRequest, SafetyRepoPort, SafetyService } from '@open-marketing/safety';
import { digestArguments, effectRequestSchema } from '@open-marketing/safety';
import type { AuditService } from '@open-marketing/audit';
import { catalogAuditPort } from './catalog.js';
import { jobsDatabase, formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';
import { bindAgentPluginJobs } from './agent-plugin-backends.js';
import { toolInputSchema } from '../om-tools.js';
import type { OmToolDefinition } from '../om-tools.js';

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

const deploymentInput = z.strictObject({ campaignId: idSchema });
const childArguments = z.strictObject({ tool: idSchema, input: z.record(z.string(), boundedJsonSchema) });
const childSelection = z.object({ operationId: idSchema, connectionId: idSchema, accountId: idSchema });
const hierarchyEvidence = z.strictObject({ complete: z.literal(true), entities: z.array(z.strictObject({ operationId: idSchema, entityId: idSchema, state: z.enum(['paused', 'draft']) })).min(1).max(500), outcomes: z.array(boundedJsonSchema).max(4).optional() });
const acknowledgement = z.object({ entityIds: z.array(idSchema).min(1).max(500).refine(ids => new Set(ids).size === ids.length) });

/** Bind the neutral deployment to the existing catalog, exact confirmations and ONE outbox.
 * Only closed plugin-owned sequences are accepted; fixed parent slots stay inside each plugin.
 * No implicit activation, rollback, replay, metadata resolver or worker is constructed.
 * @example services.campaignDeployment = bindPausedCampaignDeployment({ ...ports, prepare, definitions, read });
 * @complexity <=4 sequential destinations and <=500 evidence entities, total review <=64KiB. */
export function bindPausedCampaignDeployment(required: {
    unit: UnitOfWork; repo: CampaignRepoPort; safety: SafetyService; confirmations: ConfirmationExchangePort; clock: ClockPort; ids: IdPort; observer: ObserverPort;
    prepare(input: { context: CallContext; campaign: NeutralCampaignLaunch; operationId: string }): Promise<Outcome<readonly CampaignConstituent[]>>;
    definitions(input: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>>;
    execute(input: { context: CallContext; call: CampaignConstituent; authorization: FrozenDispatchRequest; permit: DispatchPermit; signal?: AbortSignal;
        checkpoint(input: { step: string; phase: string; references?: unknown; record?: unknown }): Promise<Outcome<void>> }): Promise<Outcome<unknown>>;
    read(input: { context: CallContext; request: FrozenDispatchRequest; jobId: string }): Promise<Outcome<unknown>>;
}): OmToolDefinition {
    const jobs = bindAgentPluginJobs(required);
    const name = 'om_campaign_deploy_paused';
    /** All destinations must prepare before the owning review; snapshot every executable/schema.
     * @complexity <=4 targets, no credentials or egress in preparation. */
    async function prepareEffect(input: { context: CallContext; call: import('@open-marketing/contracts').ToolCall }): Promise<Outcome<EffectRequest>> {
        const parsed = deploymentInput.safeParse(input.call.input);
        if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Invalid neutral campaign key' });
        const stored = await required.repo.getNeutral({ context: input.context, ...parsed.data });
        if (!stored.ok) return stored;
        if (!stored.value) return localFailure({ code: 'forbidden', message: 'Neutral draft unavailable in scope' });
        const campaign = neutralCampaignLaunchSchema.parse(stored.value.campaign);
        if (campaign.schedule.window.end <= required.clock.now({})) return localFailure({ code: 'expired', message: 'Campaign schedule has ended' });
        const prepared = await required.prepare({ context: input.context, campaign, operationId: input.call.operationId });
        if (!prepared.ok) return prepared;
        const calls = prepared.value;
        const checked = await checkCalls({ context: input.context, campaign, calls });
        if (!checked.ok) return checked;
        const args = { tool: name, input: parsed.data, campaign, budgetSemantics: 'Configured daily budgets are not hard spending caps. Exposure is per destination; no currency totals.', calls };
        const digest = digestArguments({ arguments: args });
        if (!digest.ok) return digest;
        const effect: EffectRequest = { arguments: args, pausedCampaignCalls: calls, pluginDigest: digest.value, schemaFingerprint: digest.value,
            envelope: { operationId: input.call.operationId, connectionId: name, accountId: null, effects: ['ad_spend'], argumentsDigest: digest.value, moneyExposure: null, requiredLimit: null } };
        return boundedJsonSchema.safeParse(effect).success ? { ok: true, value: effect } : localFailure({ code: 'limit_exceeded', message: 'Prepared campaign exceeds operation payload bounds' });
    }
    /** Require every target to have a call and every call to name a reviewed target and current tool.
     * @complexity <=4 lookups, no external I/O beyond bounded catalog discovery. */
    async function checkCalls(input: { context: CallContext; campaign: NeutralCampaignLaunch; calls: readonly CampaignConstituent[] }): Promise<Outcome<void>> {
        if (input.calls.length !== input.campaign.targets.length) return localFailure({ code: 'invalid_input', message: 'Campaign requires one sequence per destination' });
        const covered = new Set<string>();
        for (const call of input.calls) {
            const target = input.campaign.targets.find(target => target.connectionId === call.envelope.connectionId && target.accountId === call.envelope.accountId && targetsPlugin({ call, pluginId: target.pluginId }));
            if (!target) return localFailure({ code: 'forbidden', message: 'Constituent outside neutral destinations' });
            const definition = await currentDefinition({ context: input.context, call });
            if (!definition.ok) return definition;
            covered.add(JSON.stringify([target.pluginId, target.connectionId, target.accountId]));
        }
        return covered.size === input.campaign.targets.length ? { ok: true, value: undefined } : localFailure({ code: 'conflict', message: 'A destination has no prepared calls' });
    }
    /** Re-resolve lifecycle/account/executable fences through the existing catalog before each effect. */
    async function currentDefinition(input: { context: CallContext; call: CampaignConstituent }): Promise<Outcome<OmToolDefinition>> {
        const args = childArguments.safeParse(input.call.arguments);
        if (!args.success) return localFailure({ code: 'invalid_input', message: 'Invalid constituent arguments' });
        const selection = childSelection.safeParse(args.data.input);
        if (!selection.success || selection.data.operationId !== input.call.envelope.operationId || selection.data.connectionId !== input.call.envelope.connectionId || selection.data.accountId !== input.call.envelope.accountId) return localFailure({ code: 'conflict', message: 'Constituent identity differs from its exact call' });
        const catalog = await required.definitions({ context: input.context });
        if (!catalog.ok) return catalog;
        const definition = catalog.value.find(tool => tool.name === args.data.tool);
        if (!definition || definition.unavailableReason || definition.policy !== 'write' || definition.revision !== input.call.pluginDigest) return localFailure({ code: 'conflict', message: 'Campaign executable unavailable or changed' });
        const fingerprint = digestArguments({ arguments: definition.inputSchema });
        if (!fingerprint.ok || fingerprint.value !== input.call.schemaFingerprint) return localFailure({ code: 'conflict', message: 'Campaign schema changed' });
        const valid = definition.parse({ input: args.data.input });
        return valid.ok ? { ok: true, value: definition } : valid;
    }
    /** Immutable intent and enqueue are one outbox row; claimed/unknown identities never replay. */
    async function deploy(input: Parameters<OmToolDefinition['invoke']>[0]): Promise<Outcome<unknown>> {
        const request = input.authorization && structuredClone(input.authorization);
        if (!request?.pausedCampaignCalls || request.arguments.tool !== name) return localFailure({ code: 'forbidden', message: 'Owning exact campaign approval required' });
        // Dispatch-only fields are removed before validating the frozen effect snapshot.
        const { approvalId: _approval, policyRevision: _policy, ...effect } = request;
        if (!effectRequestSchema.safeParse(effect).success) return localFailure({ code: 'invalid_input', message: 'Invalid frozen campaign intent' });
        const payload = boundedJsonSchema.safeParse(request);
        if (!payload.success) return localFailure({ code: 'limit_exceeded', message: 'Frozen campaign payload exceeds operation bounds' });
        const digest = digestArguments({ arguments: input.input });
        const reviewed = digestArguments({ arguments: request.arguments.input });
        if (!digest.ok || !reviewed.ok || digest.value !== reviewed.value) return localFailure({ code: 'conflict', message: 'Campaign input changed after review' });
        const approved = await required.confirmations.verify({ context: input.context, request, classification: 'spend' });
        if (!approved.ok) return approved;
        const draft = await reviewedDraft({ context: input.context, request });
        if (!draft.ok) return draft;
        return jobs.dispatch({ context: input.context, pluginId: 'om-campaigns', input: { operationId: request.envelope.operationId, connectionId: name, accountId: null, arguments: { intent: 'deploy-paused', request: payload.data } },
            execute: async ({ jobId }) => {
                const expected: string[] = [];
                for (const [index, call] of request.pausedCampaignCalls!.entries()) {
                    const result = await dispatchChild({ context: input.context, request, call, index, jobId, signal: input.signal });
                    await checkpoint({ context: input.context, jobId, event: 'campaign_outcome', evidence: { operationId: call.envelope.operationId, result } });
                    if (!result.ok) {
                        await recordRemaining({ context: input.context, jobId, calls: request.pausedCampaignCalls!.slice(index + 1) });
                        return result;
                    }
                    const ack = acknowledgement.parse(result.value);
                    expected.push(...ack.entityIds.map(entityId => JSON.stringify([call.envelope.operationId, entityId])));
                    if (expected.length > 500) return localFailure({ code: 'limit_exceeded', message: 'Campaign hierarchy exceeds evidence bound; reconcile only' });
                }
                const read = await required.read({ context: input.context, request, jobId });
                if (!read.ok) return read;
                const evidence = hierarchyEvidence.safeParse(read.value);
                if (!evidence.success) return localFailure({ message: 'Complete non-serving hierarchy evidence required; reconcile only' });
                const observed = new Set(evidence.data.entities.map(entity => JSON.stringify([entity.operationId, entity.entityId])));
                if (observed.size !== evidence.data.entities.length || observed.size !== expected.length || !expected.every(key => observed.has(key))) return localFailure({ message: 'Hierarchy evidence differs from acknowledged references; reconcile only' });
                const outcomes = evidence.data.outcomes ?? [];
                return { ok: true, value: { status: 'submitted', operationId: request.envelope.operationId, hierarchy: evidence.data, outcomes } };
            } });
    }
    /** Record destinations deliberately skipped after the first failure; never schedule them. */
    async function recordRemaining(input: { context: CallContext; jobId: string; calls: readonly CampaignConstituent[] }): Promise<void> {
        for (const call of input.calls) await checkpoint({ ...input, event: 'campaign_outcome', evidence: { operationId: call.envelope.operationId, status: 'not_attempted' } });
    }
    /** Existing safety holds the account halt barrier and rechecks the owning card at every handoff.
     * Durable dispatch and acknowledgement checkpoints survive cancellation and restart. */
    async function dispatchChild(input: { context: CallContext; request: FrozenDispatchRequest; call: CampaignConstituent; index: number; jobId: string; signal?: AbortSignal }): Promise<Outcome<unknown>> {
        const authority: FrozenDispatchRequest = { ...input.call, approvalId: input.request.approvalId, policyRevision: input.request.policyRevision,
            campaignApproval: { operationId: input.request.envelope.operationId, argumentsDigest: input.request.envelope.argumentsDigest, index: input.index } };
        const draft = await reviewedDraft(input);
        if (!draft.ok) return draft;
        const definition = await currentDefinition(input);
        if (!definition.ok) return definition;
        await checkpoint({ ...input, event: 'campaign_dispatch', evidence: { operationId: input.call.envelope.operationId } });
        return required.safety.withDispatch({ context: input.context, request: authority, dispatch: async ({ permit, request: verified }) => {
            const result = await required.execute({ context: input.context, call: input.call, authorization: verified, permit, signal: input.signal,
                checkpoint: evidence => jobs.checkpoint({ context: input.context, jobId: input.jobId, event: 'campaign_step.' + input.call.envelope.operationId + '.' + evidence.step, evidence: { ...evidence, operationId: input.call.envelope.operationId } }) });
            if (!result.ok) return result;
            const bounded = boundedJsonSchema.safeParse(result.value);
            if (!bounded.success) return localFailure({ message: 'Constituent evidence exceeds bounds; reconcile only' });
            await checkpoint({ ...input, event: 'campaign_result', evidence: { operationId: input.call.envelope.operationId, result: bounded.data } });
            if (z.object({ status: z.enum(['unknown', 'failed', 'pending']) }).safeParse(bounded.data).success) return localFailure({ message: 'Constituent outcome uncertain; stop and reconcile only' });
            await checkpoint({ ...input, event: 'campaign_ack', evidence: { operationId: input.call.envelope.operationId, result: bounded.data } });
            if (!acknowledgement.safeParse(bounded.data).success) return localFailure({ message: 'Acknowledged hierarchy references unavailable; reconcile only' });
            return result;
        } }, { signal: input.signal });
    }
    /** Append bounded evidence in the existing attempts journal; never overwrite prior references. */
    async function checkpoint(input: { context: CallContext; jobId: string; event: string; evidence: unknown }): Promise<void> {
        await required.unit.transaction({ work: ({ session }) => session.query({ text: 'INSERT INTO job_attempt (job_id,sequence,tenant_id,attempt,event_type,state,observed_at,evidence_id) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,1,$3,$4,$5,$6 FROM job_attempt WHERE job_id=$1',
            values: [input.jobId, jobTenant(input), input.event, 'dispatching', required.clock.now({}), JSON.stringify(input.evidence)] }) });
    }
    /** Recheck the persisted neutral snapshot before enqueue and before each constituent.
     * @complexity One indexed read and bounded JSON comparisons; no metadata resolution. */
    async function reviewedDraft(input: { context: CallContext; request: FrozenDispatchRequest }): Promise<Outcome<void>> {
        const key = deploymentInput.safeParse(input.request.arguments.input);
        if (!key.success) return localFailure({ code: 'invalid_input', message: 'Invalid reviewed draft key' });
        const current = await required.repo.getNeutral({ context: input.context, ...key.data });
        if (!current.ok) return current;
        const expected = digestArguments({ arguments: input.request.arguments.campaign });
        const actual = digestArguments({ arguments: current.value?.campaign ?? null });
        if (!expected.ok || !actual.ok || expected.value !== actual.value) return localFailure({ code: 'conflict', message: 'Reviewed neutral campaign changed or is unavailable' });
        return { ok: true, value: undefined };
    }
    return { name, description: 'Deploy a saved neutral traffic campaign paused/draft. One exact review shows each destination and finite call; activation needs another exact card. Unsupported or unadmitted targets fail before approval.', capability: 'Campaign paused deployment', effects: ['ad_spend'], policy: 'spend', revision: '1', safety: required.safety,
        inputSchema: toolInputSchema({ schema: deploymentInput }), parse: input => { const parsed = deploymentInput.safeParse(input.input); return parsed.success ? { ok: true, value: parsed.data } : localFailure({ code: 'invalid_input', message: 'Invalid neutral campaign key' }); }, prepareEffect, invoke: deploy };
}
/** Bind a constituent to the named plugin's existing catalog namespace; no cross-plugin authority. */
function targetsPlugin(required: { call: CampaignConstituent; pluginId: string }): boolean {
    const args = childArguments.safeParse(required.call.arguments);
    return args.success && args.data.tool.startsWith('vendor_' + required.pluginId.replaceAll('-', '_') + '_');
}
