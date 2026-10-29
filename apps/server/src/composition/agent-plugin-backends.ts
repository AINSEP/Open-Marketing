/** Installed vendor namespaces contribute to the ONE catalog. Vendor codecs stay in their packages. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createMailAdapterContext, createMailProviderRegistry } from '@jini-ai/platform/mail';
import type { MailProviderModule, MailerSendResult } from '@jini-ai/platform/mail';
import { fetchTextWithTimeout } from '@jini-ai/platform/fetch-with-timeout';
import { appErrorSchema, campaignDeploymentReceiptSchema, pluginToolSchema, capabilityCatalog, pluginConfigurationSchema, pluginConnectionConfigurationSchema, capabilityIdSchema, capabilityEnvelopeSchema, effectiveCapabilityEffects, callContextSchema, addonToolEffectsSchema, boundedJsonSchema, generationCostQuoteSchema, moneySchema, dailyLimitRequirementSchema, haltStopRequestSchema, idSchema, mailManifestExtensionSchema, moneyExposureSchema, parseBoundary, scopeSchema, toolDescriptorSchema } from '@open-marketing/contracts';
import type { AddonKind, Page, PageQuery, CampaignDeploymentRequired, CallableCapabilityId, CapabilityInput, CapabilityOutput, CapabilityEnvelope, PluginCapabilitiesFactory, PluginToolsFactory, PluginConfiguration, PluginConnectionConfiguration, PluginCapabilityDependencies, PluginCapability, CallContext, CallOptions, ClockPort, HaltStopPermit, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { digestArguments, effectRequestSchema } from '@open-marketing/safety';
import type { AccountDispatchLockPort, SafetyRepoPort, SafetyService } from '@open-marketing/safety';
import type { CampaignConstituent, ConfirmationExchangePort, DispatchPermit, FrozenDispatchRequest } from '@open-marketing/safety';
import type { CampaignValidationEvidence, NeutralCampaignLaunch } from '@open-marketing/contracts';
import type { AccountBinding, AccountBindingListPort, AccountBindingLookupPort } from '@open-marketing/workspaces';
import { appendJobEvidence, enqueueInlineJob, createSqlJobRepo, createSqlOutboxStore, jobTenant } from '@open-marketing/jobs';
import type { LeaseFence, ManagedOutboxStore } from '@open-marketing/jobs';
import { conversionDiagnosticsSchema, createConversionDispatcher, createMeasurementShareabilityAdapter } from '@open-marketing/measure';
import type { ConversionDeliveryOutcome, ConversionDeliveryPort } from '@open-marketing/measure';
import { dispatchDecision } from '@open-marketing/policy';
import type { PolicyService } from '@open-marketing/policy';
import type { ContactService } from '@open-marketing/contacts';
import type { PaidSendingAllowances } from '@open-marketing/safety';
import type { Addons } from '../addons.js';
import type { AlertMailPort } from '../alerts/email.js';
import { readAddonCatalog, readBoundedPages } from '../addon-tools.js';
import { toolPolicy } from '../om-tools.js';
import type { OmToolDefinition } from '../om-tools.js';
import { formRetryPolicy } from './forms.js';
import { localFailure } from './local-auth.js';
import { processingAllowed } from './identity.js';
import type { createSubjectLane } from './subject-lane.js';

/** Internal lifecycle projection; admission is read from installed manifest/capabilities, never chat. */
export type AgentPluginState = { enabled: boolean; bundled: boolean; admitted: boolean; revision: string; metadata: Record<string, unknown>; entryUrl?: string; capabilities?: unknown; effects?: string[] };
/** Native namespace import and fetch are injected by serve; fixtures replace both without networking. */
export type AgentPluginEffects = { fetch: typeof fetch; loadModule(required: { moduleUrl: string }): Promise<object>;
    moduleDigest(required: { moduleUrl: string }): Promise<string>;
    wait(required: { milliseconds: number }, optional?: CallOptions): Promise<Outcome<void>> };
type ConversionStorage = { unit: UnitOfWork; policyForTransaction(required: { unit: UnitOfWork }): PolicyService };
type Dependencies = AgentPluginEffects & { addons: Pick<Addons, 'list'>; projectRoot: string; clock: ClockPort; observer: ObserverPort;
    state(required: { context: CallContext; pluginId: string }): Promise<AgentPluginState | null>;
    integrations: { access(required: { context: CallContext; pluginId: string; connectionId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>>;
        list?(required: { context: CallContext; query: PageQuery }, optional?: CallOptions): Promise<Outcome<Page<{ connectionId: string; pluginId: string; status: string }>>> };
    accounts: AccountBindingLookupPort; accountList?: AccountBindingListPort; publicOrigin?: string; safetyRepo: Pick<SafetyRepoPort, 'snapshot'>;
    jobs: ReturnType<typeof bindAgentPluginJobs>; messaging?: { contacts: Pick<ContactService, 'resolve'>; policy: Pick<PolicyService, 'snapshot'>; paidSending: Pick<PaidSendingAllowances, 'reserve' | 'settle'> }; safety?: SafetyService; confirmations?: ConfirmationExchangePort; accountLocks: AccountDispatchLockPort; subjectLane: ReturnType<typeof createSubjectLane> }
    & ({ mode: 'production' } & ConversionStorage | { mode: 'read_only' | 'sandbox' } & Partial<ConversionStorage>);
type Namespace = Record<string, unknown>;
type Factory<T> = (required: Record<string, unknown>) => T;
type Contribution = { ownerOnly?: true; connectionOnly?: true; unavailableReason?: string; capability?: CapabilityEnvelope; name: string; description: string; inputSchema: Record<string, unknown>; effects: readonly string[]; parse(required: { input: unknown }): Outcome<unknown> };
const assistantWriteCapabilities = new Set(['organic.publish.v1']);
const selectionSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, accountId: idSchema.nullable(),
    arguments: z.record(z.string(), boundedJsonSchema), moneyExposure: moneyExposureSchema.nullable().optional(), requiredLimit: dailyLimitRequirementSchema.nullable().optional() });
type Selection = z.infer<typeof selectionSchema>;
type Invocation = Parameters<OmToolDefinition['invoke']>[0];
type Execution = { dependencies: Dependencies; context: CallContext; pluginId: string; state: AgentPluginState; module: Namespace; contribution: Contribution; input: Selection; signal?: AbortSignal; stopPermit?: HaltStopPermit; authorization?: FrozenDispatchRequest; dispatchPermit?: DispatchPermit; checkpoint?: DeploymentCheckpoint; evidence?: Record<string, unknown>[] };
type MailInvocation = { context: CallContext; pluginId: string; request: Omit<Parameters<AlertMailPort['send']>[0], 'context' | 'pluginId'> };
type MailAttempt = { egressed: boolean; refused: boolean };
type WebhookInvocation = { context: CallContext; pluginId: string; connection: { connectionId: string; accountId: string };
    rawBody: Uint8Array; headers: Readonly<Record<string, string | undefined>>; path: string };
type WebhookEntry = (input: { dependencies: PluginCapabilityDependencies; rawBody: Uint8Array;
    headers: Readonly<Record<string, string | undefined>>; path: string }, options?: CallOptions) => Promise<Outcome<{ events: readonly unknown[] }>>;
type DeploymentCheckpoint = (input: { step: string; phase: string; references?: unknown; record?: unknown }) => Promise<Outcome<void>>;
const deploymentName = 'campaign_deploy_paused';

/** Read enabled installed modules on catalog discovery; namespaces contain no retained credentials.
 * Each call resolves lifecycle/account state again. A broken plugin contributes only an unavailable
 * descriptor; other plugins and the rest of the catalog remain usable.
 * @example const backends = bindAgentPluginBackends({ ...ports, fetch, loadModule });
 * @complexity <=1000 installed packages and <=100 descriptors/plugin; no discovery egress.
 */
export function bindAgentPluginBackends(required: Dependencies) {
    return {
        /** Typed server reads use the same guarded invocation as tools. Raised effects require the
         * generic approval dispatcher; discovery never grants execution authority.
         * @example backends.invokeCapability({ context, pluginId, capabilityId: 'campaign.status.v1', connection, input });
         */
        async invokeCapability<K extends CallableCapabilityId>(input: { context: CallContext; pluginId: string; capabilityId: K;
            connection: { connectionId: string; accountId: string }; input: CapabilityInput<K> }, options?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
            const result = await pluginJobBoundary({ ...required, context: input.context,
                execute: () => invokeCapability({ dependencies: required, ...input }, options) });
            // The shared execution path validates the catalog output before returning success.
            return result as Outcome<CapabilityOutput<K>>;
        },
        /** Resolve sandbox plans and dry-run each supported destination before approval.
         * Real account/assets/declarations remain NEEDS; validation uses guarded read-only egress. */
        async prepareCampaign(input: { context: CallContext; campaign: NeutralCampaignLaunch; operationId: string }, options?: CallOptions): Promise<Outcome<{ calls: readonly CampaignConstituent[]; validation: readonly CampaignValidationEvidence[] }>> {
            const calls: CampaignConstituent[] = [];
            const validation: CampaignValidationEvidence[] = [];
            for (const target of input.campaign.targets) {
                const prepared = await pluginJobBoundary({ ...required, context: input.context, execute: () => prepareDestination({ dependencies: required, ...input, target }, options) });
                if (!prepared.ok) return prepared;
                calls.push(prepared.value.constituent);
                validation.push(prepared.value.evidence);
            }
            return { ok: true, value: { calls, validation } };
        },
        executeCampaign: (input: CampaignExecution) => pluginJobBoundary({ ...required, context: input.context, execute: () => executeCampaign({ dependencies: required, ...input }) }),
        readCampaign: (input: { context: CallContext; request: FrozenDispatchRequest }) => pluginJobBoundary({ ...required, context: input.context, execute: () => campaignEvidence({ dependencies: required, context: input.context, operationId: input.request.envelope.operationId }) }),
        /** Measure owns inbox verification, transient contacts identifiers, durable claims and consent.
         * Incompatible plugin DTOs fail closed instead of inferring event categories or grant scope. */
        conversions(input: Omit<Parameters<typeof createConversionDispatcher>[0], 'delivery'> & { authority: ConversionAuthorityFactory }) {
            return { dispatch: (request: ConversionDispatchInput, options?: CallOptions) => dispatchConversion({ dependencies: required, dispatcher: input, input: request }, options),
                reconcile: (request: Parameters<ReturnType<typeof createConversionDispatcher>['reconcile']>[0], options?: CallOptions) => reconcileConversion({ dependencies: required, dispatcher: input, input: request }, options) };
        },
        haltStop: (input: { context: CallContext; pluginId: string; permit: HaltStopPermit }) => haltStop({ dependencies: required, ...input }),
        /** Send through the selected installed module; reserve must recheck notification consent.
         * @example backends.mail({ context, pluginId, request: { connectionId, idempotencyKey, message, reserve } }); */
        mail: (input: MailInvocation) => mail({ dependencies: required, ...input }),
        /** Signed public callbacks only increase suppression; they are accepted in every mode. */
        ingestWebhook: (input: WebhookInvocation, options?: CallOptions) => ingestWebhook({ dependencies: required, ...input }, options),
        async definitions({ context }: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> {
            const definitions: OmToolDefinition[] = [];
            const installed = await installedPluginIds({ dependencies: required, context });
            if (!installed.ok) return installed;
            for (const pluginId of installed.value) definitions.push(...await pluginDefinitions({ dependencies: required, context, pluginId }));
            definitions.push(campaignReconciliation({ dependencies: required }), messageSendDefinition({ dependencies: required }),
                messageConnectionsDefinition({ dependencies: required }), messagePreviewDefinition({ dependencies: required }));
            return { ok: true, value: definitions };
        },
    };
}

const messageSendSchema = z.strictObject({ operationId: idSchema, pluginId: idSchema, connectionId: idSchema, accountId: idSchema,
    recipient: z.string().regex(/^\+[1-9][0-9]{7,14}$/), purpose: idSchema, intent: z.enum(['marketing', 'transactional']),
    message: z.record(z.string(), boundedJsonSchema), maxCost: moneySchema.refine(value => value.currency === 'USD') });
const messageAuthoritySchema = z.strictObject({ argumentsDigest: z.string().regex(/^[a-f0-9]{64}$/),
    quote: generationCostQuoteSchema.pick({ quoteId: true, argumentsDigest: true, estimated: true, upperBound: true, pricingEvidenceId: true, expiresAt: true, status: true }) });
const messageReceiptSchema = z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('accepted'), deliveryId: idSchema, providerMessageId: idSchema }),
    z.strictObject({ status: z.literal('unknown'), deliveryId: idSchema }),
]);
type MessageSend = z.infer<typeof messageSendSchema>;
type MessageCall = { dependencies: Dependencies; context: CallContext; input: MessageSend; signal?: AbortSignal };
type MessageAuthority = z.infer<typeof messageAuthoritySchema> & { execute(): Promise<Outcome<unknown>> };
type MessageEntry = (input: { dependencies: PluginCapabilityDependencies & { deadlineSignal(input: { timeoutMs: number }): AbortSignal; authority(input: MessageAuthority): Promise<Outcome<unknown>> };
    context: CallContext; deliveryId: string; recipient: string; message: MessageSend['message'] }, options?: CallOptions) => Promise<Outcome<unknown>>;

