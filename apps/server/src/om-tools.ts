/** One OM catalog and dispatcher. SDK/HTTP adapters share these exact operations. */
import { z } from 'zod';
import { buildUiToolDefinitions } from './ui-tools.js';
import { conversionSettingsStatusSchema, setConversionSettingsSchema, approvalResponseSchema, approverRefSchema, assistantSettingsSchema, boundedJsonSchema, callContextSchema, generationAllowanceSettingsSchema, idSchema, pageQuerySchema, timeWindowSchema, digestSchema, moneySchema,
    parseBoundary, toolCallSchema, toolDescriptorSchema, toolSearchSchema, addonToolEffectsSchema, neutralCampaignLaunchSchema, mailProviderSelectionSchema, mailProviderSettingsSchema } from '@open-marketing/contracts';
import type { AppError, ApproverRef, ApprovalResponse, CallContext, ClockPort, ConfirmationCard, Outcome, ToolCall, ToolDescriptor, ToolOperation, ToolResult } from '@open-marketing/contracts';
import { digestArguments, mayAnswer } from '@open-marketing/safety';
import type { DispatchPermit, EffectRequest, FrozenDispatchRequest, ConfirmationExchangePort, SafetyService } from '@open-marketing/safety';
import { addonManagementTools, addonToolSchemas, integrationOAuthTools, loadAddonToolSources, invokeAddonManagementTool, invokeAddonTool } from './addon-tools.js';
import type { AddonToolDependencies } from './addon-tools.js';
import { getMailProviderSettings, putMailProviderSettings, type ProviderReaders } from './alerts/provider-settings.js';
import { alertQuerySchema } from './alerts/index.js';
import type { bindAlerts } from './composition/alerts.js';
import type { bindReporting } from './composition/reporting.js';
import { addonBoundary } from '@open-marketing/plugins';
import type { ObserverPort } from '@open-marketing/contracts';
import { readCard } from './cli/approval.js';
import type { OwnerServices } from './inbound/owner.js';
import { readStudioSnapshot, readCampaigns, readApprovals, campaignRow } from './inbound/owner.js';
import { routes } from './cli/http.js';
import { localFailure } from './composition/local-auth.js';
import type { ContactService, Subject } from '@open-marketing/contacts';
import { publicationSchema } from '@open-marketing/forms';
import type { FormsService } from '@open-marketing/forms';
import { stageSchema as leadStageInputSchema, getSchema as leadGetInputSchema, listSchema as leadListInputSchema, historySchema as leadHistoryInputSchema, type LeadsService } from '@open-marketing/leads';
import { trackingSnippetInputSchema, trackingSnippetOutputSchema, trackingReadinessInputSchema, trackingReadinessOutputSchema } from './composition/tracking.js';
import type { bindTracking } from './composition/tracking.js';
import { grantFieldsSchema } from './composition/conversions.js';
import type { bindMeasurementGrants } from './composition/conversions.js';
import type { WebEventService } from '@open-marketing/web-events';
import type { PrivacyService } from '@open-marketing/privacy';
import type { MeasureService } from '@open-marketing/measure';
import { calculateExperimentSampleSize, readExperiment, calculateCreativeFatigue, sampleSizeInputSchema, abReadoutInputSchema, creativeFatigueInputSchema, campaignResultsQuerySchema, campaignResultsSchema, metricSyncRequestSchema } from '@open-marketing/measure';
import type { CampaignService } from '@open-marketing/campaigns';
import type { AccountBindingLookupPort, WorkspaceListing } from '@open-marketing/workspaces';
import type { ScopedJobs } from '@open-marketing/jobs';
import { paidSendingAllowanceSchema } from '@open-marketing/safety';
import type { PaidSendingAllowances } from '@open-marketing/safety';
import type { AuditService } from '@open-marketing/audit';
import { brandKitSchema, brandRevisionSchema, revisionNumberSchema, expectedRevisionSchema, getBrandRevision, getConfirmedBrand, saveBrandDraft, confirmBrandRevision } from '@open-marketing/brand';
import type { BrandRepoPort } from '@open-marketing/brand';
import { assetImportRequestSchema, placementCropRequestSchema, provenanceLinkSchema, type MediaLibrary } from '@open-marketing/media-library';
import { creativeToolInputSchema } from './om-tool-types.js';
import type { GenerationStatus } from '@open-marketing/creative';
import type { ToolOperationStore } from './tool-operations.js';
import { compactToolOperation } from './tool-operations.js';
import type { StoredToolOperation as Operation } from './om-tool-types.js';
import type { OmTools, CreativeToolBinding } from './om-tool-types.js';
export type { OmTools } from './om-tool-types.js';
import type { OmToolDefinition, OmToolPolicy } from './om-tool-types.js';
export type { OmToolDefinition, OmToolPolicy } from './om-tool-types.js';

type Dependencies = { definitions(required: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>>;
    confirmations: ConfirmationExchangePort; clock: ClockPort; observer: ObserverPort;
    /** Omitted only by existing ephemeral callers; boot always injects durable storage. */
    store?: ToolOperationStore;
    authorize(required: { context: CallContext }): Outcome<void> };
const answerInputSchema = z.strictObject({ context: callContextSchema, response: approvalResponseSchema, approver: approverRefSchema });

// Reserve 1 KiB for ToolResult/Outcome fields and MCP's escaped text wrapper (128 KiB wire cap).
const toolOutputSchema = boundedJsonSchema.refine(value => Buffer.byteLength(JSON.stringify(value)) <= 64512,
    'Tool output exceeds the envelope allowance');

/** Known irreversible effects win over unknown declarations, which always contribute write.
 * @complexity O(e) time/space, e <=10 after wire validation; no authority is inferred here.
 */
export function toolPolicy(required: { effects: readonly string[] }): OmToolPolicy {
    if (required.effects.includes('conversion') || required.effects.includes('halt_stop')) return 'internal';
    if (required.effects.includes('ad_spend')) return 'spend';
    if (required.effects.includes('destructive')) return 'destructive';
    if (required.effects.includes('generation')) return 'generation';
    return required.effects.length > 0 && required.effects.every(effect => effect === 'read') ? 'read' : 'write';
}

/** Wire projection deliberately omits invocation callbacks and server configuration. */
function descriptor(required: { definition: OmToolDefinition }): ToolDescriptor {
    const { name, description, inputSchema, effects } = required.definition;
    return toolDescriptorSchema.parse({ name, description, inputSchema, effects });
}

/** Pure bounded substring search; no search registry or caller-supplied regular expression.
 * @complexity O(n * q) time, O(limit) output; n <=1100 definitions, query <=1024 characters.
 */
export function listOmTools(required: { definitions: readonly OmToolDefinition[]; query?: string; limit: number }): Outcome<readonly ToolDescriptor[]> {
    const parsed = parseBoundary({ schema: toolSearchSchema, input: { query: required.query, limit: required.limit } });
    if (!parsed.ok) return parsed;
    const query = parsed.value.query?.toLowerCase() ?? '';
    const items = required.definitions.filter(tool => (tool.name + ' ' + tool.description).toLowerCase().includes(query))
        .slice(0, parsed.value.limit).map(definition => descriptor({ definition }));
    return { ok: true, value: items };
}

/** Frozen declaration fingerprint binds the reviewed schema/effects and implementation revision. */
function fingerprint(required: { definition: OmToolDefinition }): string {
    return checkedDigest({ value: { ...descriptor(required), revision: required.definition.revision, policy: required.definition.policy, ownerOnly: required.definition.ownerOnly ?? false } });
}
function checkedDigest(required: { value: unknown }): string {
    const result = digestArguments({ arguments: required.value });
    if (!result.ok) throw new Error('Tool digest unavailable');
    return result.value;
}
function operationKey(required: { context: CallContext; operationId: string }): string {
    return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId, required.operationId]);
}
function sameRun(required: { context: CallContext; operation: Operation }): boolean {
    return required.context.principal.kind === 'owner' || required.context.runId === required.operation.context.runId;
}
/** A neutral deployment adds its frozen review to the original tool/input; all other financial
 * bindings must still equal the original arguments exactly. @complexity O(1), pure projection. */
function financialToolInput(required: { request: EffectRequest; operation: Operation }): Readonly<Record<string, unknown>> {
    if (!required.request.pausedCampaignCalls || required.operation.call.name !== 'om_campaign_deploy_paused') return required.request.arguments;
    return { tool: required.request.arguments.tool, input: required.request.arguments.input };
}
/** Pure unknown result for the existing operation; uncertainty never advertises automatic retry. */
function unknownState(required: { operation: Operation; error: Pick<AppError, 'code' | 'message'> }): Extract<ToolOperation, { status: 'unknown' }> {
    return { status: 'unknown', operationId: required.operation.call.operationId,
        error: { code: required.error.code, message: required.error.message, retryable: false } };
}
/** Process-owned bounded operation records. Existing durable run events retain card/result evidence.
 * Boot restores snapshots without effects; pending cards use fresh owner authority.
 * @example const tools = createOmTools({ definitions, confirmations, clock, observer, authorize });
 * @complexity <=256 full bodies and <=2 MiB resident JSON; durable replay outcomes load by key.
 */
