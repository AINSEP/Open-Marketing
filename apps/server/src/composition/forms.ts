/** Real Jini forms + one ID-only OM jobs outbox. All adapters share the checked kernel. */
import { createHash } from 'node:crypto';
import { formDefinitionRepoFor, formSubmissionRepoFor } from '@jini-ai/cms/forms/sql';
import { z } from 'zod';
import type { CallContext, ClockPort, IdPort, ObserverPort, Outcome, SqlSession, UnitOfWork } from '@open-marketing/contracts';
import { epochSchema, idSchema } from '@open-marketing/contracts';
import { acceptFormSubmission, createFormsService, createSqlFormsStorage, type FormAcceptancePort, type FormPublication } from '@open-marketing/forms';
import { createSqlJobRepo, type JobsSqlDatabase } from '@open-marketing/jobs';
import { bindIdentity, processingAllowed } from './identity.js';
import type { bindServerDatabase } from './database.js';
import { localFailure } from './local-auth.js';

/** Fixed bounded local retry policy; no provider operation or second queue exists. */
export const formRetryPolicy = { maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 10000, leaseMs: 30000 };
/** Canonical ID-only job digest; property insertion order cannot change retry identity. */
export function formJobDigest(required: { publicationId: string; submissionId: string }): string {
    return createHash('sha256').update(JSON.stringify([required.publicationId, required.submissionId])).digest('hex');
}
/** Narrow jobs execute({session}) ABI translated over the exact supplied transaction owner. */
export function jobsDatabase(required: { unit: UnitOfWork }): JobsSqlDatabase {
    return { transaction: ({ execute }) => required.unit.transaction({ work: ({ session }) => execute({
        session: { query: ({ sql, parameters }) => session.query({ text: sql, values: [...parameters] }) },
    }) }) };
}
function value<T>(required: { result: Outcome<T> }): T {
    if (!required.result.ok) throw new Error('Local forms composition unavailable');
    return required.result.value;
}
/** Exact deterministic evidence IDs allow replay without new authority. Original capture time is retained.
 * <=20 bounded consent fields, one append per field in the same acceptance transaction. */
async function captureConsent(required: {
    input: Parameters<FormAcceptancePort['accept']>[0]; subjectId: string; capturedAt: number;
    identity: ReturnType<typeof bindIdentity>;
}): Promise<Outcome<void>> {
    for (const item of required.input.consent) {
        const id = createHash('sha256').update(JSON.stringify([required.input.context.scope.workspaceId, required.input.submissionId, item.fieldId])).digest('hex');
        const result = await required.identity.policy.appendEvidence({ context: required.input.context, evidence: {
            id, scope: required.input.context.scope, subjectId: required.subjectId, sourceId: required.input.submissionId,
            recordedAt: required.capturedAt, kind: item.choice ? 'consent' : 'withdrawal',
            consent: { scope: item.purpose === 'marketing_email' || item.purpose === 'marketing_sms' ? 'channel' : 'destination',
                target: item.target, purpose: item.purpose, topic: item.topic, wordingVersion: item.wordingVersion, wordingDigest: item.wordingDigest,
                status: item.choice ? 'granted' : 'withdrawn', start: required.capturedAt, end: Number.MAX_SAFE_INTEGER },
        } });
        if (!result.ok) return result;
    }
    return { ok: true, value: undefined };
}

/** Inert binding: Jini joins the shared kernel; enqueue/contact/evidence/visit use caller sessions.
 * Worker registration/scheduling is separate. No answer is copied into a job/event envelope.
 * @example bindForms({ database, clock, ids, observer, digestKey, tokens });
 * @complexity Fixed reloads + bounded contacts/consent work, all writes atomic. */
