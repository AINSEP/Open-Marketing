/** Caller-owned contacts/policy/measure seams; one injected transaction owner per operation. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { idSchema, epochSchema } from '@open-marketing/contracts';
import type { CallContext, CallOptions, CampaignKey, ClockPort, IdPort, ObserverPort, Outcome, ServiceContext, UnitOfWork } from '@open-marketing/contracts';
import { createContactService, createSqlContactRepo, destinationIdentifierHash } from '@open-marketing/contacts';
import { createPolicyService, createSqlPolicyRepo, type PolicyService, type SubjectPolicy } from '@open-marketing/policy';
import { createSqlWebEventRepo, createWebEventService, landingPropertiesSchema, type ObservedCampaignPort, type Visit, type VisitTokenPort, type WebEventService } from '@open-marketing/web-events';
import type { ConversionIdentifiersPort, AttributionTouchPort, MetricsRepoPort } from '@open-marketing/measure';
import type { AccountBindingLookupPort } from '@open-marketing/workspaces';
import type { AgentPluginState } from './agent-plugin-backends.js';
import { localFailure } from './local-auth.js';
import type { createSubjectLane } from './subject-lane.js';

/** Persisted owner secret supplies domain-separated local keys, never destination hashes.
 * @example localKey({ ownerToken, domain: 'visits' }); @complexity O(1). */
export function localKey(required: { ownerToken: string; domain: 'visits' | 'contacts' }): Buffer {
    return createHmac('sha256', required.ownerToken).update('om.local.' + required.domain + '.v1').digest();
}
const tokenPayload = z.strictObject({ workspaceId: z.uuid(), visitId: idSchema, exp: epochSchema });
const landingPropertyKeys = Object.keys(landingPropertiesSchema.shape);

/** HMAC visit tokens have no authority/session store. Scope and expiry are checked on every use.
 * A visit's anonymous ID equals its server-issued visit ID; stored binding remains web-events-owned.
 * @complexity O(b), b <=1024 token bytes; no I/O. */
export function createVisitTokens(required: { key: Uint8Array; clock: ClockPort; ids: IdPort }) {
    const tokens: VisitTokenPort = { async verify(input) {
        try {
            const token = z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/).parse(input.visitToken);
            const [body, signature] = token.split('.');
            const expected = createHmac('sha256', required.key).update(body).digest();
            if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return localFailure({ code: 'forbidden', message: 'Invalid visit token' });
            const payload = tokenPayload.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')));
            if (payload.workspaceId !== input.context.scope.workspaceId || payload.exp <= required.clock.now({})) return localFailure({ code: 'forbidden', message: 'Expired or foreign visit token' });
            return { ok: true, value: { scope: input.context.scope, visitId: payload.visitId, anonymousId: payload.visitId, subjectId: null, expiresAt: payload.exp } };
        } catch { return localFailure({ code: 'forbidden', message: 'Invalid visit token' }); }
    } };
    return { tokens, issue(input: { context: CallContext }): { visit: Visit; token: string } {
        const payload = tokenPayload.parse({ workspaceId: input.context.scope.workspaceId, visitId: required.ids.next({}), exp: required.clock.now({}) + 3600000 });
        const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
        return { token: body + '.' + createHmac('sha256', required.key).update(body).digest('hex'),
            visit: { scope: input.context.scope, visitId: payload.visitId, anonymousId: payload.visitId, subjectId: null, expiresAt: payload.exp } };
    } };
}

/** Canonical identity always follows contacts pointers. Policy snapshots never use its legacy identity table.
 * Sharing is denied locally, even with captured consent; this sandbox has no delivery authority.
 * @example bindIdentity({ unit, clock, ids, observer, digestKey, tokens, subjectLane });
 * @complexity Bounded owning repository work, no cross-feature SQL. */
