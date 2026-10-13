import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createJiniPluginLifecycleAdapter } from "../index.js";
import type { CallContext } from "../index.js";
import { context } from "./fixtures/plugin.js";
import { jiniFixture } from "./fixtures/jini.js";

function workspaceKey(required: { context: CallContext }): string {
  return createHash("sha256").update(JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId])).digest("hex");
}

describe("published Jini lifecycle adapter", () => {
  it("running jobs block update/removal and pending cleanup remains retryable", async () => {
    const fixture = await jiniFixture();
    let jobs = 0;
    const port = createJiniPluginLifecycleAdapter({ ...fixture, async readArchive() { return fixture.packed.bytes; }, workspaceId: workspaceKey, async runningJobs() { return jobs; } });
    expect(await port.install({ context, source: fixture.source })).toMatchObject({ ok: true });
    jobs = 1;
    expect(await port.checkIdle({ context, pluginId: "demo" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await port.dispose({ context, pluginId: "demo" })).toEqual({ ok: true, value: { pluginId: "demo", status: "pending" } });
    const workspaceRoot = fixture.layout.forWorkspace({ workspaceId: workspaceKey({ context }) }).root;
    expect(await fixture.lifecycle.listInstalledPlugins({ workspaceRoot })).toHaveLength(1);
    jobs = 0;
    expect(await port.dispose({ context, pluginId: "demo" })).toEqual({ ok: true, value: { pluginId: "demo", status: "removed" } });
    expect(await fixture.lifecycle.listInstalledPlugins({ workspaceRoot })).toEqual([]);
  });

  it("invalid or unavailable job activity never permits physical removal", async () => {
    const fixture = await jiniFixture();
    let jobs = 0;
    const port = createJiniPluginLifecycleAdapter({ ...fixture, async readArchive() { return fixture.packed.bytes; }, workspaceId: workspaceKey, async runningJobs() { return jobs; } });
    expect(await port.install({ context, source: fixture.source })).toMatchObject({ ok: true });
    jobs = NaN;
    expect(await port.dispose({ context, pluginId: "demo" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await fixture.lifecycle.listInstalledPlugins({ workspaceRoot: fixture.layout.forWorkspace({ workspaceId: workspaceKey({ context }) }).root })).toHaveLength(1);
  });

  it("uninstall affects only the exact owner/workspace scope and emits trace IDs", async () => {
    const fixture = await jiniFixture();
    const events: unknown[] = [];
    const port = createJiniPluginLifecycleAdapter({ ...fixture, async readArchive() { return fixture.packed.bytes; }, workspaceId: workspaceKey, async runningJobs() { return 0; } }, {
      observer: { observe(input) { events.push(input); } },
    });
    const other = { ...context, scope: { ...context.scope, ownerId: "other" } };
    expect(await port.install({ context, source: fixture.source })).toMatchObject({ ok: true });
    expect(await port.install({ context: other, source: fixture.source })).toMatchObject({ ok: true });
    expect(await port.dispose({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { status: "removed" } });
    expect(await fixture.lifecycle.listInstalledPlugins({ workspaceRoot: fixture.layout.forWorkspace({ workspaceId: workspaceKey({ context: other }) }).root })).toHaveLength(1);
    expect(events).toContainEqual({ operation: "plugins.lifecycle.dispose", outcome: "ok", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
  });

  it("cancellation while reading prevents package publication", async () => {
    const fixture = await jiniFixture();
    const controller = new AbortController();
    const port = createJiniPluginLifecycleAdapter({ ...fixture, async readArchive() { controller.abort(); return fixture.packed.bytes; }, workspaceId: workspaceKey, async runningJobs() { return 0; } });
    expect(await port.install({ context, source: fixture.source }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
});