export function bindForms(required: {
    database: ReturnType<typeof bindServerDatabase>; clock: ClockPort; ids: IdPort; observer: ObserverPort;
    digestKey: Uint8Array; tokens: Parameters<typeof bindIdentity>[0]['tokens'];
}) {
    const tables = { definitions: 'om_form_definitions', submissions: 'om_form_submissions' };
    const definitions = formDefinitionRepoFor({ kernel: required.database.kernel, tables });
    const submissions = formSubmissionRepoFor({ kernel: required.database.kernel, tables });
    const storage = createSqlFormsStorage({ unitOfWork: required.database.unit });
    const acceptance: FormAcceptancePort = { async accept(input) {
        if (!input.session) return localFailure({ message: 'Acceptance requires the submission transaction' });
        const joined = createSqlFormsStorage({ unitOfWork: input.session });
        const prior = await joined.subjects.find({ context: input.context, submissionId: input.submissionId, session: input.session });
        if (!prior.ok) return prior;
        if (prior.value) return { ok: true, value: { subjectId: prior.value.subjectId } };
        return acceptNew({ input: { ...input, session: input.session }, joined });
    } };
    async function acceptNew(input: { input: Parameters<FormAcceptancePort['accept']>[0] & { session: SqlSession }; joined: ReturnType<typeof createSqlFormsStorage> }): Promise<Outcome<{ subjectId: string }>> {
        const request = input.input;
        const identity = bindIdentity({ ...required, unit: request.session });
        const submission = await submissions.findById({ workspaceId: request.context.scope.workspaceId, id: request.submissionId });
        if (!submission) return localFailure({ message: 'Acceptance submission unavailable' });
        const data = z.object({ email: z.string().min(1).max(320), om_publication: z.literal(request.publicationId) }).parse(submission.data);
        const capturedAt = epochSchema.parse(Date.parse(submission.submittedAt));
        const subject = await identity.contacts.upsert({ context: request.context, identifiers: [{ kind: 'email', raw: data.email }] });
        if (!subject.ok) return subject;
        const allowed = await processingAllowed({ policy: identity.policy, context: request.context, subjectId: subject.value.subjectId });
        if (!allowed.ok) return allowed;
        if (!allowed.value) return localFailure({ code: 'forbidden', message: 'Subject processing blocked' });
        const captured = await captureConsent({ input: request, subjectId: subject.value.subjectId, capturedAt, identity });
        if (!captured.ok) return captured;
        if (request.visitToken) {
            const bound = await identity.webEvents.bindVisitor({ context: request.context, visitToken: request.visitToken, subjectId: subject.value.subjectId });
            if (!bound.ok) return bound;
        }
        const receipt = await input.joined.subjects.append({ context: request.context, session: request.session,
            receipt: { submissionId: request.submissionId, publicationId: request.publicationId, subjectId: subject.value.subjectId, acceptedAt: capturedAt } });
        return receipt.ok ? { ok: true, value: { subjectId: receipt.value.subjectId } } : receipt;
    }
    const forms = createFormsService({ definitions, submissions, ...storage, acceptance, unitOfWork: required.database.unit, clock: required.clock, ids: required.ids,
        jobs: { async enqueue(input) {
            const repo = createSqlJobRepo({ database: jobsDatabase({ unit: input.session }), clock: required.clock, ids: required.ids, retryPolicy: formRetryPolicy });
            const payload = { submissionId: input.submissionId, publicationId: input.publicationId };
            const result = await repo.enqueue({ context: input.context, job: { handler: 'forms.accept', operationId: input.submissionId,
                idempotencyKey: input.submissionId, argumentsDigest: formJobDigest(payload), payload } });
            return result.ok ? { ok: true, value: { jobId: result.value.jobId } } : result;
        } } });
    return { forms, ...storage, definitions, submissions, acceptance,
        accept(input: { context: CallContext; submissionId: string; publicationId: string }) {
            return acceptFormSubmission({ ...input, submissions, publications: storage.publications, acceptance, unitOfWork: required.database.unit });
        },
    };
}

/** Seed once through the owning publish service. Restarts preserve immutable original wording/time.
 * Explicit consent checkboxes are optional and unchecked; email is a fixture-only local contact.
 * @complexity Two indexed reads/transaction and one bounded publication. */
export async function seedSandboxForm(required: { binding: ReturnType<typeof bindForms>; context: CallContext; clock: ClockPort; ids: IdPort }): Promise<void> {
    const existing = value({ result: await required.binding.publications.findBySlug({ context: required.context, slug: 'lead' }) });
    if (existing) return;
    const wording = [
        { fieldId: 'marketing', purpose: 'marketing_email', topic: 'product', target: 'newsletter', wording: 'Send me sandbox product updates by email.', wordingVersion: 'v1' },
        { fieldId: 'measurement', purpose: 'measurement', topic: 'conversions', target: 'meta', wording: 'Allow sandbox conversion measurement with Meta.', wordingVersion: 'v1' },
    ];
    const publication: FormPublication = { scope: required.context.scope, publicationId: idSchema.parse(required.ids.next({})), formDefinitionId: idSchema.parse(required.ids.next({})), slug: 'lead', version: 1,
        fields: [{ id: 'email', label: 'Email (local sandbox)', type: 'email', required: true },
            { id: 'marketing', label: 'Email updates', type: 'checkbox', required: false }, { id: 'measurement', label: 'Measurement', type: 'checkbox', required: false }],
        consent: wording.map(item => ({ ...item, wordingDigest: createHash('sha256').update(item.wording).digest('hex') })), publishedAt: required.clock.now({}) };
    value({ result: await required.binding.forms.publish({ context: required.context, publication }) });
}
