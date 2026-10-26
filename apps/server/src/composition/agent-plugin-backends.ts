/** Bundled vendor namespaces contribute to the ONE catalog. Vendor codecs stay in their packages. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { addonToolEffectsSchema, boundedJsonSchema, dailyLimitRequirementSchema, haltStopRequestSchema, idSchema, moneyExposureSchema, parseBoundary, scopeSchema, toolDescriptorSchema } from '@open-marketing/contracts';
import type { CallContext, CallOptions, ClockPort, HaltStopPermit, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { digestArguments, effectRequestSchema } from '@open-marketing/safety';
import type { AccountDispatchLockPort, SafetyRepoPort, SafetyService } from '@open-marketing/safety';
import type { CampaignConstituent, ConfirmationExchangePort, DispatchPermit, FrozenDispatchRequest } from '@open-marketing/safety';
import type { NeutralCampaignLaunch } from '@open-marketing/contracts';
import type { AccountBindingLookupPort } from '@open-marketing/workspaces';
import { createSqlJobRepo, createSqlOutboxStore, jobTenant } from '@open-marketing/jobs';
import type { JobsSqlSession, LeaseFence, ManagedOutboxStore } from '@open-marketing/jobs';
import { createConversionDispatcher, createMeasurementShareabilityAdapter } from '@open-marketing/measure';
import type { ConversionDeliveryPort } from '@open-marketing/measure';
import type { PolicyService } from '@open-marketing/policy';
import type { Integrations } from '../integrations.js';
import { toolPolicy } from '../om-tools.js';
import type { OmToolDefinition } from '../om-tools.js';
import { formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';
import { processingAllowed } from './identity.js';
import type { createSubjectLane } from './subject-lane.js';

/** Internal lifecycle projection; admission is read from installed manifest/capabilities, never chat. */
export type AgentPluginState = { enabled: boolean; bundled: boolean; admitted: boolean; revision: string; metadata: Record<string, unknown>; effects?: string[] };
/** Native namespace import and fetch are injected by serve; fixtures replace both without networking. */
export type AgentPluginEffects = { fetch: typeof fetch; loadModule(required: { moduleUrl: string }): Promise<object>;
    moduleDigest(required: { moduleUrl: string }): Promise<string>;
    wait(required: { milliseconds: number }, optional?: CallOptions): Promise<Outcome<void>> };
type ConversionStorage = { unit: UnitOfWork; policyForTransaction(required: { unit: UnitOfWork }): PolicyService };
type Dependencies = AgentPluginEffects & { projectRoot: string; clock: ClockPort; observer: ObserverPort;
    state(required: { context: CallContext; pluginId: string }): Promise<AgentPluginState | null>;
    integrations: Pick<Integrations, 'access'> & Partial<Pick<Integrations, 'resolveDeveloperToken'>>; accounts: AccountBindingLookupPort; safetyRepo: Pick<SafetyRepoPort, 'snapshot'>;
    jobs: ReturnType<typeof bindAgentPluginJobs>; safety?: SafetyService; confirmations?: ConfirmationExchangePort; accountLocks: AccountDispatchLockPort; subjectLane: ReturnType<typeof createSubjectLane> }
    & ({ mode: 'production' } & ConversionStorage | { mode: 'read_only' | 'sandbox' } & Partial<ConversionStorage>);
type Namespace = Record<string, unknown>;
type Adapter = { invoke(required: Record<string, unknown>, optional?: CallOptions): Promise<Outcome<unknown>> };
type Factory<T> = (required: Record<string, unknown>) => T;
type Contribution = { name: string; description: string; inputSchema: Record<string, unknown>; effects: readonly string[]; parse(required: { input: unknown }): Outcome<unknown> };
const pluginIds = ['google-ads', 'linkedin-ads', 'tiktok-ads', 'meta-ads', 'higgsfield-media'] as const;
const selectionSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, accountId: idSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(), timezone: z.string().min(1).max(100).optional(),
    arguments: z.record(z.string(), boundedJsonSchema), moneyExposure: moneyExposureSchema.nullable().optional(), requiredLimit: dailyLimitRequirementSchema.nullable().optional() });
type Selection = z.infer<typeof selectionSchema>;
type Invocation = Parameters<OmToolDefinition['invoke']>[0];
type Execution = { dependencies: Dependencies; context: CallContext; pluginId: string; state: AgentPluginState; module: Namespace; contribution: Contribution; input: Selection; signal?: AbortSignal; stopPermit?: HaltStopPermit; authorization?: FrozenDispatchRequest; dispatchPermit?: DispatchPermit; checkpoint?: DeploymentCheckpoint; evidence?: Record<string, unknown>[] };
type DeploymentCheckpoint = (input: { step: string; phase: string; references?: unknown; record?: unknown }) => Promise<Outcome<void>>;
const deploymentName = 'campaign_deploy_paused';

/** Read enabled bundled modules on catalog discovery; namespaces contain no retained credentials.
 * Each call resolves lifecycle/account state again. A broken plugin contributes only an unavailable
 * descriptor; other plugins and the rest of the catalog remain usable.
 * @example const backends = bindAgentPluginBackends({ ...ports, fetch, loadModule });
 * @complexity <=5 module loads and <=100 descriptors/plugin; no discovery egress.
 */
