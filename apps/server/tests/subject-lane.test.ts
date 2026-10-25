import { expect, it } from 'vitest';
import type { CallContext } from '@open-marketing/contracts';
import { createMemoryContactRepo, createContactService } from '@open-marketing/contacts';
import { createSubjectLane } from '../src/composition/subject-lane.js';

const context: CallContext = { scope: { ownerId: 'owner', workspaceId: 'workspace' }, principal: { kind: 'owner', ownerId: 'owner' }, correlationId: 'c', traceId: 't' };
const ok = async () => ({ ok: true as const, value: undefined });
async function fixture() {
    let id = 0;
    const repo = createMemoryContactRepo({});
    const contacts = createContactService({ repo, clock: { now: () => 1 }, ids: { next: () => 'id-' + ++id },
        digest: { activeKeyVersion: 'v1', keys: { v1: new Uint8Array([1]) } }, suppression: { assess: async () => ({ ok: true, value: { allowed: false } }) } });
    const a = await contacts.upsert({ context, identifiers: [{ kind: 'email', raw: 'a@example.test' }] });
    const b = await contacts.upsert({ context, identifiers: [{ kind: 'email', raw: 'b@example.test' }] });
    if (!a.ok || !b.ok) throw new Error('fixture');
    let resolved = (_input: { subjectId: string }) => {};
    const lane = createSubjectLane({ resolveSubject: async input => { const result = await repo.get(input); resolved({ subjectId: input.subjectId }); return result; } });
    return { lane, repo, contacts, a: a.value.subjectId, b: b.value.subjectId, onResolve(input: { callback(required: { subjectId: string }): void }) { resolved = input.callback; } };
}
it('orders the same subject, permits unrelated work, and releases after failures', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const order: string[] = [];
    const first = f.lane.run({ context, subjectIds: [f.a], work: async () => { entered.resolve(); await finish.promise; order.push('attempt'); throw new Error('uncertain'); } });
    await entered.promise;
    const second = f.lane.run({ context, subjectIds: [f.a], work: async () => { order.push('withdrawal'); return ok(); } });
    expect(await f.lane.run({ context, subjectIds: [f.b], work: ok })).toEqual({ ok: true, value: undefined });
    expect(order).toEqual([]);
    finish.resolve();
    expect(await first).toMatchObject({ ok: false }); expect(await second).toMatchObject({ ok: true });
    expect(order).toEqual(['attempt', 'withdrawal']);
});
it('locks both merge families and rejects a stale lineage instead of doing work', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const merging = f.lane.run({ context, subjectIds: [f.b, f.a], work: async () => { entered.resolve(); await finish.promise;
        return f.contacts.merge({ context, sourceSubjectId: f.a, targetSubjectId: f.b }); } });
    await entered.promise;
    let sends = 0; const captured = Promise.withResolvers<void>();
    f.onResolve({ callback: ({ subjectId }) => { if (subjectId === f.b) captured.resolve(); } });
    const stale = f.lane.run({ context, subjectIds: [f.b], work: async () => { sends++; return ok(); } });
    await captured.promise;
    finish.resolve(); expect(await merging).toMatchObject({ ok: true });
    expect(await stale).toMatchObject({ ok: false, error: { code: 'conflict' } }); expect(sends).toBe(0);
    expect(await f.lane.run({ context, subjectIds: [f.b], work: async ({ subjectIds }) => {
        expect(subjectIds).toEqual([f.a, f.b].sort()); return ok();
    } })).toMatchObject({ ok: true });
});
it('drains an aborted waiter without running it or leaking its lock', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    const first = f.lane.run({ context, subjectIds: [f.a], work: async () => { entered.resolve(); await finish.promise; return ok(); } });
    await entered.promise;
    const controller = new AbortController(); let ran = false;
    const aborted = f.lane.run({ context, subjectIds: [f.a], work: async () => { ran = true; return ok(); } }, { signal: controller.signal });
    controller.abort(); finish.resolve(); await first;
    expect(await aborted).toMatchObject({ ok: false, error: { code: 'cancelled' } }); expect(ran).toBe(false);
    expect(await f.lane.run({ context, subjectIds: [f.a], work: ok })).toMatchObject({ ok: true });
});
it('rejects missing subjects and over-bound lineage without effects', async () => {
    const f = await fixture(); let effects = 0;
    const work = async () => { effects++; return ok(); };
    expect(await f.lane.run({ context, subjectIds: ['missing'], work })).toMatchObject({ ok: false });
    const oversized = createSubjectLane({ resolveSubject: async () => ({ ok: true, value: { scope: context.scope, subjectId: 'root', createdAt: 0,
        creationOrder: 0, mergedInto: null, lineage: Array.from({ length: 100 }, (_, i) => ({ sourceSubjectId: String(i), targetSubjectId: 'root', mergedAt: 0 })) } }) });
    expect(await oversized.run({ context, subjectIds: ['root'], work })).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    expect(effects).toBe(0);
});

it('bounds waiting callers and removes idle entries after their final user', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const resume = Promise.withResolvers<void>();
    const holder = f.lane.run({ context, subjectIds: [f.a], work: async () => { entered.resolve(); await resume.promise; return ok(); } });
    await entered.promise;
    const waiting = Array.from({ length: 40 }, () => f.lane.run({ context, subjectIds: [f.a], work: ok }));
    try {
        const rejected = await Promise.any(waiting.map(async attempt => {
            const result = await attempt;
            if (result.ok) throw new Error('Expected capacity denial');
            return result;
        }));
        expect(rejected).toMatchObject({ ok: false, error: { code: 'limit_exceeded' } });
    } finally { resume.resolve(); await holder; await Promise.all(waiting); }
    const lane = createSubjectLane({ resolveSubject: async input => ({ ok: true, value: { scope: input.context.scope, subjectId: input.subjectId,
        createdAt: 0, creationOrder: 0, mergedInto: null, lineage: [] } }) });
    for (let id = 0; id < 1030; id++) expect(await lane.run({ context, subjectIds: [String(id)], work: ok })).toMatchObject({ ok: true });
});
