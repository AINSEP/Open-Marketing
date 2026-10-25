import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { z } from "zod";
/** Local 1.0 metadata assertions; OM host admission is separately blocked on 1.0 support. */
it("declares inert OM metadata and a Full-access paste-token card without an external MCP bypass", async () => {
  const root = new URL("../../", import.meta.url);
  const plugin: unknown = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
  const manifest = z.strictObject({ $schema: z.literal("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"), name: z.literal("resend-email"), version: z.string(), description: z.string(), license: z.literal("Apache-2.0"), extensions: z.record(z.string(), z.unknown()) }).parse(plugin);
  expect(Object.keys(manifest.extensions)).toEqual(["io.github.ainsep.openmarketing"]);
  expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ enabled: false, admitted: false, credentialCards: [{ target: "resend-email", authMode: "paste-token", permission: "full_access", baseUrl: "https://api.resend.com", probeUrl: "https://api.resend.com/domains?limit=1" }] });
  expect(JSON.parse(await readFile(new URL("mcp.json", root), "utf8"))).toEqual({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: {} });
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  expect(pkg.sideEffects).toBe(false); expect(Object.keys(pkg.dependencies).sort()).toEqual(["@open-marketing/contracts", "zod"]);
  const capabilities = JSON.parse(await readFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const fingerprint = createHash("sha256").update(await readFile(new URL("io.github.ainsep.openmarketing/src/commands.ts", root))).digest("hex");
  expect(capabilities.capabilities).toEqual([{ capabilityId: "email.domains-read.v1", version: 1, pluginId: "resend-email", schemaFingerprint: fingerprint, admitted: false, effects: ["read"] }]);
  expect(capabilities.tools).toEqual([{ name: "domain_status", effects: ["read"], capabilityId: "email.domains-read.v1" }]);
  expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ capabilities: capabilities.capabilities, credentialCards: [{ usedFor: ["Read sending-domain status"] }] });
});
