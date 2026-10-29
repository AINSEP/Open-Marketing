import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import { fixtureBinding, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { createTools, parseTool } from "../src/hosted.ts";
import { negativeKeywordReceiptSchema } from "../src/negative-keywords.ts";
import { searchTermsReportSchema } from "../src/search-terms.ts";
import { value } from "./helpers.ts";

const days = { start: "2026-10-01", end: "2026-11-01" };
const campaign = { scope: "campaign", campaignId: "201" } as const;
const group = { scope: "ad_group", campaignId: "201", adGroupId: "301" } as const;
const campaignMember = { campaign: { id: "201", advertisingChannelType: "SEARCH" } };
const groupMember = { ...campaignMember, adGroup: { id: "301" } };
const campaignResource = "customers/1234567890/campaignCriteria/201~401";
const groupResource = "customers/1234567890/adGroupCriteria/301~401";
const reportRow = { campaign: { id: "201" }, adGroup: { id: "301" }, searchTermView: { searchTerm: "free jobs", status: "NONE" } };

/** The only path under test is the hosted factory and its real REST/HTTP adapters.
 * Queued responses are handwritten fixtures; every unexpected request is observable.
 */
function hostedFixture({ responses }: { responses: (Response | (() => Response))[] }) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const pending = [...responses];
  const tools = createTools({
    configuration: pluginConfigurationSchema.parse({ scope: fixtureBinding.scope, connectionId: fixtureBinding.connectionId,
      accountId: fixtureBinding.customerId, pluginDigest: fixtureBinding.pluginDigest, settings: {} }),
    clock: { now: () => fixtureTime }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture-only" } }) },
    fetch: async (url, init) => {
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.ok(init?.signal);
      const body = JSON.parse(String(init?.body));
      calls.push({ url: String(url), body });
      if (body.query === "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2") return Response.json({
        results: [{ customer: { id: fixtureBinding.customerId, currencyCode: "USD", timeZone: "America/Los_Angeles" } }],
      });
      const next = pending.shift();
      assert.ok(next, "unexpected extra Google request");
      return typeof next === "function" ? next() : next;
    },
  });
  return { calls, invoke: ({ name, input }: { name: string; input: unknown }) => tools.invoke({
    context: fixtureContext, connection: { connectionId: fixtureBinding.connectionId, accountId: fixtureBinding.customerId },
    name, input, operationId: "search-terms-fixture", moneyExposure: null, requiredLimit: null,
  }) };
}

test("hosted search terms aggregate the window, preserve exact metrics/nulls and return valid output", async () => {
  const fixture = hostedFixture({ responses: [new Response('{"results":[{"campaign":{"id":"201"},"adGroup":{"id":"301"},"searchTermView":{"searchTerm":"free jobs","status":"NONE"},"metrics":{"costMicros":9007199254740993,"clicks":"2","impressions":"20","conversions":1.2345675}},{"campaign":{"id":"201"},"adGroup":{"id":"302"},"searchTermView":{"searchTerm":"career","status":"EXCLUDED"}}]}')] });
  assert.equal(fixture.calls.length, 0);
  const report = searchTermsReportSchema.parse(value({ outcome: await fixture.invoke({ name: "search_terms_report", input: { campaignId: "201", days } }) }));
  assert.equal(report.currency, "USD"); assert.equal(report.timezone, "America/Los_Angeles");
  assert.equal(report.retrievedAt, fixtureTime); assert.deepEqual(report.days, days); assert.equal(report.truncated, false);
  assert.deepEqual(report.rows[0], { campaignId: "201", adGroupId: "301", searchTerm: "free jobs", status: "NONE",
    spendMicros: "9007199254740993", clicks: "2", impressions: "20", vendorConversions: "1234568" });
  assert.deepEqual(report.rows[1], { campaignId: "201", adGroupId: "302", searchTerm: "career", status: "EXCLUDED",
    spendMicros: null, clicks: null, impressions: null, vendorConversions: null });
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[1].url, "https://googleads.googleapis.com/v26/customers/1234567890/googleAds:search");
  assert.deepEqual(fixture.calls[1].body, { query: "SELECT campaign.id, ad_group.id, search_term_view.search_term, search_term_view.status, metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions FROM search_term_view WHERE campaign.id = 201 AND segments.date >= '2026-10-01' AND segments.date < '2026-11-01' ORDER BY metrics.cost_micros DESC LIMIT 51" });
});

for (const scenario of [{ count: 50, token: false, truncated: false }, { count: 51, token: false, truncated: true }, { count: 1, token: true, truncated: true }]) {
  test(`search terms truncation: ${scenario.count} rows, token=${scenario.token}`, async () => {
    const fixture = hostedFixture({ responses: [Response.json({ results: Array.from({ length: scenario.count }, (_, index) => ({
      ...reportRow, searchTermView: { searchTerm: "term " + index, status: "NONE" },
    })), ...(scenario.token ? { nextPageToken: "more" } : {}) })] });
    const report = searchTermsReportSchema.parse(value({ outcome: await fixture.invoke({ name: "search_terms_report", input: { campaignId: "201", days } }) }));
    assert.equal(report.truncated, scenario.truncated); assert.equal(report.rows.length, Math.min(50, scenario.count));
    assert.equal(fixture.calls.length, 2);
  });
}

