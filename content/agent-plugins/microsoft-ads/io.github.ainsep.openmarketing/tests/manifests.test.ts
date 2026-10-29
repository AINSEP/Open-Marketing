import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { microsoftAdsTools } from "../src/index.js";
import { fixture } from "./fixtures.js";
it("keeps portable packaging inert with read tools and disabled server backends", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
  const capabilities = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));
  expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ enabled: false, admitted: false, capabilities: capabilities.capabilities });
  expect(capabilities.tools.map((tool: { name: string }) => tool.name)).toEqual(microsoftAdsTools.map(tool => tool.name));
  expect(capabilities.tools.map((tool: { effects: string[] }) => tool.effects)).toEqual([["read"], ["read"], ["read"]]);
  const files: Record<string, string> = { "campaign.read.v1": "commands.ts", "report.account-spend.v1": "reporting.ts", "campaign.create-paused.v1": "campaign-translation.ts", "conversion.deliver.v1": "capi.ts", "report.metrics.v1": "reporting.ts", "campaign.status.v1": "reporting.ts" };
  for (const capability of capabilities.capabilities) {
    const file = files[capability.capabilityId];
    if (!file) throw new Error("Unmapped capability: " + capability.capabilityId);
    expect(capability.schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("../src/" + file, import.meta.url))).digest("hex"));
  }
  expect(capabilities.capabilities.some((row: { capabilityId: string }) => row.capabilityId === "report.metrics.v1")).toBe(true);
  expect(capabilities.capabilities.some((row: { capabilityId: string }) => row.capabilityId === "campaign.status.v1")).toBe(false);
  expect(capabilities.deployment).toMatchObject({ create: "deployCampaignPaused", read: "readCampaignDeployment", admitted: false });
  expect(capabilities.backendConversion).toMatchObject({ agentTool: false, effects: ["conversion"] });
  const oauth = JSON.parse(readFileSync(new URL("../oauth.json", import.meta.url), "utf8"));
  expect(oauth.provider).toMatchObject({ usesPkce: true, clientAuth: "client_secret_post", supportedGrants: ["authorization_code"], defaultScopes: ["https://ads.microsoft.com/msads.manage", "offline_access"] });
  const f = fixture(); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]); expect(f.downloads).toEqual([]);
});
