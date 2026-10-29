import { expect, it } from "vitest";
import { deployCampaignPaused, readCampaignDeployment } from "../src/index.js";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CampaignDeploymentRequired, CallContext, PluginCapabilityDependencies } from "@open-marketing/contracts";
const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "service", serviceId: "campaigns" }, correlationId: "correlation", traceId: "trace" };
const plan = { campaign: { kind: "create-campaign", name: "Traffic", objective: "OUTCOME_TRAFFIC", specialAdCategories: [] },
  adset: { kind: "create-adset", name: "Traffic", campaignId: { from: "campaign" }, targeting: { countries: ["US"], age_min: 18, age_max: 65 }, billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: 4321, schedule: { start: 1791849600000, end: 1792022400000 } },
  ad: { kind: "create-ad", name: "Traffic", adsetId: { from: "adset" }, creativeId: "987", destinationUrl: "https://example.test/landing" } };
const creative = { id: "987", account_id: "123", object_story_spec: { link_data: { link: plan.ad.destinationUrl } } };
type FixtureOptions = { badAck?: boolean; failPost?: number; checkpointFail?: number; change?: Record<string, unknown>; readFailure?: boolean; readId?: string };
/** Simulate a scoped read or its failure; optional drift affects just the selected row. */
function readFixtureResponse(required: { url: string; rows: Map<string, object>; options: FixtureOptions }): Response {
  const { url, rows, options } = required;
  const id = new URL(url).pathname.split("/").at(-1)!;
  if (options.readFailure && id !== "987") throw new Error("read unavailable");
  return Response.json({ ...rows.get(id), ...(id === (options.readId ?? "202") ? options.change : {}) });
}
/** Store decoded Graph fields before returning a synthetic create ACK. Fixed-size fixture data. */
function createFixtureResponse(required: { body: Record<string, string>; id: string; rows: Map<string, object>; badAck?: boolean }): Response {
  const { body, id, rows } = required;
  const row: Record<string, unknown> = { ...body, id, account_id: "123", configured_status: body.status };
  for (const key of ["targeting", "special_ad_categories", "creative"]) if (body[key]) row[key] = JSON.parse(body[key]);
  if (body.creative) row.creative = { id: JSON.parse(body.creative).creative_id };
  delete row.status; rows.set(id, row);
  return Response.json(required.badAck ? { id: "bad" } : { id });
}
/** Real bounded Graph transport, synthetic responses, and the owning job's checkpoint double. */
function fixture(options: FixtureOptions = {}) {
  const calls: { url: string; body: Record<string, string>; method: string }[] = [];
  const rows = new Map<string, object>([["987", creative]]); const checkpoints: object[] = []; const intents = new Set<string>();
  let posts = 0; let credentials = 0; let denied = false;
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} }),
    credentials: { async access() { credentials++; return denied ? { ok: false, error: { code: "forbidden", message: "Server dispatch denied", retryable: false } } : { ok: true, value: { accessToken: "synthetic-secret" } }; } },
    clock: { now: () => 1790000000000 }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    fetch: async (url, init) => {
      const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))); const method = init?.method ?? "GET";
      calls.push({ url: String(url), body, method }); expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-secret");
      if (method === "GET") return readFixtureResponse({ url: String(url), rows, options });
      posts++; if (posts === options.failPost) throw new Error("ambiguous write");
      return createFixtureResponse({ body, id: String(200 + posts), rows, badAck: options.badAck });
    },
  };
  const input: CampaignDeploymentRequired = { context, operationId: "launch", connectionId: "connection", accountId: "123", plan, dependencies, saved: { references: {}, record: null },
    async checkpoint(event) { checkpoints.push(event); if (checkpoints.length === options.checkpointFail || (event.phase === "dispatch" && intents.has(event.step))) return { ok: false, error: { code: "conflict", message: "stop", retryable: false } }; if (event.phase === "dispatch") intents.add(event.step); return { ok: true, value: undefined }; } };
  return { input, calls, checkpoints, deny: () => { denied = true; }, counts: () => ({ posts, credentials }) };
}
it("creates PAUSED in order with actual Graph nested fields and reads the whole scoped hierarchy", async () => {
  const f = fixture(); const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: { campaign: "201", adset: "202", ad: "203" } } });
  expect(f.calls.map(call => call.method)).toEqual(["GET", "POST", "POST", "POST", "GET", "GET", "GET"]);
  expect(new URL(f.calls[0].url).pathname).toBe("/v26.0/987");
  expect(f.calls[2].body.campaign_id).toBe("201"); expect(f.calls[3].body.adset_id).toBe("202");
  expect(JSON.parse(f.calls[2].body.targeting)).toEqual({ geo_locations: { countries: ["US"] }, age_min: 18, age_max: 65 });
  expect(JSON.parse(f.calls[3].body.creative)).toEqual({ creative_id: "987" }); expect(f.calls[2].body.daily_budget).toBe("4321");
  expect(f.checkpoints).toHaveLength(6); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  expect(f.calls.every(call => new URL(call.url).pathname.startsWith("/v26.0/"))).toBe(true);
});

