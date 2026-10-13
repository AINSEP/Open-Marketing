/** Local erasure composition over owning APIs; unavailable removal never unblocks processing. */
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createErasureParticipantRegistry, createPrivacyService, createSqlPrivacyRepo, type ErasureParticipantPort } from '@open-marketing/privacy';
import type { FormSubjectPort } from '@open-marketing/forms';
import type { MeasurePrivacyPort } from '@open-marketing/measure';
import type { bindIdentity } from './identity.js';
import { localFailure } from './local-auth.js';

type Identity = ReturnType<typeof bindIdentity>;
type PhaseInput = Parameters<ErasureParticipantPort['run']>[0];
/** Resolve the whole contacts lineage before erasure; never purge another workspace's subject.
 * @complexity <=1001 subject IDs; owning repository enforces its lineage bound. */
async function subjectIds(required: { identity: Identity; input: PhaseInput }): Promise<Outcome<readonly string[]>> {
    const root = await required.identity.contactsRepo.get({ context: required.input.context, subjectId: required.input.subjectId });
    if (!root.ok) return root;
    if (!root.value) return localFailure({ message: 'Erasure subject unavailable' });
    return { ok: true, value: [...new Set([root.value.subjectId, ...root.value.lineage.map(item => item.sourceSubjectId)])] };
}
/** Local-only participants have no external copies: no vendor/hashed transmission adapter is admitted.
 * At purge, call owning methods sequentially; a failure keeps the durable policy barrier in force.
 * @complexity One bounded lineage reload and <=1001 sequential owning purge calls. */
function localParticipant(required: { id: string; identity: Identity; purge: (input: { context: CallContext; subjectId: string }) => Promise<Outcome<void>> }): ErasureParticipantPort {
    return { id: required.id, async run(input) {
        if (input.phase !== 'purgeLocal') return { ok: true, value: { complete: true, removedCount: 0 } };
        const subjects = await subjectIds({ identity: required.identity, input });
        if (!subjects.ok) return subjects;
        for (const subjectId of subjects.value) {
            const result = await required.purge({ context: input.context, subjectId });
            if (!result.ok) return result;
        }
        return { ok: true, value: { complete: true, removedCount: 0 } };
    } };
}
/** Registry lifetime belongs to the sole server root. Durable suppression blocks before phases;
 * contacts retains HMAC tombstones and privacy retains their IDs/key versions/purpose/topic/reason.
 * No external removal is claimed beyond this fixed local sandbox's data inventory.
 * @example bindPrivacy({ unit, identity, subjects, measure, clock, ids, observer });
 * @complexity Six participants, bounded lineage/digest scans; no cross-feature SQL. */
export function bindPrivacy(required: {
    unit: UnitOfWork; identity: Identity; subjects: FormSubjectPort; measure: MeasurePrivacyPort;
    clock: ClockPort; ids: IdPort; observer: ObserverPort;
}) {
    const participants = createErasureParticipantRegistry({});
    const contacts: ErasureParticipantPort = { id: 'contacts', async run(input) {
        if (input.phase !== 'purgeLocal') return { ok: true, value: { complete: true, removedCount: 0 } };
        const result = await required.identity.contactsRepo.purgeIdentifiers({ context: input.context, subjectId: input.subjectId });
        return result.ok ? { ok: true, value: { complete: true, removedCount: 0 } } : result;
    } };
    const policy: ErasureParticipantPort = { id: 'policy', async run(input) {
        if (input.phase !== 'plan') return { ok: true, value: { complete: true, removedCount: 0 } };
        const identifiers = await required.identity.contactsRepo.identifiersFor({ context: input.context, subjectId: input.subjectId });
        return identifiers.ok ? { ok: true, value: { complete: true, removedCount: 0,
            retainedSuppression: identifiers.value.map(item => ({ identifierDigest: item.identifierDigest, keyVersion: item.keyVersion, purpose: '*', topic: '*', reason: 'erasure' })) } } : identifiers;
    } };
    const jobs: ErasureParticipantPort = { id: 'jobs', async run() {
        // ID-only form jobs cannot revive erased answers/contacts; all other handlers are denied.
        return { ok: true, value: { complete: true, removedCount: 0 } };
    } };
    const inventory = [contacts, policy, jobs,
        localParticipant({ id: 'forms', identity: required.identity, purge: input => required.subjects.purgeSubject(input) }),
        localParticipant({ id: 'web-events', identity: required.identity, purge: input => required.identity.webRepo.purgeSubject(input) }),
        localParticipant({ id: 'measure', identity: required.identity, purge: input => required.measure.purgeSubject(input) }),
    ];
    for (const participant of inventory) {
        const result = participants.register({ participant });
        if (!result.ok) throw new Error('Privacy participant registration failed');
    }
    const privacy = createPrivacyService({ repo: createSqlPrivacyRepo({ unitOfWork: required.unit }), participants, clock: required.clock, ids: required.ids,
        block: { async block(input) {
            const snapshot = await required.identity.policy.snapshot({ context: input.context, subjectId: input.subjectId });
            if (!snapshot.ok) return snapshot;
            if (snapshot.value.suppressions.some(item => item.channel === 'om.processing')) return { ok: true, value: undefined };
            const result = await required.identity.policy.appendEvidence({ context: input.context, evidence: { id: 'privacy.' + input.requestId,
                scope: input.context.scope, subjectId: input.subjectId, sourceId: input.requestId, recordedAt: required.clock.now({}), kind: 'suppression',
                suppression: { channel: 'om.processing', start: 0, end: Number.MAX_SAFE_INTEGER } } });
            return result.ok ? { ok: true, value: undefined } : result;
        } } });
    return { privacy, participants };
}
