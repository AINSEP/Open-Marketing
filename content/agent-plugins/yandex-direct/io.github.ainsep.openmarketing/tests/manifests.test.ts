import { readFile as readCapabilityFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { yandexDirectTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
async function json(required: { path: string }): Promise<unknown> { return JSON.parse(await readFile(new URL(required.path, root), "utf8")) as unknown; }
const capability = z.strictObject({ capabilityId: z.enum(["campaign.read.v1", "report.account-spend.v1", "campaign.create-draft.v1", "report.metrics.v1", "campaign.status.v1"]), version: z.literal(1), pluginId: z.literal("yandex-direct"), schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/), admitted: z.literal(false), effects: z.union([z.tuple([z.literal("read")]), z.tuple([z.literal("write")])]) });
describe("Yandex portable package", () => {
  it("ships disabled/unadmitted with read-only tools and a grouped draft backend", async () => {
    const manifest = z.object({ name: z.literal("yandex-direct"), extensions: z.strictObject({ "io.github.ainsep.openmarketing": z.strictObject({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(capability).length(5), credentialCards: z.array(z.unknown()), credentialAssets: z.record(z.string(), z.string()) }) }) }).parse(await json({ path: "plugin.json" }));
    const declaration = z.strictObject({ version: z.literal(1), admitted: z.literal(false), capabilities: z.array(capability).length(5), tools: z.array(z.strictObject({ name: z.enum(["list_accounts", "list_campaigns", "report"]), effects: z.tuple([z.literal("read")]), capabilityId: capability.shape.capabilityId })).length(3), fingerprintBasis: z.string(), deployment: z.strictObject({ capabilityId: z.literal("campaign.create-draft.v1"), create: z.literal("deployCampaignPaused"), read: z.literal("readCampaignDeployment"), planSchema: z.literal("campaignDeploymentPlanSchema"), admitted: z.literal(false) }) }).parse(await json({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(declaration.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
    expect(declaration.tools).toEqual([{ name: "list_accounts", effects: ["read"], capabilityId: "campaign.read.v1" }, { name: "list_campaigns", effects: ["read"], capabilityId: "campaign.read.v1" }, { name: "report", effects: ["read"], capabilityId: "report.account-spend.v1" }]);
    expect(yandexDirectTools.map(tool => [tool.name, tool.effect])).toEqual([["list_accounts", "read"], ["list_campaigns", "read"], ["report", "read"]]);
    const table = {
      "campaign.read.v1": { effect: "read", files: ["commands.ts", "transport.ts"] },
      "report.account-spend.v1": { effect: "read", files: ["commands.ts", "reporting.ts", "transport.ts"] },
      "campaign.create-draft.v1": { effect: "write", files: ["commands.ts", "campaign-translation.ts", "campaign-deployment.ts"] },
      "report.metrics.v1": { effect: "read", files: ["capabilities.ts"] },
      "campaign.status.v1": { effect: "read", files: ["capabilities.ts"] },
    };
    for (const entry of declaration.capabilities) {
      expect(entry.effects).toEqual([table[entry.capabilityId].effect]);
      const { files } = table[entry.capabilityId];
      const source = await Promise.all(files.map(file => readFile(new URL("io.github.ainsep.openmarketing/src/" + file, root))));
      expect(entry.schemaFingerprint).toBe(createHash("sha256").update(Buffer.concat(source)).digest("hex"));
    }
  });
  it("declares one inert public entry and no agent-side MCP service", async () => {
    expect(await json({ path: "mcp.json" })).toEqual({ mcpServers: {} });
    expect(await json({ path: "package.json" })).toMatchObject({ sideEffects: false, exports: { ".": { types: "./io.github.ainsep.openmarketing/src/index.ts", import: "./io.github.ainsep.openmarketing/dist/index.mjs" } } });
  });
});



it("declares canonical reads and the token/login app-credentials card", async () => {
  const root = new URL("../../", import.meta.url);
  const manifest = JSON.parse(await readCapabilityFile(new URL("plugin.json", root), "utf8"));
  expect(manifest.extensions["io.github.ainsep.openmarketing"].credentialCards[0]).toMatchObject({ saveKind: "app-credentials", secretFields: [{ name: "accessToken", required: true }, { name: "clientLogin", required: true }] });
  const declaration = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/capabilities.json", root), "utf8"));
  const fingerprint = createHash("sha256").update(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/src/capabilities.ts", root))).digest("hex");
  const capabilities = declaration.capabilities.filter((value: { capabilityId: string }) => ["report.metrics.v1", "campaign.status.v1"].includes(value.capabilityId));
  expect(capabilities.map((value: { capabilityId: string }) => value.capabilityId)).toEqual(["report.metrics.v1", "campaign.status.v1"]);
  for (const entry of capabilities) expect(entry).toMatchObject({ pluginId: "yandex-direct", admitted: false, effects: ["read"], schemaFingerprint: fingerprint });
  expect(manifest.extensions["io.github.ainsep.openmarketing"].capabilities).toEqual(declaration.capabilities);
  const evidence = JSON.parse(await readCapabilityFile(new URL("io.github.ainsep.openmarketing/evidence/primary-sources.json", root), "utf8"));
  expect(evidence.canonicalReadReview).toMatchObject({ checkedAt: "2026-10-26", liveVendorCalls: false });
});
