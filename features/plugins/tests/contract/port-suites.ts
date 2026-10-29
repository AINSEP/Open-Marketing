import { describe, it, expect } from 'vitest';
import type { AddonRepository, PluginAuditPort, PluginService } from '../../index.js';
import type { AddonSummary, AddonUpload, CallContext, ObserverEvent, ObserverPort } from '@open-marketing/contracts';
import { context } from '../fixtures/plugin.js';
type Factory<T> = () => T | Promise<T>;
/** Memory catalog reference; server tests run shared memory/SQL scenarios. */
export function AddonRepositorySuite(required: { create: Factory<{ repo: AddonRepository; dispose(): void }> }) {
  it('catalog isolates scope, clones values, replaces revisions and removes idempotently', async () => {
    const { repo, dispose } = await required.create();
    const addon: AddonSummary = { id: 'demo', kind: 'skill', name: 'Demo', version: '1', description: '', revision: 'revision1', enabled: false };
    try {
      await repo.save({ context, addon });
      addon.enabled = true;
      expect(await repo.list({ context })).toEqual([{ ...addon, enabled: false }]);
      expect(await repo.list({ context: { ...context, scope: { ...context.scope, ownerId: 'other' } } })).toEqual([]);
      expect(await repo.list({ context: { ...context, scope: { ...context.scope, workspaceId: 'other' } } })).toEqual([]);
      const [read] = await repo.list({ context }); read.name = 'mutated';
      expect((await repo.list({ context }))[0].name).toBe('Demo');
      expect((await repo.list({ context: { ...context, scope: { workspaceId: context.scope.workspaceId, ownerId: context.scope.ownerId } } }))[0].name).toBe('Demo');
      await repo.save({ context, addon });
      expect(await repo.list({ context })).toEqual([addon]);
      await repo.remove({ context, kind: addon.kind, id: addon.id });
      await repo.remove({ context, kind: addon.kind, id: addon.id });
      expect(await repo.list({ context })).toEqual([]);
    } finally { dispose(); }
  });
}
/** Fixture lifecycle acceptance; server tests share scenarios with composed Jini adapters. */
export function PluginServiceSuite(required: { create: Factory<{ service: PluginService; context: CallContext; upload: AddonUpload; dispose(): Promise<void> }> }) {
  it('installs disabled, enables explicitly, replays unchanged, scopes and removes', async () => {
    const f = await required.create();
    try {
      const installed = await f.service.install({ context: f.context, request: { upload: f.upload } });
      expect(installed).toMatchObject({ ok: true, value: { enabled: false } });
      if (!installed.ok) throw new Error('Expected installation');
      const request = { kind: installed.value.kind, id: installed.value.id, enabled: true };
      const enabled = await f.service.setEnabled({ context: f.context, request });
      expect(enabled).toMatchObject({ ok: true, value: { enabled: true } });
      expect(await f.service.install({ context: f.context, request: { upload: f.upload } })).toEqual(enabled);
      expect(await f.service.setEnabled({ context: { ...f.context, scope: { ...f.context.scope, ownerId: 'other' } }, request })).toMatchObject({ ok: false });
      expect(await f.service.uninstall({ context: f.context, request: { kind: request.kind, id: request.id } })).toMatchObject({ ok: true, value: { removed: true } });
      expect(await f.service.list({ context: f.context, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
    } finally { await f.dispose(); }
  });
}

export function PluginAuditPortSuite(required: { create: Factory<{ port: PluginAuditPort; entries: () => readonly Parameters<PluginAuditPort["record"]>[0][] }> }) {
  describe("PluginAuditPort behavior", () => {
    it("appends independent records preserving scope/run/correlation/trace IDs", async () => {
      const fixture = await required.create();
      const entry = { context: structuredClone(context), pluginId: "demo", operationId: "fixture-operation", operation: "install.requested" };
      expect(await fixture.port.record(entry)).toEqual({ ok: true, value: undefined });
      entry.context.traceId = "changed";
      await fixture.port.record({ context, pluginId: "demo", operationId: "fixture-operation", operation: "install.completed" });
      expect(fixture.entries()).toEqual([{ context, pluginId: "demo", operationId: "fixture-operation", operation: "install.requested" }, { context, pluginId: "demo", operationId: "fixture-operation", operation: "install.completed" }]);
    });
  });
}

export function PluginObserverPortSuite(required: { create: Factory<{ port: ObserverPort; events: () => readonly ObserverEvent[] }> }) {
  describe("PluginObserverPort behavior", () => {
    it("records redacted lifecycle context", async () => {
      const fixture = await required.create();
      const event = { operation: "plugins.install", outcome: "ok", correlationId: "correlation", traceId: "trace", runId: "run" };
      fixture.port.observe(event);
      expect(fixture.events()).toEqual([event]);
    });
  });
}
