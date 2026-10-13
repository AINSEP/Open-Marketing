/** Test-only composition: real Jini repositories and OM outbox, synthetic acceptance stores.
 * No production services start; all state lives in an owned temporary SQLite file. */
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { sqliteKernel } from '@jini-ai/db/kernel/sqlite';
import { isHoneypotTripped, submitForm, type FormDefinitionRecord } from '@jini-ai/cms/forms';
import { formDefinitionRepoFor, formSubmissionRepoFor } from '@jini-ai/cms/forms/sql';
import type { CallContext, Outcome, SqlSession, UnitOfWork } from '@open-marketing/contracts';
import type { FormAcceptancePort, FormPublication, PublicSubmissionResult, SubmissionReceipt } from '@open-marketing/forms';
import { createOutbox, createSqlJobRepo, createSqlOutboxStore, type JobsSqlDatabase } from '@open-marketing/jobs';
import { digestArguments } from '@open-marketing/safety';
import { loadMigrations } from '../../src/composition/migrations.js';
import { createCheckedSqliteClient, createSqlitePool, runMigrations } from '../../src/platform/jini-compat/db/src/index.js';

export const context: CallContext = {
    scope: { ownerId: 'spike-owner', workspaceId: 'd590965a-e81d-4560-a341-7396d8aa5ba3' },
    principal: { kind: 'service', serviceId: 'forms-spike' },
    correlationId: 'spike-correlation', traceId: 'spike-trace', runId: 'spike-run',
};
export const publicationId = '6c902be7-ad37-4dcb-aabb-58c4e1bc25f6';
export const body = { email: 'lead@example.test', marketing: true, measurement: false };
export const retryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 20, leaseMs: 1000 };
export type Failure = 'none' | 'throw' | 'outcome';
export type AcceptanceMode = 'sync' | 'async';
const bodySchema = z.strictObject({ email: z.string().max(320), marketing: z.boolean(), measurement: z.boolean(), _hp: z.string().max(256).optional() });
const receiptSchema = z.object({ publication_id: z.string(), attempt_id: z.string(), body_digest: z.string(), submission_id: z.string(), job_id: z.string() });
const jobPayloadSchema = z.strictObject({ publicationId: z.string(), submissionId: z.string() });
const wordingSchema = z.strictObject({ fieldId: z.enum(['marketing', 'measurement']), purpose: z.string(), topic: z.string(), target: z.string(), wording: z.string(), wordingVersion: z.string(), wordingDigest: z.string().regex(/^[a-f0-9]{64}$/) });
const publicationSchema = z.object({ publicationId: z.string(), formDefinitionId: z.string(), consent: z.array(wordingSchema).max(2) });

/** Failures are synthetic typed values, never inferred from vendor errors. */
function denied<T>({ code = 'conflict' }: { code?: 'conflict' | 'unavailable' }): Outcome<T> {
    return { ok: false, error: { code, message: 'Injected spike denial', retryable: false } };
}

/** Translate the foreign jobs SQL callback ABI; nested operations use this request's session.
 * @complexity O(1) adapter overhead, with one query per injected operation. */
function jobsDatabase({ unit }: { unit: UnitOfWork }): JobsSqlDatabase {
    return { transaction: ({ execute }) => unit.transaction({ work: ({ session }) => execute({ session: {
        query: ({ sql, parameters }) => session.query({ text: sql, values: [...parameters] }),
    } }) }) };
}

/** Read/parse durable replay evidence inside the submission transaction. */
async function findReceipt(required: { session: SqlSession; workspaceId: string; publicationId: string; attemptId: string }): Promise<SubmissionReceipt | null> {
    const result = await required.session.query({ text: 'SELECT * FROM om_form_submission_receipts WHERE workspace_id=$1 AND publication_id=$2 AND attempt_id=$3', values: [required.workspaceId, required.publicationId, required.attemptId] });
    if (!result.rows[0]) return null;
    const row = receiptSchema.parse(result.rows[0]);
    return { publicationId: row.publication_id, attemptId: row.attempt_id, bodyDigest: row.body_digest, submissionId: row.submission_id, jobId: row.job_id };
}

