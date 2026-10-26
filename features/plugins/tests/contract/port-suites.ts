import { describe, it, expect } from "vitest";
import type { PluginRepoPort, PluginLifecyclePort, AgentPluginLayoutPort, AgentPluginMcpProvisioningPort, PluginTrustPort, PluginAuditPort, PluginObserverPort, PluginSource, InstalledPlugin, PluginPackage } from "../../index.js";
import type { ObserverEvent } from "@open-marketing/contracts";
import { pluginSchemaFingerprint } from "../../index.js";
import { context, descriptor, plugin, packageFixture } from "../fixtures/plugin.js";

type Factory<T> = () => T | Promise<T>;
/** Shared behavioral metadata contract; memory and atomic filesystem adapters use this suite. */
export function PluginRepoPortSuite(required: { create: Factory<PluginRepoPort> }) {
  describe("PluginRepoPort behavior", () => {
    it("stores, replaces and removes scoped metadata", async () => {
      const port = await required.create();
      expect(await port.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: null });
      expect(await port.save({ context, plugin })).toEqual({ ok: true, value: plugin });
      expect(await port.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: plugin });
      const updated = { ...plugin, enabled: true };
      expect(await port.save({ context, plugin: updated })).toEqual({ ok: true, value: updated });
      expect(await port.remove({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: undefined });
      expect(await port.remove({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: undefined });
      expect(await port.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: null });
    });
    it("isolates owner and workspace and returns independent copies", async () => {
      const port = await required.create();
      const original = structuredClone(plugin);
      await port.save({ context, plugin: original });
      (original as { version: string }).version = "mutated";
      const otherOwner = { ...context, scope: { ...context.scope, ownerId: "other" } };
      const otherWorkspace = { ...context, scope: { ...context.scope, workspaceId: "other" } };
      expect(await port.get({ context: otherOwner, pluginId: plugin.pluginId })).toEqual({ ok: true, value: null });
      expect(await port.get({ context: otherWorkspace, pluginId: plugin.pluginId })).toEqual({ ok: true, value: null });
      expect(await port.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: plugin });
      const result = await port.get({ context, pluginId: plugin.pluginId });
      if (result.ok && result.value) (result.value as { version: string }).version = "read-mutated";
      expect(await port.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: plugin });
    });
    it("rejects invalid persisted authority fields", async () => {
      const port = await required.create();
      const outcome = await port.save({ context, plugin: { ...plugin, digest: "wrong" } });
      expect(outcome.ok).toBe(false);
      expect(await port.get({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: null });
    });
  });
}

