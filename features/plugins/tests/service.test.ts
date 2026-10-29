import { expect, it } from 'vitest';
import { createPluginService, createMemoryPluginRepo, createMemoryPluginAudit, createMemoryPluginObserver } from '../index.js';
import type { AddonDependencies, AddonDescription, AddonPackageAdapter, AddonRepository } from '../index.js';
import type { AddonSummary, AddonUpload } from '@open-marketing/contracts';
import { context } from './fixtures/plugin.js';
import { PluginServiceSuite } from './contract/port-suites.js';

const upload: AddonUpload = { kind: 'files', files: [{ path: 'SKILL.md', base64: 'YQ==' }] };
function fixture(optional: Partial<AddonDependencies> = {}) {
    const repo = createMemoryPluginRepo({}); const audit = createMemoryPluginAudit({});
    const observer = createMemoryPluginObserver({}); const events: string[] = [];
    let next: AddonSummary = { id: 'demo', kind: 'skill', name: 'Demo', version: '1', description: '', revision: 'revision1', enabled: true };
    let jobs = 0; let operationId = 0;
    const backend: AddonPackageAdapter = {
        async prepare() { return { summary: { ...next }, async commit({ previous }) { events.push('commit:' + (previous?.revision ?? 'new')); } }; },
        async setEnabled(input) { events.push(input.enabled ? 'enable' : 'close'); },
        async remove() { events.push('remove'); }, async describe() { return { instructions: 'fixture instructions' }; },
    };
    const dependencies: AddonDependencies = { repo, packages: { plugin: backend, 'agent-plugin': backend, skill: backend }, audit, observer, ids: { next: () => 'operation-' + ++operationId },
        async decodeUpload() { return { ok: true, value: { kind: next.kind, files: new Map(), revision: next.revision } }; },
        async runningJobs() { return { ok: true, value: jobs }; }, ...optional };
    const service = createPluginService(dependencies);
    return { service, repo, audit, observer, events, dependencies,
        setJobs({ count }: { count: number }) { jobs = count; }, replace() { next = { ...next, revision: 'revision2', version: '2' }; } };
}
const enable = { kind: 'skill' as const, id: 'demo', enabled: true };
const removal = { kind: 'skill' as const, id: 'demo' };
PluginServiceSuite({ create: () => ({ ...fixture(), context, upload, async dispose() {} }) });