/** Owner-only removes remembered grants and offers only Allow/Cancel. The exact arguments show
 * recipient, message and the approved USD ceiling; the plugin's fresh quote must fit that ceiling.
 * @example om tools call om_message_send --input-file message.json
 */
function messageSendDefinition(required: { dependencies: Dependencies }): OmToolDefinition {
    const unavailableReason = required.dependencies.mode === 'read_only' ? 'Local vendor account mode is read-only'
        : !required.dependencies.messaging ? 'Messaging services unavailable' : undefined;
    return { name: 'om_message_send', capability: 'Send one message', description: 'Send the exact message to an OM contact after owner Allow/Cancel approval. maxCost is the maximum approved USD cost in cents; a fresh plugin quote must fit. Unknown outcomes require reconciliation.',
        effects: ['write'], policy: 'write', ownerOnly: true, revision: '1', unavailableReason,
        inputSchema: toolDescriptorSchema.shape.inputSchema.parse(z.toJSONSchema(messageSendSchema, { io: 'input' })),
        parse: input => parseBoundary({ schema: messageSendSchema, input: input.input }),
        invoke: input => pluginJobBoundary({ ...required.dependencies, context: input.context, execute: async () => {
            if (unavailableReason) return localFailure({ code: 'not_implemented', message: unavailableReason });
            const parsed = parseBoundary({ schema: messageSendSchema, input: input.input });
            if (!parsed.ok) return parsed;
            const { operationId, pluginId, connectionId, accountId, ...args } = parsed.value;
            return required.dependencies.jobs.dispatch({ context: input.context, pluginId,
                input: { operationId, connectionId, accountId, arguments: args },
                execute: () => dispatchMessage({ ...required, context: input.context, input: parsed.value, signal: input.signal }) });
        } }),
    };
}
function messageFailed(required: { reason: string }): Outcome<{ status: 'failed'; reason: string }> {
    return { ok: true, value: { status: 'failed', reason: required.reason } };
}

/** Resolve a known contact, then keep merged consent current under the same lane as STOP ingress.
 * No plugin call or reservation precedes the decision. @complexity One resolve + bounded lineage.
 */
async function dispatchMessage(required: MessageCall): Promise<Outcome<unknown>> {
    const messaging = required.dependencies.messaging!;
    const contact = await messaging.contacts.resolve({ context: required.context, identifier: { kind: 'phone', raw: required.input.recipient } }, { signal: required.signal });
    if (!contact.ok) return messageFailed({ reason: contact.error.message === 'Subject not found' ? 'unknown_recipient' : 'recipient_unavailable' });
    const execution = await messageExecution(required);
    if (!execution) return messageFailed({ reason: 'not_implemented' });
    const subjectId = contact.value.subjectId;
    return required.dependencies.subjectLane.run({ context: required.context, subjectIds: [subjectId], work: async ({ subjectIds }) => {
        const policy = await messaging.policy.snapshot({ context: required.context, subjectId }, { signal: required.signal });
        if (!policy.ok) return messageFailed({ reason: 'policy_unavailable' });
        const decision = dispatchDecision({ subject: { scope: required.context.scope, subjectId }, policy: policy.value,
            lineage: subjectIds.map(id => ({ subject: { scope: required.context.scope, subjectId: id }, erasure: 'none' as const })),
            action: { kind: 'messaging', channel: { id: execution.messageChannel, intent: required.input.intent }, purpose: required.input.purpose }, now: required.dependencies.clock.now({}) });
        if (!decision.allowed) return messageFailed({ reason: decision.reason });
        return callMessage({ ...required, execution });
    } }, { signal: required.signal });
}

/** Missing/broken exports are a definitive refusal before any vendor egress. */
async function messageExecution(required: { dependencies: Dependencies; context: CallContext; input: { pluginId: string; connectionId: string; accountId: string }; signal?: AbortSignal }): Promise<(Execution & { messageChannel: string }) | undefined> {
    try {
        const execution = await pluginExecution({ ...required, pluginId: required.input.pluginId, connection: required.input, effects: ['write'] }, { signal: required.signal });
        if (!execution) return undefined;
        const moduleUrl = new URL(pluginModuleUrl({ state: execution.state }));
        moduleUrl.searchParams.set('revision', execution.state.revision);
        execution.module = { ...await required.dependencies.loadModule({ moduleUrl: moduleUrl.href }) };
        const channel = z.string().regex(/^[a-z][a-z0-9_-]*$/).safeParse(execution.module.messageChannel);
        if (!channel.success || typeof execution.module.sendMessage !== 'function') return undefined;
        return { ...execution, messageChannel: channel.data };
    } catch { return undefined; }
}

const messageTargetSchema = z.strictObject({ pluginId: idSchema, connectionId: idSchema, accountId: idSchema });
const messagePreviewSchema = messageTargetSchema.extend({ content: z.string().min(1).max(1600) });
const segmentOutcomeSchema = z.union([z.strictObject({ ok: z.literal(true), value: z.number().int().positive().max(1600) }), z.object({ ok: z.literal(false) })]);
const routePluginId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const urlSafeId = /^(?!\.{1,2}$)[A-Za-z0-9._~-]+$/;
type MessageTarget = z.infer<typeof messageTargetSchema>;
type MessageConnection = MessageTarget & { channel: string; inboundWebhookUrl: string | null };
type MessageRead = { dependencies: Dependencies; context: CallContext; signal?: AbortSignal };
type ConnectionRow = { connectionId: string; pluginId: string; status: string };

/** Read-only discovery for Studio, assistant and CLI: bound messaging connections plus the
 * server-computed inbound callback URL. No credential access, egress or effects.
 * @example om tools call om_message_connections --input '{}'
 */
function messageConnectionsDefinition(required: { dependencies: Dependencies }): OmToolDefinition {
    const schema = z.strictObject({});
    return { name: 'om_message_connections', capability: 'Messaging connections', description: 'List bound messaging connections (max 100) with channel and inbound webhook URL to paste into the vendor console; null URL means set OM_PUBLIC_ORIGIN or use URL-safe connection/account IDs.',
        effects: ['read'], policy: 'read', ownerOnly: true, revision: '1',
        inputSchema: toolDescriptorSchema.shape.inputSchema.parse(z.toJSONSchema(schema, { io: 'input' })),
        parse: input => parseBoundary({ schema, input: input.input }),
        invoke: input => pluginJobBoundary({ ...required.dependencies, context: input.context, execute: () => messageConnections({ ...required, context: input.context, signal: input.signal }) }) };
}
/** Segment preview through the plugin's optional pure counter; channels without one return null.
 * @example om tools call om_message_preview --input '{"pluginId":"p","connectionId":"c","accountId":"a","content":"Hi"}'
 */
function messagePreviewDefinition(required: { dependencies: Dependencies }): OmToolDefinition {
    return { name: 'om_message_preview', capability: 'Message segment preview', description: 'Count message segments for one bound messaging connection without credentials or vendor requests. segments is null when the channel has no segment counter.',
        effects: ['read'], policy: 'read', ownerOnly: true, revision: '1',
        inputSchema: toolDescriptorSchema.shape.inputSchema.parse(z.toJSONSchema(messagePreviewSchema, { io: 'input' })),
        parse: input => parseBoundary({ schema: messagePreviewSchema, input: input.input }),
        invoke: input => pluginJobBoundary({ ...required.dependencies, context: input.context, execute: async () => {
            const parsed = parseBoundary({ schema: messagePreviewSchema, input: input.input });
            return parsed.ok ? messagePreview({ ...required, context: input.context, input: parsed.value, signal: input.signal }) : parsed;
        } }) };
}

/** Join scoped account bindings to saved connections; each candidate passes the send path's checks.
 * @complexity <=1000 bindings/connections via readBoundedPages; one module load per candidate, <=100 items.
 */
