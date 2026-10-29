import { expect, it } from "vitest";
import { campaignDeploymentPlanSchema, createMicrosoftAdsAdapter, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import { campaignReadWithNullError, deploymentFixture, fixture, invocation, translationInput } from "./fixtures.js";
import { deploymentDispatchSuite } from "./contract/dispatch-suite.js";

deploymentDispatchSuite({ name: "Memory owning outbox with Microsoft REST transport", makeFixture: deploymentFixture });

it("translates the entire Search plan, cents/CPC, explicit paused states and exclusive local end", () => {
  const result = translateCampaign(translationInput());
  expect(result).toMatchObject({ ok: true, value: { accountId: "123", currency: "USD", campaign: { Status: "Paused", DailyBudget: 12.34, BudgetType: "DailyBudgetStandard", TimeZone: "PacificTimeUSCanadaTijuana", BiddingScheme: { Type: "MaxClicks", MaxCpc: { Amount: 1.23 } } }, locations: [{ country: "US", id: "190" }],
    adGroup: { Status: "Paused", Language: "English", AdGroupType: "SearchStandard", StartDate: { Year: 2026, Month: 10, Day: 12 }, EndDate: { Year: 2026, Month: 10, Day: 12 } }, keywords: [{ Text: "fixture shoes", MatchType: "Exact", Status: "Paused" }, { Text: "fixture boots", MatchType: "Exact", Status: "Paused" }], ad: { Type: "ResponsiveSearch", Status: "Paused", FinalUrls: ["https://example.com/shoes"] } } });
});
it("keeps a 25-hour DST local day as one inclusive date", () => {
  const input = translationInput(); input.campaign.schedule.window = { start: Date.UTC(2026, 10, 1, 7), end: Date.UTC(2026, 10, 2, 8) };
  expect(translateCampaign(input)).toMatchObject({ ok: true, value: { adGroup: { StartDate: { Year: 2026, Month: 11, Day: 1 }, EndDate: { Year: 2026, Month: 11, Day: 1 } } } });
});
it.each(["subday", "country", "duplicate-country", "duplicate-location", "duplicate-keyword", "creative", "currency", "exponent", "headlines", "dynamic", "timezone"])("rejects unsupported or conflicting translation: %s", kind => {
  const input = translationInput();
  switch (kind) {
    case "subday": input.campaign.schedule.window.start++; break;
    case "country": input.campaign.audience.countries.push("CA"); break;
    case "duplicate-country": input.campaign.audience.countries.push("US"); break;
    case "duplicate-location": input.resolved.locations.push({ country: "US", id: "191" }); break;
    case "duplicate-keyword": input.campaign.audience.searchTerms.push("FIXTURE SHOES"); break;
    case "creative": input.resolved.creativeDigest = "c".repeat(64); break;
    case "currency": input.target.dailyBudget.currency = "EUR"; break;
    case "exponent": input.resolved.currencyExponent = 0; break;
    case "headlines": input.resolved.ad.Headlines.pop(); break;
    case "dynamic": input.resolved.ad.Headlines[0].Asset.Text = "{keyword}"; break;
    case "timezone": input.campaign.schedule.timezone = "Asia/Tokyo"; break;
  }
  expect(translateCampaign(input).ok).toBe(false);
});
it("requires each scoped readback before the next create and verifies every reviewed field", async () => {
  const f = deploymentFixture(), result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: { campaign: "1001", location0: "2001", locationIntent: "2002", adGroup: "3001", keyword0: "4001", keyword1: "4002", ad: "5001" }, hierarchy: expect.any(Array) } });
  const requests = f.calls.map(call => ({ path: new URL(call.url).pathname.split("/v13/")[1], body: JSON.parse(String(call.init.body)) }));
  expect(requests.slice(0, 11).map(item => item.path)).toEqual(["Campaigns", "Campaigns/QueryByIds", "CampaignCriterions", "CampaignCriterions/QueryByIds", "CampaignCriterions/QueryByIds", "AdGroups", "AdGroups/QueryByIds", "Keywords", "Keywords/QueryByIds", "Ads", "Ads/QueryByIds"]);
  expect([requests[1].body, requests[3].body, requests[4].body, requests[10].body]).toEqual([{ AccountId: "123", CampaignIds: ["1001"] }, { CampaignId: "1001", CriterionType: "Location", CampaignCriterionIds: ["2001"] }, { CampaignId: "1001", CriterionType: "LocationIntent", CampaignCriterionIds: ["2002"] }, { AdGroupId: "3001", AdIds: ["5001"], AdTypes: ["ResponsiveSearch"] }]);
  expect(requests[0].body).toMatchObject({ AccountId: "123", Campaigns: [{ Status: "Paused", DailyBudget: 12.34 }] });
  expect(requests[2].body).toEqual({ CriterionType: "Targets", CampaignCriterions: [{ Type: "BiddableCampaignCriterion", CampaignId: "1001", Criterion: { Type: "LocationCriterion", LocationId: "190" } }, { Type: "BiddableCampaignCriterion", CampaignId: "1001", Criterion: { Type: "LocationIntentCriterion", IntentOption: "PeopleIn" } }] });
  expect(requests[5].body.CampaignId).toBe("1001"); expect(requests[7].body.AdGroupId).toBe("3001"); expect(requests[9].body.Ads[0].Status).toBe("Paused");
  expect(f.checkpoints).toHaveLength(10); expect(f.dispatches).toEqual([]);
  expect(f.calls.every(call => call.init.redirect === "error" && new Headers(call.init.headers).get("CustomerAccountId") === "123")).toBe(true);
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
});
it.each([1, 2, 3, 4, 5])("stops at unknown create %s, saves prior IDs, and never repeats it", async failWrite => {
  const f = deploymentFixture(); f.deploymentState.failWrite = failWrite;
  const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.deploymentState.writes).toBe(failWrite);
  if (result.ok) expect(result.value.references.campaign).toBe(failWrite === 1 ? undefined : "1001");
  await deployCampaignPaused(f.input); expect(f.deploymentState.writes).toBe(failWrite);
});
it.each([
  { path: "Campaigns", writes: 1, references: { campaign: "1001" } },
  { path: "CampaignCriterions", writes: 2, references: { campaign: "1001", location0: "2001", locationIntent: "2002" } },
  { path: "AdGroups", writes: 3, references: { campaign: "1001", location0: "2001", locationIntent: "2002", adGroup: "3001" } },
  { path: "Keywords", writes: 4, references: { campaign: "1001", location0: "2001", locationIntent: "2002", adGroup: "3001", keyword0: "4001", keyword1: "4002" } },
  { path: "Ads", writes: 5, references: { campaign: "1001", location0: "2001", locationIntent: "2002", adGroup: "3001", keyword0: "4001", keyword1: "4002", ad: "5001" } },
])("checkpoints late $path IDs before returning unknown and never replays", async late => {
  const f = deploymentFixture(), fetch = f.input.dependencies.fetch;
  f.input.dependencies = { ...f.input.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith("/" + late.path)) f.advanceTime({ milliseconds: 15000 });
    return response;
  } };
  const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: late.references, entityIds: Object.values(late.references) } });
  expect(f.checkpoints.at(-1)).toEqual({ step: ["campaign", "locations", "adGroup", "keywords", "ad"][late.writes - 1], phase: "acknowledged", references: late.references });
  expect(f.calls.at(-1)?.url.endsWith("/" + late.path)).toBe(true);
  expect(f.deploymentState.writes).toBe(late.writes);
  await deployCampaignPaused(f.input);
  expect(f.deploymentState.writes).toBe(late.writes);
});
it("retains late IDs even when their checkpoint fails", async () => {
  const f = deploymentFixture(), fetch = f.input.dependencies.fetch;
  f.deploymentState.checkpointFail = 2;
  f.input.dependencies = { ...f.input.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init); f.advanceTime({ milliseconds: 15000 }); return response;
  } };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "1001" }, entityIds: ["1001"] } });
  expect(f.checkpoints.at(-1)?.references).toEqual({ campaign: "1001" });
  expect(f.calls).toHaveLength(1);
});
it("checkpoints every valid ID in a cancelled mixed-null batch without reading or creating again", async () => {
  const f = deploymentFixture(), fetch = f.input.dependencies.fetch, cancellation = new AbortController();
  f.input.dependencies = { ...f.input.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith("/Keywords")) return response;
    cancellation.abort();
    return Response.json({ KeywordIds: [null, 4002], PartialErrors: [{ Code: 1 }] });
  } };
  expect(await deployCampaignPaused(f.input, { signal: cancellation.signal })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "1001", location0: "2001", locationIntent: "2002", adGroup: "3001", keyword1: "4002" } } });
  expect(f.checkpoints.at(-1)?.references.keyword1).toBe("4002");
  expect(f.calls.at(-1)?.url.endsWith("/Keywords")).toBe(true);
  await deployCampaignPaused(f.input);
  expect(f.deploymentState.writes).toBe(4);
});
it("accepts the independent campaign read fixture with a successful null error slot", async () => {
  const f = deploymentFixture(), fetch = f.input.dependencies.fetch;
  f.input.dependencies = { ...f.input.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    return String(url).endsWith("/Campaigns/QueryByIds") ? Response.json(campaignReadWithNullError) : response;
  } };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged", references: { ad: "5001" } } });
  expect(f.deploymentState.writes).toBe(5);
});
it.each([{ errors: [null, { Code: 1 }] }, { errors: [false] }, { errors: ["unverified-error"] }])("blocks children for non-null read errors: $errors", async ({ errors }) => {
  const f = deploymentFixture(), fetch = f.input.dependencies.fetch;
  f.input.dependencies = { ...f.input.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    return String(url).endsWith("/Campaigns/QueryByIds") ? Response.json({ ...campaignReadWithNullError, PartialErrors: errors }) : response;
  } };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "1001" } } });
  expect(f.deploymentState.writes).toBe(1);
});
it("keeps late provider bodies out of public read failures and telemetry", async () => {
  const f = fixture(), fetch = f.dependencies.fetch;
  const adapter = createMicrosoftAdsAdapter({ ...f.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init); f.advanceTime({ milliseconds: 15000 }); return response;
  } });
  const result = await adapter.invoke(invocation());
  expect(result).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(result).not.toHaveProperty("receivedBody");
  expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
});
it.each([2, 4])("records ALL IDs even when batch %s includes PartialErrors", async partialWrite => {
  const f = deploymentFixture(); f.deploymentState.partialWrite = partialWrite;
  const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: partialWrite === 2 ? { location0: "2001", locationIntent: "2002" } : { keyword0: "4001", keyword1: "4002" } } });
  expect(f.deploymentState.writes).toBe(partialWrite);
  expect(f.checkpoints.at(-1)?.references).toEqual(result.ok ? result.value.references : {});
});
it.each([2, 4, 6, 8, 10])("preserves candidates when acknowledgement checkpoint %s fails", async checkpointFail => {
  const f = deploymentFixture(); f.deploymentState.checkpointFail = checkpointFail;
  const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(result.ok && result.value.entityIds.length).toBeGreaterThan(0);
  expect(f.deploymentState.writes).toBe(checkpointFail / 2);
});
it.each([
  { collection: "Campaigns", field: "Status", value: "Active", writes: 1 },
  { collection: "Campaigns", field: "AccountId", value: "999", writes: 1 },
  { collection: "Campaigns", field: "DailyBudget", value: 99, writes: 1 },
  { collection: "Campaigns", field: "BudgetId", value: 999, writes: 1 },
  { collection: "Campaigns", field: "TimeZone", value: "EasternTimeUSCanada", writes: 1 },
  { collection: "Campaigns", field: "BiddingScheme", value: { Type: "MaxClicks", MaxCpc: { Amount: 99 } }, writes: 1 },
  { collection: "CampaignCriterions", field: "CampaignId", value: 999, writes: 2 },
  { collection: "CampaignCriterions", field: "Criterion", value: { Type: "LocationCriterion", LocationId: 999 }, writes: 2 },
  { collection: "AdGroups", field: "StartDate", value: { Year: 2026, Month: 10, Day: 13 }, writes: 3 },
  { collection: "AdGroups", field: "Status", value: "Active", writes: 3 },
  { collection: "Keywords", field: "MatchType", value: "Broad", writes: 4 },
  { collection: "Ads", field: "FinalUrls", value: ["https://wrong.example"], writes: 5 },
])("blocks child writes on drift: $collection.$field", async change => {
  const f = deploymentFixture(); f.deploymentState.readHook = input => { if (input.path.startsWith(change.collection + "/")) input.rows[0][change.field] = change.value; };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.deploymentState.writes).toBe(change.writes);
});
it("rejects active/inflated plans and malformed dates before checkpoint/secret/network", async () => {
  const f = deploymentFixture(), plan = structuredClone(f.input.plan) as Record<string, unknown>;
  expect(campaignDeploymentPlanSchema.safeParse({ ...plan, activate: true }).success).toBe(false);
  expect(await deployCampaignPaused({ ...f.input, plan: { ...plan, campaign: { ...(plan.campaign as object), Status: "Active" } } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  expect(await deployCampaignPaused({ ...f.input, plan: { ...plan, adGroup: { ...(plan.adGroup as object), StartDate: { Year: 2026, Month: 2, Day: 31 } } } })).toMatchObject({ ok: false });
  expect(f.checkpoints).toEqual([]); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it("retains all candidates in a mixed-null keyword acknowledgement", async () => {
  const f = deploymentFixture(), fetch = f.input.dependencies.fetch;
  f.input.dependencies = { ...f.input.dependencies, fetch: async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith("/Keywords")) return Response.json({ KeywordIds: [null, 4002], PartialErrors: [{ Code: 1 }] });
    return response;
  } };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "1001", keyword1: "4002" } } });
  expect(f.deploymentState.writes).toBe(4); expect(f.checkpoints.at(-1)?.references.keyword1).toBe("4002");
});
it("accepts enriched text assets and documented retrieved discriminator variants", async () => {
  const f = deploymentFixture(); f.deploymentState.readHook = input => {
    for (const row of input.rows) {
      if (input.path.startsWith("Campaigns/")) row.BiddingScheme = { Type: "MaxClicksBiddingScheme", MaxCpc: { Amount: 1.23 } };
      if (input.path.startsWith("CampaignCriterions/")) { const criterion = row.Criterion as { Type: string }; criterion.Type = criterion.Type === "LocationCriterion" ? "Location" : "LocationIntent"; }
      if (input.path.startsWith("Ads/")) row.Headlines = (row.Headlines as { Asset: object }[]).map(item => ({ ...item, Asset: { ...item.Asset, Id: "999" }, PinnedField: null, EditorialStatus: "Pending" }));
    }
  };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
});
it("freezes the reviewed plan before mutable checkpoint input can change it", async () => {
  const f = deploymentFixture(); f.deploymentState.beforeCheckpoint = () => { (f.input.plan as { campaign: { DailyBudget: number } }).campaign.DailyBudget = 99; };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  expect(JSON.parse(String(f.calls[0].init.body)).Campaigns[0].DailyBudget).toBe(12.34);
});
it("keeps every saved reference when the final hierarchy readback drifts", async () => {
  const f = deploymentFixture(); f.deploymentState.readHook = input => { if (f.deploymentState.writes === 5 && input.path.startsWith("Campaigns/")) input.rows[0].Status = "Active"; };
  const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "1001", location0: "2001", locationIntent: "2002", adGroup: "3001", keyword0: "4001", keyword1: "4002", ad: "5001" } } });
  expect(f.deploymentState.writes).toBe(5);
  expect(result.ok && result.value.entityIds).toHaveLength(7);
});
it("rejects pinned or changed creative text with all candidate IDs retained", async () => {
  const f = deploymentFixture(); f.deploymentState.readHook = input => { if (input.path.startsWith("Ads/")) input.rows[0].Headlines = [{ Asset: { Type: "TextAsset", Text: "Wrong" }, PinnedField: "Headline1" }]; };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { ad: "5001" } } });
  expect(f.deploymentState.writes).toBe(5);
});
it("cancelled, cross-workspace and oversized inputs stop before any host effects", async () => {
  const f = deploymentFixture();
  expect(await deployCampaignPaused(f.input, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(await deployCampaignPaused({ ...f.input, context: { ...f.input.context, scope: { ownerId: "owner", workspaceId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await deployCampaignPaused({ ...f.input, plan: { extra: "x".repeat(65536) } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  expect(f.checkpoints).toEqual([]); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it("keeps GET-only reconciliation closed because vendor queries require POST", async () => {
  const f = deploymentFixture();
  expect(await readCampaignDeployment({ ...f.input, references: { campaign: "1001" } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  expect(f.calls).toEqual([]); expect(f.credentials).toEqual([]); expect(f.checkpoints).toEqual([]);
});
