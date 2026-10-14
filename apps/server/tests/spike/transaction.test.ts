import { afterEach, describe, expect, it } from 'vitest';
import type { SqlSession } from '@open-marketing/contracts';
import { body, context, createSpikeFixture, publicationId, type Failure } from './fixture.js';

type Fixture = Awaited<ReturnType<typeof createSpikeFixture>>;
const fixtures: Fixture[] = [];
const writtenTables = ['om_form_submissions', 'om_form_submission_receipts', 'job', 'job_attempt', 'spike_contact', 'spike_consent', 'spike_visit'] as const;

/** Each test owns a file; even assertion failures close handles and delete temporary data. */
async function fixture(_required: Record<string, never>): Promise<Fixture> {
    const value = await createSpikeFixture({});
    fixtures.push(value);
    return value;
}

/** Read actual durable state, including jobs' transition journal rather than a fixture outbox. */
function counts({ fixture }: { fixture: Fixture }): number[] {
    return writtenTables.map(table => (fixture.native.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}

afterEach(async () => { for (const value of fixtures.splice(0)) await value.close({}); });

describe('A1: published Jini forms + one checked SQLite kernel + real OM jobs', () => {
    it('applies thirteen global migrations and stores publication-bound ID-only jobs with trace context', async () => {
        const value = await fixture({});
        expect(value.native.prepare('SELECT version,name FROM om_schema_migrations ORDER BY version DESC LIMIT 1').get()).toEqual({ version: 18, name: 'server-2' });
        const accepted = await value.submit({ attemptId: 'once' });
        expect(accepted).toMatchObject({ ok: true, value: { status: 'accepted' } });
        expect(counts({ fixture: value })).toEqual([1, 1, 1, 1, 0, 0, 0]);
        const saved = value.native.prepare('SELECT payload,context_json FROM job').get() as { payload: string; context_json: string };
        const receipt = value.native.prepare('SELECT submission_id FROM om_form_submission_receipts').get() as { submission_id: string };
        expect(JSON.parse(saved.payload).payload).toEqual({ publicationId, submissionId: receipt.submission_id });
        expect(saved.payload).not.toContain(body.email);
        expect(saved.payload).not.toContain('192.0.2.1');
        expect(JSON.parse(saved.context_json)).toEqual(context);
        expect(value.native.inTransaction).toBe(false);
    });

    for (const failure of ['throw', 'outcome'] as const) {
        it(`rolls back submission, receipt, real outbox and journal after post-write ${failure}`, async () => {
            const value = await fixture({});
            const operation = value.submit({ attemptId: 'fails', failure });
            if (failure === 'throw') await expect(operation).rejects.toMatchObject({ code: 'transaction_failed' });
            else expect(await operation).toMatchObject({ ok: false, error: { code: 'conflict' } });
            expect(counts({ fixture: value })).toEqual([0, 0, 0, 0, 0, 0, 0]);
            expect(value.native.inTransaction).toBe(false);
            expect(await value.submit({ attemptId: 'fails' })).toMatchObject({ ok: true, value: { status: 'accepted' } });
        });
        it(`sync acceptance ${failure} rolls back the partially written contact and all submission writes`, async () => {
            const value = await fixture({});
            const operation = value.submit({ attemptId: 'sync-fails', mode: 'sync', failure });
            if (failure === 'throw') await expect(operation).rejects.toMatchObject({ code: 'transaction_failed' });
            else expect(await operation).toMatchObject({ ok: false });
            expect(counts({ fixture: value })).toEqual([0, 0, 0, 0, 0, 0, 0]);
        });
    }

    it('honeypot discard creates no submission, receipt, job, subject, consent or visit', async () => {
        const value = await fixture({});
        expect(await value.submit({ attemptId: 'bot', mode: 'sync', body: { ...body, _hp: 'bot' } })).toEqual({ ok: true, value: { status: 'discarded' } });
        expect(counts({ fixture: value })).toEqual([0, 0, 0, 0, 0, 0, 0]);
    });

    it('same body deduplicates after handle/kernel restart, conflicting replay denies without overwriting', async () => {
        const value = await fixture({});
        const original = await value.submit({ attemptId: 'durable' });
        if (!original.ok || original.value.status === 'discarded') throw new Error('Expected accepted receipt');
        await value.restart({});
        expect(await value.submit({ attemptId: 'durable' })).toEqual({ ok: true, value: { status: 'duplicate', receipt: original.value.receipt } });
        expect(await value.submit({ attemptId: 'durable', body: { ...body, email: 'different@example.test' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
        expect(counts({ fixture: value })).toEqual([1, 1, 1, 1, 0, 0, 0]);
        expect((await value.submissions.findById({ workspaceId: context.scope.workspaceId, id: original.value.receipt.submissionId }))?.data).toEqual(body);
    });

    it('passes global UUID workspace IDs unchanged to Jini and isolates same attempts across workspaces', async () => {
        const value = await fixture({});
        const other = { ...context, scope: { ownerId: 'other-owner', workspaceId: 'c4a0b29a-0c4f-43d6-9874-b2ae3e917cea' } };
        await value.seedWorkspace({ context: other, publicationId });
        expect((await value.definitions.findBySlug({ workspaceId: context.scope.workspaceId, slug: 'lead' }))?.workspaceId).toBe(context.scope.workspaceId);
        expect((await value.definitions.findBySlug({ workspaceId: other.scope.workspaceId, slug: 'lead' }))?.workspaceId).toBe(other.scope.workspaceId);
        const first = await value.submit({ attemptId: 'same' });
        const second = await value.submit({ attemptId: 'same', context: other });
        expect(first).toMatchObject({ ok: true, value: { status: 'accepted' } });
        expect(second).toMatchObject({ ok: true, value: { status: 'accepted' } });
        expect(counts({ fixture: value })).toEqual([2, 2, 2, 2, 0, 0, 0]);
        if (!first.ok || first.value.status === 'discarded') throw new Error('Expected receipt');
        expect(await value.submissions.findById({ workspaceId: other.scope.workspaceId, id: first.value.receipt.submissionId })).toBeNull();
    });

    it('rejects an overlapping request without letting it join the first transaction, then permits retry', async () => {
        const value = await fixture({});
        const { promise: holding, resolve: release } = Promise.withResolvers<void>();
        const { promise: started, resolve: entered } = Promise.withResolvers<void>();
        const first = value.submit({ attemptId: 'first', failure: 'outcome', hold: () => { entered(); return holding; } });
        try {
            await started;
            await expect(value.submit({ attemptId: 'second' })).rejects.toMatchObject({ code: 'connect_failed', cause: { code: 'connection_busy' } });
            expect(counts({ fixture: value }).slice(0, 4)).toEqual([1, 1, 1, 1]);
        } finally { release(); await first; }
        expect(counts({ fixture: value })).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(await value.submit({ attemptId: 'second' })).toMatchObject({ ok: true, value: { status: 'accepted' } });
    });

    it('nested real repository/session calls join and roll back, and expired sessions cannot query', async () => {
        const value = await fixture({});
        let retained!: SqlSession;
        const result = await value.pool.transaction({ work: async ({ session }) => {
            retained = session;
            const definition = (await value.definitions.findBySlug({ workspaceId: context.scope.workspaceId, slug: 'lead' }))!;
            await session.transaction({ work: async ({ session: nested }) => {
                expect(nested).toBe(session);
                await value.submissions.transaction(async () => value.definitions.create({ ...definition, id: '8b60d956-d4ce-41be-a042-3d9c98c7d4d3', slug: 'nested' }));
            } });
            expect(await value.definitions.findBySlug({ workspaceId: context.scope.workspaceId, slug: 'nested' })).not.toBeNull();
            return { ok: false, error: { code: 'conflict', message: 'Nested rollback', retryable: false } } as const;
        } });
        expect(result.ok).toBe(false);
        expect(await value.definitions.findBySlug({ workspaceId: context.scope.workspaceId, slug: 'nested' })).toBeNull();
        await expect(retained.query({ text: 'SELECT 1' })).rejects.toMatchObject({ code: 'connection_released' });
    });

    it('decodes safe integers identically for OM and Jini and rejects overflow on both paths', async () => {
        const value = await fixture({});
        const input = { workspaceId: context.scope.workspaceId, slug: 'lead' };
        expect((await value.definitions.findBySlug(input))?.version).toBe(1);
        const rows = await value.pool.transaction({ work: ({ session }) => session.query({ text: 'SELECT 9007199254740991 AS maximum' }) });
        expect(rows.rows).toEqual([{ maximum: Number.MAX_SAFE_INTEGER }]);
        await expect(value.pool.transaction({ work: ({ session }) => session.query({ text: 'SELECT 9007199254740993 AS overflow' }) })).rejects.toMatchObject({ code: 'transaction_failed', cause: { code: 'unsafe_integer' } });
        value.native.prepare('UPDATE om_form_definitions SET version=9007199254740993').run();
        await expect(value.definitions.findBySlug(input)).rejects.toMatchObject({ code: 'unsafe_integer' });
    });

    it('sync acceptance commits contact, purpose/topic wording choices and visit inside submission', async () => {
        const value = await fixture({});
        expect(await value.submit({ attemptId: 'sync', mode: 'sync' })).toMatchObject({ ok: true, value: { status: 'accepted' } });
        expect(counts({ fixture: value })).toEqual([1, 1, 1, 1, 1, 2, 1]);
        expect(value.native.prepare('SELECT purpose,topic,target,wording_version,wording_digest,choice FROM spike_consent ORDER BY purpose').all()).toEqual([
            { purpose: 'marketing_email', topic: 'product', target: 'newsletter', wording_version: 'v1', wording_digest: 'a'.repeat(64), choice: 1 },
            { purpose: 'measurement', topic: 'conversions', target: 'meta', wording_version: 'v1', wording_digest: 'b'.repeat(64), choice: 0 },
        ]);
        expect(await value.processOne({})).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(counts({ fixture: value }).slice(4)).toEqual([1, 2, 1]);
    });

    for (const failure of ['throw', 'outcome'] satisfies Failure[]) {
        it(`async worker ${failure} leaves no partial acceptance, then retries after restart`, async () => {
            const value = await fixture({});
            expect(await value.submit({ attemptId: 'async' })).toMatchObject({ ok: true });
            expect(counts({ fixture: value }).slice(4)).toEqual([0, 0, 0]);
            expect(await value.processOne({ failure })).toMatchObject({ kind: 'completed', state: 'retry' });
            expect(counts({ fixture: value }).slice(4)).toEqual([0, 0, 0]);
            expect(counts({ fixture: value }).slice(0, 3)).toEqual([1, 1, 1]);
            await value.restart({});
            value.advance({ milliseconds: 25 });
            expect(await value.processOne({})).toMatchObject({ kind: 'completed', state: 'succeeded' });
            expect(counts({ fixture: value }).slice(4)).toEqual([1, 2, 1]);
            expect(await value.processOne({})).toEqual({ kind: 'idle' });
        });
    }

    it('async acceptance replay after a lost acknowledgement does not duplicate contact, consent or visit', async () => {
        const value = await fixture({});
        await value.submit({ attemptId: 'lost-ack' });
        expect(await value.processOne({ lostAck: true })).toMatchObject({ kind: 'completed', state: 'retry' });
        expect(counts({ fixture: value }).slice(4)).toEqual([1, 2, 1]);
        await value.restart({});
        value.advance({ milliseconds: 25 });
        expect(await value.processOne({})).toMatchObject({ kind: 'completed', state: 'succeeded' });
        expect(counts({ fixture: value }).slice(4)).toEqual([1, 2, 1]);
        expect(value.events).toContain('complete:ok');
    });
});
