/** Canonical read handlers; the server alone owns admission, authority and guarded egress. */
import { z } from "zod";
import { callContextSchema, serviceContextSchema, capabilityCatalog, campaignStatusOutputSchema, metricBatchSchema, idSchema, epochSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallOptions, CapabilityOutput, CampaignStatusOutput, MetricBatch, Outcome, PluginCapability, PluginCapabilityDependencies, ReportMetricsInput } from "@open-marketing/contracts";
import { decodeTikTokRead, encodeTikTokCommand, failure, vendorIdSchema } from "./commands.js";
import type { TikTokEncoded } from "./commands.js";
import { accountDayBoundary, dailyPageSize, dailyMetricMapping, decodeTikTokDailyPage } from "./reporting.js";
import { checkTikTokHalt } from "./adapter.js";
import { uncertainFailure } from "./events.js";
import { createTikTokCredentials, createTikTokFetchEgress, requestTikTokRead } from "./transport.js";

type ReadId = "report.metrics.v1" | "campaign.status.v1";
type HandlerId = ReadId | "campaign.halt-stop.v1";
type Call<K extends HandlerId = ReadId> = Parameters<PluginCapability<K>>[0];
const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorIdSchema });
const envelope = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]), connection: z.strictObject({ connectionId: idSchema, accountId: vendorIdSchema }), input: z.unknown() });
const credentialSchema = z.object({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
type Dependencies = Omit<PluginCapabilityDependencies, "configuration"> & { configuration: z.infer<typeof configurationSchema> };
type ReadWire = Extract<TikTokEncoded, { method: "GET" }>;

/** Inert host ABI factory; <=16 sequential reporting GETs or one filtered status GET per call.
 * @example createCapabilities({ fetch, credentials, clock, observer, wait, configuration })
 * @complexity O(b+n) time/space, b<=1 MiB/response, n<=5,000 retained rows; no retries.
 */
export function createCapabilities(required: PluginCapabilityDependencies) {
  return {
    "report.metrics.v1": (call: Call<"report.metrics.v1">, options?: CallOptions) => invoke({ dependencies: required, call, id: "report.metrics.v1" }, options),
    "campaign.halt-stop.v1": (call: Parameters<PluginCapability<"campaign.halt-stop.v1">>[0], options?: CallOptions) => halt({ dependencies: required, call }, options),
    "campaign.status.v1": (call: Call<"campaign.status.v1">, options?: CallOptions) => invoke({ dependencies: required, call, id: "campaign.status.v1" }, options),
  };
}
/** Backend halt worker ABI; current server authority is rechecked by guarded fetch.
 * Both actions send only DISABLE once; an unreadable acknowledgement stays unknown.
 * O(n) validation, <=100 IDs, one bounded POST, no readback or retries.
 */
async function halt(required: { dependencies: PluginCapabilityDependencies; call: Parameters<PluginCapability<"campaign.halt-stop.v1">>[0] }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<"campaign.halt-stop.v1">>> {
  try {
    const prepared = prepare({ ...required, id: "campaign.halt-stop.v1" });
    if (!prepared.ok) return prepared;
    const { call: { context, connection }, dependencies: { configuration: binding }, input: request } = prepared.value;
    const command = checkTikTokHalt({ binding, request });
    if (!command.ok) return command;
    const egress = createTikTokFetchEgress({ fetch: required.dependencies.fetch, credentials: createTikTokCredentials(required.dependencies), observer: required.dependencies.observer });
    const response = await egress.send({ context, connectionId: connection.connectionId, accountId: request.adAccountId, operationId: request.operationId, request: command.value, isCurrent: () => !optional?.signal?.aborted }, optional);
    const result = response.ok ? { ok: true as const, value: { status: "acknowledged" as const } } : uncertainFailure({ response });
    if (!result.ok) return result;
    return { ok: true, value: capabilityCatalog["campaign.halt-stop.v1"].output.parse({ ...result.value, entityIds: request.entityIds }) };
  } catch { return failure({ code: "unavailable", message: "TikTok halt capability unavailable" }); }
}

/** Validate call and host metadata before any credential lookup; preserve owner/service context. */
async function invoke<K extends ReadId>(required: { dependencies: PluginCapabilityDependencies; call: Call<K>; id: K }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok read cancelled" });
    const prepared = prepare(required);
    if (!prepared.ok) return prepared;
    const { call, dependencies, input } = prepared.value;
    const result = "grain" in input ? await report({ dependencies, call, input }, optional) : await status({ dependencies, call, ids: input.vendorCampaignIds }, optional);
    observe({ ...required, result });
    if (!result.ok) return result;
    const output = capabilityCatalog[required.id].output.safeParse(result.value);
    return output.success ? { ok: true, value: output.data as CapabilityOutput<K> } : failure({ code: "protocol_mismatch", message: "Invalid TikTok capability output" });
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable", message: "TikTok capability failed" }); }
}
/** Parse the shared host configuration and closed call binding before effects. */
function prepare<K extends HandlerId>(required: { dependencies: PluginCapabilityDependencies; call: Call<K>; id: K }): Outcome<{ dependencies: Dependencies; call: Call<K>; input: Call<K>["input"] }> {
  const parsed = envelope.safeParse(required.call);
  const config = configurationSchema.safeParse(required.dependencies.configuration);
  const input = capabilityCatalog[required.id].input.safeParse(parsed.success ? parsed.data.input : null);
  if (!parsed.success || !config.success || !input.success) return failure({ code: "invalid_input", message: "Invalid TikTok capability binding" });
  const call = parsed.data as Call<K>;
  const binding = config.data;
  if (call.connection.connectionId !== binding.connectionId || call.connection.accountId !== binding.accountId || call.context.scope.ownerId !== binding.scope.ownerId || call.context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden", message: "TikTok scope/account mismatch" });
  return { ok: true, value: { dependencies: { ...required.dependencies, configuration: binding }, call, input: input.data as Call<K>["input"] } };
}
/** Credential broker/expiry plus fixed bounded transport; authority stays inside host guarded fetch. */
async function read(required: { dependencies: Dependencies; call: Call; wire: ReadWire }, optional?: CallOptions): Promise<Outcome<unknown>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok read cancelled" });
  const access = await required.dependencies.credentials.access(required.call.connection, optional);
  if (!access.ok) return access;
  const credential = credentialSchema.safeParse(access.value);
  if (!credential.success) return failure({ code: "unauthenticated", message: "Invalid TikTok credential" });
  const now = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input", message: "Invalid TikTok clock" });
  if (credential.data.expiresAt !== undefined && credential.data.expiresAt <= now) return failure({ code: "expired", message: "TikTok credential expired" });
  return requestTikTokRead({ fetch: required.dependencies.fetch, wire: required.wire, token: credential.data.accessToken }, optional);
}
/** Account facts come only from the authenticated advertiser response. One bounded GET. */
async function accountMetadata(required: { dependencies: Dependencies; call: Call }, optional?: CallOptions): Promise<Outcome<{ currency: string; timezone: string }>> {
  const command = { kind: "get-advertiser" as const };
  const encoded = encodeTikTokCommand({ input: command, accountId: required.call.connection.accountId });
  if (!encoded.ok) return encoded;
  if (encoded.value.method !== "GET") return failure({ code: "protocol_mismatch", message: "Expected advertiser GET" });
  const response = await read({ ...required, wire: encoded.value }, optional);
  if (!response.ok) return response;
  const decoded = decodeTikTokRead({ input: response.value, command, accountId: required.call.connection.accountId });
  if (!decoded.ok) return decoded;
  const parsed = z.object({ data: z.object({ list: z.array(z.object({ currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(100) })).length(1) }) }).safeParse(decoded.value);
  return parsed.success ? { ok: true, value: parsed.data.data.list[0] } : failure({ code: "protocol_mismatch", message: "Invalid advertiser metadata" });
}
/** Split the half-open window into <=30-day vendor ranges, retaining only known drained coverage.
 * O(n) projection, <=16 sequential GETs, <=5,000 rows and caller deadline; no invented zero rows.
 */
async function report(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const metadata = await accountMetadata(required, optional);
  if (!metadata.ok) return metadata;
  const { currency, timezone } = metadata.value;
  const zone = accountDayBoundary({ day: required.input.days.end, timezone });
  if (!zone.ok) return zone;
  const rows: MetricBatch["rows"] = [];
  let start = required.input.days.start;
  let reads = 1;
  let coveredEnd: string | undefined;
  while (start < required.input.days.end && reads < 16 && rows.length < 5000) {
    const end = nextChunkEnd({ start, end: required.input.days.end });
    const chunk = await reportChunk({ ...required, start, end, budget: 16 - reads, rowBudget: 5000 - rows.length }, optional);
    if (!chunk.ok) return chunk;
    rows.push(...chunk.value.rows);
    reads += chunk.value.reads;
    if (!chunk.value.drained) break;
    coveredEnd = end;
    start = end;
  }
  return reportBatch({ ...required, rows, coveredEnd, currency, timezone });
}
/** Coverage is the last fully drained chunk's local midnight, capped at the injected retrieval time. */
function reportBatch(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput; rows: MetricBatch["rows"]; coveredEnd: string | undefined; currency: string; timezone: string }): Outcome<MetricBatch> {
  const { rows, coveredEnd, currency, timezone } = required;
  const retrievedAt = required.dependencies.clock.now({});
  const coverage = coveredEnd ? accountDayBoundary({ day: coveredEnd, timezone }) : { ok: true as const, value: 0 };
  if (!coverage.ok) return coverage;
  const complete = coveredEnd === required.input.days.end;
  const parsed = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "tiktok-ads", ...required.call.connection, currency, timezone, ...required.input, mapping: dailyMetricMapping, retrievedAt, dataThrough: Math.min(coverage.value, retrievedAt), complete, freshness: complete && coverage.value <= retrievedAt ? "fresh" : "stale", finality: "provisional", restated: false, rows });
  return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "protocol_mismatch", message: "Invalid TikTok metric batch" });
}
function nextChunkEnd(required: { start: string; end: string }): string { return new Date(Math.min(Date.parse(required.start) + 30 * 86400000, Date.parse(required.end))).toISOString().slice(0, 10); }
/** Drain pages within the remaining call/row budget; totals must stay stable across a chunk. */
async function reportChunk(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput; start: string; end: string; budget: number; rowBudget: number }, optional?: CallOptions): Promise<Outcome<{ rows: MetricBatch["rows"]; reads: number; drained: boolean }>> {
  const rows: MetricBatch["rows"] = [];
  let totalRows: number | undefined;
  for (let page = 1; page <= required.budget; page += 1) {
    const decoded = await dailyPage({ ...required, page }, optional);
    if (!decoded.ok) return decoded;
    if (totalRows !== undefined && totalRows !== decoded.value.totalRows) return failure({ code: "protocol_mismatch", message: "TikTok report changed during pagination" });
    totalRows = decoded.value.totalRows;
    rows.push(...decoded.value.rows.slice(0, required.rowBudget - rows.length));
    const drained = page >= decoded.value.totalPages;
    if (drained || rows.length >= required.rowBudget) return { ok: true, value: { rows, reads: page, drained: drained && rows.length === totalRows } };
  }
  return { ok: true, value: { rows, reads: required.budget, drained: false } };
}
/** One page effect and its pure vendor decoder; all reads use the same transport. */
async function dailyPage(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput; start: string; end: string; page: number }, optional?: CallOptions) {
  const wire = dailyWire(required);
  if (!wire.ok) return wire;
  const response = await read({ ...required, wire: wire.value }, optional);
  if (!response.ok) return response;
  return decodeTikTokDailyPage({ ...required, input: response.value, accountId: required.call.connection.accountId, grain: required.input.grain });
}
/** Reuse the existing report encoder, replacing its account-total dimensions with daily grouping. */
function dailyWire(required: { call: Call; input: ReportMetricsInput; start: string; end: string; page: number }): Outcome<ReadWire> {
  const encoded = encodeTikTokCommand({ input: { kind: "report", startDate: required.start, endDate: new Date(Date.parse(required.end) - 86400000).toISOString().slice(0, 10), page: required.page, pageSize: dailyPageSize }, accountId: required.call.connection.accountId });
  if (!encoded.ok) return encoded;
  if (encoded.value.method !== "GET") return failure({ code: "protocol_mismatch", message: "Expected TikTok report GET" });
  const grain = required.input.grain;
  const grouping = { account: ["AUCTION_ADVERTISER", "advertiser_id"], campaign: ["AUCTION_CAMPAIGN", "campaign_id"], ad_group: ["AUCTION_ADGROUP", "adgroup_id"], ad: ["AUCTION_AD", "ad_id"] }[grain];
  const parents = grain === "ad" ? ["campaign_id", "adgroup_id"] : grain === "ad_group" ? ["campaign_id"] : [];
  return { ok: true, value: { ...encoded.value, parameters: { ...encoded.value.parameters,
    data_level: grouping[0], dimensions: JSON.stringify([grouping[1], "stat_time_day"]), metrics: JSON.stringify(["spend", "impressions", "clicks", ...parents]),
    filtering: JSON.stringify([{ field_name: "campaign_status", filter_type: "IN", filter_value: JSON.stringify(["STATUS_ALL"]) }]),
  } } };
}
const statusResponse = z.object({ data: z.object({ list: z.array(z.object({ campaign_id: vendorIdSchema, operation_status: idSchema, secondary_status: idSchema.optional() })).max(100), page_info: z.object({ total_page: z.number().int() }) }) });
/** Reuse the existing filtered campaign encoder/decoder; absent and unfamiliar states stay unknown. */
async function status(required: { dependencies: Dependencies; call: Call; ids: string[] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  const command = { kind: "get-campaigns" as const, page: 1, pageSize: 100, campaignIds: required.ids };
  const encoded = encodeTikTokCommand({ input: command, accountId: required.call.connection.accountId });
  if (!encoded.ok) return encoded;
  if (encoded.value.method !== "GET") return failure({ code: "protocol_mismatch", message: "Expected TikTok GET" });
  const response = await read({ ...required, wire: { ...encoded.value, parameters: { ...encoded.value.parameters, filtering: JSON.stringify({ campaign_ids: required.ids, primary_status: "STATUS_ALL" }) } } }, optional);
  if (!response.ok) return response;
  const decoded = decodeTikTokRead({ input: response.value, command, accountId: required.call.connection.accountId });
  if (!decoded.ok) return decoded;
  const parsed = statusResponse.safeParse(decoded.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch", message: "Invalid TikTok campaigns" });
  const byId = new Map(parsed.data.data.list.map(item => [item.campaign_id, item]));
  const campaigns = required.ids.map(vendorCampaignId => ({ vendorCampaignId, status: campaignState({ item: byId.get(vendorCampaignId) }), disapprovalDescriptions: [] }));
  return { ok: true, value: campaignStatusOutputSchema.parse({ observedAt: required.dependencies.clock.now({}), complete: parsed.data.data.page_info.total_page <= 1 && campaigns.every(item => item.status !== "unknown"), campaigns }) };
}
const secondaryStates: Readonly<Record<string, CampaignStatusOutput["campaigns"][number]["status"]>> = {
  CAMPAIGN_STATUS_DELETE: "ended",
  CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY: "disapproved",
  CAMPAIGN_STATUS_ADVERTISER_AUDIT: "pending",
  CAMPAIGN_STATUS_DISABLE: "paused",
  CAMPAIGN_STATUS_BUDGET_EXCEED: "paused",
  CAMPAIGN_STATUS_ENABLE: "active",
};
/** Deleted/rejected/pending evidence takes precedence over configured pause. ENABLE alone
 * cannot prove delivery; unknown or contradictory active evidence remains incomplete. O(1). */
function campaignState(required: { item: z.infer<typeof statusResponse>["data"]["list"][number] | undefined }): CampaignStatusOutput["campaigns"][number]["status"] {
  const item = required.item;
  if (!item) return "unknown";
  if (item.operation_status !== "ENABLE" && item.operation_status !== "DISABLE") return "unknown";
  if (!item.secondary_status) return item.operation_status === "DISABLE" ? "paused" : "unknown";
  const state = secondaryStates[item.secondary_status] ?? "unknown";
  if (item.operation_status === "DISABLE" && state === "active") return "unknown";
  return state;
}
function observe(required: { dependencies: PluginCapabilityDependencies; call: Call; id: ReadId; result: Outcome<unknown> }): void {
  const context = required.call.context;
  try { required.dependencies.observer.observe({ operation: "tiktok-ads." + required.id, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* Host durable audit remains authoritative. */ }
}
