/** Local erasure composition over owning APIs; unavailable removal never unblocks processing. */
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, UnitOfWork } from '@open-marketing/contracts';
import { createErasureParticipantRegistry, createPrivacyService, createSqlPrivacyRepo, type ErasureParticipantPort, type PrivacyService } from '@open-marketing/privacy';
import { createSqlJobRepo, jobTenant } from '@open-marketing/jobs';
import type { FormSubjectPort } from '@open-marketing/forms';
import type { MeasurePrivacyPort } from '@open-marketing/measure';
import { createSqlLeadsRepo } from '@open-marketing/leads';
import type { bindIdentity } from './identity.js';
import { localFailure } from './local-auth.js';
import { formRetryPolicy } from './forms.js';
import type { createSubjectLane } from './subject-lane.js';

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
 * @example bindPrivacy({ unit, identity, subjects, measure, clock, ids, observer, subjectLane });
 * @complexity Seven participants, bounded lineage/digest scans; no cross-feature SQL. */
export function bindPrivacy(required: {
    unit: UnitOfWork; identity: Identity; subjects: FormSubjectPort; measure: MeasurePrivacyPort;
    clock: ClockPort; ids: IdPort; observer: ObserverPort;
    subjectLane: ReturnType<typeof createSubjectLane>;
}) {
    const participants = createErasureParticipantRegistry({});
    const leadsRepo = createSqlLeadsRepo({ unitOfWork: required.unit });
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
        // Cancellation commits with the processing block before any erasure phase.
        return { ok: true, value: { complete: true, removedCount: 0 } };
    } };
    const inventory = [contacts, policy, jobs,
        localParticipant({ id: 'forms', identity: required.identity, purge: input => required.subjects.purgeSubject(input) }),
        localParticipant({ id: 'web-events', identity: required.identity, purge: input => required.identity.webRepo.purgeSubject(input) }),
        localParticipant({ id: 'measure', identity: required.identity, purge: input => required.measure.purgeSubject(input) }),
        localParticipant({ id: 'leads', identity: required.identity, purge: input => leadsRepo.purgeSubject(input) }),
    ];
    for (const participant of inventory) {
        const result = participants.register({ participant });
        if (!result.ok) throw new Error('Privacy participant registration failed');
    }
    /** Every processing block borrows one session; phase work keeps the existing inventory. */
    function service(binding: { unit: UnitOfWork }): PrivacyService {
        return createPrivacyService({ repo: createSqlPrivacyRepo({ unitOfWork: binding.unit }), participants, clock: required.clock, ids: required.ids,
            block: { block: input => binding.unit.transaction({ work: async ({ session }) => {
                const identity = required.identity.forTransaction({ unit: session });
                const snapshot = await identity.policy.snapshot({ context: input.context, subjectId: input.subjectId });
                if (!snapshot.ok) return snapshot;
                const result = snapshot.value.suppressions.some(item => item.channel === 'om.processing') ? { ok: true as const, value: undefined }
                    : await identity.policy.appendEvidence({ context: input.context, evidence: { id: 'privacy.' + input.requestId,
                        scope: input.context.scope, subjectId: input.subjectId, sourceId: input.requestId, recordedAt: required.clock.now({}), kind: 'suppression',
                        suppression: { channel: 'om.processing', start: 0, end: Number.MAX_SAFE_INTEGER } } });
                if (!result.ok) return result;
                const root = await identity.contactsRepo.get({ context: input.context, subjectId: input.subjectId });
                if (!root.ok) return root;
                if (!root.value) return localFailure({ message: 'Erasure subject unavailable' });
                const subjectIds = [...new Set([root.value.subjectId, ...root.value.lineage.map(item => item.sourceSubjectId)])];
                const jobs = createSqlJobRepo({ database: session, clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
                await jobs.outbox.cancelBySubject({ tenantId: jobTenant(input), subjectIds, now: required.clock.now({}) });
                return { ok: true, value: undefined };
            } }) } });
    }
    const root = service(required);
    const privacy: PrivacyService = { ...root, requestErasure: (input, options) => required.subjectLane.run({ ...input, subjectIds: [input.subjectId], work: () =>
        required.unit.transaction({ work: ({ session }) => service({ unit: session }).requestErasure(input, options) }) }, options),
        async advance(input, options) {
            const request = await root.status(input, options);
            return request.ok ? required.subjectLane.run({ context: input.context, subjectIds: [request.value.subjectId], work: () => root.advance(input, options) }, options) : request;
        } };
    return { privacy, participants };
}
