import { test } from "node:test";
import assert from "node:assert/strict";
import { createCapabilities, mapPerformanceToReport } from "../src/index.ts";
import type { PluginCapabilitiesFactory } from "@open-marketing/contracts";
import { capabilityCatalog } from "@open-marketing/contracts";
import { binding, context, days, fixture, memoryPlugin, native, wire } from "./fixtures.ts";

for (const implementation of ["memory", "REST"] as const) {
  test(`${implementation}: shared location/performance/scoping contract`, async () => {
    const plugin = implementation === "memory" ? memoryPlugin() : fixture({}).plugin;
    const first = await plugin.listLocations({ context }); assert.ok(first.ok);
    assert.deepEqual(first.value, { locations: [{ name: "locations/200", title: "Fixture business" }], nextPageToken: "page-2" });
    const second = await plugin.listLocations({ context, pageToken: first.value.nextPageToken }); assert.ok(second.ok); assert.deepEqual(second.value.locations, []);
    const result = await plugin.readPerformance({ context, days }); assert.ok(result.ok); assert.deepEqual(result.value, native);
    for (const scope of [{ ...context.scope, ownerId: "other" }, { ...context.scope, workspaceId: "other" }]) {
      assert.equal((await plugin.listLocations({ context: { ...context, scope } })).ok, false);
      assert.equal((await plugin.readPerformance({ context: { ...context, scope }, days })).ok, false);
    }
  });
}
test("exact integer mapping labels website clicks/impressions, omits unsupported metrics and handles detached ABI", async () => {
  const { plugin } = fixture({}); const report = plugin.reportMetrics;
  const result = await report({ context, connection: { connectionId: binding.connectionId, accountId: binding.locationName }, input: { grain: "account", days } }); assert.ok(result.ok);
  assert.deepEqual(result.value.rows.map(row => row.metrics), [{ clicks: "5", impressions: "9007199254741002" }, { clicks: null, impressions: null }]);
  assert.equal(result.value.accountId, "locations/200"); assert.equal(result.value.complete, false); assert.equal(result.value.finality, "provisional"); assert.equal(result.value.freshness, "stale");
  assert.equal(result.value.currency, "XXX"); assert.equal(result.value.dataThrough, 0); assert.equal(result.value.timezone, "America/Los_Angeles");
  assert.match(result.value.mapping.grains.account!.clicks!.meaning, /website/); assert.equal(result.value.rows[0].metrics.spend, undefined);
});
test("existing omitted values are zero, absent dates/series are unavailable, partial views are not summed", async () => {
  const response = wire(); Reflect.deleteProperty(response.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries[0].timeSeries.datedValues[0], "value");
  response.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries.pop();
  const result = await fixture({ response }).plugin.readPerformance({ context, days }); assert.ok(result.ok);
  assert.equal(result.value.rows[0].callClicks, "0"); assert.equal(result.value.rows[0].views, null); assert.equal(result.value.rows[1].callClicks, null);
  const empty = await fixture({ response: {} }).plugin.readPerformance({ context, days }); assert.ok(empty.ok); assert.equal(empty.value.rows[0].websiteClicks, null);
});
test("all observed zeros stay zero; max-int64 impression categories sum exactly; order does not change output", async () => {
  const zeros = wire(); for (const series of zeros.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries) Reflect.deleteProperty(series.timeSeries.datedValues[0], "value");
  const zero = await fixture({ response: zeros }).plugin.readPerformance({ context, days }); assert.ok(zero.ok); assert.equal(zero.value.rows[0].views, "0"); assert.equal(zero.value.rows[0].websiteClicks, "0");
  const max = wire(); for (const series of max.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries) series.timeSeries.datedValues[0].value = "9223372036854775807";
  const result = await fixture({ response: max }).plugin.readPerformance({ context, days }); assert.ok(result.ok); assert.equal(result.value.rows[0].views, "36893488147419103228");
  const reversed = wire(); reversed.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries.reverse();
  const ordered = await fixture({ response: reversed }).plugin.readPerformance({ context, days }); assert.ok(ordered.ok); assert.deepEqual(ordered.value, native);
});
test("rejects duplicate series/points, invalid counts/dates, out-of-window points and unexpected breakdowns", async () => {
  type Series = ReturnType<typeof wire>["multiDailyMetricTimeSeries"][number]["dailyMetricTimeSeries"][number];
  const mutations: Record<string, (required: { series: Series[]; item: Series; point: Series["timeSeries"]["datedValues"][number] }) => void> = {
    series: ({ series, item }) => { series[1] = structuredClone(item); }, point: ({ item, point }) => { item.timeSeries.datedValues.push(structuredClone(point)); },
    negative: ({ point }) => { point.value = "-1"; }, float: ({ point }) => { point.value = "1.5"; }, unsafeNumber: ({ point }) => { Reflect.set(point, "value", 9007199254740992); },
    overflow: ({ point }) => { point.value = "9223372036854775808"; }, date: ({ point }) => { point.date.day = 31; }, outside: ({ point }) => { point.date.month = 8; },
    breakdown: ({ item }) => { Object.assign(item, { dailySubEntityType: { dayOfWeek: "MONDAY" } }); },
  };
  for (const [kind, mutate] of Object.entries(mutations)) {
    const response = wire(); const series = response.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries; const item = series[0]; const point = item.timeSeries.datedValues[0];
    mutate({ series, item, point });
    assert.equal((await fixture({ response }).plugin.readPerformance({ context, days })).ok, false, kind);
  }
});
test("native reads need no reporting metadata; unsupported grain/mismatched binding fails before egress", async () => {
  const noMetadata = fixture({ binding: { ...binding, reportingContext: undefined } });
  const request = { context, connection: { connectionId: binding.connectionId, accountId: binding.locationName }, input: { grain: "account" as const, days } };
  const report = await noMetadata.plugin.reportMetrics(request); assert.ok(!report.ok); assert.equal(report.error.code, "unavailable"); assert.equal(noMetadata.calls.length, 0);
  assert.ok((await noMetadata.plugin.readPerformance({ context, days })).ok);
  const configured = fixture({});
  for (const changed of [{ ...request, input: { grain: "campaign" as const, days } }, { ...request, connection: { ...request.connection, accountId: "locations/999" } }, { ...request, connection: { ...request.connection, connectionId: "other" } }]) assert.equal((await configured.plugin.reportMetrics(changed)).ok, false);
  assert.equal(configured.calls.length, 0);
  const service = await configured.plugin.reportMetrics({ ...request, context: { scope: context.scope, serviceId: "sync", correlationId: "correlation", traceId: "trace" } }); assert.ok(service.ok);
});
test("pure mapping rejects host-supplied coverage/currency, duplicate native rows and invalid metadata", () => {
  assert.equal(mapPerformanceToReport({ performance: native, reportingContext: Object.assign({}, binding.reportingContext!, { dataThrough: native.retrievedAt + 1 }) }).ok, false);
  assert.equal(mapPerformanceToReport({ performance: native, reportingContext: Object.assign({}, binding.reportingContext!, { currency: "USD" }) }).ok, false);
  assert.equal(mapPerformanceToReport({ performance: { ...native, rows: [native.rows[0], native.rows[0]] }, reportingContext: binding.reportingContext! }).ok, false);
  assert.equal(mapPerformanceToReport({ performance: native, reportingContext: { ...binding.reportingContext!, timezone: "invalid/timezone" } }).ok, false);
});
test("half-open dates become inclusive Google dates across leap day; enforces 366-day maximum", async () => {
  const setup = fixture({ response: {} });
  assert.ok((await setup.plugin.readPerformance({ context, days: { start: "2024-02-29", end: "2024-03-01" } })).ok);
  const query = setup.calls[0].url.searchParams; assert.equal(query.get("dailyRange.end_date.day"), "29"); assert.equal(query.get("dailyRange.end_date.month"), "2"); assert.equal(query.getAll("dailyMetrics").length, 7);
  assert.ok((await setup.plugin.readPerformance({ context, days: { start: "2026-01-01", end: "2026-02-01" } })).ok);
  for (const range of [{ start: "2024-01-01", end: "2025-01-02" }, { start: days.end, end: days.start }, { start: "2026-02-30", end: "2026-03-01" }]) assert.equal((await setup.plugin.readPerformance({ context, days: range })).ok, false);
  assert.equal(setup.calls.length, 2);
});

