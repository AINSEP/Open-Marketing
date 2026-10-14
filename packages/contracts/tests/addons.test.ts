import { expect, it } from "vitest";
import {
 addonKindSchema, addonListRequestSchema, addonListSchema, addonSummarySchema, addonToolEffectsSchema,
 addonToolSourceSchema, addonUninstallReceiptSchema, addonUploadSchema, chartProviderDescriptorSchema,
 chartProviderListSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, installAddonSchema,
 integrationListSchema, integrationSummarySchema, setAddonEnabledSchema, uninstallAddonSchema,
} from "../src/index.js";
import type { AddonToolSource } from "../src/index.js";

const source: AddonToolSource = { id: "source", kind: "plugin", addonId: "charts", name: "report", description: "Report", inputSchema: {}, revision: "r1", effects: ["read"] };

it("retains known financial effects while unknown, absent and empty effects become write", () => {
 expect(addonToolSourceSchema.parse(source)).toEqual(source);
 expect(addonToolEffectsSchema.parse(["ad_spend", "future_effect"])).toEqual(["ad_spend", "write"]);
 expect(addonToolEffectsSchema.parse(["read", "future_effect"])).toEqual(["read", "write"]);
 for (const effects of [undefined, null, []]) expect(addonToolEffectsSchema.parse(effects)).toEqual(["write"]);
 const { effects: _effects, ...withoutEffects } = source;
 expect(addonToolSourceSchema.parse(withoutEffects).effects).toEqual(["write"]);
 expect(addonToolSourceSchema.safeParse({ ...source, name: undefined }).success).toBe(false);
 expect(addonToolSourceSchema.safeParse({ ...source, bearer: "fixture" }).success).toBe(false);
 expect(addonToolSourceSchema.safeParse({ ...source, mcp: { command: "host" } }).success).toBe(false);
 expect(addonToolEffectsSchema.safeParse(Array.from({ length: 11 }, () => "read")).success).toBe(false);
});

it("validates all three addon kinds and explicit activation and removal DTOs", () => {
 for (const kind of ["plugin", "agent-plugin", "skill"]) {
  expect(addonKindSchema.parse(kind)).toBe(kind);
  const summary = { id: "addon", kind, name: "Addon", description: "Description", version: "1.0.0", enabled: false, revision: "r1" };
  expect(addonSummarySchema.parse(summary).enabled).toBe(false);
  expect(addonListSchema.parse({ items: [summary], cursor: null }).items[0]).toEqual(summary);
  expect(setAddonEnabledSchema.parse({ kind, id: "addon", enabled: true }).enabled).toBe(true);
  expect(uninstallAddonSchema.parse({ kind, id: "addon" }).kind).toBe(kind);
  expect(addonUninstallReceiptSchema.parse({ kind, id: "addon", removed: true }).removed).toBe(true);
 }
 expect(addonListRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
 expect(setAddonEnabledSchema.safeParse({ kind: "plugin", id: "addon" }).success).toBe(false);
});

it("accepts one upload flow and rejects malformed bytes and unsafe relative paths", () => {
 const file = { path: "SKILL.md", base64: "YQ==" };
 expect(addonUploadSchema.parse({ kind: "files", files: [file] })).toEqual({ kind: "files", files: [file] });
 expect(installAddonSchema.parse({ upload: { kind: "zip", base64: "YWJj" } }).upload.kind).toBe("zip");
 for (const path of ["../SKILL.md", "dir/../SKILL.md", "./SKILL.md", "/SKILL.md", "dir//file", "dir\\file", "https://host/file"]) {
  expect(addonUploadSchema.safeParse({ kind: "files", files: [{ ...file, path }] }).success).toBe(false);
 }
 for (const base64 of ["YQ=", "!Q==", "YW=J", "A==="]) expect(addonUploadSchema.safeParse({ kind: "zip", base64 }).success).toBe(false);
 expect(addonUploadSchema.safeParse({ kind: "files", files: [] }).success).toBe(false);
});

it("enforces decoded aggregate upload size, including base64 padding at the exact cap", () => {
 // 32 MiB has two remainder bytes, so its final quartet carries one padding character.
 const base64 = "AAAA".repeat(11184810) + "AAA=";
 expect(addonUploadSchema.safeParse({ kind: "zip", base64 }).success).toBe(true);
 expect(addonUploadSchema.safeParse({ kind: "zip", base64: base64.slice(0, -1) + "A" }).success).toBe(false);
 expect(addonUploadSchema.safeParse({ kind: "files", files: [{ path: "large.bin", base64 }, { path: "SKILL.md", base64: "YQ==" }] }).success).toBe(false);
});

it("exposes saved connection status without credentials or speculative verification", () => {
 for (const status of ["saved", "reconnect_required", "disconnected"]) {
  const summary = { connectionId: "c", pluginId: "p", status };
  expect(integrationSummarySchema.parse(summary)).toEqual(summary);
  expect(integrationListSchema.parse({ items: [summary], cursor: null }).items[0]).toEqual(summary);
 }
 expect(integrationSummarySchema.safeParse({ connectionId: "c", pluginId: "p", status: "verified" }).success).toBe(false);
 expect(integrationSummarySchema.safeParse({ connectionId: "c", pluginId: "p", status: "saved", plaintext: "fixture" }).success).toBe(false);
 expect(connectIntegrationTokenSchema.parse({ connectionId: "c", pluginId: "p", plaintext: "fixture-only" }).connectionId).toBe("c");
 expect(connectIntegrationTokenSchema.safeParse({ connectionId: "c", pluginId: "p", plaintext: "" }).success).toBe(false);
 expect(disconnectIntegrationSchema.parse({ connectionId: "c" })).toEqual({ connectionId: "c" });
});

it("exposes uploaded chart providers through local digest routes without a bundled allowlist", () => {
 const digest = "a".repeat(64);
 const provider = { id: "custom.chart", pluginId: "uploaded-by-owner", version: "1.0.0", digest, contractVersion: 1, kinds: ["bar"], javascript: "/api/addons/v1/chart-assets/" + digest + "/provider.js" };
 expect(chartProviderDescriptorSchema.parse(provider)).toEqual(provider);
 expect(chartProviderListSchema.parse({ providers: [provider] }).providers[0]).toEqual(provider);
 expect(chartProviderListSchema.parse({ providers: [] }).providers).toEqual([]);
 for (const javascript of ["/private/plugin/provider.js", "https://external.test/provider.js", "/api/addons/v1/chart-assets/" + digest + "/../provider.js"]) {
  expect(chartProviderDescriptorSchema.safeParse({ ...provider, javascript }).success).toBe(false);
 }
});
