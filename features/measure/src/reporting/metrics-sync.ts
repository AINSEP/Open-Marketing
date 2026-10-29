import { callContextSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, PluginCapability } from "@open-marketing/contracts";
import { metricOutcomeSchema, metricSyncRequestSchema, metricsBoundary, metricsFailure, parseMetricsAppend } from "./metrics.js";
import type { MetricSyncReceipt, MetricSyncRequest, MetricsRepoPort } from "./metrics.js";

/** Sync one bounded request; the server MUST supply a deadline signal <=30 seconds.
 * One capability call, no retries; outbox completion follows successful persistence.
 * @complexity O(rows + reach), each <=5,000, plus one atomic repository append.
 * @example syncMetrics({ context, request, report, repo, clock }, { signal })
 */
export async function syncMetrics(required: { context: CallContext; request: MetricSyncRequest; report: PluginCapability<"report.metrics.v1">; repo: MetricsRepoPort; clock: ClockPort }, optional?: CallOptions & { observer?: ObserverPort }): Promise<Outcome<MetricSyncReceipt>> {
  const context = parseBoundary({ schema: callContextSchema, input: required.context });
  if (!context.ok) return context;
  const request = parseBoundary({ schema: metricSyncRequestSchema, input: required.request });
  if (!request.ok) return request;
  if (!optional?.signal) return metricsFailure({ code: "invalid_input", message: "Caller-enforced reporting deadline is required" });
  return metricsBoundary({ context: context.value, operation: "measure.sync_metrics", observer: optional.observer, work: async () => {
    const value = request.value;
    const response = await required.report({ context: context.value, connection: { connectionId: value.connectionId, accountId: value.accountId }, input: value.input }, optional);
    if (optional.signal?.aborted) return metricsFailure({ code: "cancelled", message: "Reporting cancelled" });
    const outcome = parseBoundary({ schema: metricOutcomeSchema, input: response });
    if (!outcome.ok) return outcome;
    if (!outcome.value.ok) return outcome.value;
    const append = parseMetricsAppend({ context: context.value, request: value, batch: outcome.value.value });
    if (!append.ok) return append;
    if (append.value.batch.retrievedAt > required.clock.now({})) return metricsFailure({ code: "invalid_input", message: "Metric retrieval is in the future" });
    return required.repo.append(append.value, optional);
  } }, optional);
}