it.each([
  { object_story_spec: { link_data: { link: "https://example.test/other" } } },
  { account_id: "999" },
  { object_story_spec: { link_data: { link: plan.ad.destinationUrl, child_attachments: [] } } },
  { object_story_spec: { video_data: { call_to_action: { value: { link: plan.ad.destinationUrl } } } } },
  { object_story_spec: undefined, object_story_id: "123_456" },
  { asset_feed_spec: { link_urls: [{ website_url: plan.ad.destinationUrl }] } },
])("refuses conflicting or unsupported creative evidence before all writes/checkpoints: %j", async change => {
  const f = fixture({ readId: "987", change });
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "conflict", retryable: false } });
  expect(f.calls.map(call => call.method)).toEqual(["GET"]);
  expect(f.counts().posts).toBe(0); expect(f.checkpoints).toEqual([]);
});
it("ignores creative tracking tags and transmits only the existing creative ID", async () => {
  const f = fixture({ readId: "987", change: { url_tags: "utm_source=fixture" } });
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  expect(JSON.parse(f.calls[3].body.creative)).toEqual({ creative_id: "987" });
  expect(f.calls.filter(call => call.method === "POST").every(call => !JSON.stringify(call.body).includes(plan.ad.destinationUrl))).toBe(true);
});
it("returns pre-flight transport refusal unchanged without checkpoints", async () => {
  const f = fixture(); f.deny();
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(f.calls).toEqual([]); expect(f.checkpoints).toEqual([]);
});
it("acknowledges reordered postal readback with descriptive fields and default location types", async () => {
  const zips = [{ key: "US:90210" }, { key: "US:94304" }];
  const f = fixture({ change: { targeting: { age_min: 18, age_max: 65, geo_locations: {
    zips: [{ key: "US:94304", name: "94304", country: "US", region_id: "1", primary_city_id: "2" }, { key: "US:90210", name: "90210" }], location_types: ["home", "recent"],
  } } } });
  f.input.plan = { ...plan, adset: { ...plan.adset, targeting: { zips, age_min: 18, age_max: 65 } } };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  expect(JSON.parse(f.calls[2].body.targeting)).toEqual({ geo_locations: { zips }, age_min: 18, age_max: 65 });
});
it.each([
  { custom_locations: [{ latitude: 37.441987, longitude: -122.143019, radius: 6, distance_unit: "kilometer" }] },
  { custom_locations: [{ latitude: 37.441988, longitude: -122.143019, radius: 5.25, distance_unit: "kilometer" }] },
  { custom_locations: [{ latitude: 37.441987, longitude: -122.143018, radius: 5.25, distance_unit: "kilometer" }] },
  { custom_locations: [{ latitude: 37.441987, longitude: -122.143019, radius: 5.25, distance_unit: "mile" }] },
  { regions: [{ key: "1" }] },
  { countries: ["US"] },
])("acknowledges a radius, then rejects geography drift during GET-only reconciliation: %j", async change => {
  const custom_locations = [{ latitude: 37.441987, longitude: -122.143019, radius: 5.25, distance_unit: "kilometer" }];
  const options: FixtureOptions = { change: { targeting: { age_min: 18, age_max: 65,
    geo_locations: { custom_locations: [{ ...custom_locations[0], address_string: "Palo Alto" }], location_types: ["home", "recent"] },
  } } };
  const f = fixture(options);
  f.input.plan = { ...plan, adset: { ...plan.adset, targeting: { custom_locations, age_min: 18, age_max: 65 } } };
  const deployed = await deployCampaignPaused(f.input);
  expect(deployed).toMatchObject({ ok: true, value: { status: "acknowledged", references: { campaign: "201", adset: "202", ad: "203" } } });
  expect(JSON.parse(f.calls[2].body.targeting)).toEqual({ geo_locations: { custom_locations }, age_min: 18, age_max: 65 });
  options.change = { targeting: { age_min: 18, age_max: 65, geo_locations: { custom_locations, ...change } } };
  const start = f.calls.length;
  expect(await readCampaignDeployment({ ...f.input, saved: { references: { campaign: "201", adset: "202", ad: "203" }, record: null } })).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["201", "202", "203"] } });
  expect(f.calls.slice(start).every(call => call.method === "GET")).toBe(true);
  expect(f.counts().posts).toBe(3);
});
it.each([
  {},
  { countries: ["US"], zips: [{ key: "US:94304" }] },
  { countries: ["US"], custom_locations: [{ latitude: 0, longitude: 0, radius: 5, distance_unit: "kilometer" }] },
  { custom_locations: [{ latitude: 91, longitude: 0, radius: 5, distance_unit: "kilometer" }] },
])("refuses absent, mixed or malformed deployment geography before credentials: %j", async geo => {
  const f = fixture();
  f.input.plan = { ...plan, adset: { ...plan.adset, targeting: { ...geo, age_min: 18, age_max: 65 } } };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.counts()).toEqual({ posts: 0, credentials: 0 }); expect(f.checkpoints).toEqual([]);
});