export function bindAgentPluginBackends(required: Dependencies) {
    return {
        /** Resolve all finite plugin plans before approval. Only explicit scoped sandbox metadata
         * is supported; real account/assets/declarations remain NEEDS. No credentials or egress. */
        async prepareCampaign(input: { context: CallContext; campaign: NeutralCampaignLaunch; operationId: string }): Promise<Outcome<readonly CampaignConstituent[]>> {
            const calls: CampaignConstituent[] = [];
            for (const target of input.campaign.targets) {
                const prepared = await pluginJobBoundary({ ...required, context: input.context, execute: () => prepareDestination({ dependencies: required, ...input, target }) });
                if (!prepared.ok) return prepared;
                calls.push(prepared.value);
            }
            return { ok: true, value: calls };
        },
        executeCampaign: (input: CampaignExecution) => pluginJobBoundary({ ...required, context: input.context, execute: () => executeCampaign({ dependencies: required, ...input }) }),
        readCampaign: (input: { context: CallContext; request: FrozenDispatchRequest }) => pluginJobBoundary({ ...required, context: input.context, execute: () => campaignEvidence({ dependencies: required, context: input.context, operationId: input.request.envelope.operationId }) }),
        /** Measure owns inbox verification, transient contacts identifiers, durable claims and consent.
         * Incompatible plugin DTOs fail closed instead of inferring event categories or grant scope. */
        conversions(input: Omit<Parameters<typeof createConversionDispatcher>[0], 'delivery'> & { authority: ConversionAuthorityFactory }) {
            return { dispatch: (request: ConversionDispatchInput, options?: CallOptions) => dispatchConversion({ dependencies: required, dispatcher: input, input: request }, options) };
        },
        haltStop: (input: { context: CallContext; pluginId: string; permit: HaltStopPermit }) => haltStop({ dependencies: required, ...input }),
        async definitions({ context }: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> {
            const definitions: OmToolDefinition[] = [];
            for (const pluginId of pluginIds) definitions.push(...await pluginDefinitions({ dependencies: required, context, pluginId }));
            definitions.push(campaignReconciliation({ dependencies: required }));
            return { ok: true, value: definitions };
        },
    };
}

/** One reviewed constituent per target; translators own all vendor fields and fixed parent slots.
 * @complexity One bounded bundle/catalog read; fixture metadata <=64 KiB. */
async function prepareDestination(required: { dependencies: Dependencies; context: CallContext; campaign: NeutralCampaignLaunch; operationId: string; target: NeutralCampaignLaunch['targets'][number] }): Promise<Outcome<CampaignConstituent>> {
    const { dependencies, context, target } = required;
    const state = await dependencies.state({ context, pluginId: target.pluginId });
    if (!state?.enabled || !state.admitted) return localFailure({ message: 'Plugin unadmitted: ' + target.pluginId });
    const fixture = z.object({ scope: scopeSchema, connectionId: idSchema, resolved: boundedJsonSchema }).safeParse(state.metadata.campaignFixture);
    if (dependencies.mode !== 'sandbox' || !fixture.success) return localFailure({ code: 'not_implemented', message: 'NEEDS: scoped campaign account, creative and declaration metadata' });
    if (fixture.data.scope.ownerId !== context.scope.ownerId || fixture.data.scope.workspaceId !== context.scope.workspaceId || fixture.data.connectionId !== target.connectionId) return localFailure({ code: 'forbidden', message: 'Campaign metadata outside scope' });
    const definitions = await pluginDefinitions({ dependencies, context, pluginId: target.pluginId });
    const definition = definitions.find(tool => tool.name.endsWith('_' + deploymentName));
    if (!definition || definition.unavailableReason) return localFailure({ message: 'Campaign deployment unavailable' });
    const module = { ...await dependencies.loadModule({ moduleUrl: bundledModuleUrl({ dependencies, pluginId: target.pluginId }) + '?revision=' + definition.revision }) };
    const translated = exported<(input: Record<string, unknown>) => Outcome<unknown>>({ module, name: 'translateCampaign' })({ campaign: required.campaign, target, resolved: fixture.data.resolved });
    if (!translated.ok) return translated;
    const args = { tool: definition.name, input: { operationId: hash({ value: [required.operationId, target] }), connectionId: target.connectionId, accountId: target.accountId,
        currency: target.dailyBudget.currency, timezone: required.campaign.schedule.timezone, arguments: { plan: translated.value } } };
    const valid = definition.parse({ input: args.input });
    if (!valid.ok) return valid;
    return { ok: true, value: { arguments: boundedJsonSchema.parse(args) as CampaignConstituent['arguments'], pluginDigest: definition.revision,
        schemaFingerprint: canonicalDigest({ value: definition.inputSchema }),
        envelope: { operationId: args.input.operationId, connectionId: target.connectionId, accountId: target.accountId, effects: ['write'], argumentsDigest: canonicalDigest({ value: args }), moneyExposure: null, requiredLimit: null } } };
}
function canonicalDigest(required: { value: unknown }): string { const result = digestArguments({ arguments: required.value }); if (!result.ok) throw new Error('Invalid campaign digest'); return result.value; }

/** Reuse each plugin's closed plan parser, never a host-owned vendor schema. */
function deploymentContribution(required: { pluginId: string; module: Namespace }): Contribution[] {
    if (!['google-ads', 'meta-ads', 'linkedin-ads', 'tiktok-ads'].includes(required.pluginId)) return [];
    const google = required.pluginId === 'google-ads';
    const schema = required.module.campaignDeploymentPlanSchema as z.ZodType;
    const plan = google ? required.module.planSchema as Record<string, unknown> : z.toJSONSchema(schema, { io: 'input' });
    return [{ name: deploymentName, description: 'Fixed PAUSED/DRAFT creation sequence; owning campaign approval required', effects: ['write'],
        inputSchema: { type: 'object', properties: { plan }, required: ['plan'], additionalProperties: false },
        parse: input => { const parsed = z.strictObject({ plan: boundedJsonSchema }).safeParse(input.input);
            if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Invalid deployment plan' });
            return google ? exported<(input: Record<string, unknown>) => Outcome<unknown>>({ module: required.module, name: 'parse' })({ schema: plan, input: parsed.data.plan }) : parseBoundary({ schema, input: parsed.data.plan }); } }];
}
type CampaignExecution = { context: CallContext; call: CampaignConstituent; authorization?: FrozenDispatchRequest; permit?: DispatchPermit; checkpoint: DeploymentCheckpoint; evidence?: Record<string, unknown>[]; signal?: AbortSignal };
/** The caller holds the owning safety lock and job; this path never claims another job/lock. */
async function executeCampaign(required: CampaignExecution & { dependencies: Dependencies }): Promise<Outcome<unknown>> {
    const authority = campaignExecutionAuthority(required);
    if (!authority.ok) return authority;
    const args = z.object({ tool: idSchema, input: selectionSchema }).parse(required.call.arguments);
    const pluginId = pluginIds.find(id => args.tool === 'vendor_' + id.replaceAll('-', '_') + '_' + deploymentName);
    if (!pluginId) return localFailure({ code: 'forbidden', message: 'Invalid campaign executable' });
    const state = await required.dependencies.state({ context: required.context, pluginId });
    if (!state?.admitted || !state.enabled || !state.bundled) return localFailure({ message: 'Campaign plugin unadmitted' });
    const revision = await executableRevision({ ...required, pluginId, state });
    if (revision !== required.call.pluginDigest) return localFailure({ code: 'conflict', message: 'Campaign executable changed' });
    const module = { ...await required.dependencies.loadModule({ moduleUrl: bundledModuleUrl({ ...required, pluginId }) + '?revision=' + revision }) };
    const contribution = deploymentContribution({ pluginId, module })[0]!;
    if (required.evidence) contribution.effects = ['read'];
    const execution: Execution = { ...required, state: { ...state, revision }, module, pluginId, contribution, input: args.input, dispatchPermit: required.permit };
    if (canonicalDigest({ value: definition(execution).inputSchema }) !== required.call.schemaFingerprint) return localFailure({ code: 'conflict', message: 'Campaign schema changed' });
    if (!await bindingCurrent(execution) || !await campaignAuthorityCurrent(execution)) return localFailure({ code: 'forbidden', message: 'Campaign authority changed' });
    return pluginJobBoundary({ ...required.dependencies, context: required.context, execute: () => deployment(execution) });
}
/** Writes need the owning sandbox authority and exact frozen arguments; reads never borrow it. */
function campaignExecutionAuthority(required: CampaignExecution & { dependencies: Dependencies }): Outcome<void> {
    if (required.evidence) return { ok: true, value: undefined };
    if (required.dependencies.mode !== 'sandbox') return localFailure({ code: 'forbidden', message: 'NEEDS: verified production campaign binding; local mode is read-only' });
    if (!required.permit || !required.authorization?.campaignApproval) return localFailure({ code: 'forbidden', message: 'Owning campaign authority required' });
    if (canonicalDigest({ value: required.call.arguments }) !== canonicalDigest({ value: required.authorization.arguments })) return localFailure({ code: 'conflict', message: 'Campaign arguments changed' });
    return { ok: true, value: undefined };
}

/** Recovery loads only scoped immutable intent and saved IDs/markers. Never dispatches creation.
 * @complexity <=4 destinations, <=128 bounded journal records; vendor reads use plugin timeouts. */
function campaignReconciliation(required: { dependencies: Dependencies }): OmToolDefinition {
    const schema = z.strictObject({ operationId: idSchema });
    return { name: 'om_campaign_reconcile_deployment', capability: 'Campaign deployment read-only reconciliation', description: 'Read saved deployment references/markers and append observations. Never creates, retries or resumes a campaign.',
        effects: ['read'], policy: 'read', revision: '1', inputSchema: toolDescriptorSchema.shape.inputSchema.parse(z.toJSONSchema(schema)), parse: input => parseBoundary({ schema, input: input.input }),
        invoke: input => pluginJobBoundary({ ...required.dependencies, context: input.context, execute: async () => {
            const key = schema.parse(input.input);
            const saved = await required.dependencies.jobs.history({ context: input.context, ...key });
            if (!saved.ok) return saved;
            const payload = z.object({ payload: z.object({ pluginId: z.literal('om-campaigns'), input: z.object({ arguments: z.object({ intent: z.literal('deploy-paused'), request: effectRequestSchema.passthrough() }) }) }) }).parse(saved.value.payload);
            const calls = payload.payload.input.arguments.request.pausedCampaignCalls ?? [];
            for (const call of calls) {
                const evidence = saved.value.evidence.filter(item => item.operationId === call.envelope.operationId);
                if (!evidence.some(item => item.status !== 'not_attempted')) continue;
                const result = await executeCampaign({ ...required, context: input.context, call, evidence, signal: input.signal,
                    checkpoint: item => required.dependencies.jobs.checkpoint({ context: input.context, jobId: saved.value.jobId, event: 'campaign_observation', evidence: { ...item, operationId: call.envelope.operationId } }) });
                const observation = reconciliationObservation({ result, evidence });
                const appended = await required.dependencies.jobs.checkpoint({ context: input.context, jobId: saved.value.jobId, event: 'campaign_result', evidence: { operationId: call.envelope.operationId, result: observation } });
                if (!appended.ok) return appended;
            }
            return campaignEvidence({ ...required, context: input.context, ...key });
        } }) };
}
const deploymentReferencesSchema = z.record(idSchema, idSchema).refine(refs => Object.keys(refs).length <= 500);
const deploymentReceiptSchema = z.object({ status: z.enum(['acknowledged', 'unknown']), entityIds: z.array(idSchema).max(500),
    references: z.union([z.array(idSchema).max(500), deploymentReferencesSchema]).optional() }).passthrough();
/** Select a receipt, never its Outcome wrapper or malformed later evidence.
 * @complexity O(n*b) time, O(n+b) space; <=128 entries of <=64 KiB each, no I/O. */
function latestDeploymentReceipt(required: { evidence: Record<string, unknown>[] }): z.infer<typeof deploymentReceiptSchema> | undefined {
    for (const entry of required.evidence.slice().reverse()) {
        const receipt = deploymentReceiptSchema.safeParse(entry.result);
        if (receipt.success) return receipt.data;
    }
    return undefined;
}
/** A failed read cannot erase validated references or claim they are current. O(n) bounded history. */
function reconciliationObservation(required: { result: Outcome<unknown>; evidence: Record<string, unknown>[] }): unknown {
    if (required.result.ok) return required.result.value;
    return { ...latestDeploymentReceipt(required), status: 'unknown' };
}
/** Summarize saved verified receipts; incomplete/missing references never establish success. */
async function campaignEvidence(required: { dependencies: Dependencies; context: CallContext; operationId: string }): Promise<Outcome<unknown>> {
    const saved = await required.dependencies.jobs.history(required);
    if (!saved.ok) return saved;
    const payload = z.object({ payload: z.object({ pluginId: z.literal('om-campaigns'), input: z.object({ arguments: z.object({ request: effectRequestSchema.passthrough() }) }) }) }).parse(saved.value.payload);
    const calls = payload.payload.input.arguments.request.pausedCampaignCalls ?? [];
    const outcomes = calls.map(call => {
        const entries = saved.value.evidence.filter(item => item.operationId === call.envelope.operationId);
        const receipt = latestDeploymentReceipt({ evidence: entries });
        return { operationId: call.envelope.operationId, tool: String(call.arguments.tool), connectionId: call.envelope.connectionId, accountId: call.envelope.accountId,
            result: receipt ?? { status: entries.some(item => item.status !== 'not_attempted') ? 'unknown' : 'not_attempted' } };
    });
    const entities = outcomes.flatMap((item, index) => z.object({ status: z.literal('acknowledged'), entityIds: z.array(idSchema).min(1).max(500) }).safeParse(item.result).success
        ? (item.result as { entityIds: string[] }).entityIds.map(entityId => ({ operationId: item.operationId, entityId, state: String(calls[index]!.arguments.tool).startsWith('vendor_linkedin_ads_') ? 'draft' : 'paused' })) : []);
    const complete = outcomes.length > 0 && outcomes.every(item => z.object({ status: z.literal('acknowledged') }).safeParse(item.result).success);
    return { ok: true, value: { complete, entities, outcomes } };
}

type ConversionAuthority = Pick<Parameters<typeof createConversionDispatcher>[0], 'policy' | 'grants' | 'audit'>;
/** Bind current evidence, grant and audit to this unit; final policy is always measure's bridge. */
type ConversionAuthorityFactory = (required: { unit: UnitOfWork }) => Omit<ConversionAuthority, 'policy'>
    & Pick<Parameters<typeof createMeasurementShareabilityAdapter>[0], 'loadEvidence'>;
const conversionClaimSchema = z.strictObject({ jobId: idSchema, leaseToken: idSchema });
type ConversionClaim = z.infer<typeof conversionClaimSchema>;
type ConversionDispatchInput = Parameters<ReturnType<typeof createConversionDispatcher>['dispatch']>[0] & { claim: ConversionClaim };
/** A real leased outbox intent must name these exact IDs; no enqueue or second beginDispatch here. */
async function conversionJob(required: { unit: UnitOfWork; dependencies: Dependencies; input: ConversionDispatchInput }): Promise<Outcome<{ outbox: ManagedOutboxStore; fence: LeaseFence; context: CallContext }>> {
    const { serviceId, ...trace } = required.input.context;
    const context: CallContext = { ...trace, principal: { kind: 'service', serviceId } };
    const outbox = createSqlOutboxStore({ database: required.unit });
    const claim = parseBoundary({ schema: conversionClaimSchema, input: required.input.claim });
    if (!claim.ok) return claim;
    const fence = { id: claim.value.jobId, tenantId: jobTenant({ context }), token: claim.value.leaseToken, now: required.dependencies.clock.now({}) };
    const job = await outbox.get({ tenantId: fence.tenantId, id: fence.id });
    if (!job || job.state !== 'leased' || job.leaseToken !== fence.token || job.leaseExpiresAt! <= fence.now) return localFailure({ code: 'conflict', message: 'Conversion claim unavailable or expired' });
    if (job.context?.scope.ownerId !== context.scope.ownerId || job.context.scope.workspaceId !== context.scope.workspaceId) return localFailure({ code: 'forbidden', message: 'Conversion job outside scope' });
    const saved = z.object({ operationId: idSchema, handler: idSchema, idempotencyKey: idSchema, argumentsDigest: idSchema, payload: z.object({ subjectId: idSchema, eventId: idSchema, deliveryId: idSchema }) }).parse(JSON.parse(job.payload));
    if (saved.idempotencyKey !== job.idempotencyKey || saved.argumentsDigest !== job.requestDigest) return localFailure({ code: 'conflict', message: 'Conversion job envelope mismatch' });
    if (saved.handler !== job.operation || saved.operationId !== required.input.deliveryId || saved.payload.subjectId !== required.input.event.subjectId
        || saved.payload.eventId !== required.input.event.eventId || saved.payload.deliveryId !== required.input.deliveryId) return localFailure({ code: 'conflict', message: 'Conversion job identity mismatch' });
    return { ok: true, value: { outbox, fence, context } };
}
/** Commit final state and redacted evidence together; an earlier committed denial is preserved. */
async function finishConversion(required: { unit: UnitOfWork; bindAuthority: ConversionAuthorityFactory; context: CallContext; input: ConversionDispatchInput; fence: LeaseFence; result: Outcome<{ status: 'delivered' | 'unknown' }> }): Promise<Outcome<boolean>> {
    return required.unit.transaction({ work: async ({ session }): Promise<Outcome<boolean>> => {
        const outbox = createSqlOutboxStore({ database: session });
        const job = await outbox.get({ tenantId: required.fence.tenantId, id: required.fence.id });
        if (job?.state === 'denied') return { ok: true, value: false };
        const result = required.result;
        const state = result.ok && result.value.status === 'delivered' ? 'succeeded'
            : !result.ok && result.error.code === 'forbidden' && job?.state === 'leased' ? 'denied' : 'reconcile';
        if (!await outbox.complete(required.fence, { state })) return localFailure({ code: 'conflict', message: 'Conversion completion lost its lease; reconcile' });
        const saved = await required.bindAuthority({ unit: session }).audit.record({ context: required.context, operationId: required.input.deliveryId, outcome: 'outbox_' + state });
        return saved.ok ? { ok: true, value: state !== 'denied' } : saved;
    } });
}
/** Hold the subject family through measure's evidence append and outbox completion, with no open SQLite. */
async function dispatchConversion(required: { dependencies: Dependencies; dispatcher: Omit<Parameters<typeof createConversionDispatcher>[0], 'delivery'> & { authority: ConversionAuthorityFactory }; input: ConversionDispatchInput }, options?: CallOptions): Promise<Outcome<{ status: 'delivered' | 'unknown' }>> {
    const { dependencies } = required;
    const input = structuredClone(required.input);
    if (dependencies.mode !== 'production') return localFailure({ code: 'forbidden', message: 'Conversion storage unavailable' });
    const { serviceId, ...trace } = input.context;
    const context: CallContext = { ...trace, principal: { kind: 'service', serviceId } };
    return pluginJobBoundary({ ...dependencies, context, execute: () => dependencies.subjectLane.run({ context, subjectIds: [input.event.subjectId], work: async (): Promise<Outcome<{ status: 'delivered' | 'unknown' }>> => {
        const checked = await conversionJob({ dependencies, input, unit: dependencies.unit });
        if (!checked.ok) return checked;
        const delivery = conversionDelivery({ dependencies, authority: required.dispatcher, bindAuthority: required.dispatcher.authority, claim: input.claim });
        const dispatcher = createConversionDispatcher({ ...required.dispatcher, delivery }, { observer: dependencies.observer });
        const { claim: _claim, ...request } = input;
        const result = await dispatcher.dispatch(request, options);
        const finished = await finishConversion({ unit: dependencies.unit, bindAuthority: required.dispatcher.authority, context, input,
            fence: { ...checked.value.fence, now: dependencies.clock.now({}) }, result });
        if (!finished.ok) return finished;
        if (!finished.value) return localFailure({ code: 'forbidden', message: 'Conversion dispatch denied' });
        return result;
    } }, options) });
}
/** LinkedIn's existing backend matches measure's open definition contract. The other vendor
 * packages require owner-supplied mappings/evidence; no vendor codecs or guessed values live here.
 * Recheck grant/consent after the plugin resolves credentials and immediately before its fetch.
 * Final authorization and egress share haltAccount's injected account barrier.
 * @complexity One bundle load and bounded measure/plugin gates; no token cache or retries. */
function conversionDelivery(required: { dependencies: Dependencies; authority: ConversionAuthority; bindAuthority: ConversionAuthorityFactory; claim: ConversionClaim }): ConversionDeliveryPort {
    return { deliver: (input, options) => conversionCall({ ...required, input, action: 'deliver', signal: options?.signal }),
        reconcile: (input, options) => conversionCall({ ...required, input, action: 'reconcile', signal: options?.signal }) };
}
/** Bind one plugin call; its foreign fetch ABI holds the shared halt barrier through egress.
 * Gate failures throw only inside the plugin's typed transport boundary.
 * @complexity O(b) bounded bundle hashing time/space; one send, no retries. */
async function conversionCall(required: { dependencies: Dependencies; authority: ConversionAuthority; bindAuthority: ConversionAuthorityFactory; claim: ConversionClaim; input: Parameters<ConversionDeliveryPort['deliver']>[0]; action: 'deliver' | 'reconcile'; signal?: AbortSignal }): Promise<Outcome<{ status: 'delivered' | 'unknown' }>> {
    const { input, dependencies } = required;
    if (!input.deliveryId) return localFailure({ code: 'invalid_input', message: 'Conversion delivery identity required' });
    if (dependencies.mode !== 'production') return localFailure({ code: 'forbidden', message: 'Conversions denied in local sandbox' });
    const pluginId = 'linkedin-ads';
    const context: CallContext = { scope: input.context.scope, correlationId: input.context.correlationId, traceId: input.context.traceId,
        principal: { kind: 'service', serviceId: input.context.serviceId } };
    const loaded = await dependencies.state({ context, pluginId });
    if (!loaded?.admitted || !loaded.enabled || !loaded.bundled) return localFailure({ message: 'Conversion plugin unadmitted or unavailable' });
    const state = { ...loaded, revision: await executableRevision({ dependencies, pluginId, state: loaded }) };
    const moduleUrl = new URL(bundledModuleUrl({ dependencies, pluginId }));
    moduleUrl.searchParams.set('revision', state.revision);
    const module = { ...await dependencies.loadModule({ moduleUrl: moduleUrl.href }) };
    const configuration = z.record(z.string(), z.unknown()).parse(state.metadata.conversionConfiguration);
    if (configuration.connectionId !== input.grant.connectionId || configuration.accountId !== input.grant.accountId) return localFailure({ code: 'forbidden', message: 'Conversion connection/account mismatch' });
    const execution: Execution = { dependencies, state, module, pluginId, context, signal: required.signal,
        input: { operationId: input.deliveryId, connectionId: input.grant.connectionId, accountId: input.grant.accountId, arguments: {} },
        contribution: { name: 'conversion', description: 'Typed conversion', effects: ['conversion'], inputSchema: {}, parse: () => ({ ok: true, value: input }) } };
    const guarded = guardedFetch({ ...execution, dependencies: { ...dependencies, fetch: async (url, options) => {
        const lock = await dependencies.accountLocks.acquire({ context, accountId: input.grant.accountId }, { signal: required.signal });
        if (!lock.ok) throw new Error('Conversion account barrier unavailable');
        try {
            // The earlier guardedFetch snapshot may predate a committed halt.
            const snapshot = await dependencies.safetyRepo.snapshot({ context, accountId: input.grant.accountId }, { signal: required.signal });
            if (!snapshot.ok || snapshot.value.halted) throw new Error('Account halted');
            const authorized = await admitConversion({ ...required, execution });
            if (!authorized.ok) throw new Error('Conversion authority withdrawn');
            if (!await bindingCurrent(execution) || required.signal?.aborted || options?.signal?.aborted) throw new Error('Conversion binding changed');
            return await dependencies.fetch(url, options);
        } finally {
            const released = await dependencies.accountLocks.release({ lockId: lock.value.lockId });
            if (!released.ok) throw new Error('Conversion account barrier release failed');
        }
    } } });
    const backend = exported<Factory<Required<ConversionDeliveryPort>>>({ module, name: 'createLinkedInCapiBackend' })({
        configuration: { ...configuration, pluginDigest: state.revision }, clock: dependencies.clock, observer: dependencies.observer,
        credentials: credentials(execution), fetch: guarded,
        authority: { async dispatch(call: { execute(input: { isCurrent(): boolean }): Promise<Outcome<{ status: 'delivered' | 'unknown' }>> }) {
            const authorized = await conversionCurrent({ ...required, execution });
            return authorized.ok ? call.execute({ isCurrent: () => !required.signal?.aborted }) : authorized;
        } } });
    if (required.action === 'reconcile') return backend.reconcile({ ...input, deliveryId: input.deliveryId }, { signal: required.signal });
    return backend.deliver(input, { signal: required.signal });
}
/** Join the current authority, single outbox dispatch-start and admission evidence in one writer.
 * Expected denial commits; infrastructure failures roll back. The caller retains the subject lane
 * after COMMIT through the provider attempt and durable outcomes.
 * @complexity Bounded policy/grant reads and one append; no transaction across network I/O. */
async function admitConversion(required: { dependencies: Dependencies; bindAuthority: ConversionAuthorityFactory; claim: ConversionClaim; input: Parameters<ConversionDeliveryPort['deliver']>[0]; execution: Execution; signal?: AbortSignal }): Promise<Outcome<void>> {
    const { dependencies } = required;
    if (dependencies.mode !== 'production') return localFailure({ code: 'forbidden', message: 'Conversion storage unavailable' });
    const admitted = await dependencies.unit.transaction({ work: async ({ session }): Promise<Outcome<Outcome<void>>> => {
        const unit = session;
        const ports = required.bindAuthority({ unit });
        const authority: ConversionAuthority = { ...ports,
            policy: createMeasurementShareabilityAdapter({ clock: dependencies.clock, loadEvidence: ports.loadEvidence }, { observer: dependencies.observer }) };
        const claim = await conversionJob({ ...required, unit, input: { ...required.input, deliveryId: required.input.deliveryId!, claim: required.claim } });
        if (!claim.ok) return claim;
        const processing = await processingAllowed({ policy: dependencies.policyForTransaction({ unit }), context: required.execution.context, subjectId: required.input.event.subjectId });
        if (!processing.ok) return processing;
        const authorized = processing.value ? await conversionCurrent({ ...required, authority }) : localFailure<void>({ code: 'forbidden', message: 'Conversion subject blocked' });
        if (!authorized.ok && authorized.error.code !== 'forbidden') return authorized;
        // Policy reads can outlast the lease; fence the transition with the current injected time.
        const fence = { ...claim.value.fence, now: dependencies.clock.now({}) };
        const transitioned = authorized.ok ? await claim.value.outbox.beginDispatch(fence)
            : await claim.value.outbox.complete(fence, { state: 'denied' });
        if (!transitioned) return localFailure({ code: 'conflict', message: 'Conversion claim expired' });
        const audit = await authority.audit.record({ context: required.execution.context, operationId: required.input.deliveryId!, outcome: authorized.ok ? 'egress_admitted' : 'egress_denied' }, { signal: required.signal });
        return audit.ok ? { ok: true, value: authorized } : audit;
    } });
    return admitted.ok ? admitted.value : admitted;
}
/** Grant/consent checks use supplied ports only; lifecycle checks surround admission outside
 * the DB transaction so their root adapters never nest a transaction. @complexity Bounded reads. */
async function conversionCurrent(required: { authority: ConversionAuthority; input: Parameters<ConversionDeliveryPort['deliver']>[0]; execution: Execution; signal?: AbortSignal }): Promise<Outcome<void>> {
    if (required.signal?.aborted) return localFailure({ code: 'forbidden', message: 'Conversion cancelled' });
    const grant = await required.authority.grants.current({ context: required.input.context, grantId: required.input.grant.grantId }, { signal: required.signal });
    if (!grant.ok) return grant;
    if (hash({ value: grant.value }) !== hash({ value: required.input.grant }) || grant.value.revoked
        || required.execution.dependencies.clock.now({}) >= grant.value.expiresAt) return localFailure({ code: 'forbidden', message: 'Conversion grant changed' });
    const consent = await required.authority.policy.assess({ context: required.execution.context, event: required.input.event }, { signal: required.signal });
    if (!consent.ok) return consent;
    if (!consent.value.allowed) return localFailure({ code: 'forbidden', message: 'Conversion consent withdrawn' });
    return { ok: true, value: undefined };
}

/** Isolate installed metadata, module evaluation and descriptor validation per plugin.
 * @complexity One module load and <=100 descriptors; failures expose no paths or raw errors.
 */
async function pluginDefinitions(required: { dependencies: Dependencies; context: CallContext; pluginId: string }): Promise<OmToolDefinition[]> {
    const { dependencies, context, pluginId } = required;
    try {
        const loaded = await dependencies.state({ context, pluginId });
        if (!loaded?.enabled || !loaded.bundled) return [];
        const state = { ...structuredClone(loaded), revision: await executableRevision({ dependencies, pluginId, state: loaded }) };
        const moduleUrl = new URL(bundledModuleUrl({ dependencies, pluginId }));
        moduleUrl.searchParams.set('revision', state.revision);
        const module = z.record(z.string(), z.unknown()).parse({ ...await dependencies.loadModule({ moduleUrl: moduleUrl.href }) });
        return [...contributions({ pluginId, module, state }), ...deploymentContribution({ pluginId, module })].map(contribution => definition({ dependencies, context, pluginId, state, module, contribution }));
    } catch {
        const message = 'Bundled agent-plugin unavailable; check installed metadata and run om:build-plugins';
        return [{ name: 'vendor_' + pluginId.replaceAll('-', '_') + '_unavailable', description: pluginId + ': ' + message,
            capability: pluginId, effects: ['write'], policy: 'write', revision: 'unavailable', inputSchema: { type: 'object' },
            unavailableReason: message, parse: () => localFailure({ message }), invoke: async () => localFailure({ message }) }];
    }
}

/** Foreign function ABI is checked before use; namespace values never cross the OM wire. */
function exported<T>(required: { module: Namespace; name: string }): T {
    const value = required.module[required.name];
    if (typeof value !== 'function') throw new Error('Agent-plugin export unavailable');
    return value as T;
}

/** Convert the plugin's public descriptors. JSON-only schemas cross the OM/Jini seams. */
function contributions(required: { pluginId: string; module: Namespace; state: AgentPluginState }): Contribution[] {
    // Higgsfield is an agent plugin; its hosted tools are owned by addon-federation, not a second adapter.
    if (required.pluginId === 'higgsfield-media') return [];
    if (required.pluginId === 'google-ads') return googleContributions(required);
    if (required.pluginId === 'linkedin-ads') return linkedinContributions(required);
    const key = required.pluginId === 'meta-ads' ? 'metaInstagramTools' : 'tiktokTools';
    const tools = z.array(z.object({ name: idSchema, description: z.string().min(1).max(4096), inputSchema: z.record(z.string(), z.unknown()), effects: z.array(z.string()).max(10) })).max(100).parse(required.module[key]);
    const schema = required.module[required.pluginId === 'meta-ads' ? 'metaInstagramCommandSchema' : 'tiktokCommandSchema'] as z.ZodType;
    return tools.map(tool => ({ ...tool, parse: input => parseBoundary({ schema, input: pluginCommand({ pluginId: required.pluginId, tool, input: input.input }) }) }));
}

/** Google owns closed JSON schemas and its mutation effect metadata in the manifest. */
function googleContributions(required: { module: Namespace; state: AgentPluginState }): Contribution[] {
    const tools = exported<(required: Record<string, never>) => unknown>({ module: required.module, name: 'tools' })({});
    const declarations = z.array(z.object({ name: idSchema, description: z.string(), inputSchema: z.record(z.string(), z.unknown()), annotations: z.object({ readOnlyHint: z.boolean() }) })).max(100).parse(tools);
    const servers = z.record(z.string(), z.object({ riskHints: z.record(z.string(), z.array(z.string())).optional() }).passthrough()).parse(required.state.metadata.servers);
    const hints = servers['google-ads']?.riskHints ?? {};
    const parse = exported<(required: { schema: unknown; input: unknown }) => Outcome<unknown>>({ module: required.module, name: 'parse' });
    return declarations.map(tool => ({ ...tool, effects: tool.annotations.readOnlyHint ? ['read'] : (hints[tool.name] ?? ['write']).map(effect => effect === 'spend' ? 'ad_spend' : effect),
        parse: input => parse({ schema: tool.inputSchema, input: input.input }) }));
}

/** LinkedIn exports Zod 4 input schemas; generate JSON here, preserving its own refinements/parser. */
function linkedinContributions(required: { module: Namespace }): Contribution[] {
    const tools = z.array(z.object({ name: idSchema, effect: z.string(), inputSchema: z.custom<z.ZodType>(value => typeof (value as z.ZodType)?.safeParse === 'function') })).max(100).parse(required.module.linkedinAdsTools);
    return tools.map(tool => ({ name: tool.name, description: 'LinkedIn ' + tool.name, effects: [tool.effect],
        inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }), parse: input => parseBoundary({ schema: tool.inputSchema, input: input.input }) }));
}

