import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { appleSearchAdsTools } from "../src/index.js";

it("advertises exactly the three implemented reads, disabled with matching source metadata", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
  const capabilities = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  expect(manifest.name).toBe("apple-search-ads"); expect(extension.enabled).toBe(false); expect(extension.admitted).toBe(false);
  expect(appleSearchAdsTools.map(tool => [tool.name, tool.effect])).toEqual([["list_accounts", "read"], ["list_campaigns", "read"], ["report", "read"]]);
  expect(capabilities.tools).toEqual([{ name: "list_accounts", effects: ["read"], capabilityId: "campaign.read.v1" }, { name: "list_campaigns", effects: ["read"], capabilityId: "campaign.read.v1" }, { name: "report", effects: ["read"], capabilityId: "report.account-spend.v1" }]);
  const hash = createHash("sha256");
  for (const file of ["commands", "reporting", "transport"]) hash.update(readFileSync(new URL("../src/" + file + ".ts", import.meta.url)));
  const fingerprint = hash.digest("hex");
  const deploymentHash = createHash("sha256");
  for (const file of ["campaign-translation", "campaign-deployment"]) deploymentHash.update(readFileSync(new URL("../src/" + file + ".ts", import.meta.url)));
  expect(capabilities.capabilities).toEqual([
    ...["campaign.read.v1", "report.account-spend.v1"].map(capabilityId => ({ capabilityId, version: 1, pluginId: "apple-search-ads", schemaFingerprint: fingerprint, admitted: false, effects: ["read"] })),
    { capabilityId: "campaign.create-draft.v1", version: 1, pluginId: "apple-search-ads", schemaFingerprint: deploymentHash.digest("hex"), admitted: false, effects: ["write"] },
  ]);
  expect(extension.capabilities).toEqual(capabilities.capabilities); expect(capabilities.admitted).toBe(false);
  expect(capabilities.deployment).toEqual({ capabilityId: "campaign.create-draft.v1", create: "deployCampaignPaused", read: "readCampaignDeployment", planSchema: "campaignDeploymentPlanSchema", admitted: false });
  const evidence = JSON.parse(readFileSync(new URL("../evidence/primary-sources.json", import.meta.url), "utf8"));
  expect(evidence.apiVersion).toBe("v5"); expect(evidence.admitted).toBe(false);
  expect(evidence.facts.length).toBeGreaterThan(0);
  for (const fact of evidence.facts) { expect(fact.url).toMatch(/^https:\/\/developer\.apple\.com\//); expect(fact.quote.length).toBeGreaterThan(0); }
});
