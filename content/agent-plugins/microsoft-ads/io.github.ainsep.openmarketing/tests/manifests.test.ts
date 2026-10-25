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
  for (const [index, file] of ["commands.ts", "reporting.ts", "campaign-translation.ts", "capi.ts"].entries()) expect(capabilities.capabilities[index].schemaFingerprint).toBe(createHash("sha256").update(readFileSync(new URL("../src/" + file, import.meta.url))).digest("hex"));
  expect(capabilities.deployment).toMatchObject({ create: "deployCampaignPaused", read: "readCampaignDeployment", admitted: false });
  expect(capabilities.backendConversion).toMatchObject({ agentTool: false, effects: ["conversion"] });
  const oauth = JSON.parse(readFileSync(new URL("../oauth.json", import.meta.url), "utf8"));
  expect(oauth.provider).toMatchObject({ usesPkce: true, clientAuth: "client_secret_post", supportedGrants: ["authorization_code"], defaultScopes: ["https://ads.microsoft.com/msads.manage", "offline_access"] });
  const f = fixture(); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]); expect(f.downloads).toEqual([]);
});