/** Instagram catalog arguments differ from its command wrapper; TikTok embeds a closed kind. */
function pluginCommand(required: { pluginId: string; tool: { name: string; inputSchema: Record<string, unknown> }; input: unknown }): unknown {
    if (required.pluginId !== 'meta-ads') return required.input;
    if (required.tool.name === 'instagram_publish_post') return { kind: required.tool.name, post: required.input };
    return { ...z.record(z.string(), z.unknown()).parse(required.input), kind: required.tool.name };
}

/** A descriptor's wrapper binds the connection/account and stable operation to the exact card.
 * Exposure is never estimated here: absence denies spend before presenting a card.
 */
function definition(required: Omit<Execution, 'input' | 'signal'>): OmToolDefinition {
    const { contribution, state, dependencies, pluginId } = required;
    const effects = addonToolEffectsSchema.parse(contribution.effects);
    const policy = toolPolicy({ effects });
    const inputSchema = z.toJSONSchema(selectionSchema, { io: 'input' });
    (inputSchema.properties as Record<string, unknown>).arguments = contribution.inputSchema;
    const name = 'vendor_' + pluginId.replaceAll('-', '_') + '_' + contribution.name.replaceAll('.', '_');
    const unavailableReason = unavailable({ dependencies, pluginId, state, policy, name: contribution.name });
    return { name, description: contribution.description, capability: pluginId + ': ' + contribution.name,
        effects, policy, revision: state.revision, inputSchema: toolDescriptorSchema.shape.inputSchema.parse(inputSchema), unavailableReason,
        safety: dependencies.safety,
        parse: input => parseSelection({ contribution, input: input.input }),
        prepareEffect: async input => {
            const parsed = parseSelection({ contribution, input: input.call.input });
            if (!parsed.ok) return parsed;
            if (parsed.value.operationId !== input.call.operationId) return localFailure({ code: 'conflict', message: 'Spend operation IDs differ' });
            if (!parsed.value.moneyExposure || !parsed.value.requiredLimit) return localFailure({ message: 'Spend requires plugin request moneyExposure and requiredLimit; no inferred amount' });
            const args = { tool: name, input: input.call.input };
            const digest = digestArguments({ arguments: args });
            if (!digest.ok) return digest;
            return { ok: true, value: { arguments: args, pluginDigest: state.revision, schemaFingerprint: hash({ value: inputSchema }), operationScope: name,
                envelope: { operationId: input.call.operationId, connectionId: parsed.value.connectionId, accountId: parsed.value.accountId,
                    effects, argumentsDigest: digest.value, moneyExposure: parsed.value.moneyExposure, requiredLimit: parsed.value.requiredLimit } } };
        },
        invoke: input => invoke({ ...required, invocation: input }),
    };
}
function unavailable(required: { dependencies: Dependencies; pluginId: string; state: AgentPluginState; policy: string; name?: string }): string | undefined {
    if (!required.state.admitted) return 'Plugin unadmitted: vendor network access is disabled';
    if (required.pluginId === 'google-ads' && required.policy !== 'read' && required.name !== deploymentName) return 'NEEDS: Google durable controlled-plan journal and verified billing evidence';
    if (required.policy !== 'read' && required.dependencies.mode === 'read_only') return 'Local vendor account mode is read-only';
    if (required.policy === 'spend' && !required.dependencies.safety) return 'NEEDS: verified vendor financial safety binding';
    return undefined;
}
function parseSelection(required: { contribution: Contribution; input: unknown }): Outcome<Selection> {
    const bounded = parseBoundary({ schema: boundedJsonSchema, input: required.input });
    if (!bounded.ok) return bounded;
    const parsed = parseBoundary({ schema: selectionSchema, input: bounded.value });
    if (!parsed.ok) return parsed;
    const valid = required.contribution.parse({ input: parsed.value.arguments });
    return valid.ok ? parsed : valid;
}

