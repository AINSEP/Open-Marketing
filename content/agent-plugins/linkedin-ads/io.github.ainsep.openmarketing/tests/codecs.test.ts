import { describe, expect, it } from "vitest";
import { encodeLinkedInCommand, linkedinAdsTools } from "../src/index.js";
import { campaign, conversionRule, draft, now, reportCommand } from "./fixtures.js";

function encode(required: { input: unknown }) { return encodeLinkedInCommand({ input: required.input, accountId: "123", currency: "USD" }); }
describe("closed LinkedIn R1 codecs", () => {
  it("maps a Sponsored Content campaign to PAUSED with explicit geo, bid, locale and political intent", () => {
    const encoded = encode({ input: campaign });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error("Fixture encode failed");
    expect(encoded.value.effect).toBe("write");
    expect(encoded.value.request.url).toBe("https://api.linkedin.com/rest/adAccounts/123/adCampaigns");
    expect(JSON.parse(encoded.value.request.body ?? "")).toEqual({ account: "urn:li:sponsoredAccount:123", campaignGroup: "urn:li:sponsoredCampaignGroup:456", associatedEntity: "urn:li:organization:789", name: "Fixture campaign", locale: { country: "US", language: "en" }, costType: "CPC", dailyBudget: { amount: "43.21", currencyCode: "USD" }, unitCost: { amount: "2.37", currencyCode: "USD" }, runSchedule: { start: now, end: now + 86400000 }, politicalIntent: "NOT_POLITICAL", type: "SPONSORED_UPDATES", status: "PAUSED", offsiteDeliveryEnabled: false, audienceExpansionEnabled: false, targetingCriteria: { include: { and: [{ or: { "urn:li:adTargetingFacet:locations": ["urn:li:geo:103644278"] } }] } } });
  });
  it("forces PAUSED creative intent around an existing post", () => {
    const input = { kind: "create_creative_paused", campaignId: "567", reference: "urn:li:ugcPost:987" };
    expect(encode({ input })).toEqual({ ok: true, value: { effect: "write", request: { url: "https://api.linkedin.com/rest/adAccounts/123/creatives", method: "POST", restliMethod: "CREATE", body: '{"campaign":"urn:li:sponsoredCampaign:567","content":{"reference":"urn:li:ugcPost:987"},"intendedStatus":"PAUSED"}' } } });
  });
  it.each([
    { ...draft, runSchedule: { start: now } },
    { ...draft, runSchedule: { start: now, end: now } },
    { ...draft, name: "é".repeat(101) },
    { ...draft, status: "ACTIVE" },
    { ...campaign, dailyBudget: { amount: "43.21", currencyCode: "EUR" } },
    { ...campaign, geoIds: ["123", "123"] },
    { kind: "list_campaigns", ids: ["1", "1"] },
    { kind: "list_accounts", pageSize: 101 },
    { kind: "list_accounts", ids: ["1)&x=2"] },
    { kind: "pause", campaignId: "567", dailyBudget: { amount: "99", currencyCode: "USD" } },
    { kind: "create_creative_paused", campaignId: "567", reference: "https://unverified.example" },
  ])("rejects unsupported fields, mismatched currency and invalid aggregate bounds", input => { expect(encode({ input })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); });
  it.each([
    ["list_accounts", "https://api.linkedin.com/rest/adAccounts?q=search&pageSize=7&search=(id:(values:List(456)))&pageToken=a%26b"],
    ["list_campaign_groups", "https://api.linkedin.com/rest/adAccounts/123/adCampaignGroups?q=search&pageSize=7&search=(id:(values:List(urn%3Ali%3AsponsoredCampaignGroup%3A456)))&pageToken=a%26b"],
    ["list_campaigns", "https://api.linkedin.com/rest/adAccounts/123/adCampaigns?q=search&pageSize=7&search=(id:(values:List(urn%3Ali%3AsponsoredCampaign%3A456)))&pageToken=a%26b"],
    ["list_creatives", "https://api.linkedin.com/rest/adAccounts/123/creatives?q=criteria&pageSize=7&creatives=List(urn%3Ali%3AsponsoredCreative%3A456)&pageToken=a%26b"],
  ])("maps %s with ID filters and escaped opaque cursors", (kind, url) => { expect(encode({ input: { kind, ids: ["456"], pageSize: 7, pageToken: "a&b" } })).toEqual({ ok: true, value: { effect: "read", request: { url, method: "GET", restliMethod: "FINDER" } } }); });
  it.each([
    ["campaign_group", "adCampaignGroups/456", "status"],
    ["campaign", "adCampaigns/456", "status"],
    ["creative", "creatives/urn%3Ali%3AsponsoredCreative%3A456", "intendedStatus"],
  ])("activates exactly one %s via PARTIAL_UPDATE", (entityType, path, field) => { expect(encode({ input: { kind: "activate", entityType, entityId: "456" } })).toEqual({ ok: true, value: { effect: "ad_spend", request: { url: "https://api.linkedin.com/rest/adAccounts/123/" + path, method: "POST", restliMethod: "PARTIAL_UPDATE", body: JSON.stringify({ patch: { $set: { [field]: "ACTIVE" } } }) } } }); });
  it("searches targeting without accepting an HTTP destination", () => {
    expect(encode({ input: { kind: "search_targeting", facet: "locations", query: "San & Francisco" } })).toEqual({ ok: true, value: { effect: "read", request: { method: "GET", restliMethod: "FINDER", url: "https://api.linkedin.com/rest/adTargetingEntities?q=typeahead&facet=urn%3Ali%3AadTargetingFacet%3Alocations&query=San%20%26%20Francisco&queryVersion=QUERY_USES_URNS" } } });
  });
  it("offers the approved sixteen tools, excluding backend delivery, destructive operations and standalone reads", () => {
    expect(linkedinAdsTools.map(tool => tool.name)).toEqual(["list_accounts", "list_campaign_groups", "list_campaigns", "list_creatives", "search_targeting", "create_campaign_group_draft", "create_campaign_paused", "create_creative_paused", "activate", "set_budget", "pause", "report", "list_conversion_rules", "create_conversion_rule", "associate_conversion_rule", "list_lead_forms"]);
  });
});