export function createOmTools(required: Dependencies): OmTools {
    const operations = new Map<string, Operation>();
    const replays = new Map<string, Operation>();
    let disposed = false;
    let restored = false;
    const active = new Set<Promise<unknown>>();
    const boundary = <T>(input: { context: CallContext; operation: string; run(): Promise<Outcome<T>> }) => {
        const pending = addonBoundary({ ...input, dependencies: required });
        active.add(pending);
        void pending.then(() => active.delete(pending), () => active.delete(pending));
        return pending;
    };
    /** Persist before proceeding; a failed save never permits egress or advertises retry. */
    async function persist(input: { operation: Operation }): Promise<boolean> {
        if (!required.store) return true;
        try {
            const saved = await required.store.save({ context: input.operation.context, operation: input.operation });
            if (saved.ok) return true;
        } catch { /* Storage implementations are isolated here; no effect follows failed persistence. */ }
        input.operation.state = unknownState({ operation: input.operation,
            error: { code: 'unavailable', message: 'Operation persistence failed; reconcile before retrying' } });
        return false;
    }
    /** Evict oldest terminal bodies only after their replay identity commits. Actual JSON bytes
     * count toward 2 MiB; ephemeral replay records share that bound. Scans/serialization are
     * bounded by the resident JSON cap; each eviction performs one awaited store write.
     */
    async function retain(input: { operation: Operation }): Promise<Outcome<void>> {
        while (!fits({ operations, operation: input.operation, replays })) {
            const oldest = [...operations.values()].find(operation => operation !== input.operation && operation.state.status !== 'pending' && !operation.executing);
            if (!oldest) return localFailure({ code: 'limit_exceeded', message: 'Tool operation retention limit reached' });
            const key = operationKey({ context: oldest.context, operationId: oldest.call.operationId });
            if (required.store) {
                const saved = await required.store.archive({ context: oldest.context, operation: oldest });
                if (!saved.ok) return saved;
            } else replays.set(key, compactToolOperation({ operation: oldest }));
            operations.delete(key);
        }
        return { ok: true, value: undefined };
    }
    /** A single scoped archive lookup never restores a callback or dispatch authority. */
    async function archived(input: { context: CallContext; operationId: string }): Promise<Outcome<Operation | null>> {
        if (required.store) return required.store.replay(input);
        return { ok: true, value: replays.get(operationKey(input)) ?? null };
    }
    /** Recheck local identity after an archive read so concurrent duplicates share one reservation. */
    async function lookup(input: { context: CallContext; operationId: string }): Promise<Outcome<Operation | null>> {
        const key = operationKey(input);
        const local = operations.get(key);
        if (local) return { ok: true, value: local };
        const stored = await archived(input);
        if (!stored.ok) return stored;
        return { ok: true, value: operations.get(key) ?? stored.value };
    }
    /** Recover exactly once under current owner authority; loading never invokes a definition.
     * O(n + c) restore work for n <=256 operations and c <=10,000 pending cards; boot completes before HTTP admission opens.
     */
    async function restore(input: { context: CallContext }): Promise<Outcome<void>> {
        const owner = admitted(input);
        if (!owner.ok) return owner;
        if (input.context.principal.kind !== 'owner') return localFailure({ code: 'forbidden', message: 'Restore requires owner authority' });
        if (restored || operations.size) return localFailure({ code: 'conflict', message: 'Operations already initialized' });
        restored = true;
        if (!required.store) return { ok: true, value: undefined };
        const loaded = await required.store.loadOpen({ scope: input.context.scope });
        if (!loaded.ok) return loaded;
        const pending = await pendingCards(input);
        if (!pending.ok) return pending;
        return restoreRecords({ context: input.context, records: loaded.value, pending: pending.value });
    }
    /** Install bounded snapshots only after each recovery transition commits. */
    async function restoreRecords(input: { context: CallContext; records: readonly Operation[]; pending: ReadonlySet<string> }): Promise<Outcome<void>> {
        for (const operation of input.records) {
            const recovered = await recover({ operation, context: input.context, pending: input.pending });
            if (!recovered.ok) return recovered;
            const retained = await retain({ operation });
            if (!retained.ok) return retained;
            operations.set(operationKey({ context: operation.context, operationId: operation.call.operationId }), operation);
        }
        return { ok: true, value: undefined };
    }
    /** A committed answer without dispatch is interrupted; uncertain dispatch is never retried. */
    async function recover(input: { context: CallContext; operation: Operation; pending: ReadonlySet<string> }): Promise<Outcome<void>> {
        const { operation } = input;
        operation.context = { ...operation.context, principal: input.context.principal };
        if (operation.state.status !== 'pending') { operation.executing = false; return { ok: true, value: undefined }; }
        if (operation.executing) operation.state = unknownState({ operation,
            error: { code: 'unavailable', message: 'Dispatch interrupted by restart; reconcile before retrying' } });
        else if (!operation.card || !input.pending.has(operation.card.cardId) || operation.expiresAt <= required.clock.now({}))
            operation.state = { status: 'interrupted', operationId: operation.call.operationId };
        operation.executing = false;
        if (await persist({ operation })) return { ok: true, value: undefined };
        return localFailure({ code: 'unavailable', message: 'Operation restore persistence failed' });
    }
    /** Read pending membership once: get intentionally also exposes answered cards.
     * O(c) time/space, c <=10,000 cards and <=100 paginated SQL reads at boot.
     */
    async function pendingCards(input: { context: CallContext }): Promise<Outcome<ReadonlySet<string>>> {
        const cards = new Set<string>();
        let cursor: string | undefined;
        do {
            const page = await required.confirmations.list({ context: input.context, query: { limit: 100, cursor } });
            if (!page.ok) return page;
            for (const card of page.value.items) cards.add(card.cardId);
            cursor = page.value.cursor ?? undefined;
            if (cards.size > 10000) return localFailure({ code: 'limit_exceeded', message: 'Card restore capacity reached' });
        } while (cursor);
        return { ok: true, value: cards };
    }

    function admitted(input: { context: CallContext; signal?: AbortSignal }): Outcome<void> {
        if (disposed || input.signal?.aborted) return localFailure({ code: 'cancelled', message: 'Tool request cancelled' });
        const parsed = callContextSchema.safeParse(input.context);
        return parsed.success ? required.authorize(input) : localFailure({ code: 'invalid_input', message: 'Invalid tool context' });
    }
    async function catalog(input: { context: CallContext }): Promise<Outcome<readonly OmToolDefinition[]>> {
        const authority = admitted(input);
        if (!authority.ok) return authority;
        const result = await required.definitions(input);
        if (!result.ok) return result;
        if (result.value.length > 1100 || new Set(result.value.map(tool => tool.name)).size !== result.value.length)
            return localFailure({ code: 'conflict', message: 'Tool catalog is too large or contains duplicate names' });
        return result;
    }
    async function owned(input: { context: CallContext; operationId: string }): Promise<Outcome<Operation>> {
        const found = await lookup(input);
        if (!found.ok) return found;
        const operation = found.value;
        if (!operation || !sameRun({ ...input, operation })) return localFailure({ code: 'forbidden', message: 'Operation unavailable in run scope' });
        return { ok: true, value: operation };
    }
    /** Synchronous local revocation closes every selected operation before awaiting storage. */
    function markInterrupted(input: { operation: Operation; status: 'interrupted' | 'cancelled' }): boolean {
        const operation = input.operation;
        if (operation.state.status !== 'pending') return false;
        operation.state = operation.executing
            ? unknownState({ operation, error: { code: 'cancelled', message: 'Dispatch interrupted; reconcile the outcome before retrying' } })
            : { status: input.status, operationId: operation.call.operationId };
        return true;
    }
    /** Await state before deleting the card; cleanup never opens overlapping lane transactions. */
    async function persistInterruption(input: { operation: Operation }): Promise<Outcome<void>> {
        const { operation } = input;
        const saved = await persist({ operation });
        let revoked: Outcome<void> = { ok: true, value: undefined };
        try {
            if (operation.card) revoked = await required.confirmations.revoke({ context: operation.context, cardId: operation.card.cardId });
        } catch { revoked = localFailure({ message: 'Card revocation failed; reconcile before retrying' }); }
        if (!saved) return { ok: false, error: { code: 'unavailable', message: 'Cancellation persistence failed; reconcile before retrying', retryable: false } };
        return revoked;
    }
    /** Revoke pending authority; in-flight effects become unknown. O(1) state/query work. */
    async function interrupt(input: { operation: Operation; status: 'interrupted' | 'cancelled' }): Promise<Outcome<void>> {
        if (!markInterrupted(input)) return { ok: true, value: undefined };
        return persistInterruption(input);
    }
    async function state(input: { operation: Operation }): Promise<ToolOperation> {
        if (input.operation.expiresAt <= required.clock.now({}) || !admitted({ context: input.operation.context }).ok) {
            const interrupted = await interrupt({ ...input, status: 'interrupted' });
            if (!interrupted.ok) throw interrupted.error;
        }
        return structuredClone(input.operation.state);
    }
    /** Finished run grants cannot replay. Their durable event log retains the completed evidence;
     * unknown outcomes stay queryable, and owner-only operation identities are never evicted.
     * @complexity O(n) time/O(1) space, n <=256 retained operations; no dispatch or retry.
     */
    async function releaseRevokedRuns(): Promise<void> {
        for (const operation of operations.values()) {
            if (retainedBeyondRun({ operation })) continue;
            if (required.authorize({ context: operation.context }).ok) continue;
            await interrupt({ operation, status: 'interrupted' });
        }
    }
    /** Elect one in-process invoker, then commit dispatching before the definition can run. */
    async function beginDispatch(input: { operation: Operation; signal?: AbortSignal }): Promise<boolean> {
        const { operation } = input;
        if (operation.state.status !== 'pending' || operation.executing) return false;
        operation.executing = true;
        if (!admitted({ context: operation.context, signal: input.signal }).ok) { await interrupt({ operation, status: 'interrupted' }); return false; }
        if (!await persist({ operation }) || operation.state.status !== 'pending') return false;
        if (operation.expiresAt <= required.clock.now({}) || !admitted({ context: operation.context, signal: input.signal }).ok) { await interrupt({ operation, status: 'interrupted' }); return false; }
        return true;
    }
    /** Failed or invalid dispatch results are unknown and cannot advertise automatic retry. */
    async function invoke(input: { operation: Operation; definition: OmToolDefinition; context: CallContext; signal?: AbortSignal }): Promise<void> {
        const { operation } = input;
        if (!await beginDispatch(input)) return;
        try {
            const context = { ...input.context, runId: operation.context.runId,
                correlationId: operation.context.correlationId, traceId: operation.context.traceId };
            const result = await invokeDefinition({ ...input, context });
            if (operation.state.status !== 'pending') return;
            const parsed = result.ok ? parseBoundary({ schema: toolOutputSchema, input: result.value }) : result;
            operation.state = parsed.ok ? { status: 'completed', operationId: operation.call.operationId, output: parsed.value }
                : unknownState({ operation, error: parsed.error });
        } catch {
            if (operation.state.status !== 'pending') return;
            operation.state = unknownState({ operation,
                error: { code: 'unavailable', message: 'Tool outcome unknown; reconcile before another attempt' } });
        } finally { await persist({ operation }); operation.executing = false; }
    }
    /** Financial classification uses the owning service's verified quote and current allowance.
     * The binding must review the same tool/input/operation; no model-supplied cost is trusted.
     * @complexity O(payload) time/space, bounded to the existing 64 KiB operation contract.
     */
    async function prepareFinancial(input: { operation: Operation; definition: OmToolDefinition; signal?: AbortSignal }): Promise<Outcome<void>> {
        const { operation } = input;
        if (operation.policy !== 'spend' && operation.policy !== 'generation') return { ok: true, value: undefined };
        try { return await verifiedFinancialRequest(input); }
        catch { return localFailure({ code: 'protocol_mismatch', message: 'Financial binding failed before dispatch; request fresh verified authority' }); }
    }
    /** Validate the binding against frozen tool arguments, then ask the owning quote verifier. */
    async function verifiedFinancialRequest(input: { operation: Operation; definition: OmToolDefinition; signal?: AbortSignal }): Promise<Outcome<void>> {
        const { operation, definition } = input;
        if (!definition.safety || !definition.prepareEffect) return localFailure({ code: 'not_implemented', message: 'NEEDS I-2: verified safety/backend binding is not connected' });
        const prepared = await definition.prepareEffect({ context: operation.context, call: structuredClone(operation.call) }, { signal: input.signal });
        if (!prepared.ok) return prepared;
        const request = prepared.value;
        const reviewed = financialToolInput({ request, operation });
        if (request.envelope.operationId !== operation.call.operationId || checkedDigest({ value: reviewed }) !== operation.request.envelope.argumentsDigest
            || checkedDigest({ value: request.arguments }) !== request.envelope.argumentsDigest
            || toolPolicy({ effects: request.envelope.effects }) !== operation.policy)
            return localFailure({ code: 'conflict', message: 'Financial binding differs from the frozen tool call' });
        operation.request = structuredClone(request);
        operation.classification = 'spend';
        if (operation.policy === 'spend') return { ok: true, value: undefined };
        if (!request.generation) return localFailure({ code: 'forbidden', message: 'Generation requires a verified quote' });
        const assessment = await definition.safety.assessGeneration({ context: operation.context, ...request.generation });
        if (!assessment.ok) return assessment;
        if (assessment.value.kind === 'denied') return localFailure({ code: 'forbidden', message: 'Generation allowance denied this request' });
        operation.classification = assessment.value.kind === 'normal_write' ? 'generation' : 'spend';
        return { ok: true, value: undefined };
    }
    /** All financial egress uses the owning safety barrier, including its fresh authority recheck.
     * Generic reads/writes invoke the existing service after the dispatcher grants authority.
     */
    async function invokeDefinition(input: { operation: Operation; definition: OmToolDefinition; context: CallContext; signal?: AbortSignal }): Promise<Outcome<unknown>> {
        const { operation, definition } = input;
        if (operation.policy !== 'spend' && operation.policy !== 'generation') return definition.invoke({ context: input.context, input: structuredClone(operation.call.input), signal: input.signal });
        if (!definition.safety || !operation.approvalId) return localFailure({ code: 'forbidden', message: 'Financial authority is unavailable' });
        const request = { ...operation.request, approvalId: operation.approvalId, policyRevision: 0 };
        if (request.pausedCampaignCalls && operation.call.name === 'om_campaign_deploy_paused')
            return definition.invoke({ context: input.context, input: structuredClone(operation.call.input), authorization: request, signal: input.signal });
        return definition.safety.withDispatch({ context: input.context, request,
            dispatch: async ({ permit }) => {
                const current = admitted({ context: operation.context, signal: input.signal });
                if (!current.ok) return current;
                return definition.invoke({ context: input.context, input: structuredClone(operation.call.input), authorization: request, permit, signal: input.signal });
            } }, { signal: input.signal });
    }
    /** Reuse only bounded, unexpired confirmed write grants from this instance. Spend/destruction
     * always receive a fresh card. The exchange verifies configuration, scope and run identity.
     * @complexity O(n) checks, n <=256 retained operations; no separate grant registry.
     */
    async function useRetainedGrant(input: { operation: Operation; definition: OmToolDefinition }): Promise<boolean> {
        const operation = input.operation;
        if (input.definition.ownerOnly || operation.classification === 'spend' || operation.classification === 'destructive') return false;
        for (const prior of operations.values()) {
            if (!retainedGrantMatches({ operation, prior })) continue;
            const verified = await required.confirmations.verify({ context: operation.context,
                request: { ...operation.request, approvalId: prior.approvalId!, policyRevision: 0 }, classification: operation.classification });
            if (!verified.ok) continue;
            operation.approvalId = prior.approvalId;
            operation.expiresAt = Math.min(operation.expiresAt, prior.expiresAt);
            return true;
        }
        return false;
    }
    async function execute(input: { context: CallContext; call: ToolCall; signal?: AbortSignal }): Promise<Outcome<ToolResult>> {
        const parsed = parseBoundary({ schema: toolCallSchema, input: input.call });
        if (!parsed.ok) return parsed;
        const found = await catalog(input);
        if (!found.ok) return found;
        const authority = admitted(input);
        if (!authority.ok) return authority;
        const definition = found.value.find(tool => tool.name === parsed.value.name);
        if (!definition) return localFailure({ code: 'not_implemented', message: 'Tool is not connected. Search the catalog for available tools.' });
        await releaseRevokedRuns();
        const digest = digestArguments({ arguments: parsed.value });
        if (!digest.ok) return digest;
        const prior = await lookup({ ...input, operationId: parsed.value.operationId });
        if (!prior.ok) return prior;
        if (prior.value) return replay({ prior: prior.value, context: input.context, digest: digest.value });
        return reserveAndDispatch({ ...input, call: parsed.value, definition, digest: digest.value });
    }
    /** Reserve identity before asynchronous verification. Duplicate dispatch observes pending and
     * cancellation cannot resurrect it while a financial binding is being checked.
     */
    async function reserveAndDispatch(input: { context: CallContext; call: ToolCall; definition: OmToolDefinition; digest: string; signal?: AbortSignal }): Promise<Outcome<ToolResult>> {
        const { definition } = input;
        const valid = definition.parse({ input: input.call.input });
        if (!valid.ok) return valid;
        const policy = toolPolicy({ effects: definition.effects });
        if (policy === 'internal') return localFailure({ code: 'forbidden', message: 'Conversion delivery and halt stops require typed server jobs; generic tool authority is insufficient' });
        if (definition.unavailableReason) return localFailure({ code: 'not_implemented', message: definition.unavailableReason });
        const operation = freezeOperation({ ...input, policy, clock: required.clock });
        const retained = await retain({ operation });
        if (!retained.ok) return retained;
        const prior = operations.get(operationKey({ ...input, operationId: operation.call.operationId }));
        if (prior) return replay({ prior, context: input.context, digest: input.digest });
        operations.set(operationKey({ ...input, operationId: operation.call.operationId }), operation);
        if (!await persist({ operation })) return resultOf({ operation });
        const prepared = await prepareFinancial({ operation, definition, signal: input.signal });
        if (!prepared.ok) {
            if (operation.state.status === 'pending') operation.state = unknownState({ operation, error: prepared.error });
            await persist({ operation });
            return prepared;
        }
        if (!(await retain({ operation })).ok) { operation.state = unknownState({ operation,
            error: { code: 'limit_exceeded', message: 'Prepared financial request exceeds operation retention limit' } }); await persist({ operation }); return resultOf({ operation }); }
        return dispatchPrepared({ ...input, operation });
    }
    async function dispatchPrepared(input: { operation: Operation; definition: OmToolDefinition; context: CallContext; signal?: AbortSignal }): Promise<Outcome<ToolResult>> {
        if (input.operation.state.status !== 'pending') return resultOf(input);
        const current = admitted(input);
        if (!current.ok) { await interrupt({ operation: input.operation, status: 'interrupted' }); return current; }
        if (input.operation.policy === 'read') await invoke(input);
        else if (await useRetainedGrant(input)) await invoke(input);
        else await present(input);
        return resultOf(input);
    }
    async function present(input: { operation: Operation; definition: OmToolDefinition }): Promise<void> {
        const { operation } = input;
        if (!await persist({ operation }) || operation.state.status !== 'pending') return;
        const card = input.definition.safety && input.definition.prepareEffect
            ? await input.definition.safety.prepareApproval({ context: operation.context, request: operation.request })
            : await required.confirmations.present({ context: operation.context, request: operation.request, policyRevision: 0, classification: operation.classification });
        if (!card.ok) { operation.state = unknownState({ operation, error: card.error }); await persist({ operation }); return; }
        if (operation.state.status !== 'pending') { await required.confirmations.revoke({ context: operation.context, cardId: card.value.cardId }); return; }
        operation.classification = card.value.classification;
        operation.card = card.value;
        operation.expiresAt = Math.min(operation.expiresAt, card.value.expiresAt);
        operation.state = { status: 'pending', operationId: operation.call.operationId, cardId: card.value.cardId };
        await persist({ operation });
    }
    async function answer(input: { context: CallContext; response: ApprovalResponse; approver: ApproverRef }): Promise<Outcome<void>> {
        const owner = admitted(input);
        if (!owner.ok) return owner;
        if (input.context.principal.kind !== 'owner') return localFailure({ code: 'forbidden', message: 'Only the authenticated owner can answer a card' });
        const eligible = mayAnswer({ card: { scope: input.context.scope }, approver: { context: input.context, reference: input.approver } });
        if (!eligible.ok) return eligible;
        const found = await owned({ ...input, operationId: input.response.operationId });
        if (!found.ok) return found;
        const operation = found.value;
        if ((await state({ operation })).status !== 'pending' || operation.executing) return localFailure({ code: 'conflict', message: 'Card operation is no longer pending' });
        if (operation.card?.cardId !== input.response.cardId) return localFailure({ code: 'forbidden', message: 'Card is not linked to this operation' });
        const latest = await catalog({ context: operation.context });
        if (!latest.ok) return latest;
        const definition = latest.value.find(tool => tool.name === operation.call.name);
        if (!definition || fingerprint({ definition }) !== operation.revision) {
            await interrupt({ operation, status: 'interrupted' });
            return localFailure({ code: 'conflict', message: 'Tool changed or was removed. Request fresh approval.' });
        }
        return confirmAndInvoke({ ...input, operation, definition });
    }
    async function confirmAndInvoke(input: { context: CallContext; response: ApprovalResponse; approver: ApproverRef; operation: Operation; definition: OmToolDefinition }): Promise<Outcome<void>> {
        const { operation } = input;
        const confirmed = await required.confirmations.confirm({ context: input.context, response: input.response, approver: input.approver });
        if (!confirmed.ok) return confirmed;
        if (input.response.choice === 'cancel') return interrupt({ operation, status: 'cancelled' });
        const verified = await required.confirmations.verify({ context: operation.context,
            request: { ...operation.request, approvalId: input.response.cardId, policyRevision: 0 },
            classification: operation.classification });
        if (!verified.ok) return verified;
        operation.approvalId = input.response.cardId;
        operation.grantChoice = input.response.choice;
        await invoke({ operation, definition: input.definition, context: input.context });
        return { ok: true, value: undefined };
    }
    return {
        list: input => boundary({ ...input, operation: 'om.tools.list', run: async () => {
            const result = await catalog(input);
            return result.ok ? listOmTools({ ...input, definitions: result.value }) : result;
        } }),
        describe: input => boundary({ ...input, operation: 'om.tools.describe', run: async () => {
            const result = await catalog(input);
            if (!result.ok) return result;
            const definition = result.value.find(tool => tool.name === input.name);
            return definition ? { ok: true, value: descriptor({ definition }) } : localFailure({ code: 'not_implemented', message: 'Tool is not connected' });
        } }),
        dispatch: input => boundary({ ...input, operation: 'om.tools.dispatch', run: () => execute(input) }),
        operation: input => boundary({ ...input, operation: 'om.tools.operation', run: async () => {
            const authority = admitted(input);
            if (!authority.ok) return authority;
            const found = await owned(input);
            return found.ok ? { ok: true, value: await state({ operation: found.value }) } : found;
        } }),
        card: input => boundary({ ...input, operation: 'om.tools.card', run: async () => {
            const authority = admitted(input);
            if (!authority.ok) return authority;
            const found = await owned(input);
            if (!found.ok) return found;
            return { ok: true, value: (await state({ operation: found.value })).status === 'pending' ? structuredClone(found.value.card ?? null) : null };
        } }),
        answer: input => {
            const parsed = parseBoundary({ schema: answerInputSchema, input });
            if (!parsed.ok) return Promise.resolve(parsed);
            return boundary({ ...parsed.value, operation: 'om.tools.answer', run: () => answer(parsed.value) });
        },
        restore: input => boundary({ ...input, operation: 'om.tools.restore', run: () => restore(input) }),
        cancel: input => boundary({ ...input, operation: 'om.tools.cancel', run: async () => {
            if (disposed) return { ok: true, value: undefined };
            const pending = [...operations.values()].filter(operation => operation.context.runId === input.runId
                && operation.context.scope.ownerId === input.context.scope.ownerId && operation.context.scope.workspaceId === input.context.scope.workspaceId);
            const changed = pending.filter(operation => markInterrupted({ operation, status: 'cancelled' }));
            let result: Outcome<void> = { ok: true, value: undefined };
            for (const operation of changed) {
                const saved = await persistInterruption({ operation });
                if (!saved.ok) result = saved;
            }
            return result;
        } }).then(result => { if (!result.ok) throw { ...result.error, retryable: false }; }),
        async dispose() {
            disposed = true;
            // Durable waiting cards survive restart; ephemeral callers retain revocation on disposal.
            const changed = [...operations.values()].filter(operation => (operation.executing || !required.store) && markInterrupted({ operation, status: 'interrupted' }));
            let failure: Outcome<void> = { ok: true, value: undefined };
            for (const operation of changed) {
                const saved = await persistInterruption({ operation });
                if (!saved.ok) failure = saved;
            }
            await Promise.allSettled([...active]);
            operations.clear(); replays.clear();
            if (!failure.ok) throw { ...failure.error, retryable: false };
        },
    };
}