export function bindIdentity(required: { unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; digestKey: Uint8Array; tokens: VisitTokenPort; subjectLane: ReturnType<typeof createSubjectLane> }, optional?: { observedCampaigns: ObservedCampaignPort }) {
    const contactsRepo = createSqlContactRepo({ uow: required.unit });
    const evidence = createPolicyService({ repo: createSqlPolicyRepo({ pool: required.unit, observer: required.observer }), clock: required.clock }, { observer: required.observer });
    // Borrowed SqlSessions already belong to a caller holding the lane; never reacquire inside SQLite.
    const policy: PolicyService = { appendEvidence: (request, options) => {
        const input = structuredClone(request);
        return 'query' in required.unit ? evidence.appendEvidence(input, options)
            : required.subjectLane.run({ context: input.context, subjectIds: [input.evidence.subjectId], work: () => evidence.appendEvidence(input, options) }, options);
    }, async snapshot(input, options) {
        const root = await contactsRepo.get({ context: input.context, subjectId: input.subjectId }, options);
        if (!root.ok) return root;
        if (!root.value) return localFailure({ message: 'Canonical subject unavailable' });
        const subjectIds = [...new Set([root.value.subjectId, ...root.value.lineage.map(item => item.sourceSubjectId)])];
        if (subjectIds.length > 100) return localFailure({ code: 'limit_exceeded', message: 'Policy identity lineage exceeds local bound' });
        const consents: SubjectPolicy['consents'][number][] = [];
        const suppressions: SubjectPolicy['suppressions'][number][] = [];
        for (const subjectId of subjectIds) {
            const snapshot = await evidence.snapshot({ context: input.context, subjectId }, options);
            if (!snapshot.ok) return snapshot;
            consents.push(...snapshot.value.consents);
            suppressions.push(...snapshot.value.suppressions);
        }
        return { ok: true, value: { consents, suppressions, holdout: false } };
    } };
    const contacts = createContactService({ repo: contactsRepo, clock: required.clock, ids: required.ids,
        digest: { activeKeyVersion: 'local-v1', keys: { 'local-v1': required.digestKey } },
        suppression: { async assess() { return { ok: true, value: { allowed: false } }; } } });
    const webRepo = createSqlWebEventRepo({ pool: required.unit, clock: required.clock });
    const webEvents = createWebEventService({ repo: webRepo, clock: required.clock, ids: required.ids, tokens: required.tokens,
        observedCampaigns: optional?.observedCampaigns ?? { async observed() { return { ok: true, value: [] }; } },
        collectionAuthority: { async assess(input) {
            const basic = Object.keys(input.event.properties).every(key => landingPropertyKeys.includes(key));
            return { ok: true, value: { allowed: basic && input.event.subjectId === undefined } };
        } } });
    const identifiers: ConversionIdentifiersPort = { async identifiersFor(input, options) {
        const found = await contacts.identifiersFor(input, options);
        return found.ok ? { ok: true, value: await withWebsiteContext({ webEvents, clock: required.clock, context: input.context, found: found.value }, options) } : found;
    } };
    const touches: AttributionTouchPort = { async touchesFor(input, options) {
        const result = await webEvents.touchesFor(input, options);
        return result.ok ? { ok: true, value: result.value.map(({ touchId, occurredAt, linkId, campaignId }) => ({ touchId, occurredAt, linkId, campaignId })) } : result;
    } };
    return { contactsRepo, contacts: { ...contacts, merge: (request: Parameters<typeof contacts.merge>[0], options?: Parameters<typeof contacts.merge>[1]) => {
        const input = structuredClone(request);
        return 'query' in required.unit ? contacts.merge(input, options) : required.subjectLane.run({ context: input.context, subjectIds: [input.sourceSubjectId, input.targetSubjectId], work: () => contacts.merge(input, options) }, options);
    } }, policy, webRepo, webEvents, identifiers, touches,
        forTransaction: (input: { unit: UnitOfWork }): { policy: PolicyService; contactsRepo: typeof contactsRepo } => bindIdentity({ ...required, unit: input.unit }) };
}