/** Recheck installed state after every awaited credential/claim. Only call-scoped tokens reach plugins. */
async function current(required: Omit<Execution, 'module' | 'contribution'>): Promise<boolean> {
    if (required.signal?.aborted) return false;
    const state = await required.dependencies.state({ context: required.context, pluginId: required.pluginId });
    if (!state?.admitted || !state.enabled || !state.bundled) return false;
    return await executableRevision({ ...required, state }) === required.state.revision;
}
function bundledModuleUrl(required: { dependencies: Dependencies; pluginId: string }): string {
    return pathToFileURL(join(required.dependencies.projectRoot, 'content/agent-plugins', required.pluginId, 'io.github.ainsep.openmarketing/dist/index.mjs')).href;
}
/** Fence both installed metadata and executed bytes. A rebuild changes cards and native import URLs;
 * every credential/egress fence rehashes the bounded bundle, so an old definition cannot send.
 * @complexity O(b) bytes per fence, b bounded by the injected file reader (8 MiB in serve). */
async function executableRevision(required: { dependencies: Dependencies; pluginId: string; state: AgentPluginState }): Promise<string> {
    const digest = z.string().regex(/^[a-f0-9]{64}$/).parse(await required.dependencies.moduleDigest({ moduleUrl: bundledModuleUrl(required) }));
    return hash({ value: [required.state.revision, digest] });
}
async function bindingCurrent(required: Execution): Promise<boolean> {
    if (!await current(required)) return false;
    if (required.input.accountId === null) return required.pluginId === 'meta-ads' && required.contribution.name === 'instagram_accounts';
    const found = await required.dependencies.accounts.find({ context: required.context, externalAccountId: required.input.accountId }, { signal: required.signal });
    return found.ok && found.value?.connectionId === required.input.connectionId;
}

