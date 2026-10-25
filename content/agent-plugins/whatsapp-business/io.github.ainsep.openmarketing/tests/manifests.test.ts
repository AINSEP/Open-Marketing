import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { whatsappBusinessTools } from "../src/index.js";
// Consumer regression: exercise the host's inert parser, never server composition or vendor I/O.
import { parseCredentialCardManifest } from "../../../../../apps/server/src/integration-credential-cards.js";

it("keeps portable declarations, fingerprints and public exports consistent", () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("plugin.json", root), "utf8"));
  const capabilities = JSON.parse(readFileSync(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  expect(manifest.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
  expect(extension).toMatchObject({ enabled: false, admitted: false });
  expect(extension.capabilities).toEqual(capabilities.capabilities);
  const fingerprint = createHash("sha256").update(readFileSync(new URL("io.github.ainsep.openmarketing/src/commands.ts", root))).digest("hex");
  expect(capabilities.capabilities).toEqual([{ capabilityId: "whatsapp.read.v1", version: 1, pluginId: "whatsapp-business", schemaFingerprint: fingerprint, admitted: false, effects: ["read"] }]);
  expect(capabilities.tools.map((tool: { name: string }) => tool.name)).toEqual(whatsappBusinessTools.map(tool => tool.name));
  expect(JSON.parse(readFileSync(new URL("mcp.json", root), "utf8")).mcpServers).toEqual({});
  expect(Object.keys(JSON.parse(readFileSync(new URL("package.json", root), "utf8")).exports)).toEqual(["."]);
});
it("host consumes identity-bound Meta reuse and sealed token cards", () => {
  const raw = readFileSync(new URL("../../plugin.json", import.meta.url), "utf8");
  const parsed = parseCredentialCardManifest({ raw, pluginId: "whatsapp-business" });
  expect(parsed).toMatchObject({ ok: true, value: { pluginId: "whatsapp-business", credentialCards: [
    { target: "whatsapp-business-meta", saveKind: "oauth", saveTarget: "whatsapp-business", actionSupported: false, permissions: ["whatsapp_business_management"] },
    { target: "whatsapp-business-token", saveKind: "app-credentials", saveTarget: "whatsapp-business", actionSupported: true,
      fields: [{ name: "wabaId", required: true }, { name: "phoneNumberId", required: true }], secretFields: [{ name: "accessToken", required: true }] },
  ] } });
  if (parsed.ok) expect(parsed.value.credentialCards).toHaveLength(2);
});
