/** Caller-owned contacts/policy/measure seams; one injected transaction owner per operation. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { idSchema, epochSchema } from '@open-marketing/contracts';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createContactService, createSqlContactRepo } from '@open-marketing/contacts';
import { createPolicyService, createSqlPolicyRepo, type PolicyService, type SubjectPolicy } from '@open-marketing/policy';
import { createSqlWebEventRepo, createWebEventService, type Visit, type VisitTokenPort } from '@open-marketing/web-events';
import type { ConversionIdentifiersPort, AttributionTouchPort } from '@open-marketing/measure';
import { localFailure } from './local-auth.js';

/** Persisted owner secret supplies domain-separated local keys, never destination hashes.
 * @example localKey({ ownerToken, domain: 'visits' }); @complexity O(1). */
export function localKey(required: { ownerToken: string; domain: 'visits' | 'contacts' }): Buffer {
    return createHmac('sha256', required.ownerToken).update('om.local.' + required.domain + '.v1').digest();
}
const tokenPayload = z.strictObject({ workspaceId: z.uuid(), visitId: idSchema, exp: epochSchema });

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
 * @example bindIdentity({ unit, clock, ids, observer, digestKey, tokens });
 * @complexity Bounded owning repository work, no cross-feature SQL. */
export function bindIdentity(required: { unit: UnitOfWork; clock: ClockPort; ids: IdPort; observer: ObserverPort; digestKey: Uint8Array; tokens: VisitTokenPort }) {
    const contactsRepo = createSqlContactRepo({ uow: required.unit });
    const evidence = createPolicyService({ repo: createSqlPolicyRepo({ pool: required.unit, observer: required.observer }), clock: required.clock }, { observer: required.observer });
    const policy: PolicyService = { appendEvidence: evidence.appendEvidence, async snapshot(input, options) {
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
        collectionAuthority: { async assess(input) {
            const basic = Object.keys(input.event.properties).every(key => key === 'linkId' || key === 'campaignId');
            return { ok: true, value: { allowed: basic && input.event.subjectId === undefined } };
        } } });
    const identifiers: ConversionIdentifiersPort = { identifiersFor: (input, options) => contacts.identifiersFor(input, options) };
    const touches: AttributionTouchPort = { async touchesFor(input, options) {
        const result = await webEvents.touchesFor(input, options);
        return result.ok ? { ok: true, value: result.value.map(({ touchId, occurredAt, linkId, campaignId }) => ({ touchId, occurredAt, linkId, campaignId })) } : result;
    } };
    return { contactsRepo, contacts, policy, webRepo, webEvents, identifiers, touches };
}

/** Durable erasure barrier is ordinary policy suppression evidence, with no second authority store. */
export async function processingAllowed(required: { policy: PolicyService; context: CallContext; subjectId: string }): Promise<Outcome<boolean>> {
    const snapshot = await required.policy.snapshot({ context: required.context, subjectId: required.subjectId });
    return snapshot.ok ? { ok: true, value: !snapshot.value.suppressions.some(item => item.channel === 'om.processing') } : snapshot;
}