for (const length of [90, 366]) test(`native and report reads accept ${length} observed days with timezone alone`, async () => {
  const start = Date.parse("2024-01-01T00:00:00Z");
  const range = { start: "2024-01-01", end: new Date(start + length * 86400000).toISOString().slice(0, 10) };
  const response = wire();
  for (const series of response.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries) {
    series.timeSeries.datedValues = Array.from({ length }, (_, offset) => {
      const day = new Date(start + offset * 86400000);
      return { date: { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() }, value: "1" };
    });
  }
  const setup = fixture({ response });
  const native = await setup.plugin.readPerformance({ context, days: range }); assert.ok(native.ok); assert.equal(native.value.rows.length, length);
  const result = await setup.plugin.reportMetrics({ context, connection: { connectionId: binding.connectionId, accountId: binding.locationName }, input: { grain: "account", days: range } });
  assert.ok(result.ok); assert.equal(result.value.rows.length, length); assert.equal(result.value.rows[length - 1].metrics.impressions, "4");
  assert.equal(result.value.currency, "XXX"); assert.equal(result.value.dataThrough, 0); assert.equal(result.value.complete, false);
});

test("367 input days fail before I/O and 367 wire points cannot overflow a 366-day report", async () => {
  const setup = fixture({ response: {} });
  const invalidDays = { start: "2024-01-01", end: "2025-01-02" };
  assert.equal((await setup.plugin.readPerformance({ context, days: invalidDays })).ok, false);
  assert.equal((await setup.plugin.reportMetrics({ context, connection: { connectionId: binding.connectionId, accountId: binding.locationName }, input: { grain: "account", days: invalidDays } })).ok, false);
  assert.equal(setup.accesses.length, 0); assert.equal(setup.calls.length, 0);
  const response = wire(); const series = response.multiDailyMetricTimeSeries[0].dailyMetricTimeSeries[0];
  series.timeSeries.datedValues = Array.from({ length: 367 }, () => structuredClone(series.timeSeries.datedValues[0]));
  assert.equal((await fixture({ response }).plugin.readPerformance({ context, days: { start: "2024-01-01", end: "2025-01-01" } })).ok, false);
});

