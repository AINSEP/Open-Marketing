import * as contracts from "../src/index.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { cardSchema, credentialCardSchema, credentialPluginStatusSchema, pluginSecretQuerySchema, pluginSecretSetSchema, pluginSecretStatusSchema } from "../src/index.js";
import { definePluginTools, pluginToolSchema } from "../src/index.js";
import {
 addonKindSchema, addonListRequestSchema, addonListSchema, addonSummarySchema, addonToolEffectsSchema,
 addonToolSourceSchema, addonUninstallReceiptSchema, addonUploadSchema, chartProviderDescriptorSchema,
 chartProviderListSchema, connectIntegrationTokenSchema, disconnectIntegrationSchema, installAddonSchema,
 integrationListSchema, integrationSummarySchema, setAddonEnabledSchema, uninstallAddonSchema,
} from "../src/index.js";
import type { AddonToolSource } from "../src/index.js";
import { mailAdapterDescriptorSchema, mailManifestExtensionSchema, mailProviderSelectionSchema, mailProviderSettingsSchema } from "../src/index.js";

const source: AddonToolSource = { id: "source", kind: "plugin", addonId: "charts", name: "report", description: "Report", inputSchema: {}, revision: "r1", effects: ["read"] };

it("retains sender overrides, explicit clearing and omission in selection and settings", () => {
 for (const selection of [{ selected: null }, { selected: "mail", alertFrom: "owner@example.test" }, { selected: "mail", alertFrom: null }]) {
  expect(mailProviderSelectionSchema.parse(selection)).toEqual(selection);
  const settings = { ...selection, candidates: [] };
  expect(mailProviderSettingsSchema.parse(settings)).toEqual(settings);
 }
});
it("rejects invalid sender syntax, oversized addresses, CRLF and verification claims", () => {
 for (const fields of [{ alertFrom: "invalid" }, { alertFrom: "a".repeat(243) + "@example.test" },
  { alertFrom: "owner@example.test\r\nBcc: other@example.test" }, { alertFrom: "owner@example.test", verified: true }]) {
  const selection = { selected: "mail", ...fields };
  expect(mailProviderSelectionSchema.safeParse(selection).success).toBe(false);
  expect(mailProviderSettingsSchema.safeParse({ ...selection, candidates: [] }).success).toBe(false);
 }
});

it("validates bounded mail declarations without rejecting sibling extension metadata", () => {
 const descriptor = { id: "example-mail", label: "Example mail", module: "io.github.ainsep.openmarketing/dist/index.mjs", credentialKeys: ["token"], feedback: true };
 expect(mailAdapterDescriptorSchema.parse(descriptor)).toEqual(descriptor);
 expect(mailAdapterDescriptorSchema.safeParse({ ...descriptor, unknown: true }).success).toBe(false);
 for (const module of ["../index.mjs", "/index.mjs", "mail/index.js"]) {
  expect(mailAdapterDescriptorSchema.safeParse({ ...descriptor, module }).success).toBe(false);
 }
 expect(mailAdapterDescriptorSchema.safeParse({ ...descriptor, credentialKeys: [] }).success).toBe(false);
 expect(mailAdapterDescriptorSchema.safeParse({ ...descriptor, credentialKeys: ["bad-key"] }).success).toBe(false);
 const siblings = { enabled: false, capabilities: [], credentialCards: [] };
 expect(mailManifestExtensionSchema.parse(siblings)).toEqual({});
 expect(mailManifestExtensionSchema.parse({ ...siblings, mailAdapters: [descriptor] })).toEqual({ mailAdapters: [descriptor] });
});

it("validates plugin secret ingress and secret-free status", () => {
 expect(pluginSecretQuerySchema.parse({ pluginId: "example-ads" })).toEqual({ pluginId: "example-ads" });
 expect(pluginSecretQuerySchema.safeParse({ pluginId: "" }).success).toBe(false);
 expect(pluginSecretSetSchema.parse({ pluginId: "example-ads", values: { clientKey: "fixture", secondKey: "fixture-2" } }).values).toEqual({ clientKey: "fixture", secondKey: "fixture-2" });
 expect(pluginSecretSetSchema.parse({ pluginId: "example-ads", values: null }).values).toBeNull();
 expect(pluginSecretSetSchema.safeParse({ pluginId: "example-ads", values: { "bad-key": "fixture" } }).success).toBe(false);
 expect(pluginSecretStatusSchema.parse({ configured: true })).toEqual({ configured: true });
 expect(pluginSecretStatusSchema.safeParse({ configured: true, values: { clientKey: "fixture" } }).success).toBe(false);
});

