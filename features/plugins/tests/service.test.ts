import { describe, it, expect } from "vitest";
import { createPluginService, createMemoryPluginRepo, createMemoryPluginLifecycle, createMemoryAgentPluginLayout, createMemoryAgentPluginMcpProvisioning, createMemoryPluginTrust, createMemoryPluginAudit, createMemoryPluginObserver } from "../index.js";
import type { MemoryPluginPackage, PluginRepoPort, AgentPluginMcpProvisioningPort, PluginLifecyclePort, PluginTrustPort, PluginAuditPort, AgentPluginLayoutPort } from "../index.js";
import { context, source, digest, descriptor, memoryFixture, packageFixture, capabilityFixture } from "./fixtures/plugin.js";
import { failure } from "../src/results.js";

function harness(required: { packages?: readonly MemoryPluginPackage[] }, optional: {
  repo?: PluginRepoPort; provisioning?: AgentPluginMcpProvisioningPort; lifecycle?: PluginLifecyclePort;
  trust?: PluginTrustPort; audit?: PluginAuditPort; layout?: AgentPluginLayoutPort;
} = {}) {
  const packages = required.packages ?? [memoryFixture({})];
  const repo = optional.repo ?? createMemoryPluginRepo({});
  const lifecycle = createMemoryPluginLifecycle({}, { packages });
  const provisioning = createMemoryAgentPluginMcpProvisioning({});
  const audit = createMemoryPluginAudit({});
  const observer = createMemoryPluginObserver({});
  const service = createPluginService({ repo, lifecycle: optional.lifecycle ?? lifecycle,
    layout: optional.layout ?? createMemoryAgentPluginLayout({}, { packages }), provisioning: optional.provisioning ?? provisioning,
    trust: optional.trust ?? createMemoryPluginTrust({}, { packages }), audit: optional.audit ?? audit }, { observer });
  return { service, repo, lifecycle, provisioning, audit, observer };
}

