import { z } from "zod";
import { callContextSchema, campaignKeySchema, capabilityCatalog, idSchema, metricBatchSchema, parseBoundary, serviceContextSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, CallableCapabilityId, CampaignStatusOutput, CapabilityInput, CapabilityOutput, ClockPort, Outcome, PluginCapability, PluginCapabilityDependencies, PluginCapabilitiesFactory, ReportMetricsInput, ServiceContext, TrackingTagInput } from "@open-marketing/contracts";
import { failure, numericId, parse, protect, success } from "./schema.ts";
import { transportBindingSchema } from "./schemas.ts";
import { asRecord, localInstant } from "./readback.ts";
import { decodeMetrics, metricSearchRows, metricsQuery } from "./metrics.ts";
import type { AccountBinding, GoogleTransportPort } from "./types.ts";
import { createCallTransport, readSignal } from "./transport.ts";
import { stopScopeMatches, transmitStop } from "./stop.ts";
import { validateCampaignDeployment } from "./hosted.ts";

type ReadBinding = Pick<AccountBinding, "scope" | "connectionId" | "customerId">;
type Dependencies = { binding: ReadBinding; transport: GoogleTransportPort; clock: ClockPort };
type ReadId = Exclude<CallableCapabilityId, "campaign.validate.v1">;
type Reads = { [K in CallableCapabilityId]: PluginCapability<K> } & { "campaign.halt-stop.v1": PluginCapability<"campaign.halt-stop.v1"> };
const connectionSchema = campaignKeySchema.pick({ accountId: true }).extend({ connectionId: idSchema });
const accountSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{9}$/), currencyCode: metricBatchSchema.shape.currency, timeZone: metricBatchSchema.shape.timezone });

/** Canonical server ABI; validate configuration and bind existing adapters per call for cancellation.
 * No construction-time I/O or plugin authority. O(1) setup; bounded Google reads per handler.
 * @example createCapabilities({ fetch, credentials, clock, observer, wait, configuration })
 */
export const createCapabilities = ((required: PluginCapabilityDependencies): Reads => ({
  "report.metrics.v1": (call, options) => configuredRead({ dependencies: required, id: "report.metrics.v1", call }, options),
  "campaign.status.v1": (call, options) => configuredRead({ dependencies: required, id: "campaign.status.v1", call }, options),
  "tracking.tag.v1": (call, options) => configuredRead({ dependencies: required, id: "tracking.tag.v1", call }, options),
  "campaign.validate.v1": (call, options) => protect({ work: () => validateCampaignDeployment({ dependencies: required, call }, options) }),
  "campaign.halt-stop.v1": (call, options) => protect({ work: () => configuredStop({ dependencies: required, call }, options) }),
})) satisfies PluginCapabilitiesFactory;

/** Host-authorized halt worker entry; identity validation precedes status-only egress.
 * No account-facts lookup or plugin policy gate. O(n), <=100 unique numeric IDs.
 */