it.each([{ failPost: 2 }, { checkpointFail: 2 }])("retains first ID and stops on partial failure: %j", async options => {
  const f = fixture(options); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "201" } } });
  expect(f.counts().posts).toBe(options.failPost ? 2 : 1);
});
it("rejects malformed ACK and never advances or retries an existing dispatch intent", async () => {
  const f = fixture({ badAck: true }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: [] } });
  await deployCampaignPaused(f.input); expect(f.counts().posts).toBe(1);
});
it.each([{ account_id: "999" }, { campaign_id: "999" }, { configured_status: "ACTIVE" }, { daily_budget: "1" }, { start_time: "invalid" }, { targeting: {} }])("readback drift stays unknown without losing IDs: %j", async change => {
  const f = fixture({ change }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["201", "202", "203"] } });
});
it("read failure preserves all IDs; reconciliation is GET-only", async () => {
  const f = fixture({ readFailure: true }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["201", "202", "203"] } });
  const start = f.calls.length; await readCampaignDeployment({ ...f.input, saved: { references: { campaign: "201", adset: "202", ad: "203" }, record: null } });
  expect(f.calls.slice(start).every(call => call.method === "GET")).toBe(true); expect(f.counts().posts).toBe(3);
});
it("cancelled and invalid complete plans cause zero credential and network access", async () => {
  const f = fixture(); await deployCampaignPaused(f.input, { signal: AbortSignal.abort() });
  expect((await deployCampaignPaused({ ...f.input, plan: { ...plan, ad: { ...plan.ad, status: "ACTIVE" } } })).ok).toBe(false);
  expect(f.counts()).toEqual({ posts: 0, credentials: 0 }); expect(f.calls).toEqual([]);
});
it("requires creative readback and obeys dispatch-time denial after a checkpoint", async () => {
  const f = fixture({ readId: "203", change: { creative: { id: "999" } } }); expect(await deployCampaignPaused(f.input)).toMatchObject({ value: { status: "unknown", entityIds: ["201", "202", "203"] } });
  const denied = fixture(); denied.input.checkpoint = async () => { denied.deny(); return { ok: true, value: undefined }; };
  await deployCampaignPaused(denied.input); expect(denied.counts().posts).toBe(0); expect(denied.calls.map(call => call.method)).toEqual(["GET"]);
});

it("canonical deployment stays paused, reconciles saved evidence and denies foreign configuration before checkpoints", async () => {
  const calls: { method: string; url: string }[] = [];
  const rows = new Map<string, object>([["987", creative]]); let posts = 0; let checkpoints = 0;
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} }),
    credentials: { access: async () => ({ ok: true, value: { accessToken: "fixture-token", expiresAt: 1799999999999, secrets: { unrelated: "s3cret-fixture" } } }) },
    clock: { now: () => 1790000000000 }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }),
    fetch: async (url, init) => {
      const method = init?.method ?? "GET"; calls.push({ method, url: String(url) });
      if (method === "GET") return readFixtureResponse({ url: String(url), rows, options: {} });
      posts++;
      return createFixtureResponse({ body: Object.fromEntries(new URLSearchParams(String(init?.body))), id: String(200 + posts), rows });
    },
  };
  const required: CampaignDeploymentRequired = { context, operationId: "canonical", connectionId: "connection", accountId: "123", plan, dependencies, saved: { references: {}, record: null }, checkpoint: async () => { checkpoints++; return { ok: true, value: undefined }; } };
  expect(await deployCampaignPaused(required)).toMatchObject({ ok: true, value: { state: "paused", status: "acknowledged" } });
  expect(posts).toBe(3);
  calls.length = 0;
  expect(await deployCampaignPaused({ ...required, saved: { references: { campaign: "201" }, record: null } })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "201" } } });
  expect(calls.map(call => call.method)).toEqual(["GET"]);
  expect(posts).toBe(3);
  calls.length = 0;
  await deployCampaignPaused({ ...required, saved: { references: {}, record: { step: "campaign", phase: "dispatch" } } });
  expect(calls).toEqual([]); expect(posts).toBe(3);
  const before = checkpoints;
  expect(await deployCampaignPaused({ ...required, dependencies: { ...dependencies, configuration: { ...dependencies.configuration, connectionId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(checkpoints).toBe(before); expect(calls).toEqual([]);
});