/** Unknown outcomes and scoped Always allow authority remain observable until instance disposal. */
function retainedBeyondRun(required: { operation: Operation }): boolean {
    const operation = required.operation;
    return !operation.context.runId || operation.state.status === 'unknown'
        || (operation.state.status === 'completed' && operation.grantChoice === 'always_allow');
}

/** Scope/implementation/expiry are reverified by the exchange before any grant is reused. */
function retainedGrantMatches(required: { operation: Operation; prior: Operation }): boolean {
    const { operation, prior } = required;
    if (prior.state.status !== 'completed' || !prior.approvalId || prior.revision !== operation.revision) return false;
    if (prior.classification !== operation.classification) return false;
    return prior.grantChoice === 'always_allow' || (prior.grantChoice === 'allow_chat' && !!operation.context.runId && prior.context.runId === operation.context.runId);
}

/** Retention includes completed outputs and frozen requests, preventing a growing replay cache. */
function fits(required: { operations: ReadonlyMap<string, Operation>; operation: Operation; replays: ReadonlyMap<string, Operation> }): boolean {
    const others = [...required.operations.values()].filter(operation => operation !== required.operation);
    if (others.length >= 256) return false;
    const retained = [...others, ...required.replays.values()].reduce((total, operation) => total + Buffer.byteLength(JSON.stringify(operation)), 0);
    return retained + Buffer.byteLength(JSON.stringify(required.operation)) <= 2097152;
}
function freezeOperation(required: { context: CallContext; call: ToolCall; definition: OmToolDefinition; policy: OmToolPolicy; digest: string; clock: ClockPort }): Operation {
    const argumentsValue = { tool: required.call.name, input: structuredClone(required.call.input) };
    const argumentsDigest = checkedDigest({ value: argumentsValue });
    return { context: structuredClone(required.context), call: structuredClone(required.call), digest: required.digest,
        revision: fingerprint({ definition: required.definition }), policy: required.policy, classification: required.policy === 'destructive' ? 'destructive' : 'write', expiresAt: required.clock.now({}) + 300000,
        state: { status: 'pending', operationId: required.call.operationId }, executing: false,
        request: { arguments: argumentsValue, pluginDigest: checkedDigest({ value: required.definition.revision }),
            // Grant reuse remains bounded by the exact card expiry.
            ...(required.definition.ownerOnly ? {} : { operationScope: required.definition.name }), schemaFingerprint: checkedDigest({ value: required.definition.inputSchema }),
            envelope: { operationId: required.call.operationId, connectionId: required.definition.name, accountId: null,
                effects: addonToolEffectsSchema.parse(required.definition.effects), argumentsDigest, moneyExposure: null, requiredLimit: null } } };
}
function replay(required: { prior: Operation; context: CallContext; digest: string }): Outcome<ToolResult> {
    if (!sameRun({ context: required.context, operation: required.prior }) || required.prior.digest !== required.digest)
        return localFailure({ code: 'conflict', message: 'Operation identity has different arguments or run scope' });
    return resultOf({ operation: required.prior });
}
function resultOf(required: { operation: Operation }): Outcome<ToolResult> {
    switch (required.operation.state.status) {
        case 'completed': return { ok: true, value: { status: 'completed', output: structuredClone(required.operation.state.output) } };
        case 'pending': return { ok: true, value: structuredClone(required.operation.state) };
        case 'unknown': return { ok: false, error: required.operation.state.error };
        case 'cancelled': return localFailure({ code: 'cancelled', message: 'Tool operation cancelled' });
        case 'interrupted': return localFailure({ code: 'expired', message: 'Tool operation interrupted; request fresh authority' });
    }
}