async function messageConnections(required: MessageRead): Promise<Outcome<{ items: MessageConnection[] }>> {
    const { integrations, accountList } = required.dependencies;
    if (!integrations.list || !accountList) return localFailure({ code: 'not_implemented', message: 'Messaging connections unavailable' });
    const options = { signal: required.signal };
    const connections = await readBoundedPages<ConnectionRow>({ readPage: (input, callOptions) => integrations.list!({ ...input, context: required.context }, callOptions) }, options);
    if (!connections.ok) return connections;
    const bindings = await readBoundedPages({ readPage: (input, callOptions) => accountList.listAccountBindings({ ...input, context: required.context }, callOptions) }, options);
    if (!bindings.ok) return bindings;
    const items: MessageConnection[] = [];
    for (const binding of bindings.value) {
        if (items.length >= 100) break;
        const item = await messageConnection({ ...required, binding, connections: connections.value });
        if (item) items.push(item);
    }
    return { ok: true, value: { items } };
}
async function messageConnection(required: MessageRead & { binding: AccountBinding; connections: readonly ConnectionRow[] }): Promise<MessageConnection | undefined> {
    const { binding, context } = required;
    if (binding.scope.ownerId !== context.scope.ownerId || binding.scope.workspaceId !== context.scope.workspaceId) return undefined;
    const connection = required.connections.find(row => row.connectionId === binding.connectionId && row.status !== 'disconnected');
    if (!connection) return undefined;
    const input = { pluginId: connection.pluginId, connectionId: binding.connectionId, accountId: binding.externalAccountId };
    const execution = await messageExecution({ ...required, input });
    if (!execution) return undefined;
    return { ...input, channel: execution.messageChannel, inboundWebhookUrl: inboundWebhookUrl({ ...input, publicOrigin: required.dependencies.publicOrigin }) };
}
/** Only IDs that need no escaping round-trip through the raw-pathname webhook route. */
function inboundWebhookUrl(required: MessageTarget & { publicOrigin?: string }): string | null {
    const ids = [required.pluginId, required.connectionId, required.accountId];
    if (!required.publicOrigin || !routePluginId.test(required.pluginId) || !ids.every(id => urlSafeId.test(id))) return null;
    return new URL(required.publicOrigin).origin + '/hooks/agent-plugins/' + ids.join('/');
}
/** Pure plugin counter only: no credentials, no fetch. Malformed output refuses. */
async function messagePreview(required: MessageRead & { input: z.infer<typeof messagePreviewSchema> }): Promise<Outcome<{ segments: number | null }>> {
    const execution = await messageExecution(required);
    if (!execution) return localFailure({ code: 'not_implemented', message: 'Messaging connection unavailable' });
    if (typeof execution.module.countMessageSegments !== 'function') return { ok: true, value: { segments: null } };
    try {
        const counted = segmentOutcomeSchema.safeParse(exported<(input: { content: string }) => unknown>({ module: execution.module, name: 'countMessageSegments' })({ content: required.input.content }));
        if (!counted.success) return localFailure({ code: 'unavailable', message: 'Segment count unavailable' });
        return counted.data.ok ? { ok: true, value: { segments: counted.data.value } } : localFailure({ code: 'invalid_input', message: 'Message cannot be segmented' });
    } catch { return localFailure({ code: 'unavailable', message: 'Segment count unavailable' }); }
}

/** Bind guarded credentials/fetch for this call only. Invalid post-send receipts stay uncertain. */
async function callMessage(required: MessageCall & { execution: Execution }): Promise<Outcome<unknown>> {
    const dependencies = pluginDependencies(required.execution);
    if (!dependencies.ok) return messageFailed({ reason: 'plugin_unavailable' });
    // Adapt the injected wait to the plugin's deadline ABI; cancel every timer at call end.
    const timers: AbortController[] = [];
    const deadlineSignal = ({ timeoutMs }: { timeoutMs: number }) => {
        const timer = new AbortController(), deadline = new AbortController();
        timers.push(timer);
        void required.dependencies.wait({ milliseconds: timeoutMs }, { signal: timer.signal }).then(
            () => { if (!timer.signal.aborted) deadline.abort(); }, () => { if (!timer.signal.aborted) deadline.abort(); });
        return deadline.signal;
    };
    try {
        const result = await exported<MessageEntry>({ module: required.execution.module, name: 'sendMessage' })({
            dependencies: { ...dependencies.value, deadlineSignal, authority: input => messageAuthority({ ...required, authority: input }) },
            context: required.context, deliveryId: required.input.operationId, recipient: required.input.recipient, message: required.input.message }, { signal: required.signal });
        if (!result.ok) return messageFailed({ reason: /^quote_exceeds_approved_maximum: [0-9]+ USD cents$/.test(result.error.message) ? result.error.message : result.error.code });
        const receipt = messageReceiptSchema.safeParse(result.value);
        if (!receipt.success || receipt.data.deliveryId !== required.input.operationId) return { ok: true, value: { status: 'unknown' } };
        return { ok: true, value: receipt.data };
    } catch { return { ok: true, value: { status: 'unknown' } }; }
    finally { timers.forEach(timer => timer.abort()); }
}

/** Accounting adds no authority: reserve only within the exact ceiling; unknown keeps the hold.
 * Accepted sends settle provisionally at the quote. A settlement failure never resends acceptance.
 */
async function messageAuthority(required: MessageCall & { authority: MessageAuthority }): Promise<Outcome<unknown>> {
    const parsed = parseBoundary({ schema: messageAuthoritySchema, input: { quote: required.authority.quote, argumentsDigest: required.authority.argumentsDigest } });
    if (!parsed.ok) return parsed;
    const { quote, argumentsDigest } = parsed.value;
    if (!quote.upperBound || quote.upperBound.currency !== required.input.maxCost.currency) return localFailure({ code: 'forbidden', message: 'quote_unavailable' });
    if (quote.upperBound.minorUnits > required.input.maxCost.minorUnits) return localFailure({ code: 'forbidden', message: 'quote_exceeds_approved_maximum: ' + quote.upperBound.minorUnits + ' USD cents' });
    const paidSending = required.dependencies.messaging!.paidSending;
    const reservation = await paidSending.reserve({ context: required.context, operationId: required.input.operationId, argumentsDigest, quote }, { signal: required.signal });
    if (!reservation.ok) return reservation;
    const outcome = await required.authority.execute();
    const accepted = messageReceiptSchema.options[0].extend({ deliveryId: z.literal(required.input.operationId) }).safeParse(outcome.ok ? outcome.value : null);
    if (outcome.ok && !accepted.success) return outcome;
    await pluginJobBoundary({ ...required.dependencies, context: required.context, execute: () => paidSending.settle({ context: required.context, settlement: {
        reservationId: reservation.value.reservationId, observationId: accepted.success ? accepted.data.providerMessageId : required.input.operationId + ':refused',
        actual: accepted.success ? quote.upperBound! : { currency: 'USD', minorUnits: 0 },
    } }) });
    return outcome;
}

/** Page the existing catalog, refusing cycles/overflow instead of truncating discovery.
 * @complexity <=10 pages of 100 packages, O(n) retained IDs; no module or credential access.
 */
async function installedPluginIds(required: { dependencies: Dependencies; context: CallContext }): Promise<Outcome<string[]>> {
    const rows = await readAddonCatalog({ context: required.context, addons: required.dependencies.addons, kind: 'agent-plugin' });
    return rows.ok ? { ok: true, value: rows.value.filter(row => row.enabled && row.kind === 'agent-plugin').map(row => row.id) } : rows;
}

/** Frozen deployment names select one plugin; its current exact definition must still exist. */
async function campaignPluginId(required: { dependencies: Dependencies; context: CallContext; tool: string }): Promise<string | undefined> {
    const match = /^vendor_([a-z0-9]+(?:_[a-z0-9]+)*)_campaign_deploy_paused$/.exec(required.tool);
    if (!match) return undefined;
    const pluginId = match[1].replaceAll('_', '-');
    const definitions = await pluginDefinitions({ ...required, pluginId });
    return definitions.some(tool => tool.name === required.tool && !tool.unavailableReason) ? pluginId : undefined;
}

/** Canonical envelopes share the installed package identity; legacy declarations stay non-executable.
 * @complexity O(n) time/space, <=100 rows. No factory or I/O runs during declaration parsing.
 */
function capabilityContributions(required: { module: Namespace; state: AgentPluginState; pluginId: string; pluginDigest: string }): Contribution[] {
    const rows = z.array(z.union([idSchema, z.record(z.string(), z.unknown())])).max(100).parse(required.state.capabilities ?? []);
    const seen = new Set<string>();
    const capabilities = rows.flatMap(row => {
        if (typeof row === 'string') return [];
        const id = capabilityIdSchema.safeParse(row.capabilityId);
        if (!id.success) return [];
        // Only named write capabilities may use assistant cards; consent-bound writes stay backend-only.
        const catalog = capabilityCatalog[id.data];
        if (!assistantCapability({ capabilityId: id.data, effects: catalog.requiredEffects })) return [];
        const envelope = capabilityEnvelopeSchema.parse({ ...row, pluginDigest: row.pluginDigest === undefined ? required.pluginDigest : row.pluginDigest });
        if (envelope.pluginId !== required.pluginId || envelope.pluginDigest !== required.pluginDigest) throw new Error('Capability package mismatch');
        if (seen.has(id.data)) throw new Error('Duplicate capability');
        seen.add(id.data);
        // Reserved IDs have no callable schema yet; skip them instead of disabling the whole plugin.
        return capabilityCatalog[id.data].input ? [{ ...envelope, capabilityId: id.data }] : [];
    });
    // A plugin without the factory keeps its other tools; it just contributes no capabilities.
    if (typeof required.module.createCapabilities !== 'function') return [];
    return capabilities.map(capability => {
        const catalog = capabilityCatalog[capability.capabilityId];
        const effects = effectiveCapabilityEffects({ capabilityId: capability.capabilityId, declaredEffects: capability.effects });
        if (!effects.ok || !catalog.input) throw new Error('Capability unavailable');
        return { capability, ownerOnly: assistantWriteCapabilities.has(capability.capabilityId) ? true as const : undefined, name: capability.capabilityId, description: 'Plugin capability ' + capability.capabilityId,
            effects: effects.value, inputSchema: z.toJSONSchema(catalog.input, { io: 'input' }),
            parse: input => parseBoundary<unknown>({ schema: catalog.input!, input: input.input }) };
    });
}

/** Catalog reads and explicitly exposed writes only; admission and cards remain server-owned. */
function assistantCapability(required: { capabilityId: string; effects: readonly string[] }): boolean {
    return required.effects.length === 1 && required.effects[0] === 'read' || assistantWriteCapabilities.has(required.capabilityId);
}

type CapabilityInvocation = { dependencies: Dependencies; context: CallContext; pluginId: string; capabilityId: CallableCapabilityId;
    connection: { connectionId: string; accountId: string }; input: unknown };