/** Foreign fetch ABI: the last admitted gate follows fresh credentials and halt/account checks.
 * Refusal throws only inside the plugin's typed transport boundary; zero native fetches occur.
 */
function guardedFetch(required: Execution): typeof fetch {
    return async (url, options) => {
        if (!await bindingCurrent(required) || !await current(required) || options?.signal?.aborted) throw new Error('Plugin unavailable');
        if (required.stopPermit && required.dependencies.clock.now({}) >= required.stopPermit.expiresAt) throw new Error('Stop permit expired');
        if (!required.stopPermit && toolPolicy({ effects: required.contribution.effects }) !== 'read' && required.input.accountId !== null) {
            const snapshot = await required.dependencies.safetyRepo.snapshot({ context: required.context, accountId: required.input.accountId }, { signal: required.signal });
            if (!snapshot.ok || snapshot.value.halted) throw new Error('Account halted');
        }
        if (!await campaignAuthorityCurrent(required)) throw new Error('Campaign authority expired or revoked');
        if (required.signal?.aborted || options?.signal?.aborted) throw new Error('Plugin cancelled');
        return required.dependencies.fetch(url, options);
    };
}
/** A campaign child keeps its owning exact approval through awaited credential resolution.
 * The caller already holds safety's halt barrier. @complexity One scoped confirmation lookup. */
