import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { URL as FileURL } from "node:url";
import { cardSchema, modelProviderSchema } from "@open-marketing/contracts";

it("parses all three real data-only provider manifests and their API-key cards", () => {
 for (const id of ["anthropic", "openai", "google"]) {
  const manifest = JSON.parse(readFileSync(new FileURL(`../../../content/agent-plugins/${id}/plugin.json`, import.meta.url), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  expect(manifest.name).toBe(id);
  expect(extension).toMatchObject({ version: 1, provides: ["model"], enabled: true, admitted: true, capabilities: {} });
  const provider = modelProviderSchema.parse(extension.modelProvider);
  expect(provider.protocol).toBe(id);
  expect(provider.models.length).toBeGreaterThan(0);
  expect(extension.credentialCards).toHaveLength(1);
  for (const raw of extension.credentialCards) {
   const card = cardSchema.parse(raw);
   expect(card).toMatchObject({ target: id, saveTarget: id, saveKind: "api-key", baseUrl: provider.endpoint,
    secretFields: [{ name: "token", label: "API key", required: true }] });
   expect(card.fields).toBeUndefined();
   expect(card.probeUrl).toBeUndefined();
  }
 }
});