it("validates manifest cards and host-bound credential status", () => {
 const card = { target: "example-ads", title: "Example", label: "Key", category: "Ads", intro: "Connect", usedFor: ["Reports"],
  helpUrl: "https://example.test/help", helpLabel: "Help", baseUrl: "https://example.test", saveKind: "plugin-secret",
  secretFields: [{ name: "clientKey", label: "Key", required: true }, { name: "secondKey", label: "Second key" }] };
 expect(cardSchema.parse(card)).toEqual(card);
 expect(cardSchema.safeParse({ ...card, secretFields: [card.secretFields[0], card.secretFields[0]] }).success).toBe(false);
 const bound = { ...card, pluginId: "example-ads", actionSupported: true, iconDigest: "a".repeat(64) };
 expect(credentialCardSchema.parse(bound)).toEqual(bound);
 expect(credentialCardSchema.safeParse({ ...bound, iconDigest: "invalid" }).success).toBe(false);
 const status = { configured: true, credentialCards: [bound], connections: [], connectionsCursor: null };
 expect(credentialPluginStatusSchema.parse(status)).toEqual(status);
 expect(credentialPluginStatusSchema.safeParse({ ...status, values: { clientKey: "fixture" } }).success).toBe(false);
});

it("permits connection-only discovery for exactly one read effect", () => {
 const tool = { name: "example_tool", description: "Read reports", inputSchema: { type: "object" }, effects: ["read"], connectionOnly: true };
 expect(pluginToolSchema.parse(tool)).toEqual(tool);
 expect(pluginToolSchema.safeParse({ ...tool, effects: ["read", "write"] }).success).toBe(false);
});

it("produces JSON Schema while retaining Zod input parsing and fixed secret-free failures", () => {
 const declaration = { name: "example_tool", description: "Read reports", effects: ["read" as const], connectionOnly: true as const, unavailableReason: "Connect first",
  inputSchema: z.strictObject({ query: z.string().min(1).transform(value => value.toUpperCase()) }) };
 const defined = definePluginTools({ tools: [declaration] });
 expect(defined.tools[0]).toMatchObject({ name: "example_tool", connectionOnly: true, unavailableReason: "Connect first",
  inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"], additionalProperties: false } });
 expect(defined.parseTool({ name: "example_tool", input: { query: "report" } })).toEqual({ ok: true, value: { query: "REPORT" } });
 const submitted = "fixture-secret-value";
 const invalid = defined.parseTool({ name: "example_tool", input: { query: "", secret: submitted } });
 expect(invalid).toEqual({ ok: false, error: { code: "invalid_input", message: "Boundary validation failed", retryable: false } });
 expect(JSON.stringify(invalid)).not.toContain(submitted);
 expect(defined.parseTool({ name: "missing", input: {} })).toEqual({ ok: false, error: { code: "invalid_input", message: "Unknown plugin tool", retryable: false } });
 expect(() => definePluginTools({ tools: [declaration, declaration] })).toThrow("Duplicate plugin tool name");
});

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
 for (const path of ["../SKILL.md", "dir/../SKILL.md", "./SKILL.md", "/SKILL.md", "dir//file", "dir\\file", "https://host/file", "a\u0000b"]) {
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


it("rejects deprecated developer-token cards and removes their public schemas", () => {
 const legacy = { target: "fixture", title: "Fixture", label: "Token", category: "Ads", intro: "Fixture", usedFor: [],
  helpUrl: "https://fixture.test/help", helpLabel: "Help", baseUrl: "https://fixture.test", saveKind: "developer-token",
  secretFields: [{ name: "token", label: "Token", required: true }] };
 expect(cardSchema.safeParse(legacy).success).toBe(false);
 for (const name of ["developerTokenQuerySchema", "developerTokenSetSchema", "developerTokenStatusSchema"]) expect(contracts).not.toHaveProperty(name);
});