async function campaignAuthorityCurrent(required: Execution): Promise<boolean> {
    if (!required.authorization?.campaignApproval) return true;
    if (!required.dependencies.confirmations || !required.dispatchPermit) return false;
    const authority = await required.dependencies.confirmations.verify({ context: required.context, request: required.authorization, classification: 'write' });
    return authority.ok && required.dispatchPermit.expiresAt > required.dependencies.clock.now({});
}
function credentials(required: Execution) {
    return { async access(input: { connectionId?: string; accountId?: string | null } = {}): Promise<Outcome<{ accessToken: string; expiresAt?: number }>> {
        if (input.connectionId !== undefined && input.connectionId !== required.input.connectionId) return localFailure({ code: 'forbidden', message: 'Plugin credential connection mismatch' });
        if (input.accountId != null && input.accountId !== required.input.accountId) return localFailure({ code: 'forbidden', message: 'Plugin credential account mismatch' });
        if (!await bindingCurrent(required)) return localFailure({ message: 'Plugin unavailable before credential access' });
        return required.dependencies.integrations.access({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } },
            pluginId: required.pluginId, connectionId: required.input.connectionId }, { signal: required.signal });
    } };
}

/** One existing outbox claim surrounds the complete tool workflow (including Instagram subcalls).
 * The dispatcher already owns financial withDispatch; gateways never nest that lock or show a card.
 */
async function invoke(required: Omit<Execution, 'input' | 'signal'> & { invocation: Invocation }): Promise<Outcome<unknown>> {
    const parsed = parseSelection({ contribution: required.contribution, input: required.invocation.input });
    if (!parsed.ok) return parsed;
    const execution: Execution = { ...required, context: required.invocation.context, input: parsed.value, signal: required.invocation.signal, authorization: required.invocation.authorization, dispatchPermit: required.invocation.permit };
    try {
        if (!await bindingCurrent(execution)) return localFailure({ message: 'Plugin unadmitted, disabled or account binding unavailable' });
        if (required.contribution.name === deploymentName) return localFailure({ code: 'forbidden', message: 'Use the owning exact campaign launch' });
        const reason = unavailable({ ...required, policy: toolPolicy({ effects: required.contribution.effects }), name: required.contribution.name });
        if (reason) return localFailure({ message: reason });
        const execute = () => executePlugin(execution);
        if (toolPolicy({ effects: required.contribution.effects }) === 'read') return await execute();
        if (toolPolicy({ effects: required.contribution.effects }) === 'spend' && !required.invocation.permit)
            return localFailure({ code: 'forbidden', message: 'Spend requires the dispatcher safety permit' });
        const dispatch = () => required.dependencies.jobs.dispatch({ context: execution.context, pluginId: required.pluginId, input: parsed.value, execute });
        if (required.invocation.permit && required.invocation.authorization?.campaignApproval) return await execute();
        return await writeWithBarrier({ execution, execute: dispatch });
    } catch { return localFailure({ message: 'Plugin binding failed; reconcile any submitted operation' }); }
}
/** Financial calls already hold withDispatch. Ordinary writes share halt's barrier through egress. */
async function writeWithBarrier(required: { execution: Execution; execute(): Promise<Outcome<unknown>> }): Promise<Outcome<unknown>> {
    const { execution } = required;
    const locks = execution.dependencies.accountLocks;
    if (toolPolicy({ effects: execution.contribution.effects }) === 'spend') return required.execute();
    const acquired = await locks.acquire({ context: execution.context, accountId: execution.input.accountId ?? 'connection:' + execution.input.connectionId }, { signal: execution.signal });
    if (!acquired.ok) return acquired;
    try { return await required.execute(); }
    finally {
        const released = await locks.release({ lockId: acquired.value.lockId });
        if (!released.ok) throw new Error('Plugin account barrier release failed');
    }
}

/** Backend-only permit route. The worker owns authorization and the shared lock; plugins own
 * closed pause/stop mappings. Meta hosted stop remains unavailable. No cards or second outbox.
 * @complexity <=1 bundle load; plugin mappings bound IDs to 100, with no blind retries. */
async function haltStop(required: { dependencies: Dependencies; context: CallContext; pluginId: string; permit: HaltStopPermit }): Promise<Outcome<unknown>> {
    try {
        const parsed = parseBoundary({ schema: haltStopRequestSchema, input: required.permit.request });
        if (!parsed.ok) return parsed;
        const request = parsed.value;
        const loaded = await required.dependencies.state({ context: required.context, pluginId: required.pluginId });
        if (!loaded?.admitted || !loaded.enabled || !loaded.bundled) return localFailure({ message: 'Stop plugin unadmitted or unavailable' });
        const state = { ...loaded, revision: await executableRevision({ ...required, state: loaded }) };
        if (request.pluginDigest !== state.revision) return localFailure({ code: 'conflict', message: 'Stop executable revision changed' });
        const moduleUrl = new URL(bundledModuleUrl(required));
        moduleUrl.searchParams.set('revision', state.revision);
        const module = { ...await required.dependencies.loadModule({ moduleUrl: moduleUrl.href }) };
        const execution: Execution = { ...required, state, module, stopPermit: required.permit,
            input: { operationId: request.operationId, connectionId: request.connectionId, accountId: request.adAccountId, arguments: {} },
            contribution: { name: 'halt-stop', description: 'Typed backend stop', effects: ['halt_stop'], inputSchema: {}, parse: () => ({ ok: true, value: request }) } };
        if (!await bindingCurrent(execution)) return localFailure({ message: 'Stop account binding unavailable' });
        return await stopPlugin(execution);
    } catch { return localFailure({ message: 'Stop result unknown; reconcile before retrying' }); }
}
async function stopPlugin(required: Execution): Promise<Outcome<unknown>> {
    const permit = required.stopPermit!;
    if (required.pluginId === 'linkedin-ads') return linkedinAdapter(required).stop({ context: required.context, request: permit.request, permit });
    if (required.pluginId === 'tiktok-ads') return tiktokAdapter(required).stop({ context: required.context, permit });
    if (required.pluginId !== 'google-ads') return localFailure({ message: 'NEEDS: verified Meta hosted stop binding' });
    const transport = googleTransport({ ...required, fetch: guardedFetch(required), credential: credentials(required) });
    const adapter = exported<Factory<{ stop(input: Record<string, unknown>): Promise<Outcome<unknown>> }>>({ module: required.module, name: 'createStopBinding' })({
        ...transport, authority: { dispatchStop: (call: { execute(): Promise<Outcome<unknown>> }) => call.execute() } });
    return adapter.stop({ context: required.context, request: permit.request });
}