test("search terms reject foreign rows and malformed/negative metrics", async () => {
  for (const row of [{ ...reportRow, campaign: { id: "999" } }, { ...reportRow, metrics: [] }, { ...reportRow, metrics: { costMicros: "-1" } }, { ...reportRow, metrics: { conversions: "bad" } }]) {
    const fixture = hostedFixture({ responses: [Response.json({ results: [row] })] });
    assert.equal((await fixture.invoke({ name: "search_terms_report", input: { campaignId: "201", days } })).ok, false);
    assert.equal(fixture.calls.length, 2);
  }
});

test("search terms reject unsafe IDs and invalid/oversized windows before I/O", async () => {
  for (const input of [
    { campaignId: "201 OR 1=1", days }, { campaignId: "0", days },
    { campaignId: "201", days: { start: "2026-10-01", end: "2026-11-02" } },
    { campaignId: "201", days: { start: "2026-11-01", end: "2026-10-01" } },
    { campaignId: "201", days: { start: "2026-10-01", end: "2026-10-01" } },
    { campaignId: "201", days: { start: "2026-02-30", end: "2026-03-01" } },
  ]) {
    const fixture = hostedFixture({ responses: [] });
    assert.equal((await fixture.invoke({ name: "search_terms_report", input })).ok, false);
    assert.equal(fixture.calls.length, 0);
  }
});

for (const target of [campaign, group]) {
  test(`one exact ${target.scope} negative uses membership -> lookup -> one mutate`, async () => {
    const isGroup = target.scope === "ad_group";
    const field = isGroup ? "adGroupCriterion" : "campaignCriterion";
    const resourceName = isGroup ? groupResource : campaignResource;
    const fixture = hostedFixture({ responses: [Response.json({ results: [isGroup ? groupMember : campaignMember] }),
      Response.json({ results: [] }), Response.json({ mutateOperationResponses: [{ [field + "Result"]: { resourceName } }] })] });
    const receipt = negativeKeywordReceiptSchema.parse(value({ outcome: await fixture.invoke({ name: "add_negative_keyword", input: { target, text: "  FREE   Jobs  " } }) }));
    assert.deepEqual(receipt, { status: "created", resourceName, target, text: "free jobs", matchType: "EXACT" });
    assert.equal(fixture.calls.length, 4);
    assert.equal(fixture.calls[1].body.query, isGroup
      ? "SELECT campaign.id, campaign.advertising_channel_type, ad_group.id FROM ad_group WHERE ad_group.id = 301 AND campaign.id = 201 LIMIT 2"
      : "SELECT campaign.id, campaign.advertising_channel_type FROM campaign WHERE campaign.id = 201 LIMIT 2");
    const source = isGroup ? "ad_group_criterion" : "campaign_criterion";
    const filter = isGroup ? "ad_group.id = 301" : "campaign.id = 201";
    assert.equal(fixture.calls[2].body.query, `SELECT ${source}.resource_name, ${source}.negative, ${source}.type, ${source}.keyword.text, ${source}.keyword.match_type FROM ${source} WHERE ${filter} AND ${source}.negative = TRUE AND ${source}.type = KEYWORD AND ${source}.keyword.match_type = EXACT AND ${source}.keyword.text = 'free jobs' LIMIT 2`);
    const mutations = fixture.calls.filter(call => call.url.endsWith("googleAds:mutate"));
    assert.equal(mutations.length, 1);
    assert.deepEqual(mutations[0].body, { partialFailure: false, mutateOperations: [{ [field + "Operation"]: { create: {
      ...(isGroup ? { adGroup: "customers/1234567890/adGroups/301" } : { campaign: "customers/1234567890/campaigns/201" }),
      negative: true, keyword: { text: "free jobs", matchType: "EXACT" },
    } } }] });
  });

  test(`existing ${target.scope} exact negative returns already_present without mutating`, async () => {
    const isGroup = target.scope === "ad_group";
    const field = isGroup ? "adGroupCriterion" : "campaignCriterion";
    const resourceName = isGroup ? groupResource : campaignResource;
    const fixture = hostedFixture({ responses: [Response.json({ results: [isGroup ? groupMember : campaignMember] }),
      Response.json({ results: [{ [field]: { resourceName, negative: true, type: "KEYWORD", keyword: { text: "Free Jobs", matchType: "EXACT" } } }] })] });
    const receipt = negativeKeywordReceiptSchema.parse(value({ outcome: await fixture.invoke({ name: "add_negative_keyword", input: { target, text: "free jobs" } }) }));
    assert.deepEqual(receipt, { status: "already_present", resourceName, target, text: "free jobs", matchType: "EXACT" });
    assert.equal(fixture.calls.filter(call => call.url.endsWith("googleAds:mutate")).length, 0); assert.equal(fixture.calls.length, 3);
  });
}

