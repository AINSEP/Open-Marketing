import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { yandexDirectTools } from "../src/index.js";

const root = new URL("../../", import.meta.url);
async function json(required: { path: string }): Promise<unknown> { return JSON.parse(await readFile(new URL(required.path, root), "utf8")) as unknown; }
const capability = z.strictObject({ capabilityId: z.enum(["campaign.read.v1", "report.account-spend.v1", "campaign.create-draft.v1"]), version: z.literal(1), pluginId: z.literal("yandex-direct"), schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/), admitted: z.literal(false), effects: z.union([z.tuple([z.literal("read")]), z.tuple([z.literal("write")])]) });
describe("Yandex portable package", () => {
  it("ships disabled/unadmitted with read-only tools and a grouped draft backend", async () => {
    const manifest = z.object({ name: z.literal("yandex-direct"), extensions: z.strictObject({ "io.github.ainsep.openmarketing": z.strictObject({ version: z.literal(1), enabled: z.literal(false), admitted: z.literal(false), capabilities: z.array(capability).length(3) }) }) }).parse(await json({ path: "plugin.json" }));
    const declaration = z.strictObject({ version: z.literal(1), admitted: z.literal(false), capabilities: z.array(capability).length(3), tools: z.array(z.strictObject({ name: z.enum(["list_accounts", "list_campaigns", "report"]), effects: z.tuple([z.literal("read")]), capabilityId: capability.shape.capabilityId })).length(3), fingerprintBasis: z.string(), deployment: z.strictObject({ capabilityId: z.literal("campaign.create-draft.v1"), create: z.literal("deployCampaignPaused"), read: z.literal("readCampaignDeployment"), planSchema: z.literal("campaignDeploymentPlanSchema"), admitted: z.literal(false) }) }).parse(await json({ path: "io.github.ainsep.openmarketing/capabilities.json" }));
    expect(declaration.capabilities).toEqual(manifest.extensions["io.github.ainsep.openmarketing"].capabilities);
    expect(declaration.tools).toEqual([{ name: "list_accounts", effects: ["read"], capabilityId: "campaign.read.v1" }, { name: "list_campaigns", effects: ["read"], capabilityId: "campaign.read.v1" }, { name: "report", effects: ["read"], capabilityId: "report.account-spend.v1" }]);
    expect(yandexDirectTools.map(tool => [tool.name, tool.effect])).toEqual([["list_accounts", "read"], ["list_campaigns", "read"], ["report", "read"]]);
    for (const entry of declaration.capabilities) {
      expect(entry.effects).toEqual(entry.capabilityId === "campaign.create-draft.v1" ? ["write"] : ["read"]);
      const files = entry.capabilityId === "campaign.read.v1" ? ["commands.ts", "transport.ts"] : entry.capabilityId === "campaign.create-draft.v1" ? ["commands.ts", "campaign-translation.ts", "campaign-deployment.ts"] : ["commands.ts", "reporting.ts", "transport.ts"];
      const source = await Promise.all(files.map(file => readFile(new URL("io.github.ainsep.openmarketing/src/" + file, root))));
      expect(entry.schemaFingerprint).toBe(createHash("sha256").update(Buffer.concat(source)).digest("hex"));
    }
  });
  it("declares one inert public entry and no agent-side MCP service", async () => {
    expect(await json({ path: "mcp.json" })).toEqual({ mcpServers: {} });
    expect(await json({ path: "package.json" })).toMatchObject({ sideEffects: false, exports: { ".": { types: "./io.github.ainsep.openmarketing/src/index.ts", import: "./io.github.ainsep.openmarketing/dist/index.mjs" } } });
  });
});