async function configuredStop(required: { dependencies: PluginCapabilityDependencies; call: Parameters<PluginCapability<"campaign.halt-stop.v1">>[0] }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<"campaign.halt-stop.v1">>> {
  const configured = createCallTransport({ dependencies: required.dependencies }, optional);
  if (!configured.ok) return configured;
  const context = readContext({ context: required.call.context });
  if (!context.ok) return context;
  const connection = parseBoundary({ schema: connectionSchema, input: required.call.connection });
  if (!connection.ok) return connection;
  const input = parseBoundary({ schema: capabilityCatalog["campaign.halt-stop.v1"].input, input: required.call.input });
  if (!input.ok) return input;
  const { binding, transport, configuration } = configured.value;
  if (connection.value.connectionId !== binding.connectionId || connection.value.accountId !== binding.customerId) return failure({ code: "forbidden", message: "Google halt connection mismatch" });
  if (!stopScopeMatches({ binding: { ...binding, pluginDigest: configuration.pluginDigest }, context: context.value, request: input.value })) return failure({ code: "forbidden", message: "Google halt binding mismatch" });
  if (!validStopIds({ ids: input.value.entityIds })) return failure({ code: "invalid_input", message: "Invalid Google halt entity IDs" });
  const result = await transmitStop({ context: context.value, request: input.value, transport });
  if (!result.ok) return result;
  return parseBoundary({ schema: capabilityCatalog["campaign.halt-stop.v1"].output, input: { status: result.value.status === "stopped" ? "acknowledged" : "unknown", entityIds: input.value.entityIds } });
}
/** Validate a bounded batch before constructing GAQL/status updates. O(n), no effects. */
function validStopIds({ ids }: { ids: string[] }): boolean {
  return new Set(ids).size === ids.length && ids.every(id => parse({ schema: numericId, input: id }).ok);
}
/** Adapt the shared token broker narrowly; invalid configuration returns before credentials/fetch. */
async function configuredRead<K extends ReadId>(required: { dependencies: PluginCapabilityDependencies; id: K; call: Parameters<PluginCapability<K>>[0] }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  const configured = createCallTransport({ dependencies: required.dependencies }, optional);
  if (!configured.ok) return configured;
  return invokeRead({ ...configured.value, clock: required.dependencies.clock, id: required.id, call: required.call }, optional);
}
/** Bind inert server-only read functions. No registration, credentials, services or new authority.
 * @param required - Trusted binding, bounded Google transport and injected retrieval clock.
 * @returns Frozen-contract functions with typed validation/transport failures; no retries.
 * @example createReadCapabilities({ binding, transport, clock })
 * @complexity O(n) projection, <=5,000 retained rows and <=32 searches per report.
 */
export function createReadCapabilities(required: Dependencies): Pick<Reads, ReadId> {
  return {
    "report.metrics.v1": (input, options) => invokeRead({ ...required, call: input, id: "report.metrics.v1" }, options),
    "campaign.status.v1": (input, options) => invokeRead({ ...required, call: input, id: "campaign.status.v1" }, options),
    "tracking.tag.v1": (input, options) => invokeRead({ ...required, call: input, id: "tracking.tag.v1" }, options),
  };
}
/** Validate context and ownership before any effect; preserve all trace IDs when adapting service contexts. */
async function invokeRead<K extends ReadId>(required: Dependencies & { call: Parameters<PluginCapability<K>>[0]; id: K }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  return protect({ work: async () => {
    if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google read cancelled" });
    const binding = parse<ReadBinding>({ schema: transportBindingSchema, input: { scope: required.binding.scope, connectionId: required.binding.connectionId, customerId: required.binding.customerId } });
    if (!binding.ok) return binding;
    const context = readContext({ context: required.call.context });
    if (!context.ok) return context;
    const connection = parseBoundary({ schema: connectionSchema, input: required.call.connection });
    if (!connection.ok) return connection;
    if (context.value.scope.ownerId !== required.binding.scope.ownerId || context.value.scope.workspaceId !== required.binding.scope.workspaceId || connection.value.connectionId !== required.binding.connectionId || connection.value.accountId !== required.binding.customerId) return failure({ code: "forbidden", message: "Google read binding mismatch" });
    const catalog = capabilityCatalog[required.id];
    const input = catalog.input.safeParse(required.call.input);
    if (!input.success) return failure({ code: "invalid_input", message: "Invalid Google read input" });
    const result = await executeRead({ dependencies: required, context: context.value, id: required.id, input: input.data }, optional);
    if (!result.ok) return result;
    const output = catalog.output.safeParse(result.value);
    if (!output.success) return failure({ code: "invalid_input", message: "Invalid Google read output" });
    return success({ value: output.data as CapabilityOutput<K> });
  } });
}
/** Normalize the two host context ABIs; typed failures contain no supplied values. */
export function readContext({ context }: { context: CallContext | ServiceContext }): Outcome<CallContext> {
  const service = serviceContextSchema.safeParse(context);
  if (!service.success) return parseBoundary({ schema: callContextSchema, input: context });
  const { serviceId, ...rest } = service.data;
  return parseBoundary({ schema: callContextSchema, input: { ...rest, principal: { kind: "service", serviceId } } });
}
async function executeRead(required: { dependencies: Dependencies; context: CallContext; id: ReadId; input: CapabilityInput<ReadId> }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, context, input } = required;
  if (required.id === "report.metrics.v1" && "grain" in input) {
    return readMetrics({ dependencies, context, input }, optional);
  }
  if (required.id === "campaign.status.v1" && "vendorCampaignIds" in input) return readStatus({ dependencies, context, ids: input.vendorCampaignIds }, optional);
  if (required.id === "tracking.tag.v1" && "campaignKey" in input) return readTag({ dependencies, context, input }, optional);
  return failure({ code: "invalid_input", message: "Invalid Google read capability" });
}
/** Consecutive half-open windows; splitting replaces saturated parents, never sums them.
 * O(d) time/space, d<=366 dates. No I/O or ambient clock reads.
 */
