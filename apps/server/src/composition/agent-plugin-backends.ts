/** Bundled vendor namespaces contribute to the ONE catalog. Vendor codecs stay in their packages. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { addonToolEffectsSchema, boundedJsonSchema, dailyLimitRequirementSchema, haltStopRequestSchema, idSchema, moneyExposureSchema, parseBoundary, toolDescriptorSchema } from '@open-marketing/contracts';
import type { CallContext, CallOptions, ClockPort, HaltStopPermit, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { digestArguments } from '@open-marketing/safety';
import type { AccountDispatchLockPort, SafetyRepoPort, SafetyService } from '@open-marketing/safety';
import type { CampaignConstituent, ConfirmationExchangePort, DispatchPermit, FrozenDispatchRequest } from '@open-marketing/safety';
import type { NeutralCampaignLaunch } from '@open-marketing/campaigns';
import type { AccountBindingLookupPort } from '@open-marketing/workspaces';
import { createSqlJobRepo, jobTenant } from '@open-marketing/jobs';
import type { JobsSqlSession } from '@open-marketing/jobs';
import { createConversionDispatcher } from '@open-marketing/measure';
import type { ConversionDeliveryPort } from '@open-marketing/measure';
import type { PolicyService } from '@open-marketing/policy';
import type { Integrations } from '../integrations.js';
import { toolPolicy } from '../om-tools.js';
import type { OmToolDefinition } from '../om-tools.js';
import { jobsDatabase, formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';
import { processingAllowed } from './identity.js';

/** Internal lifecycle projection; admission is read from installed manifest/capabilities, never chat. */
export type AgentPluginState = { enabled: boolean; bundled: boolean; admitted: boolean; revision: string; metadata: Record<string, unknown>; effects?: string[] };
/** Native namespace import and fetch are injected by serve; fixtures replace both without networking. */
export type AgentPluginEffects = { fetch: typeof fetch; loadModule(required: { moduleUrl: string }): Promise<object>;
    moduleDigest(required: { moduleUrl: string }): Promise<string>;
    wait(required: { milliseconds: number }, optional?: CallOptions): Promise<Outcome<void>> };
type ConversionStorage = { unit: UnitOfWork; policyForTransaction(required: { unit: UnitOfWork }): PolicyService };
type Dependencies = AgentPluginEffects & { projectRoot: string; clock: ClockPort; observer: ObserverPort;
    state(required: { context: CallContext; pluginId: string }): Promise<AgentPluginState | null>;
    integrations: Pick<Integrations, 'access'>; accounts: AccountBindingLookupPort; safetyRepo: Pick<SafetyRepoPort, 'snapshot'>;
    jobs: ReturnType<typeof bindAgentPluginJobs>; safety?: SafetyService; confirmations?: ConfirmationExchangePort; accountLocks: AccountDispatchLockPort }
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
type Execution = { dependencies: Dependencies; context: CallContext; pluginId: string; state: AgentPluginState; module: Namespace; contribution: Contribution; input: Selection; signal?: AbortSignal; stopPermit?: HaltStopPermit; authorization?: FrozenDispatchRequest; dispatchPermit?: DispatchPermit };

/** Read enabled bundled modules on catalog discovery; namespaces contain no retained credentials.
 * Each call resolves lifecycle/account state again. A broken plugin contributes only an unavailable
 * descriptor; other plugins and the rest of the catalog remain usable.
 * @example const backends = bindAgentPluginBackends({ ...ports, fetch, loadModule });
 * @complexity <=5 module loads and <=100 descriptors/plugin; no discovery egress.
 */
