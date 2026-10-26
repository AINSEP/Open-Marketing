import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { translateCampaign, deployCampaignPaused, readCampaignDeployment, campaignDeploymentPlanSchema } from "../src/index.js";
import { deploymentFixture, deploymentRefs, pausedPlan, translationInput, pasted, now } from "./fixtures.js";

describe("fixed traffic translation and paused deployment", () => {
  it("translates exact integer budget/bid and all four fixed mappings", () => {
    expect(translateCampaign(translationInput())).toEqual({ ok: true, value: pausedPlan() });
  });
  it("rejects unsupported objective, audience, post and incomplete evidence before approval", () => {
    const input = translationInput();
    const unsupported = [ { ...input, campaign: { ...input.campaign, objective: "reach" } },
      { ...input, campaign: { ...input.campaign, audience: { countries: ["US", "CA"] } } },
      { ...input, campaign: { ...input.campaign, audience: { countries: ["US"], searchTerms: [] } } },
      { ...input, campaign: { ...input.campaign, creativeIds: ["creative", "other"] } }, { ...input, resolved: {} } ];
    for (const candidate of unsupported) expect(translateCampaign(candidate)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(translateCampaign({ ...input, target: { ...input.target, accountId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(translateCampaign({ ...input, target: { ...input.target, dailyBudget: { currency: "USD", minorUnits: Number.MAX_SAFE_INTEGER } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(translateCampaign({ ...input, campaign: { ...input.campaign, schedule: { ...input.campaign.schedule, window: { start: Number.MAX_SAFE_INTEGER - 1, end: Number.MAX_SAFE_INTEGER } } } })).toMatchObject({ ok: false });
  });
  it("sends PAUSED explicitly, reads each predecessor, and retains all four references", async () => {
    const f = deploymentFixture();
    expect(await deployCampaignPaused(f)).toMatchObject({ ok: true, value: { status: "acknowledged", references: deploymentRefs, entityIds: ["camp1", "line1", "target1", "post1"] } });
    expect(f.calls.map(call => [call.init.method, new URL(call.url).pathname.split("/").slice(4).join("/")])).toEqual([
      ["POST", "campaigns"], ["GET", "campaigns/camp1"], ["POST", "line_items"], ["GET", "line_items/line1"],
      ["POST", "targeting_criteria"], ["GET", "targeting_criteria/target1"], ["POST", "promoted_tweets"], ["GET", "promoted_tweets/post1"],
      ["GET", "campaigns/camp1"], ["GET", "line_items/line1"], ["GET", "targeting_criteria/target1"], ["GET", "promoted_tweets/post1"],
    ]);
    const writes = f.calls.filter(call => call.init.method === "POST").map(call => Object.fromEntries(new URL(call.url).searchParams));
    expect(writes[0]).toEqual({ name: "Fixture traffic", funding_instrument_id: "fund1", entity_status: "PAUSED", budget_optimization: "LINE_ITEM", daily_budget_amount_local_micro: "12340000" });
    expect(writes[1]).toMatchObject({ campaign_id: "camp1", entity_status: "PAUSED", objective: "WEBSITE_CLICKS", product_type: "PROMOTED_TWEETS", placements: "ALL_ON_TWITTER", bid_strategy: "MAX", goal: "LINK_CLICKS", bid_amount_local_micro: "450000", daily_budget_amount_local_micro: "12340000", standard_delivery: "true", start_time: f.plan.lineItem.start_time, end_time: f.plan.lineItem.end_time });
    expect(writes[2]).toEqual({ line_item_id: "line1", targeting_type: "LOCATION", operator_type: "EQ", targeting_value: "country1" });
    expect(writes[3]).toEqual({ line_item_id: "line1", tweet_ids: "1234567890123456789" });
    expect(f.journal).toHaveLength(8); expect(f.journal[7]).toEqual({ step: "promotedTweet", phase: "acknowledged", references: deploymentRefs });
    expect(f.calls.every(call => (call.init.headers as Record<string, string>).Authorization.startsWith("OAuth "))).toBe(true);
    const normalized = "budget_optimization=LINE_ITEM&daily_budget_amount_local_micro=12340000&entity_status=PAUSED&funding_instrument_id=fund1&name=Fixture%20traffic&oauth_consumer_key=consumer&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=" + Math.floor(now / 1000) + "&oauth_token=token&oauth_version=1.0";
    const signatureBase = "POST&https%3A%2F%2Fads-api.x.com%2F12%2Faccounts%2Fabc1%2Fcampaigns&" + encodeURIComponent(normalized);
    const signature = createHmac("sha1", "consumer-secret&token-secret").update(signatureBase).digest("base64");
    expect(new Headers(f.calls[0].init.headers).get("Authorization")).toContain('oauth_signature="' + encodeURIComponent(signature) + '"');
  });
  it.each([
    ["Fixture + traffic", "Fixture%20%2B%20traffic"],
    ["Fixture %20 & café=!*'()", "Fixture%20%2520%20%26%20caf%C3%A9%3D%21%2A%27%28%29"],
  ])("signs decoded campaign query values without changing the wire name: %s", async (name, encodedName) => {
    const f = deploymentFixture();
    f.plan.campaign.name = name; f.rows.campaigns.name = name;
    expect(await deployCampaignPaused(f)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(new URL(f.calls[0].url).searchParams.get("name")).toBe(name);
    expect(f.calls[0].init.body).toBeUndefined();
    // RFC 5849 §3.4.1.3: query values are decoded before OAuth percent encoding.
    const normalized = "budget_optimization=LINE_ITEM&daily_budget_amount_local_micro=12340000&entity_status=PAUSED&funding_instrument_id=fund1&name=" + encodedName + "&oauth_consumer_key=consumer&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=" + Math.floor(now / 1000) + "&oauth_token=token&oauth_version=1.0";
    const signatureBase = "POST&https%3A%2F%2Fads-api.x.com%2F12%2Faccounts%2Fabc1%2Fcampaigns&" + encodeURIComponent(normalized);
    const signature = createHmac("sha1", "consumer-secret&token-secret").update(signatureBase).digest("base64");
    expect(new Headers(f.calls[0].init.headers).get("Authorization")).toContain('oauth_signature="' + encodeURIComponent(signature) + '"');
  });
  it.each([
    ["campaigns", "entity_status", "ACTIVE"], ["campaigns", "servable", true], ["campaigns", "daily_budget_amount_local_micro", 1], ["campaigns", "funding_instrument_id", "foreign"],
    ["line_items", "campaign_id", "foreign"], ["line_items", "bid_amount_local_micro", 2], ["line_items", "start_time", "2020-01-01T00:00:00Z"],
    ["line_items", "placements", ["PUBLISHER_NETWORK"]], ["line_items", "currency", "EUR"],
    ["targeting_criteria", "targeting_value", "foreign"], ["targeting_criteria", "operator_type", "NE"], ["targeting_criteria", "line_item_id", "foreign"],
    ["promoted_tweets", "tweet_id", "99"], ["promoted_tweets", "line_item_id", "foreign"], ["promoted_tweets", "deleted", true],
  ])("stops without losing candidates on readback mismatch %s.%s", async (resource, key, value) => {
    const f = deploymentFixture(); f.rows[String(resource)][String(key)] = value;
    const result = await deployCampaignPaused(f);
    const step = { campaigns: "campaign", line_items: "lineItem", targeting_criteria: "targeting", promoted_tweets: "promotedTweet" }[String(resource)]!;
    const index = ["campaign", "lineItem", "targeting", "promotedTweet"].indexOf(step);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references: Object.fromEntries(Object.entries(deploymentRefs).slice(0, index + 1)) } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(index + 1);
  });
  it.each(["campaigns", "line_items", "targeting_criteria", "promoted_tweets"])("unknown %s creation is never resent, including recovery", async resource => {
    const f = deploymentFixture({ response: ({ url, method, data }) => { if (method === "POST" && url.pathname.endsWith(resource)) throw new Error("lost response secret"); return Response.json(data); } });
    const result = await deployCampaignPaused(f);
    expect(result).toMatchObject({ ok: true, value: { status: "unknown" } });
    if (!result.ok) throw new Error("fixture result");
    const before = f.calls.filter(call => call.init.method === "POST").length;
    const read = await readCampaignDeployment({ ...f, references: result.value.references });
    expect(read).toMatchObject({ ok: true, value: { status: "unknown", references: result.value.references } });
    await deployCampaignPaused(f);
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(before);
    expect(JSON.stringify(result)).not.toContain("secret");
  });
  it.each(["campaign", "lineItem", "targeting", "promotedTweet"])("keeps %s ID when acknowledgement checkpoint fails", async step => {
    const f = deploymentFixture({ checkpointFault: input => input.step === step && input.phase === "acknowledged" });
    expect(await deployCampaignPaused(f)).toMatchObject({ ok: true, value: { status: "unknown", references: { [step]: deploymentRefs[step as keyof typeof deploymentRefs] } } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(["campaign", "lineItem", "targeting", "promotedTweet"].indexOf(step) + 1);
  });
  it("rejects active/extra/unsafe plans before checkpoint or credentials", async () => {
    const f = deploymentFixture();
    const bad = [{ ...f.plan, campaign: { ...f.plan.campaign, entity_status: "ACTIVE" } }, { ...f.plan, endpoint: "https://foreign.invalid" }, { ...f.plan, lineItem: { ...f.plan.lineItem, bid_amount_local_micro: Number.MAX_SAFE_INTEGER + 1 } }];
    for (const plan of bad) {
      expect(campaignDeploymentPlanSchema.safeParse(plan).success).toBe(false);
      expect(await deployCampaignPaused({ ...f, plan })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(f.journal).toEqual([]); expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it("admission false, foreign scope, cancel and post-credential withdrawal prevent egress", async () => {
    const f = deploymentFixture(); f.setAdmission({ admitted: false });
    expect(await deployCampaignPaused(f)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.setAdmission({ admitted: true });
    expect(await deployCampaignPaused({ ...f, context: { ...f.context, scope: { ...f.context.scope, ownerId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await deployCampaignPaused(f, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.credentialCalls).toEqual([]); expect(f.journal).toEqual([]);
    f.dependencies.credentials.access = async () => { f.setAdmission({ admitted: false }); return { ok: true, value: { accessToken: JSON.stringify(pasted) } }; };
    expect(await deployCampaignPaused(f)).toMatchObject({ ok: true, value: { status: "unknown" } }); expect(f.calls).toEqual([]);
  });
  it("reconciles complete references with GETs only and rejects account echoes", async () => {
    const f = deploymentFixture({ response: ({ data }) => Response.json({ ...data, request: { params: { account_id: "foreign" } } }) });
    expect(await readCampaignDeployment({ ...f, references: deploymentRefs })).toMatchObject({ ok: true, value: { status: "unknown", references: deploymentRefs } });
    expect(f.calls.map(call => call.init.method)).toEqual(["GET"]);
    const valid = deploymentFixture();
    expect(await readCampaignDeployment({ ...valid, references: deploymentRefs })).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(valid.calls.map(call => call.init.method)).toEqual(["GET", "GET", "GET", "GET"]);
  });
  it("retains the complete hierarchy if the final parent readback changes", async () => {
    let campaignReads = 0;
    const f = deploymentFixture({ response: ({ url, method, data }) => {
      if (method === "GET" && url.pathname.endsWith("campaigns/camp1") && ++campaignReads === 2) return Response.json({ ...data, data: { ...(data.data as object), entity_status: "ACTIVE" } });
      return Response.json(data);
    } });
    expect(await deployCampaignPaused(f)).toMatchObject({ ok: true, value: { status: "unknown", references: deploymentRefs } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(4);
  });
  it("freezes reviewed input and isolates checkpoint reference mutation", async () => {
    const f = deploymentFixture(); const original = f.dependencies.credentials.access;
    f.dependencies.credentials.access = async input => { f.plan.campaign.name = "altered"; f.plan.promotedTweet.tweet_ids = "99"; return original(input); };
    const result = await deployCampaignPaused({ ...f, checkpoint: async input => { const outcome = await f.checkpoint(input); input.references.campaign = "foreign"; return outcome; } });
    expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: deploymentRefs } });
    expect(new URL(f.calls[0].url).searchParams.get("name")).toBe("Fixture traffic");
    expect(new URL(f.calls[6].url).searchParams.get("tweet_ids")).toBe("1234567890123456789");
  });
  it("a thrown dispatch checkpoint stops without credential access or network", async () => {
    const f = deploymentFixture();
    expect(await deployCampaignPaused({ ...f, checkpoint: async () => { throw new Error("journal unavailable"); } })).toMatchObject({ ok: true, value: { status: "unknown", references: {} } });
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  });
});
