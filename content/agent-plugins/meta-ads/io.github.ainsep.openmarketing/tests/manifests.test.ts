import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { capabilityEnvelopeSchema } from "@open-marketing/contracts";
import { pluginDigest } from "./fixtures.js";

const root = new URL("../../", import.meta.url);
type Manifest = { $schema: string; name: string; extensions: Record<string, { version: number; enabled: boolean; admitted: boolean; capabilities: readonly unknown[] }> };
const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8")) as Manifest;
const mcp = JSON.parse(readFileSync(new URL("mcp.json", root), "utf8")) as unknown;

describe("actual packaged Meta manifests and evidence", () => {
  it("binds closed deployment to its executable schema while keeping admission false", () => {
    const declarations = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    expect(declarations.deployment).toMatchObject({ capabilityId: "campaign.create-paused.v1", admitted: false, read: "readCampaignDeployment" });
    const actual = createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/campaign-deployment.ts", root))).digest("hex");
    expect(manifest.extensions["io.github.ainsep.openmarketing"].capabilities.find(value => (value as { capabilityId: string }).capabilityId === declarations.deployment.capabilityId)).toMatchObject({ schemaFingerprint: actual });
  });
  it("uses portable v1.0 with no unverified MCP server configuration", () => {
    expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(manifest.name).toBe("meta-ads");
    expect(mcp).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  });
  it("keeps all proposed generic capabilities unadmitted under the exact namespace", () => {
    expect(Object.keys(manifest.extensions)).toEqual(["io.github.ainsep.openmarketing"]);
    const extension = manifest.extensions["io.github.ainsep.openmarketing"];
    expect(extension.enabled).toBe(false); expect(extension.admitted).toBe(false);
    const envelopes = extension.capabilities.map(value => capabilityEnvelopeSchema.parse({ ...(value as object), pluginDigest }));
    expect(envelopes).toHaveLength(14);
    expect(envelopes.every(value => !value.admitted && value.pluginId === "meta-ads")).toBe(true);
    expect(new Set(envelopes.map(value => value.capabilityId)).size).toBe(envelopes.length);
  });
  it("declares the four organic Instagram effects consistently without changing existing admission", () => {
    const extension = manifest.extensions["io.github.ainsep.openmarketing"];
    const capabilities = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
    expect(capabilities.capabilities).toEqual(extension.capabilities);
    const envelopes = extension.capabilities.map(value => capabilityEnvelopeSchema.parse({ ...(value as object), pluginDigest }));
    expect(envelopes.filter(value => value.capabilityId.startsWith("instagram.")).map(value => [value.capabilityId, value.effects])).toEqual([
      ["instagram.accounts.v1", ["read"]], ["instagram.publish-post.v1", ["write"]],
      ["instagram.post-status.v1", ["read"]], ["instagram.media-insights.v1", ["read"]],
    ]);
    expect(envelopes.filter(value => !value.capabilityId.startsWith("instagram."))).toHaveLength(10);
  });
  it("declares the three frozen read capabilities with matching source fingerprints", () => {
    const fingerprint = createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/read-capabilities.ts", root))).digest("hex");
    const ids = ["report.metrics.v1", "campaign.status.v1", "tracking.tag.v1"];
    const declarations = manifest.extensions["io.github.ainsep.openmarketing"].capabilities;
    const reads = declarations.filter(value => ids.includes((value as { capabilityId: string }).capabilityId));
    expect(reads).toEqual(ids.map(capabilityId => ({ capabilityId, version: 1, pluginId: "meta-ads", schemaFingerprint: fingerprint, admitted: false, effects: ["read"] })));
  });
  it("declares audience membership as one unadmitted write bound to its handler source", () => {
    const fingerprint = createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/audiences.ts", root))).digest("hex");
    const declarations = manifest.extensions["io.github.ainsep.openmarketing"].capabilities;
    expect(declarations.filter(value => (value as { capabilityId: string }).capabilityId === "audience.member.add.v1")).toEqual([
      { capabilityId: "audience.member.add.v1", version: 1, pluginId: "meta-ads", schemaFingerprint: fingerprint, admitted: false, effects: ["write"] },
    ]);
  });
  it("does not disguise proposed schemas as a captured actual tools/list", () => {
    const evidence = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/evidence/actual-tools-list.json", root), "utf8"));
    expect(evidence).toMatchObject({ status: "unavailable", toolsList: null, schemaFingerprint: null, admission: "denied" });
  });
});