/** Only pure reads can bypass cards. Tool calls use definition/invoke with the same catalog parser. */
async function invokeCapability(required: CapabilityInvocation, optional?: CallOptions): Promise<Outcome<unknown>> {
    if (optional?.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Capability cancelled' });
    const context = parseBoundary({ schema: callContextSchema, input: required.context });
    if (!context.ok) return context;
    const id = capabilityIdSchema.safeParse(required.capabilityId);
    if (!id.success || !capabilityCatalog[id.data].input) return localFailure({ code: 'invalid_input', message: 'Capability has no callable schema' });
    const definitions = await pluginDefinitions(required);
    const name = capabilityToolName({ pluginId: required.pluginId, capabilityId: required.capabilityId });
    const tool = definitions.find(tool => tool.name === name);
    if (!tool || tool.unavailableReason || !tool.effects.every(effect => effect === 'read')) return localFailure({ code: 'forbidden', message: 'Admitted read-only capability required; use the approval dispatcher for effects' });
    return tool.invoke({ context: context.value, signal: optional?.signal, input: { ...required.connection,
        operationId: hash({ value: [required.capabilityId, required.connection, required.input] }), arguments: required.input } });
}

/** One 30s deadline covers factory/handler work and aborts guarded credentials/egress.
 * The injected wait is cancelled on completion; caller cancellation settles even an inert handler.
 */
async function executeCapability(required: Execution): Promise<Outcome<unknown>> {
    const controller = new AbortController();
    const timer = new AbortController();
    const signal = required.signal ? AbortSignal.any([required.signal, controller.signal]) : controller.signal;
    const expired = new Error('Capability deadline');
    const failure = () => localFailure({ code: signal.reason === expired ? 'expired' : 'cancelled', message: 'Capability deadline or cancellation' });
    if (signal.aborted) return failure();
    let onAbort: () => void = () => {};
    const cancelled = new Promise<Outcome<unknown>>(resolve => { onAbort = () => resolve(failure()); signal.addEventListener('abort', onAbort, { once: true }); });
    try {
        const deadline = required.dependencies.wait({ milliseconds: 30000 }, { signal: timer.signal }).then(result => {
            if (!result.ok) return result;
            controller.abort(expired);
            return failure();
        });
        return await Promise.race([capabilityCall({ ...required, signal, capabilityId: required.contribution.capability!.capabilityId as CallableCapabilityId | 'campaign.halt-stop.v1' | 'organic.publish.v1' }), cancelled, deadline]);
    }
    finally { signal.removeEventListener('abort', onAbort); timer.abort(); controller.abort(); }
}

// Keys the host owns or reads itself.
const hostOwned = new Set(['admitted', 'enabled', 'version', 'capabilities', 'credentialCards', 'credentialAssets', 'servers', 'provides',
    'campaignFixture', 'mailAdapters', 'modelProvider']);

/** Share opaque install options across tool and mail contexts; host declarations stay private.
 * @complexity O(k) metadata keys, no I/O or credentials. */
function installSettings(required: { state: AgentPluginState }): Record<string, unknown> {
    return Object.fromEntries(Object.entries(required.state.metadata).filter(([key]) => !hostOwned.has(key)));
}

/** Build the host envelope for capabilities and tools, allowing account discovery without an account.
 * @returns Schema-validated install settings and binding, or a typed boundary failure.
 * @complexity O(k) metadata keys; no credentials or I/O.
 */
function pluginConfiguration(required: Execution) {
    const schema = required.contribution.connectionOnly === true && required.input.accountId === null ? pluginConnectionConfigurationSchema : pluginConfigurationSchema;
    return parseBoundary<PluginConfiguration | PluginConnectionConfiguration>({ schema, input: { scope: required.context.scope, connectionId: required.input.connectionId,
        accountId: required.input.accountId, pluginDigest: required.state.revision,
        settings: installSettings(required) } });
}

/** Resolve one declared default through Jini's registry; no provider or credential is cached.
 * Only the already-contained entry module is supported. Unsupported declarations fail closed.
 * @complexity One module load; <=16 descriptors and <=8 credential keys. */
async function mailProvider(required: { dependencies: Dependencies; context: CallContext; pluginId: string }): Promise<Outcome<{ state: AgentPluginState; provider: MailProviderModule }>> {
    const loaded = await required.dependencies.state({ context: required.context, pluginId: required.pluginId });
    if (!loaded) return localFailure({ code: 'not_implemented', message: 'Mail provider not bound' });
    if (!(loaded.enabled && loaded.admitted && loaded.entryUrl)) return localFailure({ code: 'forbidden', message: 'Mail provider unavailable' });
    const state = { ...structuredClone(loaded), revision: await executableRevision({ ...required, state: loaded }) };
    const metadata = mailManifestExtensionSchema.safeParse(state.metadata);
    if (!metadata.success) return localFailure({ code: 'not_implemented', message: 'Mail provider declaration unavailable' });
    const moduleUrl = new URL(pluginModuleUrl({ state }));
    moduleUrl.searchParams.set('revision', state.revision);
    const module = await required.dependencies.loadModule({ moduleUrl: moduleUrl.href }) as { default?: MailProviderModule };
    const provider = module.default;
    if (!provider) return localFailure({ code: 'not_implemented', message: 'Mail provider module unavailable' });
    const descriptor = metadata.data.mailAdapters?.find(row => row.id === provider.id);
    if (!descriptor || !state.entryUrl!.endsWith('/' + descriptor.module)) return localFailure({ code: 'not_implemented', message: 'Mail provider module mismatch' });
    const registry = createMailProviderRegistry();
    if (!registry.contribute({ definition: { id: descriptor.id, provider, label: descriptor.label }, pluginId: required.pluginId })) return localFailure({ code: 'not_implemented', message: 'Mail provider registration refused' });
    if (descriptor.feedback !== provider.capabilities.feedback || JSON.stringify(descriptor.credentialKeys) !== JSON.stringify(provider.credentialKeys)) return localFailure({ code: 'not_implemented', message: 'Mail provider declaration mismatch' });
    return { ok: true, value: { state, provider: registry.get({ id: descriptor.id })!.provider } };
}

/** One-shot foreign HTTP ABI: recheck lifecycle, caller consent/cap, then lifecycle again.
 * Throws only inside the provider boundary; mail() translates pre-egress failures to refusals.
 * @complexity One <=10s fetch/read, <=1MiB response, no redirects or retries. */
function mailHttpClient(required: MailInvocation & { dependencies: Dependencies; state: AgentPluginState; attempt: MailAttempt }): Parameters<MailProviderModule['create']>[0]['kit']['httpClient'] {
    let used = false;
    return { async send({ request }) {
        if (used) throw new Error('Mail attempt already used');
        used = true;
        required.attempt.refused = true;
        if (!await current(required)) throw new Error('Mail provider unavailable');
        const reserved = await required.request.reserve();
        if (!reserved.ok || reserved.value !== 'reserved') throw new Error('Mail reservation refused');
        if (!await current(required)) throw new Error('Mail provider changed');
        required.attempt.refused = false;
        const { response, text } = await fetchTextWithTimeout({ url: request.url, timeoutMs: Math.min(request.timeoutMs ?? 10000, 10000),
            init: { method: request.method, headers: request.headers, body: request.body as BodyInit | undefined, redirect: 'error' } }, {
            maxResponseBytes: 1048576,
            // Foreign fetch ABI: mark egress at the native call, after timeout validation.
            fetch: (url, init) => { required.attempt.egressed = true; return required.dependencies.fetch(url, init); },
        });
        const headers: Record<string, string> = {};
        // Native Headers callback supplies scalar value/key arguments.
        response.headers.forEach((value, key) => { headers[key] = value; });
        return { status: response.status, headers, bodyText: text };
    } };
}

/** Call-local credentials/settings/time and a guarded HTTP attempt, with fixed failure messages.
 * A denial before native fetch has no unknown flag; submitted failures retain uncertainty.
 * @complexity One module/credential resolution and bounded send; no jobs, retries or token cache. */
async function mail(required: MailInvocation & { dependencies: Dependencies }): Promise<MailerSendResult> {
    const attempt: MailAttempt = { egressed: false, refused: false };
    try {
        const loaded = await mailProvider(required);
        if (!loaded.ok) return { ok: false, retryable: false, errorCode: loaded.error.code, message: 'Mail provider unavailable' };
        const { state, provider } = loaded.value;
        const credential = await required.dependencies.integrations.access({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } },
            pluginId: required.pluginId, connectionId: required.request.connectionId });
        if (!credential.ok) return { ok: false, retryable: false, errorCode: 'forbidden', message: 'Mail credential unavailable' };
        if (!await current({ ...required, state })) return { ok: false, retryable: false, errorCode: 'forbidden', message: 'Mail provider changed' };
        const httpClient = mailHttpClient({ ...required, state, attempt });
        const ctx = createMailAdapterContext({ credential: { token: credential.value.accessToken }, kit: { httpClient } }, {
            now: () => new Date(required.dependencies.clock.now({})), settings: installSettings({ state }),
        });
        const result = await provider.create(ctx).send({ workspaceId: required.request.message.workspaceId, idempotencyKey: required.request.idempotencyKey,
            sourceContext: { module: 'om.mail' }, message: required.request.message });
        return mailOutcome({ result, attempt });
    } catch {
        return { ok: false, retryable: false, errorCode: 'unavailable', message: 'Mail delivery unavailable', ...(attempt.egressed ? { unknown: true } : {}) };
    }
}

/** Normalize provider results against the guarded attempt; success requires native egress.
 * Returns fixed refusals before egress and preserves uncertainty/back-pressure afterwards.
 * @complexity O(1) time/space; pure, with no I/O. */
function mailOutcome(required: { result: MailerSendResult; attempt: MailAttempt }): MailerSendResult {
    const { result, attempt } = required;
    if (!attempt.egressed) return { ok: false, retryable: false, errorCode: attempt.refused ? 'forbidden' : 'unavailable', message: 'Mail refused before egress' };
    if (result.ok) return result;
    return { ok: false, retryable: result.retryable, errorCode: 'unavailable', message: 'Mail delivery failed', unknown: result.unknown, retryAfterMs: result.retryAfterMs };
}

const conversionPluginOutcomeSchema = z.strictObject({ status: z.enum(['delivered', 'unknown']), receiptId: idSchema.optional(),
    diagnostics: conversionDiagnosticsSchema.optional() });
const conversionResultSchema = z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: conversionPluginOutcomeSchema }), z.strictObject({ ok: z.literal(false), error: z.object({ code: appErrorSchema.shape.code }) })])
    .catch({ ok: false, error: { code: 'unavailable' } });
/** Only the server's native-fetch handoff proves an attempted send. Plugin claims
 * of success without egress are protocol errors; readback cannot reclassify a send.
 * @complexity O(1), bounded evidence validation, no I/O or vendor text retained. */
function conversionOutcome(required: { result: unknown; attempt: MailAttempt; action: 'deliver' | 'reconcile' }): Outcome<ConversionDeliveryOutcome> {
    const result = conversionResultSchema.parse(required.result);
    if (required.action === 'reconcile' || required.attempt.egressed) {
        if (!result?.ok) return { ok: true, value: { status: 'unknown' } };
        const { receiptId, ...outcome } = result.value;
        return { ok: true, value: outcome.status === 'delivered' ? { status: 'delivered', receiptId, diagnostics: outcome.diagnostics } : { status: 'unknown', diagnostics: outcome.diagnostics } };
    }
    if (required.attempt.refused) return { ok: true, value: { status: 'not_sent', reason: 'forbidden' } };
    if (result?.ok) return { ok: true, value: { status: 'not_sent', reason: result.value.status === 'delivered' ? 'protocol_mismatch' : 'unavailable' } };
    return { ok: true, value: { status: 'not_sent', reason: result?.error.code ?? 'unavailable' } };
}

/** Build one call's standard effects after validating its configuration.
 * @returns Typed configuration failure before any credentials or egress.
 * @complexity O(k) metadata keys; construction performs no I/O and retains no tokens.
 */
function pluginDependencies<C extends PluginConfiguration | PluginConnectionConfiguration = PluginConfiguration>(required: Execution): Outcome<PluginCapabilityDependencies<C>>;
function pluginDependencies(required: Execution): Outcome<PluginCapabilityDependencies<PluginConfiguration | PluginConnectionConfiguration>> {
    const configuration = pluginConfiguration(required);
    if (!configuration.ok) return configuration;
    return { ok: true, value: { configuration: configuration.value, fetch: guardedFetch(required), credentials: credentials(required),
        clock: required.dependencies.clock, observer: required.dependencies.observer, wait: required.dependencies.wait } };
}