describe("LinkedIn R2 fixed request codecs", () => {
  it("encodes a half-open UTC period as inclusive dates with explicit metrics and account binding", () => {
    expect(encode({ input: reportCommand })).toEqual({ ok: true, value: { effect: "read", request: { method: "GET", restliMethod: "FINDER", url: "https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=ACCOUNT&timeGranularity=ALL&dateRange=(start:(year:2026,month:10,day:13),end:(year:2026,month:10,day:13))&accounts=List(urn%3Ali%3AsponsoredAccount%3A123)&fields=dateRange,pivotValues,costInLocalCurrency,impressions,clicks" } } });
  });
  it("filters campaign analytics while retaining the configured account", () => {
    const encoded = encode({ input: { ...reportCommand, pivot: "CAMPAIGN", campaignIds: ["567", "568"] } });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error("Fixture encoding failed");
    expect(encoded.value.request.url).toContain("&accounts=List(urn%3Ali%3AsponsoredAccount%3A123)&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A567,urn%3Ali%3AsponsoredCampaign%3A568)");
  });
  it.each([undefined, "ALL_CAMPAIGNS", "OBJECTIVE_BASED"])("creates only a CONVERSIONS_API rule with auto association %s", autoAssociationType => {
    const encoded = encode({ input: { ...conversionRule, autoAssociationType } });
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) throw new Error("Fixture encoding failed");
    expect(encoded.value.effect).toBe("write");
    expect(encoded.value.request.url).toBe("https://api.linkedin.com/rest/conversions" + (autoAssociationType ? "?autoAssociationType=" + autoAssociationType : ""));
    expect(JSON.parse(encoded.value.request.body ?? "")).toEqual({ account: "urn:li:sponsoredAccount:123", name: "Fixture signup", type: "SIGN_UP", conversionMethod: "CONVERSIONS_API", postClickAttributionWindowSize: 30, viewThroughAttributionWindowSize: 7, attributionType: "LAST_TOUCH_BY_CAMPAIGN" });
  });
  it("associates exactly one rule with one campaign using escaped compound URNs", () => {
    expect(encode({ input: { kind: "associate_conversion_rule", campaignId: "567", conversionId: "789" } })).toEqual({ ok: true, value: { effect: "write", request: { url: "https://api.linkedin.com/rest/campaignConversions/(campaign:urn%3Ali%3AsponsoredCampaign%3A567,conversion:urn%3Alla%3AllaPartnerConversion%3A789)", method: "PUT", restliMethod: "UPDATE", body: '{"campaign":"urn:li:sponsoredCampaign:567","conversion":"urn:lla:llaPartnerConversion:789"}' } } });
  });
  it("lists owned conversion rules and account-owned form metadata with bounded offsets", () => {
    expect(encode({ input: { kind: "list_conversion_rules" } })).toMatchObject({ ok: true, value: { effect: "read", request: { url: "https://api.linkedin.com/rest/conversions?q=account&account=urn%3Ali%3AsponsoredAccount%3A123", method: "GET" } } });
    expect(encode({ input: { kind: "list_lead_forms", start: 7, count: 2 } })).toMatchObject({ ok: true, value: { effect: "read", request: { url: "https://api.linkedin.com/rest/leadForms?q=owner&owner=(sponsoredAccount:urn%3Ali%3AsponsoredAccount%3A123)&start=7&count=2", method: "GET" } } });
  });
  it.each([
    { ...reportCommand, window: { start: now + 1, end: now + 86400000 } },
    { ...reportCommand, window: { start: now, end: now } },
    { ...reportCommand, window: { start: now, end: now + 367 * 86400000 } },
    { ...reportCommand, campaignIds: ["567"] }, { ...reportCommand, pivot: "CAMPAIGN" },
    { ...reportCommand, pivot: "CAMPAIGN", campaignIds: ["567", "567"] },
    { ...conversionRule, autoAssociationType: "ALL" }, { ...conversionRule, postClickAttributionWindowSize: 365 },
    { ...conversionRule, conversionMethod: "INSIGHT_TAG" }, { ...conversionRule, account: "foreign" },
    { kind: "list_lead_forms", count: 101 }, { kind: "list_lead_forms", start: -1 },
    { kind: "associate_conversion_rule", campaignId: "567", conversionId: "789", url: "https://untrusted.example" },
  ])("rejects unsupported or unbounded report/setup inputs before I/O", input => {
    expect(encode({ input })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
