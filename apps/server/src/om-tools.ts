/** One OM catalog and dispatcher. SDK/HTTP adapters share these exact operations. */
import { z } from 'zod';
import { oauthStartSchema, oauthStatusQuerySchema } from './integration-oauth-contracts.js';
import { buildUiToolDefinitions } from './ui-tools.js';
import { assistantSettingsSchema, boundedJsonSchema, callContextSchema, generationAllowanceSettingsSchema, idSchema, pageQuerySchema, timeWindowSchema, digestSchema, moneySchema,
    parseBoundary, toolCallSchema, toolDescriptorSchema, toolSearchSchema, addonToolEffectsSchema, addonListRequestSchema, installAddonSchema, setAddonEnabledSchema, uninstallAddonSchema, disconnectIntegrationSchema } from '@open-marketing/contracts';
import type { ApprovalResponse, CallContext, ClockPort, ConfirmationCard, Outcome, ToolCall, ToolDescriptor, ToolOperation, ToolResult } from '@open-marketing/contracts';
import { digestArguments } from '@open-marketing/safety';
import type { DispatchPermit, EffectRequest, FrozenDispatchRequest, ConfirmationExchangePort, SafetyService } from '@open-marketing/safety';
import { addonManagementTools, integrationOAuthTools, loadAddonToolSources, invokeAddonManagementTool, invokeAddonTool } from './addon-tools.js';
import type { AddonToolDependencies } from './addon-tools.js';
import { addonBoundary } from './addons.js';
import type { ObserverPort } from '@open-marketing/contracts';
import { handleOwnerRequest } from './inbound/owner.js';
import type { OwnerServices } from './inbound/owner.js';
import { routes } from './cli/http.js';
import { localFailure } from './composition/local-auth.js';
import type { ContactService, Subject } from '@open-marketing/contacts';
import { publicationSchema } from '@open-marketing/forms';
import type { FormsService } from '@open-marketing/forms';
import { webEventSnippetSource } from '@open-marketing/web-events';
import type { WebEventService } from '@open-marketing/web-events';
import type { PrivacyService } from '@open-marketing/privacy';
import type { MeasureService } from '@open-marketing/measure';
import { neutralCampaignLaunchSchema, type CampaignService } from '@open-marketing/campaigns';
import type { AccountBindingLookupPort, WorkspaceListing } from '@open-marketing/workspaces';
import type { ScopedJobs } from '@open-marketing/jobs';
import { paidSendingAllowanceSchema } from '@open-marketing/safety';
import type { PaidSendingAllowances } from '@open-marketing/safety';
import type { AuditService } from '@open-marketing/audit';
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
        input.operation.state = { status: 'unknown', operationId: input.operation.call.operationId,
            error: { code: 'unavailable', message: 'Operation persistence failed; reconcile before retrying', retryable: false } };
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
        if (operation.executing) operation.state = { status: 'unknown', operationId: operation.call.operationId,
            error: { code: 'unavailable', message: 'Dispatch interrupted by restart; reconcile before retrying', retryable: false } };
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
            ? { status: 'unknown', operationId: operation.call.operationId, error: { code: 'cancelled', message: 'Dispatch interrupted; reconcile the outcome before retrying', retryable: false } }
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
            const parsed = result.ok ? parseBoundary({ schema: boundedJsonSchema, input: result.value }) : result;
            operation.state = parsed.ok ? { status: 'completed', operationId: operation.call.operationId, output: parsed.value }
                : { status: 'unknown', operationId: operation.call.operationId, error: { ...parsed.error, retryable: false } };
        } catch {
            if (operation.state.status !== 'pending') return;
            operation.state = { status: 'unknown', operationId: operation.call.operationId,
                error: { code: 'unavailable', message: 'Tool outcome unknown; reconcile before another attempt', retryable: false } };
        } finally { await persist({ operation }); operation.executing = false; }
    }
    /** Financial classification uses the owning service's verified quote and current allowance.
     * The binding must review the same tool/input/operation; no model-supplied cost is trusted.
     * @complexity O(payload) time/space, bounded to the existing 64 KiB operation contract.
     */
    async function prepareFinancial(input: { operation: Operation; definition: OmToolDefinition }): Promise<Outcome<void>> {
        const { operation } = input;
        if (operation.policy !== 'spend' && operation.policy !== 'generation') return { ok: true, value: undefined };
        try { return await verifiedFinancialRequest(input); }
        catch { return localFailure({ code: 'protocol_mismatch', message: 'Financial binding failed before dispatch; request fresh verified authority' }); }
    }
    /** Validate the binding against frozen tool arguments, then ask the owning quote verifier. */
    async function verifiedFinancialRequest(input: { operation: Operation; definition: OmToolDefinition }): Promise<Outcome<void>> {
        const { operation, definition } = input;
        if (!definition.safety || !definition.prepareEffect) return localFailure({ code: 'not_implemented', message: 'NEEDS I-2: verified safety/backend binding is not connected' });
        const prepared = await definition.prepareEffect({ context: operation.context, call: structuredClone(operation.call) });
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
        const prepared = await prepareFinancial({ operation, definition });
        if (!prepared.ok) {
            if (operation.state.status === 'pending') operation.state = { status: 'unknown', operationId: operation.call.operationId, error: { ...prepared.error, retryable: false } };
            await persist({ operation });
            return prepared;
        }
        if (!(await retain({ operation })).ok) { operation.state = { status: 'unknown', operationId: operation.call.operationId,
            error: { code: 'limit_exceeded', message: 'Prepared financial request exceeds operation retention limit', retryable: false } }; await persist({ operation }); return resultOf({ operation }); }
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
        if (!card.ok) { operation.state = { status: 'unknown', operationId: operation.call.operationId, error: { ...card.error, retryable: false } }; await persist({ operation }); return; }
        if (operation.state.status !== 'pending') { await required.confirmations.revoke({ context: operation.context, cardId: card.value.cardId }); return; }
        operation.classification = card.value.classification;
        operation.card = card.value;
        operation.expiresAt = Math.min(operation.expiresAt, card.value.expiresAt);
        operation.state = { status: 'pending', operationId: operation.call.operationId, cardId: card.value.cardId };
        await persist({ operation });
    }
    async function answer(input: { context: CallContext; response: ApprovalResponse }): Promise<Outcome<void>> {
        const owner = admitted(input);
        if (!owner.ok) return owner;
        if (input.context.principal.kind !== 'owner') return localFailure({ code: 'forbidden', message: 'Only the authenticated owner can answer a card' });
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
    async function confirmAndInvoke(input: { context: CallContext; response: ApprovalResponse; operation: Operation; definition: OmToolDefinition }): Promise<Outcome<void>> {
        const { operation } = input;
        const confirmed = await required.confirmations.confirm({ context: input.context, response: input.response });
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
        answer: input => boundary({ ...input, operation: 'om.tools.answer', run: () => answer(input) }),
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

/** R3 binds existing reads and assistant settings, without introducing feature business logic. */
type ReadBinding = { name: string; capability: string; route: keyof typeof routes;
    schema: z.ZodType<{ id?: string; limit?: number; cursor?: string }> };
const readBindings: readonly ReadBinding[] = [
    { name: 'om_status', capability: 'Server status', route: 'status', schema: z.strictObject({}) },
    { name: 'om_studio_snapshot', capability: 'Studio snapshot', route: 'snapshot', schema: z.strictObject({}) },
    { name: 'om_campaigns_list', capability: 'Campaign list', route: 'campaigns', schema: pageQuerySchema },
    { name: 'om_campaigns_get', capability: 'Campaign read', route: 'campaign', schema: z.strictObject({ id: idSchema }) },
    { name: 'om_approvals_list', capability: 'Scoped pending approvals', route: 'approvals', schema: pageQuerySchema },
    { name: 'om_approvals_get', capability: 'Scoped exact approval', route: 'approval', schema: z.strictObject({ id: idSchema }) },
    { name: 'om_allowance_view', capability: 'Generation allowance view', route: 'allowance', schema: z.strictObject({}) },
    { name: 'om_assistant_settings_get', capability: 'Assistant selection', route: 'assistantSettings', schema: z.strictObject({}) },
];

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

/** Current enabled add-on sources are reloaded on discovery and again at dispatch/continuation.
 * Their unknown effects remain write. Source callbacks use D2's exact invocation seam.
 * A failed package description marks only that source unavailable; catalog-list failures propagate.
 * @complexity Fixed read bindings plus D2's bounded source loading; no second plugin registry.
 */
export async function buildOmToolDefinitions(required: { context: CallContext; services: OwnerServices & OmFeatureServices; addons?: AddonToolDependencies }): Promise<Outcome<readonly OmToolDefinition[]>> {
    const definitions: OmToolDefinition[] = readBindings.map(binding => ownerDefinition({ ...required, binding }));
    definitions.push(ownerSettingsDefinition(required), ...coreDefinitions(required), ...featureDefinitions(required),
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
        policy: toolPolicy({ effects: source.effects }),
        unavailableReason: unavailableSources.has(source.kind + ':' + source.addonId) ? 'Installed add-on unavailable; check its package metadata'
            : ['spend', 'generation', 'internal'].includes(toolPolicy({ effects: source.effects }))
            ? 'NEEDS I-2: add-on source describes contributions; verified financial/typed backend tools are not connected' : undefined, parse: input => parseBoundary({ schema: z.strictObject({ skill: idSchema.optional() }), input: input.input }),
        invoke: async input => redactAddonOutcome({ outcome: await invokeAddonTool({ ...input, sourceId: source.id, revision: source.revision, dependencies: required.addons! }, { signal: input.signal }) }) });
    return { ok: true, value: definitions };
}
function ownerDefinition(required: { services: OwnerServices; binding: ReadBinding }): OmToolDefinition {
    const { binding, services } = required;
    return { name: binding.name, capability: binding.capability, description: binding.capability + '. Returns the existing scoped owner read model; unavailable services return a typed failure.',
        inputSchema: toolInputSchema({ schema: binding.schema }), effects: ['read'], policy: 'read', revision: '1', ownerRoute: binding.route,
        parse: input => parseBoundary({ schema: binding.schema, input: input.input }),
        invoke: async input => {
            const value = binding.schema.parse(input.input);
            const context: CallContext = { ...input.context, principal: { kind: 'owner', ownerId: input.context.scope.ownerId } };
            // Only named read projections use owner identity; no agent-supplied route or method.
            const request = { method: 'GET' as const, path: routes[binding.route].path.replace(':id', encodeURIComponent(value.id ?? '')),
                query: value.limit === undefined ? {} : { limit: String(value.limit), ...(value.cursor ? { cursor: value.cursor } : {}) } };
            return (await handleOwnerRequest({ context, services, request })).body as Outcome<unknown>;
        } };
}
function ownerSettingsDefinition(required: { services: OwnerServices }): OmToolDefinition {
    return { name: 'om_assistant_settings_set', capability: 'Assistant selection change', description: 'Change Sandbox/Anthropic model selection. Requires the authenticated owner approval; keys never enter this tool.',
        inputSchema: toolInputSchema({ schema: assistantSettingsSchema }), effects: ['write'], policy: 'write', revision: '1', ownerOnly: true, ownerRoute: 'setAssistantSettings',
        parse: input => parseBoundary({ schema: assistantSettingsSchema, input: input.input }),
        invoke: async input => (await handleOwnerRequest({ context: input.context, services: required.services,
            request: { method: 'POST', path: routes.setAssistantSettings.path, body: input.input } })).body as Outcome<unknown> };
}

/** Already-public feature services supplied by composition, never constructed in a catalog module.
 * Missing services produce named coverage NEEDS rather than callable stubs.
 */
export interface OmFeatureServices {
    creative?: CreativeToolBinding;
    contacts?: ContactService;
    forms?: FormsService;
    webEvents?: WebEventService;
    privacy?: PrivacyService;
    measure?: MeasureService;
    campaignWorkflow?: CampaignService;
    campaignDeployment?: OmToolDefinition;
    accountBindings?: AccountBindingLookupPort;
    audit?: AuditService;
    workspaces?: WorkspaceListing;
    jobs?: ScopedJobs;
    paidSending?: PaidSendingAllowances;
}

/** A small schema-bound call to an existing service. The owner identity is projected for named
 * reads only; writes receive the authenticated continuation identity without substitution.
 * @complexity O(input bytes) validation; one injected service call, no dependency construction.
 */
function serviceDefinition<T>(required: { name: string; capability: string; schema: z.ZodType<T>; policy: 'read' | 'write' | 'destructive';
    ownerRoute?: keyof typeof routes; ownerOnly?: true;
    invoke(input: { context: CallContext; value: T; signal?: AbortSignal }): Promise<Outcome<unknown>> }): OmToolDefinition {
    return { name: required.name, capability: required.capability, description: required.capability + '. Returns the scoped service result. Invalid inputs or missing authority fail explicitly.',
        effects: [required.policy], policy: required.policy, revision: '1', ownerRoute: required.ownerRoute, ownerOnly: required.ownerOnly,
        inputSchema: toolInputSchema({ schema: required.schema }), parse: input => parseBoundary({ schema: required.schema, input: input.input }),
        invoke: async input => {
            const parsed = parseBoundary({ schema: required.schema, input: input.input });
            if (!parsed.ok) return parsed;
            const context = required.policy === 'read' ? scopedReadContext(input) : input.context;
            return required.invoke({ context, value: parsed.value, signal: input.signal });
        } };
}
/** Fixed owner read projections share the already-authenticated workspace, retaining run/trace IDs. */
function scopedReadContext(required: { context: CallContext }): CallContext {
    return { ...required.context, principal: { kind: 'owner', ownerId: required.context.scope.ownerId } };
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
        serviceDefinition({ name: 'om_safety_status', capability: 'Safety status', schema: account, policy: 'read',
            invoke: ({ context, value, signal }) => services.safety.snapshot({ context, ...value }, { signal }) }),
        serviceDefinition({ name: 'om_allowance_get', capability: 'Generation allowance settings', schema: empty, policy: 'read',
            invoke: ({ context, signal }) => services.safety.getGenerationAllowance({ context }, { signal }) }),
        serviceDefinition({ name: 'om_allowance_set', capability: 'Generation allowance setting', schema: generationAllowanceSettingsSchema, policy: 'write', ownerOnly: true,
            invoke: ({ context, value: settings, signal }) => services.safety.setGenerationAllowance({ context, settings }, { signal }) }),
        serviceDefinition({ name: 'om_halt_account', capability: 'Local account halt', schema: account, policy: 'write', ownerOnly: true, ownerRoute: 'halt',
            invoke: ({ context, value, signal }) => services.safety.halt({ context, adAccountId: value.accountId }, { signal }) }),
        serviceDefinition({ name: 'om_web_events_snippet', capability: 'Tracking snippet', schema: empty, policy: 'read',
            invoke: async () => webEventSnippetSource({ collectionPath: '/c' }) }),
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
    if (services.creative) definitions.push(...creativeDefinitions({ creative: services.creative }));
    if (services.contacts) definitions.push(...contactDefinitions({ contacts: services.contacts }));
    if (services.forms) definitions.push(...formDefinitions({ forms: services.forms }));
    if (services.webEvents) definitions.push(...webEventDefinitions({ webEvents: services.webEvents }));
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

const addonSchemas = { addons_list: addonListRequestSchema, addons_install: installAddonSchema, addons_set_enabled: setAddonEnabledSchema,
    addons_uninstall: uninstallAddonSchema, integrations_list: pageQuerySchema, integrations_disconnect: disconnectIntegrationSchema,
    integrations_oauth_start: oauthStartSchema, integrations_oauth_status: oauthStatusQuerySchema };
const addonRoutes = { addons_list: 'addons', addons_install: 'addonInstall', addons_set_enabled: 'addonSetEnabled',
    addons_uninstall: 'addonUninstall', integrations_list: 'integrations', integrations_disconnect: 'integrationDisconnect',
    integrations_oauth_start: 'integrationOAuthStart', integrations_oauth_status: 'integrationOAuthStatus' } as const;
/** D2 owns installation/lifecycle and credential custody; all management calls use its one seam. */
function addonDefinitions(required: { dependencies: AddonToolDependencies }): OmToolDefinition[] {
    return [...addonManagementTools, ...integrationOAuthTools].map(tool => {
        const name = tool.name as keyof typeof addonSchemas;
        const schema: z.ZodType = addonSchemas[name];
        return { ...tool, effects: addonToolEffectsSchema.parse(tool.effects), inputSchema: toolDescriptorSchema.shape.inputSchema.parse(tool.inputSchema), revision: '1',
            capability: 'Add-on management: ' + name, policy: toolPolicy({ effects: tool.effects }), ownerRoute: addonRoutes[name],
            parse: input => parseBoundary({ schema, input: input.input }),
            invoke: async input => redactAddonOutcome({ outcome: await invokeAddonManagementTool({ ...input, name, dependencies: required.dependencies }, { signal: input.signal }) }) };
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