test("foreign ad group/campaign, non-Search, absent or ambiguous membership never mutates", async () => {
  for (const membership of [
    { results: [{ ...groupMember, adGroup: { id: "999" } }] },
    { results: [{ ...groupMember, campaign: { id: "999", advertisingChannelType: "SEARCH" } }] },
    { results: [{ ...groupMember, campaign: { id: "201", advertisingChannelType: "DISPLAY" } }] },
    { results: [] }, { results: [groupMember, groupMember] }, { results: [groupMember], nextPageToken: "more" },
  ]) {
    const fixture = hostedFixture({ responses: [Response.json(membership)] });
    assert.equal((await fixture.invoke({ name: "add_negative_keyword", input: { target: group, text: "free jobs" } })).ok, false);
    assert.equal(fixture.calls.filter(call => call.url.endsWith("googleAds:mutate")).length, 0); assert.equal(fixture.calls.length, 2);
  }
});

test("ambiguous/malformed/incomplete exact-negative evidence never mutates", async () => {
  const existing = { campaignCriterion: { resourceName: campaignResource, negative: true, type: "KEYWORD", keyword: { text: "free jobs", matchType: "EXACT" } } };
  for (const lookup of [{ results: [existing, existing] }, { results: [{}] }, { results: [existing], nextPageToken: "more" },
    { results: [{ campaignCriterion: { ...existing.campaignCriterion, resourceName: groupResource } }] }]) {
    const fixture = hostedFixture({ responses: [Response.json({ results: [campaignMember] }), Response.json(lookup)] });
    assert.equal((await fixture.invoke({ name: "add_negative_keyword", input: { target: campaign, text: "free jobs" } })).ok, false);
    assert.equal(fixture.calls.filter(call => call.url.endsWith("googleAds:mutate")).length, 0); assert.equal(fixture.calls.length, 3);
  }
});

test("malformed ACKs and response/timeout failures after send stay unknown without retry/readback", async () => {
  const good = { campaignCriterionResult: { resourceName: campaignResource } };
  const responses = [Response.json({}), Response.json({ mutateOperationResponses: [] }),
    Response.json({ mutateOperationResponses: [good, good] }), Response.json({ mutateOperationResponses: [{ campaignCriterionResult: { resourceName: "customers/9999999999/campaignCriteria/201~401" } }] }),
    Response.json({ mutateOperationResponses: [{ adGroupCriterionResult: { resourceName: groupResource } }] }),
    new Response(""), new Response("invalid JSON"),
    () => { throw new DOMException("fixture-secret-must-not-escape", "TimeoutError"); },
    () => { throw new DOMException("fixture-secret-must-not-escape", "AbortError"); },
  ];
  for (const response of responses) {
    const fixture = hostedFixture({ responses: [Response.json({ results: [campaignMember] }), Response.json({ results: [] }), response] });
    const result = await fixture.invoke({ name: "add_negative_keyword", input: { target: campaign, text: "free jobs" } });
    const receipt = negativeKeywordReceiptSchema.parse(value({ outcome: result }));
    assert.deepEqual(receipt, { status: "unknown", target: campaign, text: "free jobs", matchType: "EXACT" });
    assert.equal(JSON.stringify(result).includes("fixture-secret-must-not-escape"), false);
    assert.equal(fixture.calls.filter(call => call.url.endsWith("googleAds:mutate")).length, 1); assert.equal(fixture.calls.length, 4);
  }
});

test("a Google HTTP rejection remains the transport's typed unavailable failure", async () => {
  const fixture = hostedFixture({ responses: [Response.json({ results: [campaignMember] }), Response.json({ results: [] }), Response.json({ error: { message: "fixture vendor rejection" } }, { status: 400 })] });
  const result = await fixture.invoke({ name: "add_negative_keyword", input: { target: campaign, text: "free jobs" } });
  assert.deepEqual(result, { ok: false, error: { code: "unavailable", message: "Google request failed; reconciliation may be required", retryable: false } });
  assert.equal(fixture.calls.filter(call => call.url.endsWith("googleAds:mutate")).length, 1); assert.equal(fixture.calls.length, 4);
});

test("unsafe keyword text, match-type options and connection smuggling reject at parse before I/O", async () => {
  const unsafe = ["", "   ", "x".repeat(81), "one two three four five six seven eight nine ten eleven",
    ...["'", '"', "\\", "\n", "\r", "\t", "\u0000", "\u0085", "[", "]", "+", "!", "@", "%", "^", "*", "=", "<", ">", ";", ",", "{", "}", "|", "~"].map(character => "free" + character + "jobs")];
  for (const input of [...unsafe.map(text => ({ target: campaign, text })),
    { target: campaign, text: "free jobs", matchType: "PHRASE" },
    { target: { ...group, connectionId: "foreign" }, text: "free jobs" },
    { target: campaign, text: "free jobs", connection: { connectionId: "foreign" } },
    { target: { scope: "campaign", campaignId: "01" }, text: "free jobs" },
  ]) {
    const fixture = hostedFixture({ responses: [] });
    assert.equal(parseTool({ name: "add_negative_keyword", input }).ok, false);
    assert.equal((await fixture.invoke({ name: "add_negative_keyword", input })).ok, false);
    assert.equal(fixture.calls.length, 0);
  }
});
