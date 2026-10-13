import { describe, expect, it } from "vitest";
import { createPluginMcpProvisioningAdapter, pluginSchemaFingerprint } from "../index.js";
import type { AgentPluginMcpProvisioningPort, PluginExtensionDescriptor } from "../index.js";
import { capabilityFixture, context, descriptor, plugin } from "./fixtures/plugin.js";
import { failure } from "../src/results.js";

function admissionFixture(required: { descriptor: PluginExtensionDescriptor }, optional: { partial?: boolean; revokeFails?: boolean; throws?: boolean } = {}) {
  const registered: PluginExtensionDescriptor[] = [];
  const events: string[] = [];
  const port: AgentPluginMcpProvisioningPort = createPluginMcpProvisioningAdapter({ host: {
    async describe() { return { ok: true, value: required.descriptor }; },
    async register(input) {
      registered.push(input.descriptor);
      if (optional.throws) throw new Error("fixture secret token");
      if (optional.partial) return failure({ code: "unavailable", message: "fixture partial registration" });
      return { ok: true, value: undefined };
    },
    async invalidate() {
      events.push("invalidate");
      if (optional.revokeFails) return failure({ code: "unavailable", message: "fixture revocation failure" });
      return { ok: true, value: undefined };
    },
    async dispose() { events.push("dispose"); return { ok: true, value: undefined }; },
  } });
  return { port, registered, events };
}

describe("capability admission", () => {
  it("registers inert capabilities and revokes authority before disposing resources", async () => {
    const declaration = { ...descriptor, capabilities: [capabilityFixture({})] };
    const fixture = admissionFixture({ descriptor: declaration });
    const admitted = { ...plugin, schemaFingerprint: pluginSchemaFingerprint({ descriptor: declaration }) };
    expect(await fixture.port.provision({ context, plugin: admitted })).toEqual({ ok: true, value: undefined });
    expect(fixture.registered[0].capabilities).toEqual([{ ...capabilityFixture({}), admitted: false }]);
    expect(await fixture.port.dispose({ context, pluginId: plugin.pluginId })).toEqual({ ok: true, value: undefined });
    expect(fixture.events).toEqual(["invalidate", "dispose"]);
  });

  it("schema fingerprints ignore ordering and admission hints, but include effects and identity", () => {
    const first = capabilityFixture({});
    const second = { ...first, capabilityId: "image-quote.v1" };
    const original = pluginSchemaFingerprint({ descriptor: { ...descriptor, capabilities: [first, second] } });
    const reordered = { ...descriptor, capabilities: [{ ...second, admitted: false, effects: [...second.effects].reverse() }, { ...first, admitted: false }] };
    expect(pluginSchemaFingerprint({ descriptor: reordered })).toBe(original);
    const differentEffects = { ...descriptor, capabilities: [{ ...first, effects: ["read" as const] }, second] };
    expect(pluginSchemaFingerprint({ descriptor: differentEffects })).not.toBe(original);
    expect(pluginSchemaFingerprint({ descriptor: { ...descriptor, capabilities: [{ ...first, schemaFingerprint: "c".repeat(64) }, second] } })).not.toBe(original);
  });

  it.each([
    { declaration: { ...descriptor, capabilities: [{ ...capabilityFixture({}), pluginDigest: "f".repeat(64) }] }, code: "forbidden" },
    { declaration: { ...descriptor, capabilities: [{ ...capabilityFixture({}), pluginId: "other" }] }, code: "forbidden" },
    { declaration: { ...descriptor, capabilities: [capabilityFixture({}), capabilityFixture({})] }, code: "invalid_input" },
  ])("rejects mismatched/duplicate capabilities before registration", async ({ declaration, code }) => {
    const fixture = admissionFixture({ descriptor: declaration });
    const admitted = { ...plugin, schemaFingerprint: pluginSchemaFingerprint({ descriptor: declaration }) };
    expect(await fixture.port.provision({ context, plugin: admitted })).toMatchObject({ ok: false, error: { code } });
    expect(fixture.registered).toEqual([]);
  });

  it("schema drift cannot inherit an old admission", async () => {
    const before = { ...descriptor, capabilities: [capabilityFixture({})] };
    const after = { ...descriptor, capabilities: [capabilityFixture({}, { schemaFingerprint: "c".repeat(64) })] };
    const fixture = admissionFixture({ descriptor: after });
    expect(await fixture.port.provision({ context, plugin: { ...plugin, schemaFingerprint: pluginSchemaFingerprint({ descriptor: before }) } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.registered).toEqual([]);
  });

  it("failed invalidation is explicit and prevents physical disposal", async () => {
    const fixture = admissionFixture({ descriptor }, { revokeFails: true });
    expect(await fixture.port.dispose({ context, pluginId: plugin.pluginId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.events).toEqual(["invalidate"]);
  });

  it("redacts opaque host errors", async () => {
    const fixture = admissionFixture({ descriptor }, { throws: true });
    const result = await fixture.port.provision({ context, plugin: { ...plugin, schemaFingerprint: pluginSchemaFingerprint({ descriptor }) } });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("secret token");
  });
});
