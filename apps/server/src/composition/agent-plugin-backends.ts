/** Bundled vendor namespaces contribute to the ONE catalog. Vendor codecs stay in their packages. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { addonToolEffectsSchema, boundedJsonSchema, dailyLimitRequirementSchema, idSchema, moneyExposureSchema, parseBoundary, toolDescriptorSchema } from '@open-marketing/contracts';
import type { CallContext, CallOptions, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { digestArguments } from '@open-marketing/safety';
import type { SafetyRepoPort, SafetyService } from '@open-marketing/safety';
import type { AccountBindingLookupPort } from '@open-marketing/workspaces';
import { createSqlJobRepo, jobTenant } from '@open-marketing/jobs';
import type { JobsSqlSession } from '@open-marketing/jobs';
import type { Integrations } from '../integrations.js';
import { toolPolicy } from '../om-tools.js';
import type { OmToolDefinition } from '../om-tools.js';
import { jobsDatabase, formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';

/** Internal lifecycle projection; admission is read from installed manifest/capabilities, never chat. */
export type AgentPluginState = { enabled: boolean; bundled: boolean; admitted: boolean; revision: string; metadata: Record<string, unknown>; effects?: string[] };
/** Native namespace import and fetch are injected by serve; fixtures replace both without networking. */
export type AgentPluginEffects = { fetch: typeof fetch; loadModule(required: { moduleUrl: string }): Promise<object>;
    wait(required: { milliseconds: number }, optional?: CallOptions): Promise<Outcome<void>> };
type Dependencies = AgentPluginEffects & { projectRoot: string; clock: ClockPort; observer: ObserverPort;
    state(required: { context: CallContext; pluginId: string }): Promise<AgentPluginState | null>;
    integrations: Pick<Integrations, 'access'>; accounts: AccountBindingLookupPort; safetyRepo: Pick<SafetyRepoPort, 'snapshot'>;
    jobs: ReturnType<typeof bindAgentPluginJobs>; mode: 'read_only' | 'sandbox' | 'production'; safety?: SafetyService };
type Namespace = Record<string, unknown>;
type Adapter = { invoke(required: Record<string, unknown>, optional?: CallOptions): Promise<Outcome<unknown>> };
type Factory<T> = (required: Record<string, unknown>) => T;
type Contribution = { name: string; description: string; inputSchema: Record<string, unknown>; effects: readonly string[]; parse(required: { input: unknown }): Outcome<unknown> };
const pluginIds = ['google-ads', 'linkedin-ads', 'tiktok-ads', 'meta-ads'] as const;
const selectionSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, accountId: idSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(), timezone: z.string().min(1).max(100).optional(),
    arguments: z.record(z.string(), boundedJsonSchema), moneyExposure: moneyExposureSchema.nullable().optional(), requiredLimit: dailyLimitRequirementSchema.nullable().optional() });
type Selection = z.infer<typeof selectionSchema>;
type Invocation = Parameters<OmToolDefinition['invoke']>[0];
type Execution = { dependencies: Dependencies; context: CallContext; pluginId: string; state: AgentPluginState; module: Namespace; contribution: Contribution; input: Selection; signal?: AbortSignal };

/** Read enabled bundled modules on catalog discovery; namespaces contain no retained credentials.
 * Each call resolves lifecycle/account state again. A broken plugin contributes only an unavailable
 * descriptor; other plugins and the rest of the catalog remain usable.
 * @example const backends = bindAgentPluginBackends({ ...ports, fetch, loadModule });
 * @complexity <=4 module loads and <=100 descriptors/plugin; no discovery egress.
 */