/** Test composition owns the file, native handle, injected clock and UUID generator.
 * @example const fixture = await createSpikeFixture({}); try { await fixture.submit({ attemptId: 'one' }); } finally { await fixture.close({}); }
 * @returns A temporary-file probe; restart reconstructs repositories/kernel over durable state.
 * @throws Native/migration errors during setup; no real credentials or vendor effects exist.
 * @complexity Setup applies 13 bounded migrations; probe operations use fixed-count writes. */
export async function createSpikeFixture(_required: Record<string, never>) {
    const directory = await mkdtemp(join(tmpdir(), 'om-step0c-'));
    const file = join(directory, 'spike.sqlite');
    let now = 1_792_000_000_123;
    const clock = { now: (_required: Record<string, never>) => now };
    const ids = { next: (_required: Record<string, never>) => randomUUID() };
    const events: string[] = [];
    const native = new Database(file);
    native.pragma('foreign_keys = ON');
    const initial = bind({ native });
    const root = new URL('../../../../', import.meta.url);
    try {
        const migrations = await loadMigrations({ readSql: ({ path }) => readFile(new URL(path, root), 'utf8') });
        await runMigrations({ pool: initial.pool, migrations });
        // These are SQL acceptance probes for frozen contacts/consent/visit seams, not feature implementations.
        native.exec(`CREATE TABLE spike_contact (submission_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, email TEXT NOT NULL);
            CREATE TABLE spike_consent (submission_id TEXT, purpose TEXT, topic TEXT, target TEXT, wording_version TEXT, wording_digest TEXT, choice INTEGER, PRIMARY KEY(submission_id,purpose,topic));
            CREATE TABLE spike_visit (submission_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL);`);
        await seed({ binding: initial, context, publicationId });
    } catch (error) {
        native.close();
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
    let binding = initial;

    /** Build every consumer over the SAME checked kernel; no adapter maps workspace IDs. */
    function bind({ native }: { native: Database.Database }) {
        const kernel = sqliteKernel(createCheckedSqliteClient({ database: native }));
        const pool = createSqlitePool({ database: native, kernel });
        const tables = { definitions: 'om_form_definitions', submissions: 'om_form_submissions' };
        return { native, kernel, pool, definitions: formDefinitionRepoFor({ kernel, tables }), submissions: formSubmissionRepoFor({ kernel, tables }) };
    }

    /** Seed one immutable publication and real Jini definition in a nested repository transaction. */
    async function seed(required: { binding: ReturnType<typeof bind>; context: CallContext; publicationId: string }): Promise<void> {
        const definition: FormDefinitionRecord = { id: randomUUID(), workspaceId: required.context.scope.workspaceId, name: 'Spike lead', slug: 'lead', status: 'active',
            fields: [{ id: 'email', label: 'Email', type: 'email', required: true }, { id: 'marketing', label: 'Product updates', type: 'checkbox', required: false }, { id: 'measurement', label: 'Measurement', type: 'checkbox', required: false }],
            notify: { enabled: false, recipients: [] }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), version: 1 };
        const publication: FormPublication = { scope: required.context.scope, publicationId: required.publicationId, formDefinitionId: definition.id, slug: definition.slug, version: 1, fields: definition.fields,
            consent: [{ fieldId: 'marketing', purpose: 'marketing_email', topic: 'product', target: 'newsletter', wording: 'Product updates', wordingVersion: 'v1', wordingDigest: 'a'.repeat(64) },
                { fieldId: 'measurement', purpose: 'measurement', topic: 'conversions', target: 'meta', wording: 'Measure conversions', wordingVersion: 'v1', wordingDigest: 'b'.repeat(64) }], publishedAt: now };
        await required.binding.pool.transaction({ work: async ({ session }) => {
            await session.query({ text: 'INSERT INTO workspace(owner_id,workspace_id) VALUES($1,$2)', values: [required.context.scope.ownerId, required.context.scope.workspaceId] });
            await required.binding.definitions.create(definition);
            await session.query({ text: 'INSERT INTO om_form_publications VALUES($1,$2,$3,$4,$5,$6,$7)', values: [definition.workspaceId, publication.publicationId, definition.id, definition.slug, 1, JSON.stringify(publication), now] });
        } });
    }

    /** Real SQL writes behind the frozen acceptance port; root failure rolls back partial acceptance.
     * Idempotency is submissionId; no provider operation or production contact implementation is simulated.
     * @complexity Fixed contact/visit writes and two consent rows for this bounded fixture. */
    function acceptance({ failure }: { failure: Failure }): FormAcceptancePort {
        return { async accept(input) {
            if (!input.session) return denied({ code: 'unavailable' });
            const submission = await binding.submissions.findById({ workspaceId: input.context.scope.workspaceId, id: input.submissionId });
            if (!submission) return denied({});
            const subjectId = input.submissionId;
            await input.session.query({ text: 'INSERT INTO spike_contact VALUES($1,$2,$3) ON CONFLICT(submission_id) DO NOTHING', values: [input.submissionId, subjectId, submission.data.email] });
            if (failure === 'throw') throw new Error('Injected acceptance failure');
            if (failure === 'outcome') return denied({});
            await appendConsent({ session: input.session, submissionId: input.submissionId, consent: input.consent });
            await input.session.query({ text: 'INSERT INTO spike_visit VALUES($1,$2) ON CONFLICT(submission_id) DO NOTHING', values: [input.submissionId, subjectId] });
            return { ok: true, value: { subjectId } };
        } };
    }

    /** Consent carries exact purpose/topic/version/choice; retry cannot widen or duplicate it. */
    async function appendConsent(required: { session: SqlSession; submissionId: string; consent: Parameters<FormAcceptancePort['accept']>[0]['consent'] }): Promise<void> {
        for (const item of required.consent) await required.session.query({ text: 'INSERT INTO spike_consent VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(submission_id,purpose,topic) DO NOTHING', values: [required.submissionId, item.purpose, item.topic, item.target, item.wordingVersion, item.wordingDigest, item.choice ? 1 : 0] });
    }

    /** Reload immutable wording and erasable answers, never from an outbox payload. */
    async function acceptSubmission(required: { session: SqlSession; context: CallContext; submissionId: string; publicationId: string; failure: Failure }) {
        const saved = await required.session.query({ text: 'SELECT publication_json FROM om_form_publications WHERE workspace_id=$1 AND publication_id=$2', values: [required.context.scope.workspaceId, required.publicationId] });
        const publication = publicationSchema.parse(JSON.parse(z.string().parse(saved.rows[0]?.publication_json)));
        const submission = await binding.submissions.findById({ workspaceId: required.context.scope.workspaceId, id: required.submissionId });
        if (!submission) return denied<{ subjectId: string }>({});
        const answers = bodySchema.parse(submission.data);
        const consent = publication.consent.map(item => ({ fieldId: item.fieldId, purpose: item.purpose, topic: item.topic, target: item.target, wordingVersion: item.wordingVersion, wordingDigest: item.wordingDigest, choice: answers[item.fieldId] }));
        return acceptance(required).accept({ ...required, consent });
    }

    /** Jini's foreign transaction callback is wrapped in a request-local object adapter.
     * Persist real submission + ID-only job + durable receipt atomically. Throws and root denials roll back.
     * @complexity Bounded body validation/hash and fixed indexed writes; no detached transaction work. */
    async function submit(required: { attemptId: string; mode?: AcceptanceMode; failure?: Failure; body?: typeof body & { _hp?: string }; context?: CallContext; publicationId?: string; hold?: () => Promise<void> }): Promise<Outcome<PublicSubmissionResult>> {
        const input = { ...required, context: required.context ?? context, publicationId: required.publicationId ?? publicationId, mode: required.mode ?? 'async', failure: required.failure ?? 'none', body: bodySchema.parse(required.body ?? body) };
        const hashed = digestArguments({ arguments: input.body });
        if (!hashed.ok) return hashed;
        return binding.pool.transaction({ work: async ({ session }): Promise<Outcome<PublicSubmissionResult>> => {
            let prior: SubmissionReceipt | null = null;
            if (!isHoneypotTripped({ hp: input.body._hp })) prior = await findReceipt({ session, workspaceId: input.context.scope.workspaceId, publicationId: input.publicationId, attemptId: input.attemptId });
            if (prior) return replay({ prior, digest: hashed.value });
            let receipt: SubmissionReceipt | undefined;
            const repo = createSqlJobRepo({ database: jobsDatabase({ unit: session }), clock, ids, retryPolicy });
            await submitForm({ input: { workspaceId: input.context.scope.workspaceId, slug: 'lead', body: input.body, sourceIp: '192.0.2.1' }, deps: {
                definitionRepo: binding.definitions, submissionRepo: binding.submissions,
                clock: { nowMs: () => now }, idGen: { newId: () => ids.next({}) }, rateLimiter: { check: () => ({ allowed: true }) }, logger: { warn() {} },
                dispatcher: { async dispatch() {} }, // Worker runs explicitly after the committed response, never in Jini's background hook.
                transaction: work => binding.submissions.transaction(work),
                outbox: { async enqueue(event) {
                    const submissionId = event.aggregateId!;
                    const result = await repo.enqueue({ context: input.context, job: { operationId: submissionId, idempotencyKey: submissionId, argumentsDigest: hashed.value, handler: 'forms.accept', payload: { submissionId, publicationId: input.publicationId } } });
                    if (!result.ok) throw new Error('Real jobs enqueue failed');
                    receipt = { publicationId: input.publicationId, attemptId: input.attemptId, bodyDigest: hashed.value, submissionId, jobId: result.value.jobId };
                    await session.query({ text: 'INSERT INTO om_form_submission_receipts VALUES($1,$2,$3,$4,$5,$6)', values: [input.context.scope.workspaceId, input.publicationId, input.attemptId, hashed.value, submissionId, receipt.jobId] });
                } },
            } });
            if (!receipt) return { ok: true, value: { status: 'discarded' } };
            await input.hold?.();
            if (input.mode === 'sync') {
                const result = await acceptSubmission({ session, ...input, submissionId: receipt.submissionId });
                if (!result.ok) return result;
            }
            if (input.failure === 'throw') throw new Error('Injected post-receipt failure');
            if (input.failure === 'outcome') return denied({});
            return { ok: true, value: { status: 'accepted', receipt } };
        } });
    }

    /** The real jobs worker reloads IDs; synthetic acceptance is SQL-atomic and idempotent.
     * lostAck probes replay AFTER committed acceptance. Unknown idempotent outcomes may retry safely. */
    async function processOne(required: { failure?: Failure; lostAck?: boolean }) {
        const store = createSqlOutboxStore({ database: jobsDatabase({ unit: binding.pool }), observe: event => events.push(event.operation + ':' + event.outcome) });
        const worker = createOutbox({ inputPolicy: retryPolicy, ports: { store, clock, generateId: () => ids.next({}), authorize: async () => true,
            transport: { idempotent: true, async dispatch(request) {
                const envelope = z.object({ payload: jobPayloadSchema }).parse(JSON.parse(request.payload));
                const current = request.context!;
                const result = await binding.pool.transaction({ work: ({ session }) => acceptSubmission({ session, context: current, ...envelope.payload, failure: required.failure ?? 'none' }) });
                if (!result.ok) return { kind: 'failure', classification: 'transient' };
                if (required.lostAck) return { kind: 'failure', classification: 'unknown' };
                return { kind: 'success' };
            } },
        } });
        return worker.processOne();
    }

    return {
        submit, processOne, events,
        get native() { return binding.native; }, get pool() { return binding.pool; }, get kernel() { return binding.kernel; }, get definitions() { return binding.definitions; }, get submissions() { return binding.submissions; },
        advance({ milliseconds }: { milliseconds: number }) { now += milliseconds; },
        async seedWorkspace(required: { context: CallContext; publicationId: string }) { await seed({ ...required, binding }); },
        async restart(_required: Record<string, never>) { binding.native.close(); const native = new Database(file); native.pragma('foreign_keys = ON'); binding = bind({ native }); },
        async close(_required: Record<string, never>) { if (binding.native.open) binding.native.close(); await rm(directory, { recursive: true, force: true }); },
    };
}

/** Same attempt/body returns the original IDs; a changed body never overwrites the first receipt. */
function replay(required: { prior: SubmissionReceipt; digest: string }): Outcome<PublicSubmissionResult> {
    if (required.prior.bodyDigest !== required.digest) return denied({});
    return { ok: true, value: { status: 'duplicate', receipt: required.prior } };
}