export function PluginLifecyclePortSuite(required: { create: Factory<{ port: PluginLifecyclePort; source: PluginSource }> }) {
  describe("PluginLifecyclePort behavior", () => {
    it("installs disabled without tool/write/spend authority", async () => {
      const fixture = await required.create();
      const installed = await fixture.port.install({ context, source: fixture.source });
      expect(installed).toMatchObject({ ok: true, value: { pluginId: "demo", digest: fixture.source.expectedDigest, enabled: false, admitted: false } });
    });
    it("refuses a mismatched source pin", async () => {
      const fixture = await required.create();
      const outcome = await fixture.port.install({ context, source: { ...fixture.source, expectedDigest: "f".repeat(64) } });
      expect(outcome).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("checks idle and removes idempotently", async () => {
      const fixture = await required.create();
      await fixture.port.install({ context, source: fixture.source });
      expect(await fixture.port.checkIdle({ context, pluginId: "demo" })).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.dispose({ context, pluginId: "demo" })).toEqual({ ok: true, value: { pluginId: "demo", status: "removed" } });
      expect(await fixture.port.dispose({ context, pluginId: "demo" })).toEqual({ ok: true, value: { pluginId: "demo", status: "removed" } });
    });
  });
}

export function AgentPluginLayoutPortSuite(required: { create(required: { package?: PluginPackage }): { port: AgentPluginLayoutPort; source: PluginSource } | Promise<{ port: AgentPluginLayoutPort; source: PluginSource }> }) {
  describe("AgentPluginLayoutPort behavior", () => {
    it("accepts v1.1 and returns the exact OM namespace with inert capabilities", async () => {
      const fixture = await required.create({});
      expect(await fixture.port.validate({ source: fixture.source })).toEqual({ ok: true, value: descriptor });
    });
    it("refuses malformed digest pins", async () => {
      const fixture = await required.create({});
      expect(await fixture.port.validate({ source: { ...fixture.source, expectedDigest: "invalid" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it.each(["1.1.0", "2.0.0"])("rejects unsupported manifest schema %s in both memory and disk", async version => {
      const fixture = await required.create({ package: packageFixture({}, { manifest: { $schema: `https://agent-plugins.org/schemas/${version}/plugin.schema.json` } }) });
      expect(await fixture.port.validate({ source: fixture.source })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("unknown extensions remain inert while an invalid OM extension fails", async () => {
      const unknown = await required.create({ package: packageFixture({}, { manifest: { extensions: { "com.example.other": { admitted: true } } } }) });
      expect(await unknown.port.validate({ source: unknown.source })).toEqual({ ok: true, value: descriptor });
      const invalid = await required.create({ package: packageFixture({}, { manifest: { extensions: { [descriptor.namespace]: { version: 99 } } } }) });
      expect(await invalid.port.validate({ source: invalid.source })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("invalid MCP siblings do not block valid portable package inspection", async () => {
      const fixture = await required.create({ package: packageFixture({}, { mcp: { $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { valid: { type: "stdio", command: "node" }, invalid: { type: "stdio", command: "../escape" } } } }) });
      expect(await fixture.port.validate({ source: fixture.source })).toEqual({ ok: true, value: descriptor });
    });
  });
}

export function AgentPluginMcpProvisioningPortSuite(required: { create: Factory<{ port: AgentPluginMcpProvisioningPort; bindings: () => readonly InstalledPlugin[] }> }) {
  describe("AgentPluginMcpProvisioningPort behavior", () => {
    it("registers once, scopes bindings, unregisters/disposes idempotently", async () => {
      const fixture = await required.create();
      const admitted = { ...plugin, schemaFingerprint: pluginSchemaFingerprint({ descriptor }) };
      const other = { ...context, scope: { ...context.scope, workspaceId: "other" } };
      expect(await fixture.port.provision({ context, plugin: admitted })).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.provision({ context, plugin: admitted })).toEqual({ ok: true, value: undefined });
      expect(await fixture.port.provision({ context: other, plugin: admitted })).toEqual({ ok: true, value: undefined });
      expect(fixture.bindings()).toHaveLength(2);
      await fixture.port.dispose({ context, pluginId: plugin.pluginId });
      expect(fixture.bindings()).toHaveLength(1);
      await fixture.port.dispose({ context, pluginId: plugin.pluginId });
      await fixture.port.dispose({ context: other, pluginId: plugin.pluginId });
      expect(fixture.bindings()).toHaveLength(0);
    });
    it("rejects unadmitted metadata without registration", async () => {
      const fixture = await required.create();
      expect(await fixture.port.provision({ context, plugin: { ...plugin, admitted: false } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(fixture.bindings()).toHaveLength(0);
    });
    it("requires a schema pin for admitted metadata", async () => {
      const fixture = await required.create();
      expect(await fixture.port.provision({ context, plugin })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(fixture.bindings()).toHaveLength(0);
    });
  });
}

export function PluginTrustPortSuite(required: { create: Factory<{ port: PluginTrustPort; source: PluginSource }> }) {
  describe("PluginTrustPort behavior", () => {
    it("returns verified host-trusted identity", async () => {
      const fixture = await required.create();
      expect(await fixture.port.verify({ source: fixture.source })).toEqual({ ok: true, value: { pluginId: "demo", digest: fixture.source.expectedDigest } });
    });
    it("denies digest mismatch", async () => {
      const fixture = await required.create();
      expect(await fixture.port.verify({ source: { ...fixture.source, expectedDigest: "f".repeat(64) } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
  });
}

export function PluginAuditPortSuite(required: { create: Factory<{ port: PluginAuditPort; entries: () => readonly Parameters<PluginAuditPort["record"]>[0][] }> }) {
  describe("PluginAuditPort behavior", () => {
    it("appends independent records preserving scope/run/correlation/trace IDs", async () => {
      const fixture = await required.create();
      const entry = { context: structuredClone(context), pluginId: "demo", operation: "install.requested" };
      expect(await fixture.port.record(entry)).toEqual({ ok: true, value: undefined });
      entry.context.traceId = "changed";
      await fixture.port.record({ context, pluginId: "demo", operation: "install.completed" });
      expect(fixture.entries()).toEqual([{ context, pluginId: "demo", operation: "install.requested" }, { context, pluginId: "demo", operation: "install.completed" }]);
    });
  });
}

export function PluginObserverPortSuite(required: { create: Factory<{ port: PluginObserverPort; events: () => readonly ObserverEvent[] }> }) {
  describe("PluginObserverPort behavior", () => {
    it("records redacted lifecycle context", async () => {
      const fixture = await required.create();
      const event = { operation: "plugins.install", outcome: "ok", correlationId: "correlation", traceId: "trace", runId: "run" };
      fixture.port.observe(event);
      expect(fixture.events()).toEqual([event]);
    });
  });
}
