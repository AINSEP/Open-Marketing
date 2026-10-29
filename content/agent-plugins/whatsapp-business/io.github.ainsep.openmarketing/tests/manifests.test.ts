import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { whatsappBusinessTools } from "../src/index.js";

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