export function bindAgentPluginBackends(required: Dependencies) {
    return {
        /** Neutral creation stays unavailable until plugins expose verified executable call plans.
         * Admission is checked before any adapter/credentials. No guessed parent-ID substitutions. */
        async prepareCampaign(input: { context: CallContext; campaign: NeutralCampaignLaunch; operationId: string }): Promise<Outcome<readonly CampaignConstituent[]>> {
            for (const target of input.campaign.targets) {
                const state = await required.state({ context: input.context, pluginId: target.pluginId });
                if (!state?.enabled || !state.admitted) return localFailure({ message: 'Plugin unadmitted: ' + target.pluginId });
            }
            return localFailure({ code: 'not_implemented', message: 'NEEDS: plugin-owned exact creation calls, resolved assets, parent slots and complete non-serving readback' });
        },
        /** Measure owns inbox verification, transient contacts identifiers, durable claims and consent.
         * Incompatible plugin DTOs fail closed instead of inferring event categories or grant scope. */
        conversions(input: Omit<Parameters<typeof createConversionDispatcher>[0], 'delivery'> & { authority: ConversionAuthorityFactory }) {
            return createConversionDispatcher({ ...input, delivery: conversionDelivery({ dependencies: required, authority: input, bindAuthority: input.authority }) }, { observer: required.observer });
        },
        haltStop: (input: { context: CallContext; pluginId: string; permit: HaltStopPermit }) => haltStop({ dependencies: required, ...input }),
        async definitions({ context }: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> {
            const definitions: OmToolDefinition[] = [];
            for (const pluginId of pluginIds) definitions.push(...await pluginDefinitions({ dependencies: required, context, pluginId }));
            return { ok: true, value: definitions };
        },
    };
}

type ConversionAuthority = Pick<Parameters<typeof createConversionDispatcher>[0], 'policy' | 'grants' | 'audit'>;
/** Bind ALL final authority ports to the supplied unit; never capture a root DB inside it. */
type ConversionAuthorityFactory = (required: { unit: UnitOfWork }) => ConversionAuthority;
/** LinkedIn's existing backend matches measure's open definition contract. The other vendor
 * packages require owner-supplied mappings/evidence; no vendor codecs or guessed values live here.
 * Recheck grant/consent after the plugin resolves credentials and immediately before its fetch.
 * Final authorization and egress share haltAccount's injected account barrier.
 * @complexity One bundle load and bounded measure/plugin gates; no token cache or retries. */
function conversionDelivery(required: { dependencies: Dependencies; authority: ConversionAuthority; bindAuthority: ConversionAuthorityFactory }): ConversionDeliveryPort {
    return { deliver: (input, options) => conversionCall({ ...required, input, action: 'deliver', signal: options?.signal }),
        reconcile: (input, options) => conversionCall({ ...required, input, action: 'reconcile', signal: options?.signal }) };
}
/** Bind one plugin call; its foreign fetch ABI holds the shared halt barrier through egress.
 * Gate failures throw only inside the plugin's typed transport boundary.
 * @complexity O(b) bounded bundle hashing time/space; one send, no retries. */
async function conversionCall(required: { dependencies: Dependencies; authority: ConversionAuthority; bindAuthority: ConversionAuthorityFactory; input: Parameters<ConversionDeliveryPort['deliver']>[0]; action: 'deliver' | 'reconcile'; signal?: AbortSignal }): Promise<Outcome<{ status: 'delivered' | 'unknown' }>> {
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
            if (!await bindingCurrent(execution) || required.signal?.aborted) throw new Error('Conversion binding changed');
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
/** Reuse the existing grant/consent recheck in a writer transaction with the erasure barrier
 * and redacted admission evidence. COMMIT precedes fetch; the halt barrier stays unchanged.
 * SQLite serializes writers. Postgres needs SERIALIZABLE or a shared subject-row lock.
 * @complexity Bounded policy/grant reads and one append; no transaction across network I/O. */
async function admitConversion(required: { dependencies: Dependencies; bindAuthority: ConversionAuthorityFactory; input: Parameters<ConversionDeliveryPort['deliver']>[0]; execution: Execution; signal?: AbortSignal }): Promise<Outcome<void>> {
    const { dependencies } = required;
    if (dependencies.mode !== 'production') return localFailure({ code: 'forbidden', message: 'Conversion storage unavailable' });
    return dependencies.unit.transaction({ work: async ({ session }) => {
        const unit: UnitOfWork = { transaction: ({ work }) => work({ session }) };
        const authority = required.bindAuthority({ unit });
        const processing = await processingAllowed({ policy: dependencies.policyForTransaction({ unit }), context: required.execution.context, subjectId: required.input.event.subjectId });
        if (!processing.ok) return processing;
        if (!processing.value) return localFailure({ code: 'forbidden', message: 'Conversion subject blocked' });
        const authorized = await conversionCurrent({ ...required, authority });
        if (!authorized.ok) return authorized;
        return authority.audit.record({ context: required.execution.context, operationId: required.input.deliveryId!, outcome: 'egress_admitted' }, { signal: required.signal });
    } });
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
    const execution: Execution = { ...required, context: required.invocation.context, input: parsed.value, signal: required.invocation.signal, authorization: required.invocation.authorization, dispatchPermit: required.invocation.permit };
    try {
        if (!await bindingCurrent(execution)) return localFailure({ message: 'Plugin unadmitted, disabled or account binding unavailable' });
        const reason = unavailable({ ...required, policy: toolPolicy({ effects: required.contribution.effects }) });
        if (reason) return localFailure({ message: reason });
        const execute = () => executePlugin(execution);
        if (toolPolicy({ effects: required.contribution.effects }) === 'read') return await execute();
        if (toolPolicy({ effects: required.contribution.effects }) === 'spend' && !required.invocation.permit)
            return localFailure({ code: 'forbidden', message: 'Spend requires the dispatcher safety permit' });
        const dispatch = () => required.dependencies.jobs.dispatch({ context: execution.context, pluginId: required.pluginId, input: parsed.value, execute });
        if (required.invocation.permit && required.invocation.authorization?.campaignApproval) return await dispatch();
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
            pluginDigest: required.state.revision, currency: required.input.currency ?? required.state.metadata.currency, apiVersion: '202609', bindingId: 'linkedin-ads.stop.v1' },
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
        mode: 'read_only', pluginDigest: required.state.revision, schemaFingerprint: hash({ value: required.contribution.inputSchema }) };
    const http = exported<Factory<unknown>>({ module: required.module, name: 'createHttpAdapter' })({ fetch: required.fetch, observer: required.dependencies.observer });
    const transport = exported<Factory<unknown>>({ module: required.module, name: 'createGoogleRestTransport' })({ binding, http, credentials: required.credential });
    return { binding, transport };
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
    const database = jobsDatabase(required);
    const repo = createSqlJobRepo({ database, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
    async function dispatch(input: { context: CallContext; pluginId: string; input: Selection; execute(required: { jobId: string }): Promise<Outcome<unknown>> }): Promise<Outcome<unknown>> {
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
        try { result = await input.execute({ jobId: claim.value.jobId }); } catch { result = localFailure({ message: 'Plugin result unknown; reconcile' }); }
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