test("real canonical factory accepts server-shaped configuration and publishes one exact Update", async () => {
  const factory: PluginCapabilitiesFactory = createCapabilities;
  const setup = fixture({});
  const handlers = factory(setup.capabilityDependencies);
  assert.deepEqual(Object.keys(handlers), ["organic.publish.v1"]);
  assert.equal(setup.accesses.length, 0); assert.equal(setup.calls.length, 0);
  const result = await handlers["organic.publish.v1"]!(publishCall);
  assert.ok(result.ok); assert.ok(capabilityCatalog["organic.publish.v1"].output.safeParse(result.value).success);
  assert.deepEqual(result.value, { status: "published", postId });
  assert.equal(setup.accesses.length, 1); assert.equal(setup.calls.length, 1);
  const { url, init } = setup.calls[0];
  assert.equal(url.href, "https://mybusiness.googleapis.com/v4/accounts/1/locations/2/localPosts");
  assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
  assert.deepEqual(JSON.parse(String(init?.body)), { topicType: "STANDARD", summary: "A new Update", languageCode: "en" });
  assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer fixture-token-never-real");
  assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json");
  assert.deepEqual(setup.observations, [{ operation: "google-business-profile.publish", outcome: "published", correlationId: "correlation", traceId: "trace", runId: "run" }]);
});

const postId = "accounts/1/locations/2/localPosts/3";
const publishCall = { context, connection: { connectionId: "connection", accountId: "accounts/1/locations/2" }, input: { text: "A new Update", languageCode: "en" } };
function publication(required: Parameters<typeof fixture>[0] = {}) {
  const setup = fixture(required);
  return { ...setup, publish: createCapabilities(setup.capabilityDependencies)["organic.publish.v1"] };
}

