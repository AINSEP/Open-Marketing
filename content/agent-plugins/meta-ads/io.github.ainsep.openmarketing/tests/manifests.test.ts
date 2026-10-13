import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { pluginDigest } from "./fixtures.js";

const root = new URL("../../", import.meta.url);
type Manifest = { $schema: string; name: string; extensions: Record<string, { version: number; enabled: boolean; admitted: boolean; capabilities: readonly unknown[] }> };
const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8")) as Manifest;
const mcp = JSON.parse(readFileSync(new URL("mcp.json", root), "utf8")) as unknown;

describe("actual packaged Meta manifests and evidence", () => {
  it("uses portable v1.1 with no unverified MCP server configuration", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.1.0/plugin.schema.json");
    expect(manifest.name).toBe("meta-ads");
    expect(mcp).toEqual({ $schema: "https://agent-plugins.org/schemas/1.1.0/mcp.schema.json", mcpServers: {} });
  });
  it("keeps all proposed generic capabilities unadmitted under the exact namespace", () => {
    expect(Object.keys(manifest.extensions)).toEqual(["io.github.ainsep.openmarketing"]);
    const extension = manifest.extensions["io.github.ainsep.openmarketing"];
    expect(extension.enabled).toBe(false); expect(extension.admitted).toBe(false);
    const envelopes = extension.capabilities.map(value => capabilityEnvelopeSchema.parse({ ...(value as object), pluginDigest }));
    expect(envelopes).toHaveLength(6);
    expect(envelopes.every(value => !value.admitted && value.pluginId === "meta-ads")).toBe(true);
    expect(new Set(envelopes.map(value => value.capabilityId)).size).toBe(envelopes.length);
  });
  it("does not disguise proposed schemas as a captured actual tools/list", () => {
    const evidence = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/evidence/actual-tools-list.json", root), "utf8"));
    expect(evidence).toMatchObject({ status: "unavailable", toolsList: null, schemaFingerprint: null, admission: "denied" });
  });
});