function dateWindows({ days, maxDays }: { days: ReportMetricsInput["days"]; maxDays: number }): ReportMetricsInput["days"][] {
  const windows: ReportMetricsInput["days"][] = [];
  const end = Date.parse(days.end);
  for (let start = Date.parse(days.start); start < end; start += maxDays * 86400000) {
    windows.push({ start: new Date(start).toISOString().slice(0, 10), end: new Date(Math.min(end, start + maxDays * 86400000)).toISOString().slice(0, 10) });
  }
  return windows;
}
/** Metadata is read even for empty reports. Never accept currency/timezone from install settings.
 * O(1) projection; one bounded customer search, explicit missing/foreign metadata failures.
 */
export async function readAccount(required: { dependencies: Dependencies; context: CallContext }, optional?: CallOptions): Promise<Outcome<z.infer<typeof accountSchema>>> {
  const response = await search({ ...required, query: "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2" }, optional);
  if (!response.ok) return response;
  if (!response.value.complete || response.value.rows.length !== 1) return failure({ code: "unavailable", message: "Google account metadata unavailable" });
  const account = parseBoundary({ schema: accountSchema, input: response.value.rows[0].customer });
  if (!account.ok) return account;
  if (account.value.id !== required.dependencies.binding.customerId) return failure({ code: "forbidden", message: "Foreign Google account metadata" });
  return account;
}
/** Fetch bounded date windows; split oversized responses and discard saturated parent pages before visiting child windows.
 * O(r+n) retained work, r<=32 requests, n<=5,000 rows; <=30s total and <=1MiB per response.
 * Single-day saturation or unvisited windows produce stale, incomplete coverage. No retries.
 */
async function readMetrics(required: { dependencies: Dependencies; context: CallContext; input: ReportMetricsInput }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const signal = readSignal({ signal: optional?.signal });
  const options = { ...optional, signal };
  const account = await readAccount(required, options);
  if (!account.ok) return account;
  const pending = dateWindows({ days: required.input.days, maxDays: 30 });
  const rows: Record<string, unknown>[] = [];
  let incomplete = false;
  let requests = 1;
  while (pending.length > 0 && rows.length < 5000 && requests < 32) {
    const days = pending.shift()!;
    const response = await metricWindow({ ...required, days }, options);
    requests += 1;
    const length = (Date.parse(days.end) - Date.parse(days.start)) / 86400000;
    if (length > 1 && (response.ok ? !response.value.complete : response.error.code === "limit_exceeded")) {
      pending.unshift(...dateWindows({ days, maxDays: Math.ceil(length / 2) }));
      continue;
    }
    if (!response.ok) return response;
    const remaining = 5000 - rows.length;
    incomplete ||= !response.value.complete || response.value.rows.length > remaining;
    rows.push(...response.value.rows.slice(0, remaining));
  }
  const binding = { ...required.dependencies.binding, currency: account.value.currencyCode, timezone: account.value.timeZone };
  return decodeMetrics({ rows, complete: !(incomplete || pending.length > 0), binding, input: required.input, retrievedAt: required.dependencies.clock.now({}) });
}
/** Validate each fetched window before splitting/retaining it; O(n), at most 1,000 rows.
 * One bounded search; malformed/out-of-window data fails even on a discarded parent page.
 */
