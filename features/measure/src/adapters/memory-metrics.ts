import { parseBoundary } from "@open-marketing/contracts";
import type { MetricBatch } from "@open-marketing/contracts";
import { boundedMetricDays, matchesMetricsQuery, metricCampaignGroups, metricPartition, metricsBoundary, metricsObservedSchema, metricsReadSchema, metricsScope, newerMetricDay, observedMetricCampaigns, parseMetricsAppend, reportingDays, metricsFailure } from "../reporting/metrics.js";
import type { MetricDay, MetricsRepoPort } from "../reporting/metrics.js";

/** In-memory reference adapter; instances own isolated evidence. Appends have no
 * await between validation and publication, so partial evidence never escapes.
 * O(history) reads; bounded result <=31 days / 5,000 rows. For fixtures/local doubles.
 * @example createMemoryMetricsRepo({}) */
export function createMemoryMetricsRepo(_required: Record<string, never>): MetricsRepoPort {
  const records = new Map<string, { request: string; scope: string; batch: MetricBatch; partitions: MetricDay[] }>();
  return {
    async append(input, options) {
      if (options?.signal?.aborted) return metricsFailure({ code: "cancelled", message: "Reporting cancelled" });
      const parsed = parseMetricsAppend(input);
      if (!parsed.ok) return parsed;
      const { context, request, batch } = parsed.value;
      const scope = metricsScope({ context }), key = JSON.stringify([scope, request.syncId]);
      const previous = records.get(key), identity = JSON.stringify(request);
      if (previous && previous.request !== identity) return metricsFailure({ code: "conflict", message: "Sync ID reused for different arguments" });
      if (previous) return { ok: true, value: { syncId: request.syncId, status: "existing" } };
      const query = { ...request, grain: request.input.grain, days: request.input.days };
      const latest = select({ records: [...records.values()], scope, query });
      const partitions = reportingDays({ days: batch.days }).map(day => metricPartition({ batch, syncId: request.syncId, day, previousSyncId: latest.find(partition => partition.day === day)?.syncId ?? null }));
      records.set(key, structuredClone({ request: identity, scope, batch, partitions }));
      return { ok: true, value: { syncId: request.syncId, status: "stored" } };
    },
    async readDays(input, options) {
      if (options?.signal?.aborted) return metricsFailure({ code: "cancelled", message: "Reporting cancelled" });
      const parsed = parseBoundary({ schema: metricsReadSchema, input });
      if (!parsed.ok) return parsed;
      return boundedMetricDays({ partitions: structuredClone(select({ records: [...records.values()], scope: metricsScope(parsed.value), query: parsed.value.query })) });
    },
    /** Reference lookup scans/sorts history per group; only 31 matching batches are inspected.
     * O(groups * history log history) time, O(history) scratch space; groups <=100. */
    async observedCampaigns(input, options) {
      const parsed = parseBoundary({ schema: metricsObservedSchema, input });
      if (!parsed.ok) return parsed;
      return metricsBoundary({ context: parsed.value.context, operation: "measure.metrics.observedCampaigns", work: async () => {
        const scoped = [...records.values()].filter(record => record.scope === metricsScope(parsed.value));
        const observed = metricCampaignGroups(parsed.value).flatMap(keys => {
          const { pluginId, accountId } = keys[0]!;
          const latest = scoped.filter(({ batch }) => batch.pluginId === pluginId && batch.accountId === accountId && batch.grain === "campaign")
            .sort((left, right) => newerMetricDay({ left: left.partitions[0]!, right: right.partitions[0]! }) ? -1 : 1).slice(0, 31);
          return observedMetricCampaigns({ keys, batches: latest.map(record => record.batch) });
        });
        return { ok: true, value: observed };
      } }, options);
    },
  };
}
/** O(history days) latest-partition selection, never a per-campaign fallback. */
function select(required: { records: { scope: string; partitions: MetricDay[] }[]; scope: string; query: Parameters<MetricsRepoPort["readDays"]>[0]["query"] }): MetricDay[] {
  const latest = new Map<string, MetricDay>();
  for (const record of required.records.filter(record => record.scope === required.scope)) {
    for (const partition of record.partitions.filter(partition => matchesMetricsQuery({ partition, query: required.query }))) {
      const prior = latest.get(partition.day);
      if (!prior || newerMetricDay({ left: partition, right: prior })) latest.set(partition.day, partition);
    }
  }
  return [...latest.values()];
}