describe("plugin service acceptance", () => {
  it("installs disabled, enables explicitly, then unregisters/disposes on disable and uninstall", async () => {
    const fixture = harness({});
    const installed = await fixture.service.install({ context, source });
    expect(installed).toMatchObject({ ok: true, value: { pluginId: "demo", digest, enabled: false, admitted: true, schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(fixture.provisioning.bindings({})).toHaveLength(0);
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: true, value: { enabled: true } });
    expect(fixture.provisioning.bindings({})).toHaveLength(1);
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: false })).toMatchObject({ ok: true, value: { enabled: false } });
    expect(fixture.provisioning.bindings({})).toHaveLength(0);
    await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true });
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toEqual({ ok: true, value: { pluginId: "demo", status: "removed" } });
    expect(fixture.provisioning.bindings({})).toHaveLength(0);
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toBeNull();
    expect(await fixture.repo.get({ context, pluginId: "demo" })).toEqual({ ok: true, value: null });
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toEqual({ ok: true, value: { pluginId: "demo", status: "removed" } });
  });

  it("never accepts adapter enablement/grant claims from installation", async () => {
    const lifecycle = createMemoryPluginLifecycle({}, { packages: [memoryFixture({})] });
    const fixture = harness({}, { lifecycle: { ...lifecycle, async install(input) {
      const outcome = await lifecycle.install(input);
      if (!outcome.ok) return outcome;
      return { ok: true, value: { ...outcome.value, enabled: true, admitted: true } };
    } } });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true, value: { enabled: false } });
    expect(fixture.provisioning.bindings({})).toEqual([]);
  });

  it("denies untrusted packages and invalid trust identity before physical installation", async () => {
    const fixture = harness({ packages: [memoryFixture({}, { trusted: false })] });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toBeNull();
    const badTrust = harness({}, { trust: { async verify() { return { ok: true, value: { pluginId: "demo", digest: "f".repeat(64) } }; } } });
    expect(await badTrust.service.install({ context, source })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(badTrust.lifecycle.installed({ context, pluginId: "demo" })).toBeNull();
  });

  it("replay preserves the exact admitted version without disposal or duplicate install events", async () => {
    const fixture = harness({});
    await fixture.service.install({ context, source });
    await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true, value: { enabled: true } });
    expect(fixture.provisioning.bindings({})).toHaveLength(1);
    expect(fixture.audit.entries({}).filter(entry => entry.operation === "install.requested")).toHaveLength(1);
  });

  it("digest update disposes old bindings and readmits the new version disabled", async () => {
    const updatedSource = { ...source, location: "/fixtures/updated", expectedDigest: "c".repeat(64) };
    const fixture = harness({ packages: [memoryFixture({}), memoryFixture({}, { source: updatedSource, actualDigest: updatedSource.expectedDigest, package: packageFixture({}, { manifest: { version: "2.0.0" } }) })] });
    await fixture.service.install({ context, source });
    await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true });
    expect(await fixture.service.install({ context, source: updatedSource })).toMatchObject({ ok: true, value: { version: "2.0.0", digest: updatedSource.expectedDigest, enabled: false } });
    expect(fixture.provisioning.bindings({})).toHaveLength(0);
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toMatchObject({ digest: updatedSource.expectedDigest });
  });

  it("running jobs block update/removal while preserving the existing installation", async () => {
    const updatedSource = { ...source, location: "/fixtures/updated", expectedDigest: "c".repeat(64) };
    const fixture = harness({ packages: [memoryFixture({}), memoryFixture({}, { source: updatedSource, actualDigest: updatedSource.expectedDigest })] });
    await fixture.service.install({ context, source });
    fixture.lifecycle.setRunningJobs({ context, pluginId: "demo", count: 1 });
    expect(await fixture.service.install({ context, source: updatedSource })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toMatchObject({ digest });
    fixture.lifecycle.setRunningJobs({ context, pluginId: "demo", count: 0 });
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { status: "removed" } });
  });

  it("job-start race yields pending removal, retains closed metadata and permits later cleanup", async () => {
    const lifecycle = createMemoryPluginLifecycle({}, { packages: [memoryFixture({})] });
    const fixture = harness({}, { lifecycle: { ...lifecycle, async checkIdle() { return { ok: true, value: undefined }; } } });
    await fixture.service.install({ context, source });
    lifecycle.setRunningJobs({ context, pluginId: "demo", count: 1 });
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { status: "pending" } });
    expect(await fixture.repo.get({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { enabled: false, admitted: false } });
    lifecycle.setRunningJobs({ context, pluginId: "demo", count: 0 });
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { status: "removed" } });
  });

  it("partial provisioning failure revokes admission and unregisters acquired resources", async () => {
    const provisioning = createMemoryAgentPluginMcpProvisioning({});
    const fixture = harness({}, { provisioning: { ...provisioning, async provision(input) {
      await provisioning.provision(input);
      return failure({ code: "unavailable", message: "fixture partial registration" });
    } } });
    await fixture.service.install({ context, source });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(provisioning.bindings({})).toHaveLength(0);
    expect(await fixture.repo.get({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { enabled: false, admitted: false } });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("failed enabled-state persistence cleans registered resources", async () => {
    const repo = createMemoryPluginRepo({});
    const fixture = harness({}, { repo: { ...repo, async save(input) {
      if (input.plugin.enabled) return failure({ code: "unavailable", message: "fixture enabled-save failure" });
      return repo.save(input);
    } } });
    await fixture.service.install({ context, source });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: false });
    expect(fixture.provisioning.bindings({})).toHaveLength(0);
    expect(await repo.get({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { enabled: false, admitted: false } });
  });

  it("cleanup still unregisters when the closed-state save fails", async () => {
    const repo = createMemoryPluginRepo({});
    let fail = false;
    const fixture = harness({}, { repo: { ...repo, async save(input) {
      if (fail && !input.plugin.admitted) return failure({ code: "unavailable", message: "fixture closed-save failure" });
      return repo.save(input);
    } } });
    await fixture.service.install({ context, source });
    await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true });
    fail = true;
    expect(await fixture.service.uninstall({ context, pluginId: "demo" })).toMatchObject({ ok: false });
    expect(fixture.provisioning.bindings({})).toHaveLength(0);
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).not.toBeNull();
  });

  it("failed audit blocks installation before package effects", async () => {
    const fixture = harness({}, { audit: { async record() { return failure({ code: "unavailable", message: "fixture audit failure" }); } } });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: false });
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toBeNull();
  });

  it("failed update audit preserves the prior package and registered resources", async () => {
    const updatedSource = { ...source, location: "/fixtures/updated", expectedDigest: "c".repeat(64) };
    const audit = createMemoryPluginAudit({});
    let rejectAudit = false;
    const fixture = harness({ packages: [memoryFixture({}), memoryFixture({}, { source: updatedSource, actualDigest: updatedSource.expectedDigest })] }, {
      audit: { async record(input) {
        if (rejectAudit) return failure({ code: "unavailable", message: "fixture audit failure" });
        return audit.record(input);
      } },
    });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: true });
    rejectAudit = true;
    expect(await fixture.service.install({ context, source: updatedSource })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toMatchObject({ digest });
    expect(fixture.provisioning.bindings({})).toHaveLength(1);
    expect(await fixture.repo.get({ context, pluginId: "demo" })).toMatchObject({ ok: true, value: { digest, enabled: true, admitted: true } });
  });

  it("disable unregisters resources even when metadata save throws", async () => {
    const repo = createMemoryPluginRepo({});
    let failSave = false;
    const fixture = harness({}, { repo: { ...repo, async save(input) {
      if (failSave) throw new Error("fixture unavailable metadata");
      return repo.save(input);
    } } });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: true });
    failSave = true;
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: false })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.provisioning.bindings({})).toEqual([]);
  });

  it("schema update with an unchanged byte pin invalidates prior admission", async () => {
    let declaration = descriptor;
    const fixture = harness({}, { layout: { async validate() { return { ok: true, value: declaration }; } } });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: true });
    declaration = { ...descriptor, capabilities: [capabilityFixture({})] };
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true, value: { enabled: false, admitted: true } });
    expect(fixture.provisioning.bindings({})).toEqual([]);
  });

  it("cross-plugin layout envelopes fail before installation or audit", async () => {
    const wrong = { ...capabilityFixture({}), pluginId: "other" };
    const fixture = harness({}, { layout: { async validate() { return { ok: true, value: { ...descriptor, capabilities: [wrong] } }; } } });
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.lifecycle.installed({ context, pluginId: "demo" })).toBeNull();
    expect(fixture.audit.entries({})).toEqual([]);
  });

  it("exceptions are typed/redacted and the scope lock releases for retry", async () => {
    const trust = createMemoryPluginTrust({}, { packages: [memoryFixture({})] });
    let fail = true;
    const fixture = harness({}, { trust: { async verify(input) {
      if (fail) throw new Error("secret credential upstream failure");
      return trust.verify(input);
    } } });
    const outcome = await fixture.service.install({ context, source });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(outcome)).not.toContain("secret credential");
    fail = false;
    expect(await fixture.service.install({ context, source })).toMatchObject({ ok: true });
  });

  it("rejects concurrent install/enable so closed state cannot be resurrected", async () => {
    const fixture = harness({});
    const install = fixture.service.install({ context, source });
    expect(await fixture.service.setEnabled({ context, pluginId: "demo", enabled: true })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await install).toMatchObject({ ok: true, value: { enabled: false } });
  });

  it("pre-cancelled or malformed input never performs effects; missing plugins are explicit", async () => {
    const fixture = harness({});
    const controller = new AbortController();
    controller.abort();
    expect(await fixture.service.install({ context, source }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await fixture.service.install({ context, source: { ...source, expectedDigest: "invalid" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.audit.entries({})).toHaveLength(0);
    expect(await fixture.service.setEnabled({ context, pluginId: "missing", enabled: true })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  it("isolates operations across owner/workspace and propagates redacted trace IDs", async () => {
    const fixture = harness({});
    await fixture.service.install({ context, source });
    const other = { ...context, scope: { ownerId: "other", workspaceId: "workspace" } };
    expect(await fixture.service.setEnabled({ context: other, pluginId: "demo", enabled: true })).toMatchObject({ ok: false });
    expect(fixture.observer.events({})[0]).toEqual({ operation: "plugins.install", outcome: "ok", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
    expect(fixture.audit.entries({})[0].context).toEqual(context);
  });
});