async function metricWindow(required: { dependencies: Dependencies; context: CallContext; input: ReportMetricsInput; days: ReportMetricsInput["days"] }, optional?: CallOptions): Promise<ReturnType<typeof metricSearchRows>> {
  const response = await search({ ...required, query: metricsQuery({ input: { ...required.input, days: required.days } }) }, optional);
  if (!response.ok) return response;
  if (response.value.rows.some(row => !inWindow({ row, days: required.days }))) return failure({ code: "invalid_input", message: "Google row outside requested window" });
  return response;
}
/** A retained row must belong to the window that returned it; constant work, no effects. */
function inWindow({ row, days }: { row: Record<string, unknown>; days: ReportMetricsInput["days"] }): boolean {
  const day = asRecord({ value: row.segments }).date;
  return typeof day === "string" && day >= days.start && day < days.end;
}
async function search(required: { dependencies: Dependencies; context: CallContext; query: string }, optional?: CallOptions): Promise<ReturnType<typeof metricSearchRows>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google read cancelled" });
  const result = await required.dependencies.transport.request({ method: "search", context: required.context, operationId: required.context.correlationId, body: { query: required.query } });
  if (!result.ok) return result;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google read cancelled" });
  return metricSearchRows({ value: result.value });
}
const campaignSchema = campaignKeySchema.pick({ vendorCampaignId: true }).extend({
  vendorCampaignId: idSchema.max(19).regex(/^[1-9][0-9]*$/), status: idSchema, primaryStatus: idSchema, primaryStatusReasons: idSchema.array().max(20),
});
/** Read campaign state before enriching it with one bounded child-ad search. */
async function readStatus(required: { dependencies: Dependencies; context: CallContext; ids: string[] }, optional?: CallOptions): Promise<Outcome<unknown>> {
  if (required.ids.some(id => !parse({ schema: numericId, input: id }).ok)) return failure({ code: "invalid_input", message: "Invalid Google campaign ID" });
  const rows = await search({ ...required, query: `SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id, campaign.status, campaign.primary_status, campaign.primary_status_reasons, campaign.start_date_time, campaign.end_date_time, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period, campaign_budget.explicitly_shared FROM campaign WHERE campaign.id IN (${required.ids.join(",")}) LIMIT 101` }, optional);
  if (!rows.ok) return rows;
  if (!rows.value.complete) return failure({ code: "limit_exceeded", message: "Incomplete Google status search" });
  const campaigns = new Map<string, CampaignStatusOutput["campaigns"][number]>();
  for (const row of rows.value.rows) {
    const checked = statusRow({ row, customerId: required.dependencies.binding.customerId });
    if (!checked.ok) return checked;
    const campaign = checked.value;
    if (!required.ids.includes(campaign.vendorCampaignId) || campaigns.has(campaign.vendorCampaignId)) return failure({ code: "invalid_input", message: "Unexpected or duplicate Google campaign" });
    campaigns.set(campaign.vendorCampaignId, campaign);
  }
  return readChildEvidence({ ...required, campaigns }, optional);
}
/** Count ad_group_ad rows once; saturation omits counts without discarding campaign state.
 * O(a+c) time/space, a<=1,000 retained ads, c<=100 campaigns; one existing bounded search.
 * Transport/ownership failures remain typed; missing campaigns never receive a zero count.
 */