it('audits before publication, and never accepts adapter enablement claims', async () => {
    const f = fixture();
    expect(await f.service.install({ context, request: { upload } })).toMatchObject({ ok: true, value: { enabled: false } });
    expect(f.events).toEqual(['commit:new']);
    expect(f.audit.entries({}).map(entry => entry.operation)).toEqual(['install.requested', 'install.completed']);
    expect(f.audit.entries({})[0].context).toEqual(context);
    expect(f.observer.events({})[0]).toMatchObject({ correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
});

it('pairs lifecycle audit rows by operation and plugin, with a fresh ID for each mutation', async () => {
    const f = fixture();
    await f.service.install({ context, request: { upload } });
    f.replace();
    await f.service.install({ context, request: { upload } });
    await f.service.uninstall({ context, request: removal });
    const entries = f.audit.entries({});
    expect(entries).toHaveLength(6);
    expect(entries.map(entry => entry.pluginId)).toEqual(Array(6).fill('demo'));
    expect(entries.map(entry => entry.operation)).toEqual([
        'install.requested', 'install.completed', 'install.requested', 'install.completed', 'uninstall.requested', 'uninstall.completed',
    ]);
    expect(entries[0].operationId).toEqual(expect.any(String));
    expect(entries[0].operationId).toBe(entries[1].operationId);
    expect(entries[2].operationId).toBe(entries[3].operationId);
    expect(entries[4].operationId).toBe(entries[5].operationId);
    expect(new Set([entries[0].operationId, entries[2].operationId, entries[4].operationId]).size).toBe(3);
});

it('running work blocks replacement/removal and retains the enabled installation', async () => {
    const f = fixture(); await f.service.install({ context, request: { upload } });
    await f.service.setEnabled({ context, request: enable });
    f.replace(); f.setJobs({ count: 1 }); f.events.length = 0;
    expect(await f.service.install({ context, request: { upload } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await f.service.uninstall({ context, request: removal })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(f.events).toEqual([]);
    expect((await f.repo.list({ context }))[0]).toMatchObject({ revision: 'revision1', enabled: true });
    f.setJobs({ count: 0 });
    expect(await f.service.install({ context, request: { upload } })).toMatchObject({ ok: true, value: { revision: 'revision2', enabled: false } });
    expect(f.events).toEqual(['close', 'commit:revision1']);
});

it('a job starting as admission closes retains closed metadata and bytes until idle', async () => {
    let reads = 0;
    const f = fixture({ async runningJobs() { return { ok: true, value: reads++ === 0 ? 0 : 1 }; } });
    await f.service.install({ context, request: { upload } }); f.events.length = 0;
    expect(await f.service.uninstall({ context, request: removal })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(f.events).toEqual(['close']);
    expect((await f.repo.list({ context }))[0].enabled).toBe(false);
});

it.each([NaN, -1, Infinity, 0.5])('invalid activity %s never permits removal', async count => {
    const f = fixture(); await f.service.install({ context, request: { upload } }); f.setJobs({ count }); f.events.length = 0;
    expect(await f.service.uninstall({ context, request: removal })).toMatchObject({ ok: false, error: { retryable: false } });
    expect(f.events).toEqual([]); expect(await f.repo.list({ context })).toHaveLength(1);
});

it('audit failure blocks publication, activation and removal but still closes disable', async () => {
    let fail = false;
    const f = fixture({ audit: { async record() { return fail ? { ok: false, error: { code: 'unavailable', message: 'audit unavailable', retryable: false } } : { ok: true, value: undefined }; } } });
    fail = true;
    expect(await f.service.install({ context, request: { upload } })).toMatchObject({ ok: false }); expect(f.events).toEqual([]);
    fail = false; await f.service.install({ context, request: { upload } }); await f.service.setEnabled({ context, request: enable });
    fail = true; f.events.length = 0; f.replace();
    expect(await f.service.install({ context, request: { upload } })).toMatchObject({ ok: false });
    expect(await f.service.setEnabled({ context, request: enable })).toMatchObject({ ok: false });
    expect(await f.service.uninstall({ context, request: removal })).toMatchObject({ ok: false });
    expect(f.events).toEqual([]); expect((await f.repo.list({ context }))[0].enabled).toBe(true);
    expect(await f.service.setEnabled({ context, request: { ...enable, enabled: false } })).toMatchObject({ ok: false, error: { retryable: false, message: expect.stringContaining('reconcile') } });
    expect(f.events).toEqual(['close']); expect((await f.repo.list({ context }))[0].enabled).toBe(false);
});

it('completion audit failure reports reconciliation without blind retry', async () => {
    const f = fixture({ audit: { async record(input) { return input.operation.endsWith('.completed') ? { ok: false, error: { code: 'unavailable', message: 'audit failed', retryable: false } } : { ok: true, value: undefined }; } } });
    expect(await f.service.install({ context, request: { upload } })).toMatchObject({ ok: false, error: { retryable: false, message: expect.stringContaining('reconcile') } });
    expect(await f.repo.list({ context })).toHaveLength(1);
});

it('failed closed-state persistence still unregisters; failed enable publication closes again', async () => {
    const repo = createMemoryPluginRepo({}); let fail: 'none' | 'all' | 'enabled' = 'none';
    const injected: AddonRepository = { ...repo, async save(input) {
        if (fail === 'all' || (fail === 'enabled' && input.addon.enabled)) throw new Error('secret failure');
        await repo.save(input);
    } };
    const f = fixture({ repo: injected }); await f.service.install({ context, request: { upload } });
    fail = 'enabled'; f.events.length = 0;
    expect(await f.service.setEnabled({ context, request: enable })).toMatchObject({ ok: false, error: { retryable: false } });
    expect(f.events).toEqual(['close', 'enable', 'close']); expect((await repo.list({ context }))[0].enabled).toBe(false);
    fail = 'all'; f.events.length = 0;
    const result = await f.service.uninstall({ context, request: removal });
    expect(result).toMatchObject({ ok: false }); expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.events).toEqual(['close']); expect(await repo.list({ context })).toHaveLength(1);
});

it('partial enable failure unregisters, and stale instructions never escape', async () => {
    const f = fixture(); await f.service.install({ context, request: { upload } });
    f.dependencies.packages.skill = { ...f.dependencies.packages.skill, async setEnabled(input) { f.events.push(input.enabled ? 'enable' : 'close'); if (input.enabled) throw new Error('partial enable'); } };
    expect(await f.service.setEnabled({ context, request: enable })).toMatchObject({ ok: false });
    expect(f.events.slice(-3)).toEqual(['close', 'enable', 'close']);
    const addon = (await f.repo.list({ context }))[0]; await f.repo.save({ context, addon: { ...addon, enabled: true } });
    f.dependencies.packages.skill = { ...f.dependencies.packages.skill, async describe(): Promise<AddonDescription> {
        await f.repo.save({ context, addon: { ...addon, revision: 'revision2' } }); return { instructions: 'stale instructions' };
    } };
    expect(await f.service.describe({ context, ...removal, revision: addon.revision })).toMatchObject({ ok: false, error: { code: 'conflict' } });
});

it('pre-cancellation and overlap never publish, and cancellation after activity recheck retains bytes', async () => {
    const controller = new AbortController(); controller.abort(); const f = fixture();
    expect(await f.service.install({ context, request: { upload } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    const pending = f.service.install({ context, request: { upload } });
    const sameScope = { ...context, scope: { workspaceId: context.scope.workspaceId, ownerId: context.scope.ownerId } };
    expect(await f.service.setEnabled({ context: sameScope, request: enable })).toMatchObject({ ok: false, error: { code: 'conflict' } });
    await pending;
    const cancel = new AbortController(); let checks = 0;
    f.dependencies.runningJobs = async () => { if (++checks === 2) cancel.abort(); return { ok: true, value: 0 }; };
    expect(await f.service.uninstall({ context, request: removal }, { signal: cancel.signal })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(f.events).not.toContain('remove'); expect(await f.repo.list({ context })).toHaveLength(1);
});
