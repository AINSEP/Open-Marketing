import { describe, expect, it, vi } from "vitest";
import { metricBatchSchema } from "@open-marketing/contracts";
import { createMemoryMetricsRepo, createSqlMetricsRepo } from "../../index.js";
import type { MetricsRepoPort } from "../../index.js";
import type { CallContext, MetricBatch } from "@open-marketing/contracts";
import { context, metricsBatch, metricsQuery, metricsRequest } from "../fixtures.js";
import { createSqlFixture } from "../sql-fixture.js";

/** One B1 contract suite: both adapters exercise the same evidence assertions. */
function metricsRepoSuite(required: { name: string; create: () => MetricsRepoPort }): void {
  describe(required.name, () => {
    it("keeps exact micros and returns independent evidence copies", async () => {
      const repo = required.create(), batch = structuredClone(metricsBatch);
      expect(await append({ repo, batch })).toEqual({ ok: true, value: { syncId: "sync-1", status: "stored" } });
      batch.rows[0]!.metrics.spend = "0";
      const read = await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } });
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.value.map(day => day.batch.rows.map(row => row.metrics.spend))).toEqual([["9007199254740993"], ["7"]]);
      read.value[0]!.batch.rows.length = 0;
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toMatchObject({ ok: true, value: [{ batch: { rows: [{ metrics: { spend: "9007199254740993" } }] } }, {}] });
    });
    it("makes repeated syncs idempotent and rejects changed request arguments", async () => {
      const repo = required.create(); await append({ repo });
      expect(await append({ repo, batch: { ...metricsBatch, rows: [] } })).toEqual({ ok: true, value: { syncId: "sync-1", status: "existing" } });
      expect(await append({ repo, batch: { ...metricsBatch, connectionId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toMatchObject({ ok: true, value: [{ batch: { rows: [{ metrics: { spend: "9007199254740993" } }] } }, {}] });
    });
    it("replaces entire days with partial or empty observations and appends lineage", async () => {
      const repo = required.create(); await append({ repo });
      const batch = { ...metricsBatch, days: { start: "2026-10-02", end: "2026-10-03" }, retrievedAt: metricsBatch.retrievedAt + 1, restated: true, complete: false, rows: [] };
      await append({ repo, batch, syncId: "sync-2" });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toMatchObject({ ok: true, value: [
        { day: "2026-10-01", syncId: "sync-1", previousSyncId: null },
        { day: "2026-10-02", syncId: "sync-2", previousSyncId: "sync-1", batch: { rows: [], complete: false, restated: true } },
      ] });
    });
    it("does not fill missing campaigns from older complete days", async () => {
      const repo = required.create(); await append({ repo });
      const row = metricsBatch.rows[0]!;
      await append({ repo, syncId: "sync-2", batch: { ...metricsBatch, retrievedAt: metricsBatch.retrievedAt + 1, complete: false, rows: [{ ...row, entity: { grain: "campaign", vendorCampaignId: "replacement" } }] } });
      const read = await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } });
      expect(read.ok && read.value.flatMap(day => day.batch.rows.map(row => row.entity))).toEqual([{ grain: "campaign", vendorCampaignId: "replacement" }]);
    });
    it.each([["sync-z", "sync-a"], ["sync-a", "sync-z"]])("selects by retrieval time then ASCII ID across arrival order %s/%s", async (first, second) => {
      const repo = required.create(); await append({ repo, syncId: first }); await append({ repo, syncId: second });
      await append({ repo, syncId: "later-arrival", batch: { ...metricsBatch, retrievedAt: metricsBatch.retrievedAt - 1, rows: [] } });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toMatchObject({ ok: true, value: [{ syncId: "sync-z" }, { syncId: "sync-z" }] });
    });
    it("rejects non-ASCII sync IDs before storing evidence", async () => {
      const repo = required.create();
      expect(await append({ repo, syncId: "sync-𐀀" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
    });
    it("isolates every scope and account dimension", async () => {
      const repo = required.create(); await append({ repo });
      for (const query of [{ ...metricsQuery, pluginId: "other" }, { ...metricsQuery, connectionId: "other" }, { ...metricsQuery, accountId: "other" }]) expect(await repo.readDays({ context, query: { ...query, grain: "campaign" } })).toEqual({ ok: true, value: [] });
      for (const scope of [{ ...context.scope, ownerId: "other" }, { ...context.scope, workspaceId: "other" }]) expect(await repo.readDays({ context: { ...context, scope }, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "account" } })).toEqual({ ok: true, value: [] });
      expect(await append({ repo, context: { ...context, scope: { ...context.scope, workspaceId: "other" } } })).toMatchObject({ ok: true, value: { status: "stored" } });
    });
    it("rejects partially invalid batches before publishing any days", async () => {
      const repo = required.create(), batch = structuredClone(metricsBatch); batch.rows[1]!.metrics.spend = "1.5";
      expect(await append({ repo, batch })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
      expect(await append({ repo })).toMatchObject({ ok: true, value: { status: "stored" } });
    });
    it("returns only requested stored campaign keys in scope, plugin and account", async () => {
      const repo = required.create();
      await append({ repo });
      const stored = { pluginId: metricsBatch.pluginId, accountId: metricsBatch.accountId, vendorCampaignId: "campaign-1" };
      const otherScope = { ...context, scope: { ...context.scope, workspaceId: "other" } };
      const batch = { ...metricsBatch, rows: [{ ...metricsBatch.rows[0]!, entity: { grain: "campaign" as const, vendorCampaignId: "other-scope" } }] };
      await append({ repo, context: otherScope, batch });
      expect(await repo.observedCampaigns({ context, keys: [stored, { ...stored, vendorCampaignId: "unknown" },
        { ...stored, pluginId: "other" }, { ...stored, accountId: "other" }, { ...stored, vendorCampaignId: "other-scope" }] })).toEqual({ ok: true, value: [stored] });
      expect(await repo.observedCampaigns({ context: otherScope, keys: [stored] })).toEqual({ ok: true, value: [] });
      expect(await repo.observedCampaigns({ context, keys: [] })).toEqual({ ok: true, value: [] });
    });
    it("rejects more than 100 campaign membership keys", async () => {
      const repo = required.create();
      const key = { pluginId: metricsBatch.pluginId, accountId: metricsBatch.accountId, vendorCampaignId: "campaign-1" };
      expect(await repo.observedCampaigns({ context, keys: Array(101).fill(key) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("fails rather than truncating when selected days exceed 5000 rows", async () => {
      const repo = required.create();
      for (const day of ["2026-10-01", "2026-10-02"]) await append({ repo, syncId: day, batch: { ...metricsBatch, days: { start: day, end: day === "2026-10-01" ? "2026-10-02" : "2026-10-03" }, rows: Array.from({ length: 5000 }, (_, index) => ({ ...metricsBatch.rows[0]!, day, entity: { grain: "campaign", vendorCampaignId: "campaign-" + index } })) } });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    });
    it("cancels before mutation", async () => {
      const repo = required.create(), controller = new AbortController(); controller.abort();
      expect(await repo.append({ context, request: metricsRequest({}), batch: metricsBatch }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toEqual({ ok: true, value: [] });
    });
  });
}
function append(required: { repo: MetricsRepoPort; batch?: MetricBatch; syncId?: string; context?: CallContext }) {
  return required.repo.append({ context: required.context ?? context, batch: required.batch ?? metricsBatch, request: metricsRequest(required) });
}
metricsRepoSuite({ name: "memory metrics repository", create: () => createMemoryMetricsRepo({}) });
metricsRepoSuite({ name: "SQLite metrics repository", create: () => createSqlMetricsRepo({ database: createSqlFixture({}).database }) });
it("decodes each distinct SQL batch once per read and uses portable ordering", async () => {
  const fixture = createSqlFixture({}), repo = createSqlMetricsRepo(fixture);
  await append({ repo });
  await append({ repo, syncId: "sync-2", batch: { ...metricsBatch, days: { start: "2026-10-03", end: "2026-10-04" }, rows: [], reach: undefined } });
  const parse = vi.spyOn(JSON, "parse"), validate = vi.spyOn(metricBatchSchema, "safeParse"), query = vi.spyOn(fixture.database, "query");
  try {
    const input = { context, query: { ...metricsQuery, grain: "campaign" as const, days: { start: "2026-10-01", end: "2026-10-04" } } };
    const read = await repo.readDays(input);
    expect(read).toMatchObject({ ok: true, value: [{ syncId: "sync-1" }, { syncId: "sync-1" }, { syncId: "sync-2" }] });
    expect(parse).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]![0].text).not.toMatch(/COLLATE BINARY/);
    parse.mockClear(); validate.mockClear();
    expect(await repo.readDays(input)).toEqual(read);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(validate).toHaveBeenCalledTimes(2);
  } finally { parse.mockRestore(); validate.mockRestore(); query.mockRestore(); }
});
it.each([
  "UPDATE measure_metrics_day SET previous_sync_id='' WHERE day='2026-10-02'",
  "UPDATE measure_metrics_day SET day='2026-10-03' WHERE day='2026-10-02'",
])("validates every SQL day after reusing a parsed batch: %s", async text => {
  const fixture = createSqlFixture({}), repo = createSqlMetricsRepo(fixture);
  await append({ repo });
  await fixture.database.query({ text });
  expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign", days: { start: "2026-10-01", end: "2026-10-04" } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});
it("still rejects malformed stored batch evidence before publishing any cached days", async () => {
  const fixture = createSqlFixture({}), repo = createSqlMetricsRepo(fixture);
  await append({ repo });
  await fixture.database.query({ text: "UPDATE measure_metrics_batch SET batch_json=$1", values: [JSON.stringify({ ...metricsBatch, currency: "invalid" })] });
  expect(await repo.readDays({ context, query: { ...metricsQuery, grain: "campaign" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});
it("rolls back batch and first day when the second SQL day insert fails", async () => {
  const fixture = createSqlFixture({}), repo = createSqlMetricsRepo(fixture);
  await fixture.database.query({ text: "CREATE TRIGGER fail_metrics_day BEFORE INSERT ON measure_metrics_day WHEN NEW.day='2026-10-02' BEGIN SELECT RAISE(ABORT,'fixture failure'); END" });
  expect(await append({ repo })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect((await fixture.database.query({ text: "SELECT COUNT(*) AS count FROM measure_metrics_batch" })).rows).toEqual([{ count: 0 }]);
  expect((await fixture.database.query({ text: "SELECT COUNT(*) AS count FROM measure_metrics_day" })).rows).toEqual([{ count: 0 }]);
  await fixture.database.query({ text: "DROP TRIGGER fail_metrics_day" });
  expect(await append({ repo })).toMatchObject({ ok: true, value: { status: "stored" } });
});