/** Instantiate one call's plugin dependencies; no adapter or token cache survives the invocation. */
async function executePlugin(required: Execution): Promise<Outcome<unknown>> {
    const fetch = guardedFetch(required);
    const credential = credentials(required);
    const input = required.input;
    const invocation = { context: required.context, operationId: input.operationId, command: input.arguments,
        moneyExposure: input.moneyExposure ?? null, requiredLimit: input.requiredLimit ?? null };
    switch (required.pluginId) {
        case 'linkedin-ads': return linkedinAdapter(required).invoke(invocation, { signal: required.signal });
        case 'tiktok-ads': return tiktokAdapter(required).invoke(invocation, { signal: required.signal });
        case 'meta-ads': return instagram({ ...required, fetch, credential });
        case 'google-ads': return google({ ...required, fetch, credential });
        default: return localFailure({ message: 'Plugin backend unavailable' });
    }
}
type StopAdapter = Adapter & { stop(input: Record<string, unknown>, optional?: CallOptions): Promise<Outcome<unknown>> };
function linkedinAdapter(required: Execution): StopAdapter {
    return exported<Factory<StopAdapter>>({ module: required.module, name: 'createLinkedInAdsAdapter' })({
        clock: required.dependencies.clock, observer: required.dependencies.observer,
        configuration: { scope: required.context.scope, connectionId: required.input.connectionId, accountId: required.input.accountId,
            pluginDigest: required.state.revision, currency: required.input.currency ?? required.state.metadata.currency, apiVersion: '202610', bindingId: 'linkedin-ads.stop.v1' },
        credentials: credentials(required), fetch: guardedFetch(required),
        gateway: { dispatch: (call: { execute(): Promise<Outcome<unknown>> }) => call.execute() } });
}
function tiktokAdapter(required: Execution): StopAdapter {
    const egress = exported<Factory<{ send(input: Record<string, unknown>, optional?: CallOptions): Promise<Outcome<unknown>> }>>({ module: required.module, name: 'createTikTokFetchEgress' })({
        fetch: guardedFetch(required), credentials: credentials(required), observer: required.dependencies.observer });
    return exported<Factory<StopAdapter>>({ module: required.module, name: 'createTikTokAdsAdapter' })({ clock: required.dependencies.clock, observer: required.dependencies.observer,
        binding: { scope: required.context.scope, connectionId: required.input.connectionId, accountId: required.input.accountId, pluginDigest: required.state.revision },
        gateway: { invoke: (call: { call: { connectionId: string; accountId: string; operationId: string; request: unknown } }, options?: CallOptions) => egress.send({
            ...call.call, context: required.context, isCurrent: () => !required.signal?.aborted }, options) } });
}
async function instagram(required: Execution & { fetch: typeof fetch; credential: ReturnType<typeof credentials> }): Promise<Outcome<unknown>> {
    const dispatch = exported<Factory<unknown>>({ module: required.module, name: 'createMetaInstagramFetchDispatch' })({ fetch: required.fetch, credentials: required.credential });
    const invoke = exported<(required: Record<string, unknown>, optional?: CallOptions) => Promise<Outcome<unknown>>>({ module: required.module, name: 'invokeMetaInstagram' });
    return invoke({ request: { context: required.context, connectionId: required.input.connectionId, operationId: required.input.operationId,
        command: pluginCommand({ ...required, tool: required.contribution, input: required.input.arguments }) }, dispatch,
        clock: required.dependencies.clock, observer: required.dependencies.observer, configuration: { apiVersion: 'v25.0', timeoutMs: 15000 },
        wait: required.dependencies.wait }, { signal: required.signal });
}
function googleTransport(required: Execution & { fetch: typeof fetch; credential: ReturnType<typeof credentials> }) {
    const binding = { scope: required.context.scope, connectionId: required.input.connectionId, customerId: required.input.accountId,
        currency: required.input.currency ?? required.state.metadata.currency, timezone: required.input.timezone ?? required.state.metadata.timezone,
        mode: required.checkpoint && !required.evidence ? required.dependencies.mode : 'read_only', pluginDigest: required.state.revision, schemaFingerprint: hash({ value: required.contribution.inputSchema }) };
    const http = exported<Factory<unknown>>({ module: required.module, name: 'createHttpAdapter' })({ fetch: required.fetch, observer: required.dependencies.observer, signal: required.signal });
    const transport = exported<Factory<unknown>>({ module: required.module, name: 'createGoogleRestTransport' })({ binding, http, credentials: { async access() {
        const accessed = await required.credential.access();
        if (!accessed.ok || !await bindingCurrent(required)) return localFailure({ message: 'Google credentials unavailable' });
        const token = await required.dependencies.integrations.resolveDeveloperToken?.({ context: { ...required.context, principal: { kind: 'service', serviceId: 'google-ads-transport' } }, pluginId: 'google-ads' }, { signal: required.signal });
        if (token && !token.ok) return token;
        const manager = z.string().regex(/^[0-9]{10}$/).optional().parse(required.state.metadata.loginCustomerId);
        return { ok: true, value: { ...accessed.value, ...(manager ? { loginCustomerId: manager } : {}), ...(token?.value ? { developerToken: token.value } : {}) } };
    } } });
    return { binding, transport };
}
/** Fixed plugin sequence with owning-job checkpoints. Google keeps billing authority unavailable.
 * @complexity At most one atomic Google mutate or three social creates, bounded plugin readback. */
async function deployment(required: Execution): Promise<Outcome<unknown>> {
    const common = { context: required.context, operationId: required.input.operationId, plan: required.input.arguments.plan, checkpoint: required.checkpoint };
    if (required.pluginId === 'google-ads') return googleDeployment(required);
    const dependencies = required.pluginId === 'meta-ads'
        ? { admitted: true, dispatch: exported<Factory<unknown>>({ module: required.module, name: 'createMetaInstagramFetchDispatch' })({ fetch: guardedFetch(required), credentials: credentials(required) }) }
        : required.pluginId === 'tiktok-ads'
        ? { admitted: true, egress: exported<Factory<unknown>>({ module: required.module, name: 'createTikTokFetchEgress' })({ fetch: guardedFetch(required), credentials: credentials(required), observer: required.dependencies.observer }) }
        : { admitted: true, clock: required.dependencies.clock, observer: required.dependencies.observer, fetch: guardedFetch(required), credentials: credentials(required),
            configuration: { scope: required.context.scope, connectionId: required.input.connectionId, accountId: required.input.accountId, pluginDigest: required.state.revision, currency: required.input.currency, apiVersion: '202610', bindingId: 'campaign.create-draft.v1' } };
    const read = required.evidence !== undefined;
    const references = savedDeploymentReferences({ evidence: required.evidence ?? [] });
    return exported<(input: Record<string, unknown>, optional?: CallOptions) => Promise<Outcome<unknown>>>({ module: required.module, name: read ? 'readCampaignDeployment' : 'deployCampaignPaused' })({ ...common, connectionId: required.input.connectionId, accountId: required.input.accountId, dependencies, references }, { signal: required.signal });
}
/** Recover an ID whose acknowledgement checkpoint failed but whose receipt was saved.
 * Receipt references supplement the latest valid checkpoint; duplicate vendor IDs occur once.
 * @complexity O(n*b+r) time, O(n+b+r) space; <=128 bounded entries, <=1000 merged references, no I/O. */
function savedDeploymentReferences(required: { evidence: Record<string, unknown>[] }): Record<string, string> {
    let checkpoint: Record<string, string> = {};
    for (const entry of required.evidence) {
        const parsed = deploymentReferencesSchema.safeParse(entry.references);
        if (parsed.success) checkpoint = parsed.data;
    }
    const receipt = deploymentReferencesSchema.safeParse(latestDeploymentReceipt(required)?.references);
    const references = new Map(Object.entries(checkpoint));
    for (const [step, id] of Object.entries(receipt.success ? receipt.data : {})) {
        references.delete(step);
        references.set(step, id);
    }
    const byVendorId = new Map([...references].map(([step, id]) => [id, [step, id]] as const));
    return Object.fromEntries(byVendorId.values());
}
/** Adapt Google's journal into append-only evidence of the SAME job; never enqueue/lock here. */
async function googleDeployment(required: Execution): Promise<Outcome<unknown>> {
    const { binding, transport } = googleTransport({ ...required, fetch: guardedFetch(required), credential: credentials(required) });
    let record = required.evidence?.filter(item => item.record).at(-1)?.record;
    const unavailable = async () => localFailure({ message: 'NEEDS: Google billing authority' });
    const adapter = exported<Factory<Adapter>>({ module: required.module, name: 'createGooglePlugin' })({ binding, transport, clock: required.dependencies.clock,
        journal: { async claim(input: { record: unknown }) { const saved = await required.checkpoint!({ step: 'google', phase: 'dispatch', record: input.record }); if (!saved.ok) return saved; record = input.record; return { ok: true, value: { acquired: true, record } }; },
            async append(input: { record: unknown }) { const saved = await required.checkpoint!({ step: 'google', phase: 'observation', record: input.record }); if (saved.ok) record = input.record; return saved; },
            async get() { return { ok: true, value: record ?? null }; }, findCampaign: unavailable },
        authority: { dispatch: (input: { execute(): Promise<Outcome<unknown>> }) => input.execute(), billing: unavailable } });
    const result = await adapter.invoke({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-campaign-deployment' } }, name: required.evidence ? 'reconcile' : 'create_paused', arguments: { operationId: required.input.operationId, ...(required.evidence ? {} : { plan: required.input.arguments.plan }) } });
    if (!result.ok) return result;
    const receipt = z.object({ status: z.enum(['unknown', 'acknowledged']), references: z.array(idSchema).max(256).optional() }).parse(result.value);
    return { ok: true, value: { ...receipt, entityIds: receipt.references ?? [] } };
}
async function google(required: Execution & { fetch: typeof fetch; credential: ReturnType<typeof credentials> }): Promise<Outcome<unknown>> {
    const { binding, transport } = googleTransport(required);
    const unavailable = async () => localFailure({ message: 'NEEDS: Google durable controlled-plan journal and billing evidence' });
    const adapter = exported<Factory<Adapter>>({ module: required.module, name: 'createGooglePlugin' })({ binding, transport, clock: required.dependencies.clock,
        journal: { claim: unavailable, append: unavailable, get: unavailable, findCampaign: unavailable }, authority: { dispatch: unavailable, billing: unavailable } });
    return adapter.invoke({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } }, name: required.contribution.name, arguments: required.input.arguments });
}
function hash(required: { value: unknown }): string { return createHash('sha256').update(JSON.stringify(required.value)).digest('hex'); }