type FoundIdentifiers = { subjectId: string; identifiers: Readonly<Record<string, string>>; identifierDigests: Readonly<Record<string, string>> };
/** The newest consented touch in 30 days carrying the user-agent/page-URL pair adds both identifiers and digests.
 * No such touch, or an unreadable one, adds nothing; contacts' own denial/failure paths are unchanged.
 * @complexity One <=10-touch read; O(1) hashing. */
export async function withWebsiteContext(required: { webEvents: Pick<WebEventService, 'touchesFor'>; clock: ClockPort; context: ServiceContext; found: FoundIdentifiers }, options?: CallOptions): Promise<FoundIdentifiers> {
    const { context, found } = required;
    const now = required.clock.now({});
    const touches = await required.webEvents.touchesFor({ context: { scope: context.scope, principal: { kind: 'service', serviceId: context.serviceId }, correlationId: context.correlationId, traceId: context.traceId },
        subjectId: found.subjectId, window: { start: Math.max(0, now - 30 * 86400000), end: now + 1 }, limit: 10 }, options);
    const pair = touches.ok ? touches.value.find(touch => touch.clickIdentifiers.client_user_agent && touch.clickIdentifiers.event_source_url)?.clickIdentifiers : undefined;
    if (!pair) return found;
    const agent = destinationIdentifierHash({ normalizedValue: pair.client_user_agent });
    const url = destinationIdentifierHash({ normalizedValue: pair.event_source_url });
    if (!agent.ok || !url.ok) return found;
    return { subjectId: found.subjectId, identifiers: { ...found.identifiers, client_user_agent: pair.client_user_agent, event_source_url: pair.event_source_url },
        identifierDigests: { ...found.identifierDigests, client_user_agent: agent.value, event_source_url: url.value } };
}

type MembershipDependencies = { metrics: Pick<MetricsRepoPort, 'observedCampaigns'>; accounts: AccountBindingLookupPort;
    state(input: { context: CallContext; pluginId: string }): Promise<Pick<AgentPluginState, 'admitted' | 'enabled'> | null> };

/** Current admission and scoped account ownership precede historical membership; no credentials.
 * @example observedCampaignMembership({ metrics: reporting.repo, state, accounts }).observed({ context, keys })
 * @complexity O(keys) sequential admission/binding reads, then one bounded metrics batch (<=100 keys).
 */
export function observedCampaignMembership(required: MembershipDependencies): ObservedCampaignPort {
    return { async observed(input, options) {
        const keys: CampaignKey[] = [];
        for (const key of input.keys) {
            const allowed = await admittedCampaign({ ...required, context: input.context, key }, options);
            if (!allowed.ok) return allowed;
            if (allowed.value) keys.push(key);
        }
        if (keys.length === 0) return { ok: true, value: [] };
        return required.metrics.observedCampaigns({ context: input.context, keys }, options);
    } };
}

/** Missing/foreign bindings and disabled plugins cannot turn visitor claims into attribution. */
async function admittedCampaign(required: MembershipDependencies & { context: CallContext; key: CampaignKey }, options?: CallOptions): Promise<Outcome<boolean>> {
    const state = await required.state({ context: required.context, pluginId: required.key.pluginId });
    if (!state?.admitted || !state.enabled) return { ok: true, value: false };
    const found = await required.accounts.find({ context: required.context, externalAccountId: required.key.accountId }, options);
    if (!found.ok) return found;
    const binding = found.value;
    return { ok: true, value: binding !== null && binding.externalAccountId === required.key.accountId
        && binding.scope.ownerId === required.context.scope.ownerId && binding.scope.workspaceId === required.context.scope.workspaceId };
}

/** Durable erasure barrier is ordinary policy suppression evidence, with no second authority store. */
export async function processingAllowed(required: { policy: PolicyService; context: CallContext; subjectId: string }): Promise<Outcome<boolean>> {
    const snapshot = await required.policy.snapshot({ context: required.context, subjectId: required.subjectId });
    return snapshot.ok ? { ok: true, value: !snapshot.value.suppressions.some(item => item.channel === 'om.processing') } : snapshot;
}