async function readChildEvidence(required: { dependencies: Dependencies; context: CallContext; ids: string[]; campaigns: Map<string, CampaignStatusOutput["campaigns"][number]> }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  const ads = await search({ ...required, query: `SELECT customer.id, campaign.id, ad_group_ad.ad.id FROM ad_group_ad WHERE campaign.id IN (${required.ids.join(",")}) AND ad_group_ad.policy_summary.approval_status = 'DISAPPROVED' AND ad_group_ad.status != 'REMOVED' LIMIT 1001` }, optional);
  if (!ads.ok) return ads;
  const counts = new Map<string, number>();
  for (const row of ads.value.rows) {
    if (asRecord({ value: row.customer }).id !== required.dependencies.binding.customerId) return failure({ code: "forbidden", message: "Foreign Google ad" });
    const id = asRecord({ value: row.campaign }).id;
    if (typeof id !== "string" || !required.ids.includes(id)) return failure({ code: "invalid_input", message: "Unexpected Google ad campaign" });
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return success({ value: { observedAt: required.dependencies.clock.now({}), complete: required.campaigns.size === required.ids.length,
    campaigns: required.ids.map(id => {
      const campaign = required.campaigns.get(id);
      if (!campaign) return { vendorCampaignId: id, status: "unknown" as const, disapprovalDescriptions: [] };
      if (!ads.value.complete) return campaign;
      return { ...campaign, rejectedChildAds: counts.get(id) ?? 0 };
    }),
  } });
}
/** Project only attributable current budgets; malformed/unknown facts omit the budget, not status.
 * O(1) bounded schema checks and account-local flight conversion; no effects or amount arithmetic.
 */
function currentBudget({ row }: { row: Record<string, unknown> }): CampaignStatusOutput["campaigns"][number]["currentBudget"] {
  const budget = asRecord({ value: row.campaignBudget });
  if (budget.explicitlyShared !== false && budget.explicitlyShared !== undefined) return undefined;
  const account = accountSchema.pick({ currencyCode: true, timeZone: true }).safeParse(row.customer);
  if (!account.success) return undefined;
  let candidate: unknown;
  if (budget.period === "DAILY") candidate = { kind: "daily", amountMicros: budget.amountMicros, currency: account.data.currencyCode };
  else if (budget.period === "CUSTOM_PERIOD") {
    const campaign = asRecord({ value: row.campaign });
    const start = localInstant({ value: campaign.startDateTime, timezone: account.data.timeZone });
    const end = localInstant({ value: campaign.endDateTime, timezone: account.data.timeZone });
    if (!start.ok || !end.ok) return undefined;
    candidate = { kind: "lifetime", amountMicros: budget.totalAmountMicros, currency: account.data.currencyCode, flight: { start: start.value, end: end.value } };
  } else return undefined;
  const checked = capabilityCatalog["campaign.status.v1"].output.shape.campaigns.element.shape.currentBudget.safeParse(candidate);
  return checked.success ? checked.data : undefined;
}
/** Validate and project one vendor status row; O(r), <=20 policy reasons, no effects. */
function statusRow({ row, customerId }: { row: Record<string, unknown>; customerId: string }): Outcome<CampaignStatusOutput["campaigns"][number]> {
  if (asRecord({ value: row.customer }).id !== customerId) return failure({ code: "forbidden", message: "Foreign Google campaign" });
  const raw = asRecord({ value: row.campaign });
  const checked = parseBoundary({ schema: campaignSchema, input: { vendorCampaignId: raw.id, status: raw.status, primaryStatus: raw.primaryStatus, primaryStatusReasons: raw.primaryStatusReasons ?? [] } });
  if (!checked.ok) return checked;
  const campaign = checked.value;
  const budget = currentBudget({ row });
  return success({ value: { vendorCampaignId: campaign.vendorCampaignId, status: googleStatus({ campaign }), disapprovalDescriptions: campaign.primaryStatusReasons.filter(reason => reason.includes("DISAPPROVED")), ...(budget ? { currentBudget: budget } : {}) } });
}
/** Child-policy reasons are retained separately; they cannot prove total campaign disapproval. */
function googleStatus({ campaign }: { campaign: ReturnType<typeof campaignSchema.parse> }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (campaign.status === "PAUSED") return "paused";
  if (campaign.status === "REMOVED" || campaign.primaryStatus === "ENDED") return "ended";
  if (campaign.primaryStatus === "PENDING") return "pending";
  if (campaign.status === "ENABLED" && ["ELIGIBLE", "LIMITED", "LEARNING"].includes(campaign.primaryStatus)) return "active";
  return "unknown";
}
async function readTag(required: { dependencies: Dependencies; context: CallContext; input: TrackingTagInput }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { campaignKey, destinationUrl } = required.input;
  if (campaignKey.pluginId !== "google-ads" || campaignKey.accountId !== required.dependencies.binding.customerId) return failure({ code: "forbidden", message: "Google tracking key mismatch" });
  if (!parse({ schema: numericId, input: campaignKey.vendorCampaignId }).ok) return failure({ code: "invalid_input", message: "Invalid Google campaign ID" });
  const rows = await search({ ...required, query: "SELECT customer.id, customer.remarketing_setting.google_global_site_tag FROM customer LIMIT 2" }, optional);
  if (!rows.ok) return rows;
  if (!rows.value.complete) return failure({ code: "limit_exceeded", message: "Incomplete Google tag search" });
  if (rows.value.rows.length !== 1) return failure({ code: "unavailable", message: "Google tag unavailable" });
  const customer = asRecord({ value: rows.value.rows[0].customer });
  if (customer.id !== required.dependencies.binding.customerId) return failure({ code: "forbidden", message: "Foreign Google tag" });
  const snippet = asRecord({ value: customer.remarketingSetting }).googleGlobalSiteTag;
  if (typeof snippet !== "string" || snippet.length === 0) return failure({ code: "unavailable", message: "Google tag unavailable" });
  const url = new URL(destinationUrl);
  const hasTracking = ["utm_source", "utm_medium", "om_a", "utm_id"].some(key => url.searchParams.has(key));
  if (!url.hash && !hasTracking) return success({ value: { snippet, campaignUrlTemplate: `{lpurl}?utm_source=google-ads&utm_medium=paid&om_a=${campaignKey.accountId}&utm_id={campaignid}` } });
  // Google requires tracking parameters in the final URL when it contains a fragment:
  // https://support.google.com/google-ads/answer/6277564
  url.searchParams.set("utm_source", "google-ads"); url.searchParams.set("utm_medium", "paid");
  url.searchParams.set("om_a", campaignKey.accountId); url.searchParams.set("utm_id", "{campaignid}");
  return success({ value: { snippet, campaignUrlTemplate: url.toString().replace("utm_id=%7Bcampaignid%7D", "utm_id={campaignid}") } });
}