/** Validate Zod's generated schema with the bounded JSON object contract before exposing it.
 * @throws z.ZodError if generated data exceeds the wire contract; Zod rejects unsupported schemas.
 * @example toolInputSchema({ schema: toolSearchSchema });
 * @complexity O(s) time/space for generated schema size s; wire output <=64 KiB/depth 16.
 */
export function toolInputSchema(required: { schema: z.ZodType }): ToolDescriptor['inputSchema'] {
    return toolDescriptorSchema.shape.inputSchema.parse(z.toJSONSchema(required.schema, { io: 'input' }));
}
/** Model sees only three discovery tools; execute_tool's policy is always the target's policy. */
export const discoveryTools: readonly ToolDescriptor[] = [
    { name: 'search_tools', description: 'Find available OM tools by name or description. Returns bounded descriptors; unavailable capabilities are absent.',
        effects: ['read'], inputSchema: toolInputSchema({ schema: toolSearchSchema }) },
    { name: 'describe_tool', description: 'Read one OM tool schema before calling it. Unknown or disconnected tools return a typed failure.',
        effects: ['read'], inputSchema: toolInputSchema({ schema: z.strictObject({ name: idSchema }) }) },
    { name: 'execute_tool', description: 'Execute a discovered OM tool with exact input and a stable operationId. Writes may wait for the owner card; completion returns the actual output.',
        effects: ['write'], inputSchema: toolInputSchema({ schema: toolCallSchema }) },
];

/** Current enabled instruction sources are reloaded on discovery and again at dispatch.
 * Source callbacks only disclose instructions; executable tools keep their verified effects.
 * A failed package description marks only that source unavailable; catalog-list failures propagate.
 * @complexity Fixed read bindings plus D2's bounded source loading; no second plugin registry.
 */