export function bindAgentPluginBackends(required: Dependencies): { definitions(required: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> } {
    return { async definitions({ context }) {
        const definitions: OmToolDefinition[] = [];
        for (const pluginId of pluginIds) definitions.push(...await pluginDefinitions({ dependencies: required, context, pluginId }));
        return { ok: true, value: definitions };
    } };
}

/** Isolate installed metadata, module evaluation and descriptor validation per plugin.
 * @complexity One module load and <=100 descriptors; failures expose no paths or raw errors.
 */
async function pluginDefinitions(required: { dependencies: Dependencies; context: CallContext; pluginId: string }): Promise<OmToolDefinition[]> {
    const { dependencies, context, pluginId } = required;
    try {
        const loaded = await dependencies.state({ context, pluginId });
        if (!loaded?.enabled || !loaded.bundled) return [];
        const state = structuredClone(loaded);
        const moduleUrl = pathToFileURL(join(dependencies.projectRoot, 'content/agent-plugins', pluginId, 'io.github.ainsep.openmarketing/dist/index.mjs')).href;
        const module = z.record(z.string(), z.unknown()).parse({ ...await dependencies.loadModule({ moduleUrl }) });
        return contributions({ pluginId, module, state }).map(contribution => definition({ dependencies, context, pluginId, state, module, contribution }));
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
    const unavailableReason = unavailable({ dependencies, pluginId, state, policy });
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
function unavailable(required: { dependencies: Dependencies; pluginId: string; state: AgentPluginState; policy: string }): string | undefined {
    if (!required.state.admitted) return 'Plugin unadmitted: vendor network access is disabled';
    if (required.pluginId === 'google-ads' && required.policy !== 'read') return 'NEEDS: Google durable controlled-plan journal and verified billing evidence';
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
    return !!state?.admitted && state.enabled && state.bundled && state.revision === required.state.revision;
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
        if (!await bindingCurrent(required)) throw new Error('Plugin unavailable');
        if (!await current(required) || options?.signal?.aborted) throw new Error('Plugin unavailable');
        if (toolPolicy({ effects: required.contribution.effects }) !== 'read' && required.input.accountId !== null) {
            const snapshot = await required.dependencies.safetyRepo.snapshot({ context: required.context, accountId: required.input.accountId }, { signal: required.signal });
            if (!snapshot.ok || snapshot.value.halted) throw new Error('Account halted');
        }
        return required.dependencies.fetch(url, options);
    };
}
function credentials(required: Execution) {
    return { async access(input: { connectionId?: string; accountId?: string | null } = {}) {
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
    const execution: Execution = { ...required, context: required.invocation.context, input: parsed.value, signal: required.invocation.signal };
    try {
        if (!await bindingCurrent(execution)) return localFailure({ message: 'Plugin unadmitted, disabled or account binding unavailable' });
        const reason = unavailable({ ...required, policy: toolPolicy({ effects: required.contribution.effects }) });
        if (reason) return localFailure({ message: reason });
        const execute = () => executePlugin(execution);
        if (toolPolicy({ effects: required.contribution.effects }) === 'read') return await execute();
        if (toolPolicy({ effects: required.contribution.effects }) === 'spend' && !required.invocation.permit)
            return localFailure({ code: 'forbidden', message: 'Spend requires the dispatcher safety permit' });
        return await required.dependencies.jobs.dispatch({ context: execution.context, pluginId: required.pluginId, input: parsed.value, execute });
    } catch { return localFailure({ message: 'Plugin binding failed; reconcile any submitted operation' }); }
}

/** Instantiate one call's plugin dependencies; no adapter or token cache survives the invocation. */
async function executePlugin(required: Execution): Promise<Outcome<unknown>> {
    const common = { clock: required.dependencies.clock, observer: required.dependencies.observer };
    const fetch = guardedFetch(required);
    const credential = credentials(required);
    const input = required.input;
    const configuration = { scope: required.context.scope, connectionId: input.connectionId, accountId: input.accountId, pluginDigest: required.state.revision };
    const invocation = { context: required.context, operationId: input.operationId, command: input.arguments,
        moneyExposure: input.moneyExposure ?? null, requiredLimit: input.requiredLimit ?? null };
    switch (required.pluginId) {
        case 'linkedin-ads': {
            const factory = exported<Factory<Adapter>>({ module: required.module, name: 'createLinkedInAdsAdapter' });
            return factory({ ...common, configuration: { ...configuration, currency: input.currency, apiVersion: '202609', bindingId: 'linkedin-ads.stop.v1' },
                credentials: credential, fetch, gateway: { dispatch: (call: { execute: () => Promise<Outcome<unknown>> }) => call.execute() } }).invoke(invocation, { signal: required.signal });
        }
        case 'tiktok-ads': {
            const egress = exported<Factory<{ send(required: Record<string, unknown>, optional?: CallOptions): Promise<Outcome<unknown>> }>>({ module: required.module, name: 'createTikTokFetchEgress' })({ fetch, credentials: credential, observer: common.observer });
            const gateway = { invoke: (call: { call: { connectionId: string; accountId: string; operationId: string; request: unknown } }, options?: CallOptions) => egress.send({
                connectionId: call.call.connectionId, accountId: call.call.accountId, operationId: call.call.operationId, request: call.call.request,
                context: required.context, isCurrent: () => !required.signal?.aborted }, options) };
            return exported<Factory<Adapter>>({ module: required.module, name: 'createTikTokAdsAdapter' })({ ...common, binding: configuration, gateway }).invoke(invocation, { signal: required.signal });
        }
        case 'meta-ads': return instagram({ ...required, fetch, credential });
        case 'google-ads': return google({ ...required, fetch, credential });
        default: return localFailure({ message: 'Plugin backend unavailable' });
    }
}
async function instagram(required: Execution & { fetch: typeof fetch; credential: ReturnType<typeof credentials> }): Promise<Outcome<unknown>> {
    const dispatch = exported<Factory<unknown>>({ module: required.module, name: 'createMetaInstagramFetchDispatch' })({ fetch: required.fetch, credentials: required.credential });
    const invoke = exported<(required: Record<string, unknown>, optional?: CallOptions) => Promise<Outcome<unknown>>>({ module: required.module, name: 'invokeMetaInstagram' });
    return invoke({ request: { context: required.context, connectionId: required.input.connectionId, operationId: required.input.operationId,
        command: pluginCommand({ ...required, tool: required.contribution, input: required.input.arguments }) }, dispatch,
        clock: required.dependencies.clock, observer: required.dependencies.observer, configuration: { apiVersion: 'v25.0', timeoutMs: 15000 },
        wait: required.dependencies.wait }, { signal: required.signal });
}
async function google(required: Execution & { fetch: typeof fetch; credential: ReturnType<typeof credentials> }): Promise<Outcome<unknown>> {
    const binding = { scope: required.context.scope, connectionId: required.input.connectionId, customerId: required.input.accountId,
        currency: required.input.currency, timezone: required.input.timezone, mode: 'read_only', pluginDigest: required.state.revision, schemaFingerprint: hash({ value: required.contribution.inputSchema }) };
    const http = exported<Factory<unknown>>({ module: required.module, name: 'createHttpAdapter' })({ fetch: required.fetch, observer: required.dependencies.observer });
    const transport = exported<Factory<unknown>>({ module: required.module, name: 'createGoogleRestTransport' })({ binding, http, credentials: required.credential });
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
    const database = jobsDatabase(required);
    const repo = createSqlJobRepo({ database, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
    async function dispatch(input: { context: CallContext; pluginId: string; input: Selection; execute(): Promise<Outcome<unknown>> }): Promise<Outcome<unknown>> {
        const digest = digestArguments({ arguments: { pluginId: input.pluginId, input: input.input } });
        if (!digest.ok) return digest;
        const token = required.ids.next({});
        const claim = await database.transaction({ context: input.context, execute: async ({ session }) => {
            const joined = createSqlJobRepo({ database: { transaction: ({ execute }) => execute({ session }) }, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
            const queued = await joined.enqueue({ context: input.context, job: { operationId: input.input.operationId, handler: 'agent-plugin.invoke',
                idempotencyKey: 'agent-plugin:' + hash({ value: input.input.operationId }), argumentsDigest: digest.value, payload: { pluginId: input.pluginId, input: input.input } } });
            if (!queued.ok) return queued;
            const claimed = await session.query({ sql: "UPDATE job SET state='leased', attempts=1, lease_token=$1, lease_expires_at=$2 WHERE id=$3 AND tenant_id=$4 AND state='pending' AND attempts=0 RETURNING id",
                parameters: [token, required.clock.now({}) + 300000, queued.value.jobId, jobTenant(input)] });
            if (!claimed.rows.length) return localFailure<{ jobId: string }>({ code: 'conflict', message: 'Plugin operation already claimed; reconcile before retrying' });
            await journalClaim({ session, id: queued.value.jobId, tenantId: jobTenant(input), now: required.clock.now({}) });
            return queued;
        } });
        if (!claim.ok) return claim;
        const fence = { id: claim.value.jobId, tenantId: jobTenant(input), token, now: required.clock.now({}) };
        if (!await repo.outbox.beginDispatch(fence)) return localFailure({ code: 'conflict', message: 'Plugin claim expired' });
        let result: Outcome<unknown>;
        try { result = await input.execute(); } catch { result = localFailure({ message: 'Plugin result unknown; reconcile' }); }
        const checked = result.ok ? parseBoundary({ schema: boundedJsonSchema, input: result.value }) : result;
        const completion = jobCompletion({ result: checked });
        const finished = await repo.outbox.complete({ ...fence, now: required.clock.now({}) }, completion);
        if (!finished) return localFailure({ code: 'conflict', message: 'Plugin completion lost its lease; reconcile' });
        return checked;
    }
    return { dispatch: (input: Parameters<typeof dispatch>[0]) => pluginJobBoundary({ ...required, context: input.context, execute: () => dispatch(input) }) };
}
/** An absent/invalid acknowledgement cannot turn a durable claim into observed success. */
function jobCompletion(required: { result: Outcome<unknown> }): { state: 'reconcile' | 'failed' | 'succeeded' } {
    if (!required.result.ok) return { state: 'reconcile' };
    if (z.object({ status: z.literal('unknown') }).safeParse(required.result.value).success) return { state: 'reconcile' };
    if (z.object({ status: z.literal('failed') }).safeParse(required.result.value).success) return { state: 'failed' };
    return { state: 'succeeded' };
}
/** Storage exceptions are explicit failures; diagnostics contain only outcome and trace identity. */
async function pluginJobBoundary(required: { context: CallContext; observer: ObserverPort; execute(): Promise<Outcome<unknown>> }): Promise<Outcome<unknown>> {
    let result: Outcome<unknown>;
    try { result = await required.execute(); }
    catch { result = localFailure({ message: 'Plugin outbox unavailable; reconcile any submitted operation' }); }
    try { required.observer.observe({ operation: 'server.agent-plugin.jobs', outcome: result.ok ? 'ok' : result.error.code,
        correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); } catch { /* Diagnostics do not grant retries. */ }
    return result;
}
async function journalClaim(required: { session: JobsSqlSession; id: string; tenantId: string; now: number }): Promise<void> {
    await required.session.query({ sql: "INSERT INTO job_attempt (job_id,sequence,tenant_id,attempt,event_type,state,observed_at,evidence_id) SELECT $1,COALESCE(MAX(sequence),0)+1,$2,1,'claim','leased',$3,NULL FROM job_attempt WHERE job_id=$1",
        parameters: [required.id, required.tenantId, required.now] });
}