/** Inline lease in the ONE jobs outbox; duplicate/expired work never sends again. Outcomes append,
 * and uncertain failures stay reconciliation-only. No retry or independent worker is introduced.
 * @example const jobs = bindAgentPluginJobs({ unit, clock, ids, observer });
 * @complexity Fixed indexed queries per write; immutable payload <=64 KiB, no token persistence.
 */
export function bindAgentPluginJobs(required: { unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort }) {
    const database = required.unit;
    const repo = createSqlJobRepo({ database, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
    async function dispatch(input: { context: CallContext; pluginId: string; input: Selection; execute(required: { jobId: string }): Promise<Outcome<unknown>> }): Promise<Outcome<unknown>> {
        const digest = digestArguments({ arguments: { pluginId: input.pluginId, input: input.input } });
        if (!digest.ok) return digest;
        const token = required.ids.next({});
        const claim = await database.transaction({ work: async ({ session }) => {
            const joined = createSqlJobRepo({ database: session, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
            const queued = await joined.enqueue({ context: input.context, job: { operationId: input.input.operationId, handler: 'agent-plugin.invoke',
                idempotencyKey: 'agent-plugin:' + hash({ value: input.input.operationId }), argumentsDigest: digest.value, payload: { pluginId: input.pluginId, input: input.input } } });
            if (!queued.ok) return queued;
            const claimed = await session.query({ text: "UPDATE job SET state='leased', attempts=1, lease_token=$1, lease_expires_at=$2 WHERE id=$3 AND tenant_id=$4 AND state='pending' AND attempts=0 RETURNING id",
                values: [token, required.clock.now({}) + 300000, queued.value.jobId, jobTenant(input)] });
            if (!claimed.rows.length) return localFailure<{ jobId: string }>({ code: 'conflict', message: 'Plugin operation already claimed; reconcile before retrying' });
            await journalClaim({ session, id: queued.value.jobId, tenantId: jobTenant(input), now: required.clock.now({}) });
            return queued;
        } });
        if (!claim.ok) return claim;
        const fence = { id: claim.value.jobId, tenantId: jobTenant(input), token, now: required.clock.now({}) };
        if (!await repo.outbox.beginDispatch(fence)) return localFailure({ code: 'conflict', message: 'Plugin claim expired' });
        let result: Outcome<unknown>;
        try { result = await input.execute({ jobId: claim.value.jobId }); } catch { result = localFailure({ message: 'Plugin result unknown; reconcile' }); }
        const checked = result.ok ? parseBoundary({ schema: boundedJsonSchema, input: result.value }) : result;
        const completion = jobCompletion({ result: checked });
        const finished = await repo.outbox.complete({ ...fence, now: required.clock.now({}) }, completion);
        if (!finished) return localFailure({ code: 'conflict', message: 'Plugin completion lost its lease; reconcile' });
        return checked;
    }
    /** Append scoped bounded evidence. A duplicate step dispatch can never authorize another send.
     * Transactions commit before plugin I/O; observations may append after completion. */
    async function checkpoint(input: { context: CallContext; jobId: string; event: string; evidence: Record<string, unknown> }): Promise<Outcome<void>> {
        const evidence = boundedJsonSchema.safeParse(input.evidence);
        if (!evidence.success) return localFailure({ code: 'limit_exceeded', message: 'Campaign evidence exceeds bounds' });
        return database.transaction({ work: async ({ session }) => {
            const job = await session.query({ text: 'SELECT state FROM job WHERE id=$1 AND tenant_id=$2', values: [input.jobId, jobTenant(input)] });
            if (!job.rows.length) return localFailure({ code: 'forbidden', message: 'Owning job unavailable' });
            if (input.evidence.phase === 'dispatch') {
                const prior = await session.query({ text: 'SELECT evidence_id FROM job_attempt WHERE job_id=$1 AND tenant_id=$2 AND event_type=$3 LIMIT 129', values: [input.jobId, jobTenant(input), input.event] });
                if (job.rows[0]!.state !== 'dispatching' || prior.rows.length >= 128 || prior.rows.some(row => JSON.parse(String(row.evidence_id)).phase === 'dispatch')) return localFailure({ code: 'conflict', message: 'Campaign step already dispatched or job ended' });
            }
            await session.query({ text: 'INSERT INTO job_attempt (job_id,sequence,tenant_id,attempt,event_type,state,observed_at,evidence_id) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,1,$3,$4,$5,$6 FROM job_attempt WHERE job_id=$1',
                values: [input.jobId, jobTenant(input), input.event, job.rows[0]!.state, required.clock.now({}), JSON.stringify(evidence.data)] });
            return { ok: true, value: undefined };
        } });
    }
    /** Scoped immutable intent plus bounded append history for read-only recovery. No claim/replay. */
    async function history(input: { context: CallContext; operationId: string }): Promise<Outcome<{ jobId: string; payload: unknown; evidence: Record<string, unknown>[] }>> {
        return database.transaction({ work: async ({ session }) => {
            const found = await session.query({ text: 'SELECT id,payload FROM job WHERE tenant_id=$1 AND idempotency_key=$2', values: [jobTenant(input), 'agent-plugin:' + hash({ value: input.operationId })] });
            if (!found.rows[0]) return localFailure({ code: 'forbidden', message: 'Campaign job unavailable in scope' });
            const rows = await session.query({ text: 'SELECT evidence_id FROM job_attempt WHERE job_id=$1 AND tenant_id=$2 AND evidence_id IS NOT NULL ORDER BY sequence LIMIT 129', values: [found.rows[0].id, jobTenant(input)] });
            if (rows.rows.length > 128) return localFailure({ code: 'limit_exceeded', message: 'Campaign history exceeds recovery bound' });
            return { ok: true, value: { jobId: String(found.rows[0].id), payload: boundedJsonSchema.parse(JSON.parse(String(found.rows[0].payload))), evidence: rows.rows.map(row => z.record(z.string(), boundedJsonSchema).parse(JSON.parse(String(row.evidence_id)))) } };
        } });
    }
    return { dispatch: (input: Parameters<typeof dispatch>[0]) => pluginJobBoundary({ ...required, context: input.context, execute: () => dispatch(input) }),
        checkpoint: (input: Parameters<typeof checkpoint>[0]) => pluginJobBoundary({ ...required, context: input.context, execute: () => checkpoint(input) }),
        history: (input: Parameters<typeof history>[0]) => pluginJobBoundary({ ...required, context: input.context, execute: () => history(input) }) };
}
/** An absent/invalid acknowledgement cannot turn a durable claim into observed success. */
function jobCompletion(required: { result: Outcome<unknown> }): { state: 'reconcile' | 'failed' | 'succeeded' } {
    if (!required.result.ok) return { state: 'reconcile' };
    if (z.object({ status: z.literal('unknown') }).safeParse(required.result.value).success) return { state: 'reconcile' };
    if (z.object({ status: z.literal('failed') }).safeParse(required.result.value).success) return { state: 'failed' };
    return { state: 'succeeded' };
}
/** Storage exceptions are explicit failures; diagnostics contain only outcome and trace identity. */
async function pluginJobBoundary<T>(required: { context: CallContext; observer: ObserverPort; execute(): Promise<Outcome<T>> }): Promise<Outcome<T>> {
    let result: Outcome<T>;
    try { result = await required.execute(); }
    catch { result = localFailure({ message: 'Plugin outbox unavailable; reconcile any submitted operation' }); }
    try { required.observer.observe({ operation: 'server.agent-plugin.jobs', outcome: result.ok ? 'ok' : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); } catch { /* Diagnostics do not grant retries. */ }
    return result;
}
async function journalClaim(required: { session: JobsSqlSession; id: string; tenantId: string; now: number }): Promise<void> {
    await required.session.query({ text: "INSERT INTO job_attempt (job_id,sequence,tenant_id,attempt,event_type,state,observed_at,evidence_id) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,1,'claim','leased',$3,NULL FROM job_attempt WHERE job_id=$1",
        values: [required.id, required.tenantId, required.now] });
}