for (const [state, status] of [["LIVE", "published"], ["PROCESSING", "processing"], ["REJECTED", "rejected"], ["SCHEDULED", "unknown"], ["toString", "unknown"]]) {
  test(`publish receipt maps ${state} without guessing publication`, async () => {
    const setup = publication({ response: { name: postId, state, searchUrl: "https://example.test/post", createTime: "extra Google field" } });
    assert.deepEqual(await setup.publish(publishCall), { ok: true, value: { status, postId, url: "https://example.test/post" } });
    assert.equal(setup.calls.length, 1);
  });
}
test("publish omits an unsafe URL and optional language; credentials may include expiresAt", async () => {
  const setup = publication({ response: { name: postId, state: "LIVE", searchUrl: "http://unsafe.test" } });
  const publish = createCapabilities({ ...setup.capabilityDependencies, credentials: { async access() { return { ok: true, value: { accessToken: "fixture-token", expiresAt: 2000 } }; } } })["organic.publish.v1"];
  assert.deepEqual(await publish({ ...publishCall, input: { text: "x".repeat(1500) } }), { ok: true, value: { status: "published", postId } });
  assert.deepEqual(JSON.parse(String(setup.calls[0].init?.body)), { topicType: "STANDARD", summary: "x".repeat(1500) });
});
for (const response of [{ name: "accounts/9/locations/2/localPosts/3", state: "LIVE" }, { name: "accounts/1/locations/2/localPosts/", state: "LIVE" }, { name: postId }, {}]) {
  test(`publish rejects unusable or foreign receipts: ${JSON.stringify(response)}`, async () => {
    const setup = publication({ response });
    assert.deepEqual(await setup.publish(publishCall), { ok: true, value: { status: "unknown" } });
    assert.equal(setup.calls.length, 1);
  });
}
test("publish rejects 1501 characters and nested connection input before credentials", async () => {
  const setup = publication();
  for (const input of [{ text: "x".repeat(1501) }, { text: " " }, { text: "Update", connectionId: "other" }]) {
    const result = await setup.publish({ ...publishCall, input });
    assert.ok(!result.ok); assert.equal(result.error.code, "invalid_input");
  }
  assert.equal(setup.accesses.length, 0); assert.equal(setup.calls.length, 0);
});
test("connection, account and scope mismatches fail before credential access", async () => {
  const setup = publication();
  const calls = [
    { ...publishCall, connection: { ...publishCall.connection, connectionId: "other" } },
    { ...publishCall, connection: { ...publishCall.connection, accountId: "accounts/1/locations/9" } },
    ...[{ ownerId: "other", workspaceId: "workspace" }, { ownerId: "owner", workspaceId: "other" }].map(scope => ({ ...publishCall, context: { ...context, scope } })),
  ];
  for (const call of calls) {
    const result = await setup.publish(call); assert.ok(!result.ok); assert.equal(result.error.code, "forbidden");
  }
  setup.capabilityDependencies.configuration.accountId = "locations/2";
  const invalidParent = await setup.publish(publishCall); assert.ok(!invalidParent.ok); assert.equal(invalidParent.error.code, "forbidden");
  assert.equal(setup.accesses.length, 0); assert.equal(setup.calls.length, 0);
});
test("abort before submission cancels without a POST, including abort during credentials", async () => {
  const stopped = new AbortController(); stopped.abort(); const setup = publication();
  const result = await setup.publish(publishCall, { signal: stopped.signal }); assert.ok(!result.ok); assert.equal(result.error.code, "cancelled");
  assert.equal(setup.accesses.length, 0); assert.equal(setup.calls.length, 0);
  const during = new AbortController();
  const publish = createCapabilities({ ...setup.capabilityDependencies, credentials: { async access() { during.abort(); return { ok: true, value: { accessToken: "fixture-token" } }; } } })["organic.publish.v1"];
  const cancelled = await publish(publishCall, { signal: during.signal }); assert.ok(!cancelled.ok); assert.equal(cancelled.error.code, "cancelled");
  assert.equal(setup.calls.length, 0);
});
for (const [status, code] of [[400, "invalid_input"], [401, "unauthenticated"], [403, "forbidden"], [404, "unavailable"], [429, "unavailable"]] as const) {
  test(`publish HTTP ${status} returns a sanitized definite rejection`, async () => {
    const setup = publication({ fetch: async () => new Response("fixture-token-never-real", { status }) });
    const result = await setup.publish(publishCall); assert.ok(!result.ok); assert.equal(result.error.code, code);
    assert.equal(JSON.stringify(result).includes("fixture-token"), false); assert.equal(setup.calls.length, 1);
  });
}
for (const kind of ["500", "invalid JSON", "network", "oversize", "abort"] as const) {
  test(`publish ${kind} after submission is unknown and never retried`, async () => {
    const controller = new AbortController();
    const setup = publication({ fetch: async (_url, init) => {
      if (kind === "network") throw new Error("fixture-token-never-real");
      if (kind === "abort") { controller.abort(); init?.signal?.throwIfAborted(); }
      if (kind === "500") return new Response("fixture-token-never-real", { status: 500 });
      return new Response(kind === "oversize" ? "x".repeat(1048577) : "invalid JSON");
    } });
    assert.deepEqual(await setup.publish(publishCall, { signal: controller.signal }), { ok: true, value: { status: "unknown" } });
    assert.equal(setup.calls.length, 1);
  });
}
test("publish credential failures and malformed tokens never expose secrets or send a POST", async () => {
  for (const credential of [
    { ok: false as const, error: { code: "forbidden" as const, message: "fixture-token-never-real", retryable: false } },
    { ok: true as const, value: { accessToken: "fixture-token\r\nnever-real" } },
  ]) {
    const setup = publication();
    const publish = createCapabilities({ ...setup.capabilityDependencies, credentials: { async access() { return credential; } } })["organic.publish.v1"];
    const result = await publish(publishCall); assert.ok(!result.ok);
    assert.equal(result.error.code, credential.ok ? "unauthenticated" : "forbidden");
    assert.equal(JSON.stringify(result).includes("fixture-token"), false); assert.equal(setup.calls.length, 0);
  }
});