export async function buildOmToolDefinitions(required: { context: CallContext; services: OwnerServices & OmFeatureServices; addons?: AddonToolDependencies; providerSettings?: ProviderReaders; siteGuide?: OmToolDefinition; chartProviders?: (required: { context: CallContext }) => Promise<Outcome<z.infer<typeof routes.chartProviders.schema>>> }): Promise<Outcome<readonly OmToolDefinition[]>> {
    const definitions: OmToolDefinition[] = ownerReadDefinitions(required);
    if (required.siteGuide) definitions.push(required.siteGuide);
    definitions.push(ownerSettingsDefinition(required), ...mailProviderDefinitions({ readers: required.providerSettings }), ...conversionSettingsDefinitions({ integrations: required.addons?.integrations }), ...assistantDefinitions(required), ...mediaDefinitions({ media: required.services.media }), ...coreDefinitions(required), ...featureDefinitions(required),
        ...buildUiToolDefinitions({ runtime: required.services.ui?.runtime ?? null, frontend: required.services.ui?.frontend }));
    if (!required.addons) return { ok: true, value: definitions };
    const unavailableSources = new Set<string>();
    const dependencies = { ...required.addons, addons: { ...required.addons.addons, async describe(input: Parameters<AddonToolDependencies['addons']['describe']>[0]) {
        const described = await required.addons!.addons.describe(input);
        if (described.ok) return described;
        unavailableSources.add(input.kind + ':' + input.id);
        return { ok: true as const, value: { effects: ['write'] } };
    } } };
    const loaded = await loadAddonToolSources({ context: required.context, dependencies });
    if (!loaded.ok) return redactAddonOutcome({ outcome: loaded });
    definitions.push(...addonDefinitions({ dependencies: required.addons }));
    for (const source of loaded.value) definitions.push({ ...source, capability: 'Installed ' + source.kind + ': ' + source.addonId,
        policy: 'read',
        unavailableReason: unavailableSources.has(source.kind + ':' + source.addonId) ? 'Installed add-on unavailable; check its package metadata'
            : undefined, parse: input => parseBoundary({ schema: z.strictObject({ skill: idSchema.optional() }), input: input.input }),
        invoke: async input => redactAddonOutcome({ outcome: await invokeAddonTool({ ...input, sourceId: source.id, revision: source.revision, dependencies: required.addons! }, { signal: input.signal }) }) });
    return { ok: true, value: definitions };
}
/** Named owner read models call their owning service directly and validate the CLI wire schema.
 * The dispatcher still admits the original caller; serviceDefinition projects read identity only.
 */
function ownerReadDefinitions(required: { services: OwnerServices; chartProviders?: (required: { context: CallContext }) => Promise<Outcome<z.infer<typeof routes.chartProviders.schema>>> }): OmToolDefinition[] {
    const { services } = required;
    const resourceId = idSchema.refine(value => value !== '.' && value !== '..' && !/[\x00-\x1f/\\]/.test(value));
    const empty = z.strictObject({}); const id = z.strictObject({ id: resourceId });
    return [
        serviceDefinition({ name: 'om_status', capability: 'Server status', schema: empty, policy: 'read', ownerRoute: 'status', outputSchema: routes.status.schema,
            invoke: async () => ({ ok: true, value: { ready: true, mode: 'local' } }) }),
        serviceDefinition({ name: 'om_studio_snapshot', capability: 'Studio snapshot', schema: empty, policy: 'read', ownerRoute: 'snapshot', outputSchema: routes.snapshot.schema,
            invoke: ({ context }) => readStudioSnapshot({ services, context }) }),
        serviceDefinition({ name: 'om_campaigns_list', capability: 'Campaign list', schema: pageQuerySchema, policy: 'read', ownerRoute: 'campaigns', outputSchema: routes.campaigns.schema,
            invoke: ({ context, value: query, signal }) => readCampaigns({ context, services, query }, { signal }) }),
        serviceDefinition({ name: 'om_campaigns_get', capability: 'Campaign read', schema: id, policy: 'read', ownerRoute: 'campaign', outputSchema: routes.campaign.schema,
            invoke: async ({ context, value, signal }) => {
                const found = await services.campaigns.get({ context, campaignId: value.id }, { signal });
                if (!found.ok) return found;
                return found.value ? { ok: true, value: campaignRow({ record: found.value }) } : localFailure({ code: 'forbidden', message: 'Campaign unavailable in scope' });
            } }),
        serviceDefinition({ name: 'om_approvals_list', capability: 'Scoped pending approvals', schema: pageQuerySchema, policy: 'read', ownerRoute: 'approvals', outputSchema: routes.approvals.schema,
            invoke: ({ context, value: query, signal }) => readApprovals({ context, services, query }, { signal }) }),
        serviceDefinition({ name: 'om_approvals_get', capability: 'Scoped exact approval', schema: id, policy: 'read', ownerRoute: 'approval', outputSchema: routes.approval.schema,
            invoke: async ({ context, value, signal }) => {
                const found = await services.confirmations.get({ context, cardId: value.id }, { signal });
                if (!found.ok) return found;
                return found.value ? readCard({ input: found.value }) : localFailure({ code: 'forbidden', message: 'Card unavailable in scope' });
            } }),
        serviceDefinition({ name: 'om_allowance_view', capability: 'Generation allowance view', schema: empty, policy: 'read', ownerRoute: 'allowance', outputSchema: routes.allowance.schema,
            invoke: ({ context, signal }) => services.safety.getGenerationAllowanceView({ context }, { signal }) }),
        serviceDefinition({ name: 'om_assistant_settings_get', capability: 'Assistant selection', schema: empty, policy: 'read', ownerRoute: 'assistantSettings', outputSchema: routes.assistantSettings.schema,
            invoke: async ({ context }) => services.conversations?.settings({ context }) ?? localFailure({ message: 'Assistant settings unavailable' }) }),
        serviceDefinition({ name: 'om_conversations_list', capability: 'Conversation list', schema: pageQuerySchema.extend({ limit: z.number().int().min(1).max(10) }), policy: 'read', ownerRoute: 'conversations', outputSchema: routes.conversations.schema,
            invoke: async ({ context, value: query }) => services.conversations?.list({ context, query }) ?? localFailure({ message: 'Conversation storage unavailable' }) }),
        serviceDefinition({ name: 'om_conversations_get', capability: 'Conversation history (64 KiB output; reduce limit if exceeded)', schema: pageQuerySchema.extend({ id: resourceId, limit: z.number().int().min(1).max(5) }), policy: 'read', ownerRoute: 'conversation', outputSchema: routes.conversation.schema,
            invoke: async ({ context, value: { id: conversationId, ...query } }) => services.conversations?.read({ context, conversationId, query }) ?? localFailure({ message: 'Conversation storage unavailable' }) }),
        serviceDefinition({ name: 'om_chart_providers_list', capability: 'Chart provider inventory', schema: empty, policy: 'read', ownerRoute: 'chartProviders', outputSchema: routes.chartProviders.schema,
            invoke: async ({ context }) => required.chartProviders?.({ context }) ?? localFailure({ message: 'Chart providers unavailable' }) }),
    ];
}

function ownerSettingsDefinition(required: { services: OwnerServices }): OmToolDefinition {
    return serviceDefinition({ name: 'om_assistant_settings_set', capability: 'Assistant selection change', schema: assistantSettingsSchema,
        policy: 'write', ownerOnly: true, ownerRoute: 'setAssistantSettings', outputSchema: routes.setAssistantSettings.schema,
        invoke: async ({ context, value: settings }) => required.services.conversations?.setSettings({ context, settings }) ?? localFailure({ message: 'Assistant settings unavailable' }) });
}

/** Bind existing settings readers; each select/clear requires a fresh authenticated owner card.
 * @complexity O(1) definitions; service-owned catalog/storage reads retain their existing bounds.
 */
function mailProviderDefinitions(required: { readers?: ProviderReaders }): OmToolDefinition[] {
    const readers = required.readers;
    if (!readers) return [];
    return [
        serviceDefinition({ name: 'om_mail_provider_get', capability: 'Mail provider selection', policy: 'read', schema: z.strictObject({}),
            ownerRoute: 'mailProvider', outputSchema: mailProviderSettingsSchema,
            invoke: ({ context }) => getMailProviderSettings({ ...readers, context }) }),
        serviceDefinition({ name: 'om_mail_provider_set', capability: 'Mail provider selection', policy: 'write', schema: mailProviderSelectionSchema,
            ownerOnly: true, ownerRoute: 'setMailProvider', outputSchema: mailProviderSelectionSchema,
            invoke: ({ context, value }) => putMailProviderSettings({ ...readers, context, ...value }) }),
    ];
}

/** Manifest-declared non-secret settings use the existing exact owner approval continuation.
 * @complexity O(1) catalog entries; bounded storage validation belongs to integrations.
 */