/** Resolve the installed bytes and bound account for one backend entry; credentials stay call-local. */
async function pluginExecution(required: { dependencies: Dependencies; context: CallContext; pluginId: string;
    connection: { connectionId: string; accountId: string }; effects: readonly string[] }, optional?: CallOptions): Promise<Execution | undefined> {
    const loaded = await required.dependencies.state({ context: required.context, pluginId: required.pluginId });
    if (!loaded?.enabled || !loaded.admitted) return undefined;
    const state = { ...loaded, revision: await executableRevision({ ...required, state: loaded }) };
    const execution: Execution = { ...required, state, module: {}, signal: optional?.signal,
        input: { operationId: 'backend', ...required.connection, arguments: {} },
        contribution: { name: 'backend', description: 'Server backend entry', effects: required.effects, inputSchema: {}, parse: () => ({ ok: true, value: {} }) } };
    return await bindingCurrent(execution) ? execution : undefined;
}

/** Fence lifecycle, binding and fresh credentials before loading the generic callback export.
 * Returns events only; public ingress owns validation and durable suppression. No queue or egress.
 * @example backends.ingestWebhook({ context, pluginId, connection, rawBody, headers, path });
 * @complexity One bounded module load and call-local broker accesses; no token cache or retries. */
async function ingestWebhook(required: WebhookInvocation & { dependencies: Dependencies }, optional?: CallOptions): Promise<Outcome<{ events: readonly unknown[] }>> {
    const unavailable = () => localFailure<never>({ code: 'not_implemented', message: 'Webhook unavailable' });
    try {
        const execution = await pluginExecution({ ...required, effects: ['read'] }, optional);
        if (!execution) return unavailable();
        const credential = await credentials(execution).access({}, optional);
        if (!credential.ok) return unavailable();
        const moduleUrl = new URL(pluginModuleUrl({ state: execution.state }));
        moduleUrl.searchParams.set('revision', execution.state.revision);
        execution.module = { ...await required.dependencies.loadModule({ moduleUrl: moduleUrl.href }) };
        if (typeof execution.module.ingestWebhook !== 'function') return unavailable();
        const dependencies = pluginDependencies(execution);
        if (!dependencies.ok || !await bindingCurrent(execution)) return unavailable();
        const result = await exported<WebhookEntry>({ module: execution.module, name: 'ingestWebhook' })({
            dependencies: dependencies.value, rawBody: required.rawBody, headers: required.headers, path: required.path }, optional);
        return await bindingCurrent(execution) ? result : unavailable();
    } catch { return unavailable(); }
}

/** Call-scoped factory and catalog validation; no token/adapter registry survives a call.
 * Missing exports return not_implemented; malformed input/output returns a typed boundary failure.
 * @complexity One factory/capability call; O(n) output validation, reporting bounded to 5000 rows.
 */
