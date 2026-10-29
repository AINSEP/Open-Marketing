import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { appleSearchAdsTools } from "../src/index.js";

it("advertises only two native reads with no capability declarations and keeps deployment metadata disabled", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
  const capabilities = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  expect(manifest.name).toBe("apple-search-ads"); expect(extension.enabled).toBe(false); expect(extension.admitted).toBe(false);
  expect(appleSearchAdsTools.map(tool => [tool.name, tool.effect])).toEqual([["list_accounts", "read"], ["list_campaigns", "read"]]);
  expect(capabilities.tools).toEqual([{ name: "list_accounts", effects: ["read"] }, { name: "list_campaigns", effects: ["read"] }]);
  expect(capabilities.capabilities).toEqual([]);
  expect(extension.capabilities).toEqual(capabilities.capabilities); expect(capabilities.admitted).toBe(false);
  expect(capabilities.deployment).toEqual({ create: "deployCampaignPaused", read: "readCampaignDeployment", planSchema: "campaignDeploymentPlanSchema", admitted: false });
  const evidence = JSON.parse(readFileSync(new URL("../evidence/primary-sources.json", import.meta.url), "utf8"));
  expect(evidence.apiVersion).toBe("v1"); expect(evidence.admitted).toBe(false);
  expect(evidence.facts.length).toBeGreaterThan(0);
  for (const fact of evidence.facts) { expect(fact.url).toMatch(/^https:\/\/(developer\.apple\.com|ads\.apple\.com)\//); expect(fact.quote.length).toBeGreaterThan(0); }
});