function conversionSettingsDefinitions(required: { integrations?: AddonToolDependencies['integrations'] }): OmToolDefinition[] {
    const integrations = required.integrations;
    if (!integrations?.conversionSettings || !integrations.setConversionSettings) return [];
    return [
        serviceDefinition({ name: 'integrations_conversion_settings_get', capability: 'Conversion settings', policy: 'read', schema: setConversionSettingsSchema.pick({ pluginId: true }),
            ownerRoute: 'integrationConversionSettings', outputSchema: conversionSettingsStatusSchema,
            invoke: async ({ context, value, signal }) => integrations.conversionSettings!({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'integrations_conversion_settings_set', capability: 'Conversion settings', policy: 'write', schema: setConversionSettingsSchema,
            ownerOnly: true, ownerRoute: 'setIntegrationConversionSettings', outputSchema: conversionSettingsStatusSchema,
            invoke: async ({ context, value: request, signal }) => integrations.setConversionSettings!({ context, request }, { signal }) }),
    ];
}

/** Already-public feature services supplied by composition, never constructed in a catalog module.
 * Missing services produce named coverage NEEDS rather than callable stubs.
 */
export interface OmFeatureServices {
    alerts?: Pick<ReturnType<typeof bindAlerts>, 'list' | 'acknowledge'>;
    brand?: { repo: BrandRepoPort; clock: ClockPort };
    media?: MediaLibrary;
    creative?: CreativeToolBinding;
    contacts?: ContactService;
    forms?: FormsService;
    leads?: LeadsService;
    webEvents?: WebEventService;
    tracking?: ReturnType<typeof bindTracking>;
    privacy?: PrivacyService;
    measure?: MeasureService;
    reporting?: Pick<ReturnType<typeof bindReporting>, 'results' | 'enqueue'>;
    campaignWorkflow?: CampaignService;
    campaignDeployment?: OmToolDefinition;
    accountBindings?: AccountBindingLookupPort;
    audit?: AuditService;
    workspaces?: WorkspaceListing;
    jobs?: ScopedJobs;
    paidSending?: PaidSendingAllowances;
    measurementGrants?: ReturnType<typeof bindMeasurementGrants>;
}

/** A small schema-bound call to an existing service. The owner identity is projected for named
 * reads only; writes receive the authenticated continuation identity without substitution.
 * @complexity O(input bytes) validation; one injected service call, no dependency construction.
 */
function serviceDefinition<T>(required: { name: string; capability: string; schema: z.ZodType<T>; policy: 'read' | 'write' | 'destructive';
    ownerRoute?: keyof typeof routes; ownerOnly?: true; outputSchema?: z.ZodType;
    invoke(input: { context: CallContext; value: T; signal?: AbortSignal }): Promise<Outcome<unknown>> }): OmToolDefinition {
    return { name: required.name, capability: required.capability, description: required.capability + '. Returns the scoped service result. Invalid inputs or missing authority fail explicitly.',
        effects: [required.policy], policy: required.policy, revision: '1', ownerRoute: required.ownerRoute, ownerOnly: required.ownerOnly,
        inputSchema: toolInputSchema({ schema: required.schema }), parse: input => parseBoundary({ schema: required.schema, input: input.input }),
        invoke: async input => {
            const parsed = parseBoundary({ schema: required.schema, input: input.input });
            if (!parsed.ok) return parsed;
            const context = required.policy === 'read' ? scopedReadContext(input) : input.context;
            const result = await required.invoke({ context, value: parsed.value, signal: input.signal });
            return result.ok && required.outputSchema ? parseBoundary({ schema: required.outputSchema, input: result.value }) : result;
        } };
}
/** Fixed owner read projections share the already-authenticated workspace, retaining run/trace IDs. */
function scopedReadContext(required: { context: CallContext }): CallContext {
    return { ...required.context, principal: { kind: 'owner', ownerId: required.context.scope.ownerId } };
}

/** Expose the existing revision service through the shared HTTP/MCP/CLI dispatcher.
 * Confirmation always needs a fresh owner card; the continuation supplies its real actor.
 * @complexity O(1) declarations; validation is O(b) for kits capped at 60 KiB, one service call.
 */
function brandDefinitions(required: { brand?: OmFeatureServices['brand'] }): OmToolDefinition[] {
    const brand = required.brand;
    if (!brand) return [];
    const revision = revisionNumberSchema;
    const draft = z.strictObject({ kit: brandKitSchema.refine(kit => Buffer.byteLength(JSON.stringify(kit), 'utf8') <= 60 * 1024, 'Kit exceeds 60 KiB'),
        expectedRevision: expectedRevisionSchema });
    return [
        serviceDefinition({ name: 'om_brand_get', capability: 'Latest or exact brand revision', policy: 'read', schema: z.strictObject({ revision: revision.optional() }), outputSchema: brandRevisionSchema.nullable(),
            invoke: ({ context, value, signal }) => getBrandRevision({ context, repo: brand.repo, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_brand_confirmed', capability: 'Last confirmed brand facts and offers', policy: 'read', schema: z.strictObject({}), outputSchema: brandRevisionSchema.nullable(),
            invoke: ({ context, signal }) => getConfirmedBrand({ context, repo: brand.repo }, { signal }) }),
        serviceDefinition({ name: 'om_brand_save_draft', capability: 'Save a complete brand draft with the loaded expectedRevision', policy: 'write', schema: draft, outputSchema: brandRevisionSchema,
            invoke: ({ context, value, signal }) => saveBrandDraft({ ...brand, context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_brand_confirm', capability: 'Owner confirmation of the exact current brand draft', policy: 'write', ownerOnly: true, schema: z.strictObject({ revision }), outputSchema: brandRevisionSchema,
            invoke: ({ context, value, signal }) => confirmBrandRevision({ ...brand, context, ...value }, { signal }) }),
    ];
}

/** Existing lifecycle schemas own inputs; stage mutations require a fresh exact owner card.
 * O(1) declarations and one bounded service operation per call. No lead store is created here. */
function leadDefinitions(required: { leads?: LeadsService }): OmToolDefinition[] {
    const leads = required.leads;
    if (!leads) return [];
    return [
        serviceDefinition({ name: 'om_leads_list', capability: 'Lead inbox', policy: 'read', schema: leadListInputSchema.omit({ context: true }),
            invoke: ({ context, value, signal }) => leads.list({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_leads_get', capability: 'Lead detail', policy: 'read', schema: leadGetInputSchema.omit({ context: true }),
            invoke: ({ context, value, signal }) => leads.get({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_leads_history', capability: 'Lead stage history', policy: 'read', schema: leadHistoryInputSchema.omit({ context: true }),
            invoke: ({ context, value, signal }) => leads.history({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_leads_set_stage', capability: 'Lead stage change', policy: 'write', ownerOnly: true, ownerRoute: 'setLeadStage',
            schema: leadStageInputSchema.omit({ context: true }),
            invoke: ({ context, value, signal }) => leads.setStage({ context, ...value }, { signal }) }),
    ];
}

/** Existing owner services supply history/run control. Cancellation may end the calling run
 * before its tool result returns; run events, rather than a completion claim, are the evidence.
 * @complexity O(1) service calls; events are capped at 128 by the owning service.
 */
function assistantDefinitions(required: { services: OwnerServices }): OmToolDefinition[] {
    const services = required.services;
    const run = z.strictObject({ runId: idSchema });
    return [
        serviceDefinition({ name: 'om_conversations_create', capability: 'Create conversation', policy: 'write', schema: z.strictObject({}), ownerRoute: 'createConversation',
            invoke: async ({ context }) => services.conversations?.create({ context }) ?? localFailure({ message: 'Conversation storage unavailable' }) }),
        serviceDefinition({ name: 'om_runs_events', capability: 'Run events; continue after the last returned sequence', policy: 'read', schema: run.extend({ after: z.number().int().nonnegative().safe() }), ownerRoute: 'runEvents',
            invoke: async ({ context, value }) => runEventsOutput({ outcome: await (services.runs?.events({ context, ...value }) ?? localFailure({ message: 'Run storage unavailable' })) }) }),
        serviceDefinition({ name: 'om_runs_cancel', capability: 'Cancel run; self-cancellation can end this turn before a result returns', policy: 'write', schema: run, ownerRoute: 'cancelRun',
            invoke: async ({ context, value }) => services.runs?.cancel({ context, ...value }) ?? localFailure({ message: 'Run control unavailable' }) }),
    ];
}

/** Keep a contiguous event prefix within the tool envelope, preserving sequence cursors.
 * An individually oversized event fails explicitly; no event is silently skipped or altered.
 * @complexity O(event bytes), <=128 events; O(64 KiB) output and no further I/O.
 */
function runEventsOutput(required: { outcome: Outcome<z.infer<typeof routes.runEvents.schema>> }): Outcome<unknown> {
    if (!required.outcome.ok) return required.outcome;
    const page = required.outcome.value;
    const events: typeof page.events = [];
    let bytes = 0;
    for (const event of page.events) {
        bytes += Buffer.byteLength(JSON.stringify(event)) + 1;
        if (bytes > 60000) break;
        events.push(event);
    }
    if (page.events.length && !events.length) return localFailure({ code: 'limit_exceeded', message: 'Run event exceeds the tool output bound' });
    return { ok: true, value: { ...page, events, status: events.length < page.events.length ? 'running' : page.status } };
}

/** Four thin wrappers over the injected public MediaLibrary; absent composition advertises no
 * callable media stubs. Provenance success is a JSON receipt instead of Outcome<void>.
 * @complexity O(1) calls; inputs and dispatcher outputs are bounded to 64 KiB.
 */
function mediaDefinitions(required: { media?: MediaLibrary }): OmToolDefinition[] {
    const media = required.media;
    if (!media) return [];
    return [
        serviceDefinition({ name: 'om_media_list', capability: 'Media list', policy: 'read', schema: pageQuerySchema.extend({ limit: z.number().int().min(1).max(5) }),
            invoke: ({ context, value: query, signal }) => media.list({ context, query }, { signal }) }),
        serviceDefinition({ name: 'om_media_import', capability: 'Import media with rights and expected digest', policy: 'write', schema: z.strictObject({ request: assetImportRequestSchema }),
            invoke: ({ context, value, signal }) => media.importAsset({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_media_crop', capability: 'Non-destructive media placement crop', policy: 'write', schema: z.strictObject({ request: placementCropRequestSchema }),
            invoke: ({ context, value, signal }) => media.createCrop({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_media_record_provenance', capability: 'Append media provenance', policy: 'write', schema: z.strictObject({ link: provenanceLinkSchema }),
            invoke: async ({ context, value, signal }) => {
                const result = await media.recordProvenance({ context, ...value }, { signal });
                return result.ok ? { ok: true, value: { recorded: true, operationId: value.link.provenance.operationId } } : result;
            } }),
    ];
}

/** Repository-owned safety operations are available in the existing boot. Halt records local
 * authority first and reports remote pending; it never fabricates an unbound backend stop.
 */
function coreDefinitions(required: { services: OwnerServices }): OmToolDefinition[] {
    const services = required.services;
    const empty = z.strictObject({});
    const account = z.strictObject({ accountId: idSchema });
    return [
        serviceDefinition({ name: 'om_workspace_current', capability: 'Workspace current', schema: empty, policy: 'read',
            invoke: async ({ context }) => ({ ok: true, value: context.scope }) }),
        serviceDefinition({ name: 'om_measure_experiment_sample_size', capability: 'Approximate A/B sample size; fixed 5% two-sided error, 80% power and absolute lift', schema: sampleSizeInputSchema, policy: 'read',
            invoke: async ({ value }) => calculateExperimentSampleSize(value) }),
        serviceDefinition({ name: 'om_measure_experiment_readout', capability: 'A/B qualified-lead readout from caller-supplied randomized assignment, completed observation including lag, and guardrail evidence; CPL goal is separate', schema: abReadoutInputSchema, policy: 'read',
            invoke: async ({ value }) => readExperiment(value) }),
        serviceDefinition({ name: 'om_measure_creative_fatigue', capability: 'Descriptive creative trends from comparable whole periods; unchanged setup includes creative, audience, placement, objective and timezone; no causal verdict', schema: creativeFatigueInputSchema, policy: 'read',
            invoke: async ({ value }) => calculateCreativeFatigue(value) }),
        serviceDefinition({ name: 'om_safety_status', capability: 'Safety status', schema: account, policy: 'read',
            invoke: ({ context, value, signal }) => services.safety.snapshot({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_allowance_get', capability: 'Generation allowance settings', schema: empty, policy: 'read',
            invoke: ({ context, signal }) => services.safety.getGenerationAllowance({ context }, { signal }) }),
        serviceDefinition({ name: 'om_allowance_set', capability: 'Generation allowance setting', schema: generationAllowanceSettingsSchema, policy: 'write', ownerOnly: true,
            invoke: ({ context, value: settings, signal }) => services.safety.setGenerationAllowance({ context, settings }, { signal }) }),
        serviceDefinition({ name: 'om_halt_account', capability: 'Local account halt', schema: account, policy: 'write', ownerOnly: true, ownerRoute: 'halt',
            invoke: ({ context, value, signal }) => services.safety.halt({ context, adAccountId: value.accountId }, { signal }) }),
    ];
}

const identifierInput = z.strictObject({ kind: z.enum(['email', 'phone', 'external_customer_id', 'fbclid', 'fbc', 'fbp', 'gclid', 'gbraid', 'wbraid']), raw: z.string().min(1).max(2048) });
/** Bind contacts without reimplementing canonicalization, merge lineage or erasure suppression. */
function contactDefinitions(required: { contacts: ContactService }): OmToolDefinition[] {
    const service = required.contacts;
    return [
        serviceDefinition({ name: 'om_contacts_resolve', capability: 'Contact resolve', policy: 'read', schema: z.strictObject({ identifier: identifierInput }),
            invoke: async ({ context, value, signal }) => contactOutput({ outcome: await service.resolve({ context, ...value }, { signal }) }) }),
        serviceDefinition({ name: 'om_contacts_upsert', capability: 'Contact upsert', policy: 'write', schema: z.strictObject({ identifiers: identifierInput.array().min(1).max(20), timezone: z.string().min(1).max(100).optional() }),
            invoke: async ({ context, value, signal }) => contactOutput({ outcome: await service.upsert({ context, ...value }, { signal }) }) }),
        serviceDefinition({ name: 'om_contacts_merge', capability: 'Contact merge', policy: 'destructive', schema: z.strictObject({ sourceSubjectId: idSchema, targetSubjectId: idSchema }),
            invoke: async ({ context, value, signal }) => contactOutput({ outcome: await service.merge({ context, ...value }, { signal }) }) }),
    ];
}
/** Contacts' optional timezone is deliberately omitted on the wire when absent. Other invalid
 * values still fail the dispatcher's bounded JSON guard; no generic undefined stripping occurs.
 */
function contactOutput(required: { outcome: Outcome<Subject> }): Outcome<Subject> {
    if (!required.outcome.ok) return required.outcome;
    const { timezone, ...subject } = required.outcome.value;
    return { ok: true, value: timezone === undefined ? subject : { ...subject, timezone } };
}

/** Forms owns authored publication validation, including field and consent invariants. */
function formDefinitions(required: { forms: FormsService }): OmToolDefinition[] {
    const service = required.forms;
    return [
        serviceDefinition({ name: 'om_forms_publish', capability: 'Form publish', policy: 'write', schema: z.strictObject({ publication: publicationSchema.omit({ scope: true }) }),
            invoke: ({ context, value, signal }) => service.publish({ context, publication: { ...value.publication, scope: context.scope } }, { signal }) }),
        serviceDefinition({ name: 'om_forms_preview', capability: 'Form preview', policy: 'read', schema: z.strictObject({ slug: idSchema }),
            invoke: ({ context, value, signal }) => service.renderHostedForm({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_forms_submissions', capability: 'Form submissions', policy: 'read', schema: z.strictObject({ publicationId: idSchema, page: pageQuerySchema }),
            invoke: ({ context, value, signal }) => service.listSubmissions({ context, ...value }, { signal }) }),
    ];
}
/** Visit tokens remain bounded; owning web-events service verifies their scope/expiry and subject. */
function webEventDefinitions(required: { webEvents: WebEventService }): OmToolDefinition[] {
    const service = required.webEvents;
    return [
        serviceDefinition({ name: 'om_web_events_touches', capability: 'Attribution touches', policy: 'read', schema: z.strictObject({ subjectId: idSchema, window: timeWindowSchema, limit: z.number().int().min(1).max(100) }),
            invoke: ({ context, value, signal }) => service.touchesFor({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_web_events_bind_visitor', capability: 'Visitor binding', policy: 'write', schema: z.strictObject({ visitToken: z.string().min(1).max(4096), subjectId: idSchema }),
            invoke: ({ context, value, signal }) => service.bindVisitor({ context, ...value }, { signal }) }),
    ];
}

/** Setup shares the authenticated tool transport used by CLI and Studio; output is text only. */
function trackingDefinitions(required: { tracking?: OmFeatureServices['tracking'] }): OmToolDefinition[] {
    const service = required.tracking;
    if (!service) return [];
    return [
        serviceDefinition({ name: 'om_web_events_snippet', capability: 'Tracking snippet', schema: trackingSnippetInputSchema, policy: 'read', outputSchema: trackingSnippetOutputSchema,
            invoke: ({ context, value, signal }) => service.snippet({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_tracking_readiness', capability: 'Destination readiness and hosted-form fallback', schema: trackingReadinessInputSchema, policy: 'read', outputSchema: trackingReadinessOutputSchema,
            invoke: ({ context, value, signal }) => service.readiness({ context, ...value }, { signal }) }),
    ];
}
/** Grant changes use the single owner-only exact-card path across HTTP, CLI and assistant.
 * @complexity O(1) declarations; one schema-bound service call per invocation. */
function measurementGrantDefinitions(required: { grants?: OmFeatureServices['measurementGrants'] }): OmToolDefinition[] {
    const service = required.grants;
    if (!service) return [];
    return [
        serviceDefinition({ name: 'om_measure_grants_list', capability: 'Measurement grants list', policy: 'read', schema: pageQuerySchema,
            invoke: ({ context, value: query, signal }) => service.list({ context, query }, { signal }) }),
        serviceDefinition({ name: 'om_measure_grant', capability: 'Grant conversion sharing', policy: 'write', ownerOnly: true, schema: grantFieldsSchema,
            invoke: ({ context, value: grant, signal }) => service.grant({ context, grant }, { signal }) }),
        serviceDefinition({ name: 'om_measure_revoke_grant', capability: 'Revoke conversion sharing', policy: 'write', ownerOnly: true, schema: z.strictObject({ grantId: idSchema }),
            invoke: ({ context, value, signal }) => service.revoke({ context, ...value }, { signal }) }),
    ];
}
/** Results and refresh share the existing tool transport and jobs outbox.
 * Refresh is a normal write, without spend authority or a plugin-specific gate.
 * @complexity O(1) declarations; one bounded service call per invocation.
 */
function reportingDefinitions(required: { reporting?: OmFeatureServices['reporting'] }): OmToolDefinition[] {
    const service = required.reporting;
    if (!service) return [];
    return [
        serviceDefinition({ name: 'om_measure_results', capability: 'Per-campaign results', policy: 'read',
            schema: z.strictObject({ query: campaignResultsQuerySchema }), outputSchema: campaignResultsSchema,
            invoke: ({ context, value, signal }) => service.results({ context, query: value.query }, { signal }) }),
        serviceDefinition({ name: 'om_measure_refresh', capability: 'Refresh campaign results', policy: 'write',
            schema: z.strictObject({ syncId: metricSyncRequestSchema.shape.syncId, query: campaignResultsQuerySchema }),
            invoke: ({ context, value: { syncId, query }, signal }) => service.enqueue({ context, request: { syncId,
                pluginId: query.pluginId, connectionId: query.connectionId, accountId: query.accountId,
                input: { grain: 'campaign', days: query.days } } }, { signal }) }),
    ];
}
/** Privacy request blocks further processing; advance remains its server worker's responsibility. */
function privacyDefinitions(required: { privacy: PrivacyService }): OmToolDefinition[] {
    const service = required.privacy;
    return [
        serviceDefinition({ name: 'om_privacy_request_erasure', capability: 'Privacy erasure request', policy: 'destructive', schema: z.strictObject({ subjectId: idSchema }),
            invoke: ({ context, value, signal }) => service.requestErasure({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_privacy_status', capability: 'Privacy erasure status', policy: 'read', schema: z.strictObject({ requestId: idSchema }),
            invoke: ({ context, value, signal }) => service.status({ context, ...value }, { signal }) }),
    ];
}
/** Conversion ingestion/delivery stay typed verified-source/server jobs, never arbitrary agent inputs. */
function measureDefinitions(required: { measure: MeasureService }): OmToolDefinition[] {
    const service = required.measure;
    return [
        serviceDefinition({ name: 'om_measure_create_link', capability: 'Tracked link creation', policy: 'write', schema: z.strictObject({ destinationUrl: z.url().max(2048), campaignId: idSchema, utm: z.record(idSchema, z.string().max(1024)).refine(value => Object.keys(value).length <= 10) }),
            invoke: ({ context, value: request, signal }) => service.createTrackedLink({ context, request }, { signal }) }),
        serviceDefinition({ name: 'om_measure_report_cac', capability: 'CAC reporting (local sandbox-account fixtures)', policy: 'read', schema: z.strictObject({ definitionId: idSchema, accountId: idSchema, attributionWindow: idSchema, window: timeWindowSchema, currency: z.string().length(3), timezone: idSchema, attributionModel: idSchema }),
            invoke: ({ context, value: query, signal }) => service.reportCac({ context, query }, { signal }) }),
    ];
}
/** Paused creation and launch proposal use owning campaign workflows. Launch requires the
 * verified safety/outbox binding (I-2), so no second generic card wraps its existing approval.
 */
function campaignDefinitions(required: { campaignWorkflow: CampaignService }): OmToolDefinition[] {
    const service = required.campaignWorkflow;
    return [
        serviceDefinition({ name: 'om_campaign_save_local', capability: 'Neutral campaign local draft', policy: 'write', schema: neutralCampaignLaunchSchema,
            invoke: ({ context, value: campaign, signal }) => service.saveLocal({ context, campaign }, { signal }) }),
        serviceDefinition({ name: 'om_campaign_get_local', capability: 'Neutral campaign draft lookup', policy: 'read', schema: z.strictObject({ campaignId: idSchema }),
            invoke: ({ context, value, signal }) => service.getLocal({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_campaign_create_paused', capability: 'Paused/draft campaign creation (local sandbox-account / sandbox-campaigns / sandbox-creative)', policy: 'write', schema: z.strictObject({ operationId: idSchema, connectionId: idSchema, accountId: idSchema, name: z.string().min(1).max(200), objective: idSchema, creativeIds: idSchema.array().min(1).max(100), creativeDigest: digestSchema, placements: idSchema.array().min(1).max(100) }),
            invoke: ({ context, value: draft, signal }) => service.createPaused({ context, draft }, { signal }) }),
        serviceDefinition({ name: 'om_campaign_propose_launch', capability: 'Launch proposal', policy: 'write', schema: z.strictObject({ campaignId: idSchema, flight: z.strictObject({ window: timeWindowSchema, expectedExposure: moneySchema, timezone: idSchema }) }),
            invoke: ({ context, value, signal }) => service.proposeLaunch({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_campaign_reconcile', capability: 'Campaign reconcile', policy: 'read', schema: z.strictObject({ operationId: idSchema }),
            invoke: ({ context, value, signal }) => service.reconcile({ context, ...value }, { signal }) }),
    ];
}
/** Fixed public service bindings; composition can supply existing instances additively.
 * @complexity O(1) bounded declarations; no service factories, I/O or hidden runtime state.
 */
function featureDefinitions(required: { services: OmFeatureServices }): OmToolDefinition[] {
    const services = required.services;
    const definitions: OmToolDefinition[] = [];
    definitions.push(...brandDefinitions({ brand: services.brand }));
    definitions.push(...leadDefinitions({ leads: services.leads }));
    if (services.creative) definitions.push(...creativeDefinitions({ creative: services.creative }));
    if (services.contacts) definitions.push(...contactDefinitions({ contacts: services.contacts }));
    if (services.forms) definitions.push(...formDefinitions({ forms: services.forms }));
    if (services.webEvents) definitions.push(...webEventDefinitions({ webEvents: services.webEvents }));
    definitions.push(...trackingDefinitions({ tracking: services.tracking }));
    definitions.push(...reportingDefinitions({ reporting: services.reporting }));
    if (services.privacy) definitions.push(...privacyDefinitions({ privacy: services.privacy }));
    if (services.measure) definitions.push(...measureDefinitions({ measure: services.measure }));
    if (services.campaignWorkflow) definitions.push(...campaignDefinitions({ campaignWorkflow: services.campaignWorkflow }));
    if (services.campaignDeployment) definitions.push(services.campaignDeployment);
    if (services.accountBindings) definitions.push(serviceDefinition({ name: 'om_account_binding_get', capability: 'Account binding lookup', policy: 'read', schema: z.strictObject({ externalAccountId: idSchema }),
        invoke: ({ context, value, signal }) => services.accountBindings!.find({ context, ...value }, { signal }) }));
    if (services.audit) definitions.push(serviceDefinition({ name: 'om_audit_list', capability: 'Audit list', policy: 'read', schema: pageQuerySchema.extend({ operationId: idSchema.optional() }),
        invoke: ({ context, value: query, signal }) => services.audit!.list({ context, query }, { signal }) }));
    definitions.push(...scopedDefinitions({ services }));
    return definitions;
}

/** Additive owning APIs expose only scoped read models, pending-job cancellation and settings. */
function scopedDefinitions(required: { services: OmFeatureServices }): OmToolDefinition[] {
    const services = required.services;
    const definitions: OmToolDefinition[] = [];
    const jobId = z.strictObject({ jobId: idSchema });
    if (services.alerts) definitions.push(
        serviceDefinition({ name: 'om_alerts_list', capability: 'Alert feed', policy: 'read', schema: alertQuerySchema,
            invoke: ({ context, value: query }) => services.alerts!.list({ context, query }) }),
        serviceDefinition({ name: 'om_alerts_acknowledge', capability: 'Acknowledge alert', policy: 'write', ownerOnly: true, ownerRoute: 'acknowledgeAlert',
            schema: z.strictObject({ noticeId: idSchema }), outputSchema: routes.acknowledgeAlert.schema,
            invoke: async ({ context, value }) => {
                const result = await services.alerts!.acknowledge({ context, ...value });
                return result.ok ? { ok: true, value: { status: 'acknowledged' } } : result;
            } }));
    if (services.workspaces) definitions.push(serviceDefinition({ name: "om_workspaces_list", capability: "Workspace list", policy: "read", schema: pageQuerySchema,
        invoke: ({ context, value: query, signal }) => services.workspaces!.list({ context, query }, { signal }) }));
    if (services.jobs) definitions.push(
        serviceDefinition({ name: "om_jobs_get", capability: "Job get", policy: "read", schema: jobId,
            invoke: ({ context, value, signal }) => services.jobs!.get({ context, ...value }, { signal }) }),
        serviceDefinition({ name: "om_jobs_list", capability: "Job list", policy: "read", schema: pageQuerySchema,
            invoke: ({ context, value: query, signal }) => services.jobs!.list({ context, query }, { signal }) }),
        serviceDefinition({ name: "om_jobs_cancel", capability: "Job cancel", policy: "write", schema: jobId,
            invoke: ({ context, value, signal }) => services.jobs!.cancel({ context, ...value }, { signal }) }));
    if (services.paidSending) definitions.push(
        serviceDefinition({ name: "om_paid_sending_allowance_get", capability: "Paid-sending allowance get", policy: "read", schema: z.strictObject({}),
            invoke: ({ context, signal }) => services.paidSending!.get({ context }, { signal }) }),
        serviceDefinition({ name: "om_paid_sending_allowance_set", capability: "Paid-sending allowance set", policy: "write", ownerOnly: true, schema: paidSendingAllowanceSchema,
            invoke: ({ context, value: settings, signal }) => services.paidSending!.set({ context, settings }, { signal }) }));
    definitions.push(...measurementGrantDefinitions({ grants: services.measurementGrants }));
    return definitions;
}

/** Queued generation uses the same verified safety/allowance policy as every other financial tool. */
function creativeDefinitions(required: { creative: CreativeToolBinding }): OmToolDefinition[] {
    const binding = required.creative;
    const generationId = z.strictObject({ generationId: idSchema });
    return [
        { name: 'om_creative_generate', capability: 'Creative generation', description: 'Queue a zero-cost local sandbox generation. model is sandbox; this fixture creates durable pending intent. Vendor rendering is I-2.',
            effects: ['generation'], policy: 'generation', revision: '1', inputSchema: toolInputSchema({ schema: creativeToolInputSchema }),
            safety: binding.safety, prepareEffect: binding.prepareEffect, parse: input => parseBoundary({ schema: creativeToolInputSchema, input: input.input }),
            async invoke({ context, input, authorization, permit }) {
                if (!authorization || !permit) return localFailure({ code: 'forbidden', message: 'Generation requires verified dispatch authority' });
                const parsed = parseBoundary({ schema: creativeToolInputSchema, input });
                return parsed.ok ? redactAddonOutcome({ outcome: await binding.generate({ context, input: parsed.value, authorization, permit }) }) : parsed;
            } },
        serviceDefinition({ name: 'om_creative_status', capability: 'Creative status', policy: 'read', schema: generationId,
            invoke: async ({ context, value, signal }) => creativeStatusOutput({ outcome: await binding.service.refreshJob({ context, ...value }, { signal }) }) }),
        serviceDefinition({ name: 'om_creative_cancel', capability: 'Creative cancellation', policy: 'write', schema: generationId,
            invoke: async ({ context, value, signal }) => creativeStatusOutput({ outcome: await binding.service.cancelGeneration({ context, ...value }, { signal }) }) }),
    ];
}

/** Deliberately project lifecycle metadata; remote operation errors and state never enter chat. */
function creativeStatusOutput(required: { outcome: Outcome<GenerationStatus> }): Outcome<unknown> {
    if (!required.outcome.ok) return redactAddonOutcome(required);
    const status = required.outcome.value;
    return { ok: true, value: { generationId: status.generationId, state: status.state, dispatchState: status.dispatchState,
        asyncOperationId: status.asyncOperationId, assetIds: status.assetIds, actualCost: status.actualCost } };
}

const addonRoutes = { addons_list: 'addons', addons_install: 'addonInstall', addons_set_enabled: 'addonSetEnabled',
    addons_uninstall: 'addonUninstall', integrations_list: 'integrations', integrations_disconnect: 'integrationDisconnect',
    integrations_plugin_secret_status: 'integrationPluginSecretStatus',
    integrations_oauth_start: 'integrationOAuthStart', integrations_oauth_status: 'integrationOAuthStatus' } as const;
/** D2 owns installation/lifecycle and credential custody; all management calls use its one seam.
 * After dispatcher admission, only secret-free integration listing uses trusted service identity;
 * the verified scope and trace IDs survive, while mutations retain the caller's identity.
 */
function addonDefinitions(required: { dependencies: AddonToolDependencies }): OmToolDefinition[] {
    return [...addonManagementTools, ...integrationOAuthTools].map(tool => {
        const name = tool.name as keyof typeof addonToolSchemas;
        const schema: z.ZodType = addonToolSchemas[name];
        return { ...tool, effects: addonToolEffectsSchema.parse(tool.effects), inputSchema: toolDescriptorSchema.shape.inputSchema.parse(tool.inputSchema), revision: '1',
            capability: 'Add-on management: ' + name, policy: toolPolicy({ effects: tool.effects }), ownerRoute: addonRoutes[name],
            parse: input => parseBoundary({ schema, input: input.input }),
            invoke: async input => {
                // Dispatcher verified current caller authority. Only this secret-free summary read
                // uses trusted server identity, preserving the verified scope and trace IDs.
                const context: CallContext = name === 'integrations_list'
                    ? { ...input.context, principal: { kind: 'service', serviceId: 'integration-summary' } } : input.context;
                return redactAddonOutcome({ outcome: await invokeAddonManagementTool({ ...input, context, name, dependencies: required.dependencies }, { signal: input.signal }) });
            } };
    });
}
/** Third-party messages never reach addonBoundary's schema-valid failure passthrough.
 * Keep the parsed OM code and retry flag, replacing all content with an OM-owned message.
 */
function redactAddonOutcome<T>(required: { outcome: Outcome<T> }): Outcome<T> {
    if (required.outcome.ok) return required.outcome;
    return { ok: false, error: { code: required.outcome.error.code, retryable: required.outcome.error.retryable,
        message: 'Add-on operation failed. Check its current installation/connection state before another attempt.' } };
}