async function capabilityCall(required: Execution & { capabilityId: CallableCapabilityId | 'campaign.halt-stop.v1' | 'organic.publish.v1' }): Promise<Outcome<unknown>> {
    const { capabilityId } = required;
    const parsed = parseBoundary<CapabilityInput<typeof capabilityId>>({ schema: capabilityCatalog[capabilityId].input, input: required.input.arguments });
    if (!parsed.ok) return parsed;
    if (capabilityId === 'tracking.tag.v1') {
        const key = capabilityCatalog['tracking.tag.v1'].input.parse(parsed.value).campaignKey;
        if (key.pluginId !== required.pluginId || key.accountId !== required.input.accountId) return localFailure({ code: 'forbidden', message: 'Tracking campaign outside binding' });
    }
    const dependencies = pluginDependencies(required);
    if (!dependencies.ok) return dependencies;
    if (typeof required.module.createCapabilities !== 'function') return localFailure({ code: 'not_implemented', message: 'Plugin has no ' + capabilityId + ' capability' });
    const handlers = z.record(z.string(), z.unknown()).parse((required.module.createCapabilities as PluginCapabilitiesFactory)(dependencies.value));
    if (typeof handlers[capabilityId] !== 'function') return localFailure({ code: 'not_implemented', message: 'Plugin has no ' + capabilityId + ' capability' });
    const handler = handlers[capabilityId] as PluginCapability<typeof capabilityId>;
    const result = await handler({ context: required.context, connection: { connectionId: required.input.connectionId, accountId: required.input.accountId! }, input: parsed.value }, { signal: required.signal });
    const outcome = parseBoundary({ schema: z.discriminatedUnion('ok', [z.strictObject({ ok: z.literal(true), value: capabilityCatalog[capabilityId].output }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]), input: result });
    if (!outcome.ok) return outcome;
    if (!outcome.value.ok) return outcome.value;
    return capabilityOutputScope({ execution: required, capabilityId, output: outcome.value.value });
}

/** Schema-valid data must also belong to the requested identity/window, not another account. */
function capabilityOutputScope(required: { execution: Execution; capabilityId: CallableCapabilityId | 'campaign.halt-stop.v1' | 'organic.publish.v1'; output: unknown }): Outcome<unknown> {
    const { execution } = required;
    if (required.capabilityId === 'report.metrics.v1') return reportingOutputScope(required);
    if (required.capabilityId === 'campaign.status.v1') {
        const result = capabilityCatalog['campaign.status.v1'].output.parse(required.output);
        const input = capabilityCatalog['campaign.status.v1'].input.parse(execution.input.arguments);
        if (result.campaigns.some(row => !input.vendorCampaignIds.includes(row.vendorCampaignId))) return localFailure({ code: 'forbidden', message: 'Status outside requested campaigns' });
    }
    return { ok: true, value: required.output };
}

/** Validate reporting identity and the exact requested half-open window after catalog parsing. */
function reportingOutputScope(required: { execution: Execution; output: unknown }): Outcome<unknown> {
    const { execution } = required;
    const batch = capabilityCatalog['report.metrics.v1'].output.parse(required.output);
    const input = capabilityCatalog['report.metrics.v1'].input.parse(execution.input.arguments);
    if (batch.pluginId !== execution.pluginId || batch.connectionId !== execution.input.connectionId || batch.accountId !== execution.input.accountId
        || batch.grain !== input.grain || batch.days.start !== input.days.start || batch.days.end !== input.days.end) return localFailure({ code: 'forbidden', message: 'Reporting identity or window mismatch' });
    return { ok: true, value: required.output };
}

/** One reviewed constituent per target; translators receive call-local read-only effects and cancellation.
 * @complexity Bounded bundle/catalog reads plus the translator's bounded preparation reads; metadata <=64 KiB. */
async function prepareDestination(required: { dependencies: Dependencies; context: CallContext; campaign: NeutralCampaignLaunch; operationId: string; target: NeutralCampaignLaunch['targets'][number] }, optional?: CallOptions): Promise<Outcome<{ constituent: CampaignConstituent; evidence: CampaignValidationEvidence }>> {
    const { dependencies, context, target } = required;
    const execution = await pluginExecution({ dependencies, context, pluginId: target.pluginId,
        connection: { connectionId: target.connectionId, accountId: target.accountId }, effects: ['read'] }, optional);
    if (!execution) return localFailure({ message: 'Plugin unadmitted or account binding not current: ' + target.pluginId });
    const { state } = execution;
    const fixture = z.object({ scope: scopeSchema, connectionId: idSchema, resolved: boundedJsonSchema }).safeParse(state.metadata.campaignFixture);
    if (dependencies.mode !== 'sandbox' || !fixture.success) return localFailure({ code: 'not_implemented', message: 'NEEDS: scoped campaign account, creative and declaration metadata' });
    if (fixture.data.scope.ownerId !== context.scope.ownerId || fixture.data.scope.workspaceId !== context.scope.workspaceId || fixture.data.connectionId !== target.connectionId) return localFailure({ code: 'forbidden', message: 'Campaign metadata outside scope' });
    const definitions = await pluginDefinitions({ dependencies, context, pluginId: target.pluginId });
    const definition = definitions.find(tool => tool.name.endsWith('_' + deploymentName));
    if (!definition || definition.unavailableReason) return localFailure({ message: 'Campaign deployment unavailable' });
    const module = { ...await dependencies.loadModule({ moduleUrl: pluginModuleUrl({ state }) + '?revision=' + definition.revision }) };
    const configured = pluginDependencies(execution);
    if (!configured.ok) return configured;
    const translated = await exported<(input: Record<string, unknown>, options?: CallOptions) => Outcome<unknown> | Promise<Outcome<unknown>>>({ module, name: 'translateCampaign' })({
        campaign: required.campaign, target, resolved: fixture.data.resolved, context, dependencies: configured.value }, { signal: optional?.signal });
    if (!translated.ok) return translated;
    const args = { tool: definition.name, input: { operationId: hash({ value: [required.operationId, target] }), connectionId: target.connectionId, accountId: target.accountId,
        arguments: { plan: translated.value } } };
    return validatedDestination({ context, pluginId: target.pluginId, definitions, definition, args });
}

/** Parse and dry-run the exact constituent arguments through the existing guarded read tool.
 * A declared unavailable/failing validator prevents the card; absent validators are explicit.
 * @complexity One bounded definition scan and at most one 30s capability invocation per target. */
async function validatedDestination(required: { context: CallContext; pluginId: string; definitions: readonly OmToolDefinition[]; definition: OmToolDefinition;
    args: { tool: string; input: { operationId: string; connectionId: string; accountId: string; arguments: { plan: unknown } } } }): Promise<Outcome<{ constituent: CampaignConstituent; evidence: CampaignValidationEvidence }>> {
    const { context, definition, args } = required;
    const valid = definition.parse({ input: args.input });
    if (!valid.ok) return valid;
    const pluginDigest = definition.revision, schemaFingerprint = canonicalDigest({ value: definition.inputSchema }), argumentsDigest = canonicalDigest({ value: args });
    const validator = required.definitions.find(tool => tool.name === capabilityToolName({ pluginId: required.pluginId, capabilityId: 'campaign.validate.v1' }));
    let status: CampaignValidationEvidence['status'] = 'unsupported';
    if (validator) {
        if (validator.unavailableReason || !validator.effects.every(effect => effect === 'read')) return localFailure({ code: 'forbidden', message: 'Campaign validation unavailable' });
        const result = await validator.invoke({ context, input: { operationId: hash({ value: ['validate', args.input.operationId] }),
            connectionId: args.input.connectionId, accountId: args.input.accountId, arguments: { operationId: args.input.operationId, plan: args.input.arguments.plan } } });
        if (!result.ok) return result;
        status = 'validated';
    }
    const evidence = { pluginDigest, schemaFingerprint, argumentsDigest, status,
        evidenceDigest: canonicalDigest({ value: { pluginDigest, schemaFingerprint, argumentsDigest, status } }) };
    const constituent: CampaignConstituent = { arguments: boundedJsonSchema.parse(args) as CampaignConstituent['arguments'], pluginDigest, schemaFingerprint,
        envelope: { operationId: args.input.operationId, connectionId: args.input.connectionId, accountId: args.input.accountId, effects: ['write'], argumentsDigest, moneyExposure: null, requiredLimit: null } };
    return { ok: true, value: { constituent, evidence } };
}
/** Shared catalog name derivation for direct reads and campaign dry runs; no I/O. */
function capabilityToolName(required: { pluginId: string; capabilityId: string }): string {
    return 'vendor_' + required.pluginId.replaceAll('-', '_') + '_' + required.capabilityId.replaceAll('.', '_');
}
function canonicalDigest(required: { value: unknown }): string { const result = digestArguments({ arguments: required.value }); if (!result.ok) throw new Error('Invalid campaign digest'); return result.value; }

/** Discover deployment by its fixed exports and reuse the plugin's closed plan schema.
 * @complexity Schema conversion is bounded by the installed bundle; no factory or I/O.
 */
function deploymentContribution(required: { module: Namespace }): Contribution[] {
    const schema = required.module.campaignDeploymentPlanSchema as z.ZodType | undefined;
    if (typeof schema?.safeParse !== 'function' || typeof required.module.deployCampaignPaused !== 'function'
        || typeof required.module.readCampaignDeployment !== 'function') return [];
    const plan = z.toJSONSchema(schema, { io: 'input' });
    return [{ name: deploymentName, description: 'Fixed PAUSED/DRAFT creation sequence; owning campaign approval required', effects: ['write'],
        inputSchema: { type: 'object', properties: { plan }, required: ['plan'], additionalProperties: false },
        parse: input => { const parsed = z.strictObject({ plan: boundedJsonSchema }).safeParse(input.input);
            if (!parsed.success) return localFailure({ code: 'invalid_input', message: 'Invalid deployment plan' });
            return parseBoundary({ schema, input: parsed.data.plan }); } }];
}
type CampaignExecution = { context: CallContext; call: CampaignConstituent; authorization?: FrozenDispatchRequest; permit?: DispatchPermit; checkpoint: DeploymentCheckpoint; evidence?: Record<string, unknown>[]; signal?: AbortSignal };
/** The caller holds the owning safety lock and job; this path never claims another job/lock. */
async function executeCampaign(required: CampaignExecution & { dependencies: Dependencies }): Promise<Outcome<unknown>> {
    const authority = campaignExecutionAuthority(required);
    if (!authority.ok) return authority;
    const args = z.object({ tool: idSchema, input: selectionSchema }).parse(required.call.arguments);
    const pluginId = await campaignPluginId({ ...required, tool: args.tool });
    if (!pluginId) return localFailure({ code: 'forbidden', message: 'Invalid campaign executable' });
    const state = await required.dependencies.state({ context: required.context, pluginId });
    if (!state?.admitted || !state.enabled) return localFailure({ message: 'Campaign plugin unadmitted' });
    const revision = await executableRevision({ ...required, pluginId, state });
    if (revision !== required.call.pluginDigest) return localFailure({ code: 'conflict', message: 'Campaign executable changed' });
    const module = { ...await required.dependencies.loadModule({ moduleUrl: pluginModuleUrl({ state }) + '?revision=' + revision }) };
    const contribution = deploymentContribution({ module })[0]!;
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
/** Select a receipt, never its Outcome wrapper or malformed later evidence.
 * @complexity O(n*b) time, O(n+b) space; <=128 entries of <=64 KiB each, no I/O. */
function latestDeploymentReceipt(required: { evidence: Record<string, unknown>[] }): z.infer<typeof campaignDeploymentReceiptSchema> | undefined {
    for (const entry of required.evidence.slice().reverse()) {
        const receipt = campaignDeploymentReceiptSchema.safeParse(entry.result);
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
    const entities = outcomes.flatMap(item => {
        const receipt = campaignDeploymentReceiptSchema.safeParse(item.result);
        if (!receipt.success || receipt.data.status !== 'acknowledged') return [];
        return receipt.data.entityIds.map(entityId => ({ operationId: item.operationId, entityId, state: receipt.data.state }));
    });
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
type ConversionReadbackInput = Parameters<NonNullable<ConversionDeliveryPort['reconcile']>>[0];
type ConversionCallInput = Omit<ConversionReadbackInput, 'deliveryId'> & { deliveryId?: string };
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
async function finishConversion(required: { unit: UnitOfWork; bindAuthority: ConversionAuthorityFactory; context: CallContext; input: ConversionDispatchInput; fence: LeaseFence; result: Outcome<ConversionDeliveryOutcome> }): Promise<Outcome<boolean>> {
    return required.unit.transaction({ work: async ({ session }): Promise<Outcome<boolean>> => {
        const outbox = createSqlOutboxStore({ database: session });
        const job = await outbox.get({ tenantId: required.fence.tenantId, id: required.fence.id });
        if (job?.state === 'denied') return { ok: true, value: false };
        const result = required.result;
        const state = conversionJobState({ result, leased: job?.state === 'leased' });
        if (!await outbox.complete(required.fence, { state })) return localFailure({ code: 'conflict', message: 'Conversion completion lost its lease; reconcile' });
        const saved = await required.bindAuthority({ unit: session }).audit.record({ context: required.context, operationId: required.input.deliveryId, outcome: 'outbox_' + state });
        return saved.ok ? { ok: true, value: state !== 'denied' } : saved;
    } });
}
/** Choose durable outbox state from transport evidence, never from vendor messages.
 * @complexity O(1), pure; definite refusals do not enter reconciliation. */
function conversionJobState(required: { result: Outcome<ConversionDeliveryOutcome>; leased: boolean }): 'succeeded' | 'denied' | 'failed' | 'reconcile' {
    const result = required.result;
    if (!result.ok) return result.error.code === 'forbidden' && required.leased ? 'denied' : 'reconcile';
    if (result.value.status === 'delivered') return 'succeeded';
    if (result.value.status === 'not_sent') return result.value.reason === 'forbidden' ? 'denied' : 'failed';
    return 'reconcile';
}
/** Hold the subject family through measure's evidence append and outbox completion, with no open SQLite. */
async function dispatchConversion(required: { dependencies: Dependencies; dispatcher: Omit<Parameters<typeof createConversionDispatcher>[0], 'delivery'> & { authority: ConversionAuthorityFactory }; input: ConversionDispatchInput }, options?: CallOptions): Promise<Outcome<ConversionDeliveryOutcome>> {
    const { dependencies } = required;
    const input = structuredClone(required.input);
    if (dependencies.mode !== 'production') return localFailure({ code: 'forbidden', message: 'Conversion storage unavailable' });
    const { serviceId, ...trace } = input.context;
    const context: CallContext = { ...trace, principal: { kind: 'service', serviceId } };
    return pluginJobBoundary({ ...dependencies, context, execute: () => dependencies.subjectLane.run({ context, subjectIds: [input.event.subjectId], work: async (): Promise<Outcome<ConversionDeliveryOutcome>> => {
        const checked = await conversionJob({ dependencies, input, unit: dependencies.unit });
        if (!checked.ok) return checked;
        const delivery = conversionDelivery({ dependencies, authority: required.dispatcher, bindAuthority: required.dispatcher.authority, claim: input.claim });
        const dispatcher = createConversionDispatcher({ ...required.dispatcher, delivery }, { observer: dependencies.observer });
        const { claim: _claim, ...request } = input;
        const result = await dispatcher.dispatch(request, options);
        const finished = await finishConversion({ unit: dependencies.unit, bindAuthority: required.dispatcher.authority, context, input,
            fence: { ...checked.value.fence, now: dependencies.clock.now({}) }, result });
        if (!finished.ok) return finished;
        if (!finished.value && !result.ok) return localFailure({ code: 'forbidden', message: 'Conversion dispatch denied' });
        return result;
    } }, options) });
}
/** Explicit diagnostic refresh has no subject lane, send claim or outbox effects.
 * @complexity One observed dispatcher call; bounded readback uses saved receipt only. */
async function reconcileConversion(required: { dependencies: Dependencies; dispatcher: Omit<Parameters<typeof createConversionDispatcher>[0], 'delivery'> & { authority: ConversionAuthorityFactory }; input: Parameters<ReturnType<typeof createConversionDispatcher>['reconcile']>[0] }, options?: CallOptions): Promise<Outcome<ConversionDeliveryOutcome>> {
    const { serviceId, ...trace } = required.input.context;
    const context: CallContext = { ...trace, principal: { kind: 'service', serviceId } };
    return pluginJobBoundary({ ...required.dependencies, context, execute: () => {
        const delivery = conversionDelivery({ dependencies: required.dependencies, authority: required.dispatcher, bindAuthority: required.dispatcher.authority, claim: undefined });
        return createConversionDispatcher({ ...required.dispatcher, delivery }, { observer: required.dependencies.observer }).reconcile(required.input, options);
    } });
}
/** The grant destination selects the plugin's fixed conversion-delivery factory.
 * Plugins own install mappings and codecs; measure retains its open definition contract.
 * Recheck grant/consent after the plugin resolves credentials and immediately before its fetch.
 * Final authorization and egress share haltAccount's injected account barrier.
 * @complexity One bundle load and bounded measure/plugin gates; no token cache or retries. */
function conversionDelivery(required: { dependencies: Dependencies; authority: ConversionAuthority; bindAuthority: ConversionAuthorityFactory; claim?: ConversionClaim }): ConversionDeliveryPort {
    return { deliver: (input, options) => conversionCall({ ...required, input, action: 'deliver', signal: options?.signal }),
        reconcile: (input, options) => conversionCall({ ...required, input, action: 'reconcile', signal: options?.signal }) };
}
/** Bind one plugin call; its foreign fetch ABI holds the shared halt barrier through egress.
 * Gate failures throw only inside the plugin's typed transport boundary.
 * @complexity O(b) bounded bundle hashing time/space; one send, no retries. */
async function conversionCall(required: { dependencies: Dependencies; authority: ConversionAuthority; bindAuthority: ConversionAuthorityFactory; claim?: ConversionClaim; signal?: AbortSignal } & ({ input: Parameters<ConversionDeliveryPort['deliver']>[0]; action: 'deliver' } | { input: ConversionReadbackInput; action: 'reconcile' })): Promise<Outcome<ConversionDeliveryOutcome>> {
    const attempt: MailAttempt = { egressed: false, refused: false };
    try {
        const { input, dependencies } = required;
        if (!input.deliveryId) return conversionOutcome({ attempt, action: required.action, result: localFailure({ code: 'invalid_input', message: 'Conversion delivery identity required' }) });
        if (dependencies.mode !== 'production') return conversionOutcome({ attempt, action: required.action, result: localFailure({ code: 'forbidden', message: 'Conversions denied in local sandbox' }) });
        const pluginId = input.grant.destination;
        const context: CallContext = { scope: input.context.scope, correlationId: input.context.correlationId, traceId: input.context.traceId,
            principal: { kind: 'service', serviceId: input.context.serviceId } };
        const loaded = await dependencies.state({ context, pluginId });
        if (!loaded?.admitted || !loaded.enabled) return conversionOutcome({ attempt, action: required.action, result: localFailure({ message: 'Conversion plugin unadmitted or unavailable' }) });
        const state = { ...loaded, revision: await executableRevision({ dependencies, pluginId, state: loaded }) };
        const moduleUrl = new URL(pluginModuleUrl({ state }));
        moduleUrl.searchParams.set('revision', state.revision);
        const module: Namespace = { ...await dependencies.loadModule({ moduleUrl: moduleUrl.href }) };
        if (typeof module.createConversionDelivery !== 'function') return conversionOutcome({ attempt, action: required.action, result: localFailure({ message: 'Conversion destination unavailable' }) });
        const execution: Execution = { dependencies, state, module, pluginId, context, signal: required.signal,
            input: { operationId: input.deliveryId, connectionId: input.grant.connectionId, accountId: input.grant.accountId, arguments: {} },
            contribution: { name: 'conversion', description: 'Typed conversion', effects: ['conversion'], inputSchema: {}, parse: () => ({ ok: true, value: input }) } };
        const wrapped: Execution = { ...execution, dependencies: { ...dependencies, fetch: async (url, options) => {
            const lock = await dependencies.accountLocks.acquire({ context, accountId: input.grant.accountId }, { signal: required.signal });
            if (!lock.ok) { attempt.refused = true; throw new Error('Conversion account barrier unavailable'); }
            try {
                // The earlier guardedFetch snapshot may predate a committed halt.
                const snapshot = await dependencies.safetyRepo.snapshot({ context, accountId: input.grant.accountId }, { signal: required.signal });
                if (!snapshot.ok || snapshot.value.halted) { attempt.refused = true; throw new Error('Account halted'); }
                const authorized = required.claim ? await admitConversion({ ...required, claim: required.claim, execution }) : getOnly({ url, options });
                if (!authorized.ok) { attempt.refused = true; throw new Error('Conversion authority withdrawn'); }
                if (!await bindingCurrent(execution) || required.signal?.aborted || options?.signal?.aborted) { attempt.refused = true; throw new Error('Conversion binding changed'); }
                attempt.egressed = true;
                return await dependencies.fetch(url, options);
            } finally {
                const released = await dependencies.accountLocks.release({ lockId: lock.value.lockId });
                if (!released.ok) throw new Error('Conversion account barrier release failed');
            }
        } } };
        const deps = pluginDependencies(wrapped);
        if (!deps.ok) return conversionOutcome({ attempt, action: required.action, result: deps });
        const guarded = deps.value.fetch;
        const observed: typeof fetch = async (url, options) => {
            try { return await guarded(url, options); }
            catch { if (!attempt.egressed) attempt.refused = true; throw new Error('Conversion transport unavailable'); }
        };
        const backend = (module.createConversionDelivery as Factory<Required<ConversionDeliveryPort>>)({ ...deps.value, fetch: observed,
            authority: { async dispatch(call: { execute(input: { isCurrent(): boolean }): Promise<Outcome<ConversionDeliveryOutcome>> }) {
                const authorized = await conversionCurrent({ ...required, execution });
                return authorized.ok ? call.execute({ isCurrent: () => !required.signal?.aborted }) : authorized;
            } } });
        const result = required.action === 'reconcile' ? await backend.reconcile({ ...input, deliveryId: input.deliveryId }, { signal: required.signal }) : await backend.deliver(required.input, { signal: required.signal });
        return conversionOutcome({ result, attempt, action: required.action });
    } catch { return conversionOutcome({ result: undefined, attempt, action: required.action }); }
}
/** The foreign fetch ABI can carry a method on Request or RequestInit; refuse both
 * forms of writes on claim-less diagnostic reads. @complexity O(1), no I/O. */
function getOnly(required: { url: Parameters<typeof fetch>[0]; options?: RequestInit }): Outcome<void> {
    const method = required.options?.method ?? (required.url instanceof Request ? required.url.method : 'GET');
    return method.toUpperCase() === 'GET' ? { ok: true, value: undefined } : localFailure({ code: 'forbidden', message: 'Conversion readback requires GET' });
}
/** Join the current authority, single outbox dispatch-start and admission evidence in one writer.
 * Expected denial commits; infrastructure failures roll back. The caller retains the subject lane
 * after COMMIT through the provider attempt and durable outcomes.
 * @complexity Bounded policy/grant reads and one append; no transaction across network I/O. */
async function admitConversion(required: { dependencies: Dependencies; bindAuthority: ConversionAuthorityFactory; claim: ConversionClaim; input: ConversionCallInput; execution: Execution; signal?: AbortSignal }): Promise<Outcome<void>> {
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
async function conversionCurrent(required: { authority: ConversionAuthority; input: ConversionCallInput; execution: Execution; signal?: AbortSignal }): Promise<Outcome<void>> {
    if (required.signal?.aborted) return localFailure({ code: 'forbidden', message: 'Conversion cancelled' });
    const grant = await required.authority.grants.current({ context: required.input.context, grantId: required.input.grant.grantId }, { signal: required.signal });
    if (!grant.ok) return grant;
    if (hash({ value: grant.value }) !== hash({ value: required.input.grant }) || grant.value.revoked
        || required.execution.dependencies.clock.now({}) >= grant.value.expiresAt) return localFailure({ code: 'forbidden', message: 'Conversion grant changed' });
    const { identifiers: _identifiers, ...event } = required.input.event;
    const consent = await required.authority.policy.assess({ context: required.execution.context, event }, { signal: required.signal });
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
        if (!loaded?.enabled || !loaded.entryUrl) return [];
        const state = { ...structuredClone(loaded), revision: await executableRevision({ dependencies, pluginId, state: loaded }) };
        const moduleUrl = new URL(pluginModuleUrl({ state }));
        moduleUrl.searchParams.set('revision', state.revision);
        const module = z.record(z.string(), z.unknown()).parse({ ...await dependencies.loadModule({ moduleUrl: moduleUrl.href }) });
        return [...capabilityContributions({ module, state, pluginId, pluginDigest: loaded.revision }), ...contributions({ module }), ...deploymentContribution({ module })].map(contribution => definition({ dependencies, context, pluginId, state, module, contribution }));
    } catch {
        const message = 'Agent-plugin unavailable; check installed metadata and runtime bundle';
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

/** Read bounded standard declarations and retain the plugin's own argument parser.
 * Missing tool exports leave capabilities available; invalid declarations fail discovery closed.
 * @complexity O(t) time/space for at most 100 declarations; no factory or I/O.
 */
function contributions(required: { module: Namespace }): Contribution[] {
    const { module } = required;
    if (!module.tools || typeof module.parseTool !== 'function' || typeof module.createTools !== 'function') return [];
    const tools = z.array(pluginToolSchema).max(100).parse(module.tools);
    const parse = exported<(required: { name: string; input: unknown }) => Outcome<unknown>>({ module, name: 'parseTool' });
    return tools.map(tool => ({ ...tool, parse: input => parse({ name: tool.name, input: input.input }) }));
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
    const unavailableReason = contribution.unavailableReason ?? (contribution.capability?.admitted === false ? 'Capability unadmitted' : unavailable({ dependencies, pluginId, state, policy, name: contribution.name }));
    return { name, description: contribution.description, capability: pluginId + ': ' + contribution.name,
        effects, policy, revision: state.revision, inputSchema: toolDescriptorSchema.shape.inputSchema.parse(inputSchema), unavailableReason,
        safety: dependencies.safety, ownerOnly: contribution.ownerOnly,
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
async function current(required: { dependencies: Dependencies; context: CallContext; pluginId: string; state: AgentPluginState; signal?: AbortSignal }): Promise<boolean> {
    if (required.signal?.aborted) return false;
    const state = await required.dependencies.state({ context: required.context, pluginId: required.pluginId });
    if (!state?.admitted || !state.enabled) return false;
    return await executableRevision({ ...required, state }) === required.state.revision;
}
function pluginModuleUrl(required: { state: AgentPluginState }): string {
    return z.url({ protocol: /^file$/ }).parse(required.state.entryUrl);
}
/** Fence both installed metadata and executed bytes. A rebuild changes cards and native import URLs;
 * every credential/egress fence rehashes the bounded bundle, so an old definition cannot send.
 * @complexity O(b) bytes per fence, b bounded by the injected file reader (8 MiB in serve). */
async function executableRevision(required: { dependencies: Dependencies; pluginId: string; state: AgentPluginState }): Promise<string> {
    const digest = z.string().regex(/^[a-f0-9]{64}$/).parse(await required.dependencies.moduleDigest({ moduleUrl: pluginModuleUrl({ state: required.state }) }));
    return hash({ value: [required.state.revision, digest, required.state.entryUrl, required.state.capabilities ?? null] });
}
async function bindingCurrent(required: Execution): Promise<boolean> {
    if (!await current(required)) return false;
    if (required.input.accountId === null) return required.contribution.connectionOnly === true;
    const found = await required.dependencies.accounts.find({ context: required.context, externalAccountId: required.input.accountId }, { signal: required.signal });
    if (!found.ok || !found.value) return false;
    const binding = found.value;
    return binding.connectionId === required.input.connectionId && binding.externalAccountId === required.input.accountId
        && binding.scope.ownerId === required.context.scope.ownerId && binding.scope.workspaceId === required.context.scope.workspaceId;
}

/** Marks a guard refusal raised before any native fetch so a plugin can report a definite not-sent failure. */
function egressRefusal(message: string): Error { return Object.assign(new Error(message), { refusedBeforeEgress: true as const }); }
/** Foreign fetch ABI: the last admitted gate follows fresh credentials and halt/account checks.
 * Refusal throws only inside the plugin's typed transport boundary; zero native fetches occur.
 */
function guardedFetch(required: Execution): typeof fetch {
    return async (url, options) => {
        if (!await bindingCurrent(required) || !await current(required) || options?.signal?.aborted) throw egressRefusal('Plugin unavailable');
        if (required.stopPermit && required.dependencies.clock.now({}) >= required.stopPermit.expiresAt) throw egressRefusal('Stop permit expired');
        if (!required.stopPermit && toolPolicy({ effects: required.contribution.effects }) !== 'read' && required.input.accountId !== null) {
            const snapshot = await required.dependencies.safetyRepo.snapshot({ context: required.context, accountId: required.input.accountId }, { signal: required.signal });
            if (!snapshot.ok || snapshot.value.halted) throw egressRefusal('Account halted');
        }
        if (!await campaignAuthorityCurrent(required)) throw egressRefusal('Campaign authority expired or revoked');
        if (required.signal?.aborted || options?.signal?.aborted) throw egressRefusal('Plugin cancelled');
        const signals = [required.signal, options?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
        const signal = required.signal ? AbortSignal.any(signals) : options?.signal;
        return required.dependencies.fetch(url, { ...options, signal });
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
/** Forward fresh credentials and declared secrets for the bound plugin only; cache/log nothing. */
function credentials(required: Execution) {
    return { async access(input: { connectionId?: string; accountId?: string | null } = {}, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>> {
        if (input.connectionId !== undefined && input.connectionId !== required.input.connectionId) return localFailure({ code: 'forbidden', message: 'Plugin credential connection mismatch' });
        if (input.accountId != null && input.accountId !== required.input.accountId) return localFailure({ code: 'forbidden', message: 'Plugin credential account mismatch' });
        const signal = optional?.signal ? AbortSignal.any([optional.signal, ...required.signal ? [required.signal] : []]) : required.signal;
        if (!await bindingCurrent({ ...required, signal })) return localFailure({ message: 'Plugin unavailable before credential access' });
        return required.dependencies.integrations.access({ context: { ...required.context, principal: { kind: 'service', serviceId: 'om-agent-plugin-backends' } },
            pluginId: required.pluginId, connectionId: required.input.connectionId }, { signal });
    } };
}

/** One existing outbox claim surrounds the complete tool workflow (including plugin subcalls).
 * The dispatcher already owns financial withDispatch; gateways never nest that lock or show a card.
 */
async function invoke(required: Omit<Execution, 'input' | 'signal'> & { invocation: Invocation }): Promise<Outcome<unknown>> {
    const parsed = parseSelection({ contribution: required.contribution, input: required.invocation.input });
    if (!parsed.ok) return parsed;
    const execution: Execution = { ...required, context: required.invocation.context, input: parsed.value, signal: required.invocation.signal, authorization: required.invocation.authorization, dispatchPermit: required.invocation.permit };
    try {
        if (!await bindingCurrent(execution)) return localFailure({ message: 'Plugin unadmitted, disabled or account binding unavailable' });
        const allowed = invocationAllowed(execution);
        if (!allowed.ok) return allowed;
        const execute = () => executePlugin(execution);
        if (toolPolicy({ effects: required.contribution.effects }) === 'read') return await execute();
        const dispatch = () => required.dependencies.jobs.dispatch({ context: execution.context, pluginId: required.pluginId, input: parsed.value, execute });
        if (required.invocation.permit && required.invocation.authorization?.campaignApproval) return await execute();
        return await writeWithBarrier({ execution, execute: dispatch });
    } catch { return localFailure({ message: 'Plugin binding failed; reconcile any submitted operation' }); }
}
/** Pure execution eligibility; stop/conversion authority never comes from a generic tool. */
function invocationAllowed(required: Execution): Outcome<void> {
    const policy = toolPolicy({ effects: required.contribution.effects });
    if (required.contribution.capability?.admitted === false || policy === 'internal') return localFailure({ code: 'forbidden', message: 'Capability authority unavailable' });
    if (required.contribution.name === deploymentName) return localFailure({ code: 'forbidden', message: 'Use the owning exact campaign launch' });
    const reason = required.contribution.unavailableReason ?? unavailable({ ...required, policy, name: required.contribution.name });
    if (reason) return localFailure({ message: reason });
    if (policy === 'spend' && !required.dispatchPermit) return localFailure({ code: 'forbidden', message: 'Spend requires the dispatcher safety permit' });
    return { ok: true, value: undefined };
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
 * closed pause/stop mappings through the catalog capability. No cards or second outbox.
 * @complexity <=1 bundle load; plugin mappings bound IDs to 100, with no blind retries. */
async function haltStop(required: { dependencies: Dependencies; context: CallContext; pluginId: string; permit: HaltStopPermit }): Promise<Outcome<unknown>> {
    try {
        const parsed = parseBoundary({ schema: haltStopRequestSchema, input: required.permit.request });
        if (!parsed.ok) return parsed;
        const request = parsed.value;
        const loaded = await required.dependencies.state({ context: required.context, pluginId: required.pluginId });
        if (!loaded?.admitted || !loaded.enabled) return localFailure({ message: 'Stop plugin unadmitted or unavailable' });
        const state = { ...loaded, revision: await executableRevision({ ...required, state: loaded }) };
        if (request.pluginDigest !== state.revision) return localFailure({ code: 'conflict', message: 'Stop executable revision changed' });
        const moduleUrl = new URL(pluginModuleUrl({ state }));
        moduleUrl.searchParams.set('revision', state.revision);
        const module = { ...await required.dependencies.loadModule({ moduleUrl: moduleUrl.href }) };
        const execution: Execution = { ...required, state, module, stopPermit: required.permit,
            input: { operationId: request.operationId, connectionId: request.connectionId, accountId: request.adAccountId, arguments: request },
            contribution: { name: 'halt-stop', description: 'Typed backend stop', effects: ['halt_stop'], inputSchema: {}, parse: () => ({ ok: true, value: request }) } };
        if (!await bindingCurrent(execution)) return localFailure({ message: 'Stop account binding unavailable' });
        return await capabilityCall({ ...execution, capabilityId: 'campaign.halt-stop.v1' });
    } catch { return localFailure({ message: 'Stop result unknown; reconcile before retrying' }); }
}
/** Invoke the fixed tool factory with call-local dependencies and the reviewed input.
 * @complexity One factory/invocation; existing binding/egress fences own all external I/O.
 */
async function executePlugin(required: Execution): Promise<Outcome<unknown>> {
    if (required.contribution.capability) return executeCapability(required);
    const dependencies = pluginDependencies<PluginConfiguration | PluginConnectionConfiguration>(required);
    if (!dependencies.ok) return dependencies;
    const input = required.input;
    return exported<(required: PluginCapabilityDependencies<PluginConfiguration | PluginConnectionConfiguration>) => ReturnType<PluginToolsFactory>>({ module: required.module, name: 'createTools' })(dependencies.value).invoke({
        context: required.context, connection: { connectionId: input.connectionId, accountId: input.accountId },
        name: required.contribution.name, operationId: input.operationId, input: input.arguments,
        moneyExposure: input.moneyExposure ?? null, requiredLimit: input.requiredLimit ?? null }, { signal: required.signal });
}
/** Call fixed deploy/read exports with standard dependencies and the owning job's saved evidence.
 * Invalid receipts fail at this boundary; no replay, extra job or lock is introduced.
 * @complexity O(n) bounded evidence selection (<=128 entries); plugin owns its finite I/O sequence.
 */
async function deployment(required: Execution): Promise<Outcome<unknown>> {
    const dependencies = pluginDependencies(required);
    if (!dependencies.ok) return dependencies;
    if (!required.checkpoint) return localFailure({ message: 'Campaign checkpoint unavailable' });
    const input: CampaignDeploymentRequired = { context: required.context, operationId: required.input.operationId, plan: required.input.arguments.plan,
        connectionId: required.input.connectionId, accountId: dependencies.value.configuration.accountId, dependencies: dependencies.value,
        checkpoint: required.checkpoint, saved: { references: savedDeploymentReferences({ evidence: required.evidence ?? [] }),
            record: required.evidence?.filter(entry => entry.record).at(-1)?.record ?? null } };
    const result = await exported<(input: CampaignDeploymentRequired, optional?: CallOptions) => Promise<Outcome<unknown>>>({
        module: required.module, name: required.evidence !== undefined ? 'readCampaignDeployment' : 'deployCampaignPaused' })(input, { signal: required.signal });
    return result.ok ? parseBoundary({ schema: campaignDeploymentReceiptSchema, input: result.value }) : result;
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
        const claim = await enqueueInlineJob({ database, clock: required.clock, ids: required.ids, context: input.context, leaseMs: 300000,
            job: { operationId: input.input.operationId, handler: 'agent-plugin.invoke', idempotencyKey: 'agent-plugin:' + hash({ value: input.input.operationId }),
                argumentsDigest: digest.value, payload: { pluginId: input.pluginId, input: input.input } } });
        if (!claim.ok) return claim;
        if (claim.value.kind !== 'inserted') return localFailure({ code: 'conflict', message: 'Plugin operation already claimed; reconcile before retrying' });
        const job = claim.value.job;
        const fence = { id: job.id, tenantId: job.tenantId, token: job.leaseToken!, now: required.clock.now({}) };
        if (!await repo.outbox.beginDispatch(fence) || required.clock.now({}) >= job.leaseExpiresAt!) return localFailure({ code: 'conflict', message: 'Plugin claim expired' });
        let result: Outcome<unknown>;
        try { result = await input.execute({ jobId: job.id }); } catch { result = localFailure({ message: 'Plugin result unknown; reconcile' }); }
        const checked = result.ok ? parseBoundary({ schema: boundedJsonSchema, input: result.value }) : result;
        const completion = jobCompletion({ result: checked });
        const finished = await repo.outbox.complete({ ...fence, now: required.clock.now({}) }, completion);
        if (!finished) return localFailure({ code: 'conflict', message: 'Plugin completion lost its lease; reconcile' });
        return checked;
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
        checkpoint: (input: { context: CallContext; jobId: string; event: string; evidence: Record<string, unknown> }) => pluginJobBoundary({ ...required, context: input.context, execute: () => appendJobEvidence({ database, clock: required.clock, ...input }) }),
        history: (input: Parameters<typeof history>[0]) => pluginJobBoundary({ ...required, context: input.context, execute: () => history(input) }) };
}
/** Check the durable outbox, including reconciliation-only outcomes and nested deployments.
     * O(n+b), <=1000 rows and <=64 KiB each; oversized/unresolved linkage refuses cleanup.
     * Generation/conversion jobs currently lack a durable plugin pin: they conservatively block
     * cleanup rather than being mistaken for zero activity. No second activity registry is kept.
     */
export async function countAddonJobs(required: { unit: UnitOfWork; observer: ObserverPort; context: CallContext; kind: AddonKind; id: string }): Promise<Outcome<number>> {
    return pluginJobBoundary({ ...required, execute: () => required.unit.transaction({ work: async ({ session }) => {
            const rows = await session.query({ text: "SELECT operation,CASE WHEN length(CAST(payload AS BLOB)) <= 65536 THEN payload ELSE NULL END AS payload FROM job WHERE tenant_id=$1 AND state IN ('pending','leased','dispatching','retry','reconcile') ORDER BY id LIMIT 1001", values: [jobTenant(required)] });
            if (rows.rows.length > 1000) return localFailure({ code: 'limit_exceeded', message: 'Plugin activity exceeds cleanup bound' });
            let count = 0;
            for (const row of rows.rows) {
                const active = jobUsesAddon({ ...required, operation: z.string().parse(row.operation), raw: row.payload });
                if (!active.ok) return active;
                if (active.value) count++;
            }
            return { ok: true, value: count };
    } }) });
}

/** Parse every relevant intent before interpreting identity; an unresolved reference denies. */
function jobUsesAddon(required: { kind: AddonKind; id: string; operation: string; raw: unknown }): Outcome<boolean> {
    if (required.operation === 'forms.accept' || required.operation === 'alerts.evaluate' || required.operation === 'alerts.email' || required.operation === 'alerts.weekly_report') return { ok: true, value: false };
    const raw = z.string().max(65536).parse(required.raw);
    const job = z.object({ handler: idSchema, payload: z.record(z.string(), boundedJsonSchema) }).parse(JSON.parse(raw));
    if (job.handler !== required.operation) throw new Error('Job handler mismatch');
    if (required.operation !== 'agent-plugin.invoke' && required.operation !== 'agent-plugin.halt-stop') {
        return localFailure({ code: 'unavailable', message: 'Outstanding external work has unresolved plugin linkage; finish or reconcile it before cleanup' });
    }
    const pluginId = idSchema.parse(job.payload.pluginId);
    if (required.kind !== 'agent-plugin') return { ok: true, value: true };
    if (pluginId !== 'om-campaigns') return { ok: true, value: pluginId === required.id };
    const deployment = z.object({ input: z.object({ arguments: z.object({ request: effectRequestSchema.passthrough() }) }) }).parse(job.payload);
    const calls = deployment.input.arguments.request.pausedCampaignCalls;
    if (!calls?.length) throw new Error('Unresolved campaign constituents');
    const names = calls.map(call => z.object({ tool: z.string().regex(/^vendor_[a-z0-9_]+_campaign_deploy_paused$/) }).parse(call.arguments).tool);
    return { ok: true, value: names.includes('vendor_' + required.id.replaceAll('-', '_') + '_campaign_deploy_paused') };
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
