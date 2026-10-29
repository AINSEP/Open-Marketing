/** DAILY UTC analytics and scoped campaign reads for the frozen plugin ABI. */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { callContextSchema, capabilityCatalog, campaignStatusOutputSchema, epochSchema, idSchema, metricBatchSchema, metricMappingSchema, pluginConfigurationSchema, serviceContextSchema, decimalToMicros } from "@open-marketing/contracts";
import type { CallOptions, CapabilityOutput, CampaignStatusOutput, MetricBatch, Outcome, PluginCapability, ReportMetricsInput, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { failure, linkedInApiVersion, readAccountCurrency, oversizedBody, requestLinkedIn, resolveCredential } from "./transport.js";
import { pauseRequest, stopArgumentsDigest, vendorIdSchema } from "./commands.js";
import type { LinkedInWireRequest } from "./ports.js";

type Id = "report.metrics.v1" | "campaign.status.v1" | "campaign.halt-stop.v1";
type Call<K extends Id = Id> = Parameters<PluginCapability<K>>[0];
const vendorId = z.string().regex(/^[1-9]\d{0,18}$/);
const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorId });
type Dependencies = Omit<PluginCapabilityDependencies, "configuration"> & { configuration: z.infer<typeof configurationSchema> };
const envelope = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]), connection: z.strictObject({ connectionId: idSchema, accountId: vendorId }), input: z.unknown() });
const metrics = {
  spend: { vendorField: "costInLocalCurrency", meaning: "Cost in account local currency, converted exactly from major units to micros." },
  impressions: { vendorField: "impressions", meaning: "Sponsored Content impressions; Sponsored Messaging sends, as defined by LinkedIn." },
  clicks: { vendorField: "clicks", meaning: "Chargeable clicks by objective, including would-be chargeable clicks for CPM campaigns; not landing-page clicks only." },
  vendorConversions: { vendorField: "externalWebsiteConversions", meaning: "Advertiser-defined website actions after an ad click or view; includes vendor estimation. Uses each conversion rule's configured click/view attribution windows; no assumed fixed window. Millionths of conversions, no addition of post-click/post-view categories." },
  vendorConversionValue: { vendorField: "conversionValueInLocalCurrency", meaning: "Advertiser-defined conversion values aggregated in account currency, converted to micros; follows the advertiser's configured conversion rules/windows." },
};
/** Creative rows cannot satisfy OM's required ad-group parent, so those grains are unsupported. */
export const metricMapping = metricMappingSchema.parse({ pluginId: "linkedin-ads", version: "202610-daily-1", grains: { account: metrics, campaign: metrics } });
const decimal = z.string().max(80).regex(/^(0|[1-9]\d{0,37})(\.\d{1,32})?$/);
const integer = z.string().regex(/^(0|[1-9]\d{0,37})$/);
const date = z.object({ year: z.number().int().min(1970).max(9999), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31) });
const analyticRow = z.object({ dateRange: z.object({ start: date, end: date }), pivotValues: z.array(z.string().regex(/^urn:li:sponsored(Account|Campaign):[1-9]\d{0,18}$/)).length(1), costInLocalCurrency: decimal.nullish(), impressions: integer.nullish(), clicks: integer.nullish(), externalWebsiteConversions: decimal.nullish(), conversionValueInLocalCurrency: decimal.nullish() });
const analytics = z.object({ elements: z.array(analyticRow).max(15000) });
const campaign = z.object({ id: vendorId, account: z.string(), status: idSchema, servingStatuses: z.array(idSchema).max(32).optional() });

/** Bind inert canonical reads; no credentials, registries or services at construction.
 * @example createCapabilities({ configuration, credentials, fetch, clock, observer, wait })
 * @complexity O(b+n) time/space, b<=1MiB and n<=5,000; at most 32 reads under a 25s pre-issue budget and caller deadline, no retries. */
export function createCapabilities(required: PluginCapabilityDependencies) {
  const dependencies = { ...required, configuration: required.configuration };
  return { "report.metrics.v1": (call: Call<"report.metrics.v1">, options?: CallOptions) => invoke({ dependencies, call, id: "report.metrics.v1" }, options), "campaign.status.v1": (call: Call<"campaign.status.v1">, options?: CallOptions) => invoke({ dependencies, call, id: "campaign.status.v1" }, options), "campaign.halt-stop.v1": (call: Call<"campaign.halt-stop.v1">, options?: CallOptions) => invoke({ dependencies, call, id: "campaign.halt-stop.v1" }, options) };
}
/** Parse closed canonical inputs and binding before credentials; preserve service identity unchanged. */
async function invoke<K extends Id>(required: { dependencies: PluginCapabilityDependencies; call: Call<K>; id: K }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const prepared = prepare(required);
    if (!prepared.ok) return prepared;
    const { call, dependencies, input } = prepared.value;
    const result = await execute({ ...required, dependencies, call, input }, optional);
    observe({ ...required, dependencies, call, result });
    if (!result.ok) return result;
    const output = capabilityCatalog[required.id].output.safeParse(result.value);
    return output.success ? { ok: true, value: output.data as CapabilityOutput<K> } : failure({ code: "protocol_mismatch" });
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
/** Parse the shared host configuration and closed call binding before effects. */
function prepare(required: { dependencies: PluginCapabilityDependencies; call: Call; id: Id }): Outcome<{ dependencies: Dependencies; call: Call; input: Call["input"] }> {
  const parsed = envelope.safeParse(required.call);
  const config = configurationSchema.safeParse(required.dependencies.configuration);
  const input = capabilityCatalog[required.id].input.safeParse(parsed.success ? parsed.data.input : null);
  if (!parsed.success || !config.success || !input.success) return failure({ code: "invalid_input" });
  const call = parsed.data as Call;
  const binding = config.data;
  if (call.connection.connectionId !== binding.connectionId || call.connection.accountId !== binding.accountId || call.context.scope.ownerId !== binding.scope.ownerId || call.context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden" });
  return { ok: true, value: { dependencies: { ...required.dependencies, configuration: binding }, call, input: input.data } };
}
async function execute(required: { dependencies: Dependencies; call: Call; id: Id; input: Call["input"] }, optional?: CallOptions): Promise<Outcome<unknown>> {
  if ("action" in required.input) return halt({ ...required, input: required.input }, optional);
  if ("grain" in required.input) return report({ ...required, input: required.input }, optional);
  return status({ ...required, ids: required.input.vendorCampaignIds }, optional);
}
/** Reuse token validation and the bounded LinkedIn edge, with exact source tokens for metric values. */
async function read(required: { dependencies: Dependencies; call: Call; id: Id; request: LinkedInWireRequest }, optional?: CallOptions): Promise<Outcome<{ response: Response; body: unknown }>> {
  const { dependencies } = required;
  const credential = await resolveCredential({ credentials: dependencies.credentials, configuration: dependencies.configuration }, optional);
  if (!credential.ok) return credential;
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (credential.value.expiresAt !== undefined && credential.value.expiresAt <= now) return failure({ code: "expired" });
  return requestLinkedIn({ fetch: dependencies.fetch, request: required.request, credential: credential.value, apiVersion: linkedInApiVersion, numericText: true, missingAsNull: required.id === "campaign.status.v1" }, optional);
}
/** DAILY fields remain UTC. Saturated parent windows are discarded before splitting.
 * O(r+n) retained work, <=32 reads/25s pre-issue and <=5,000 rows; no retries. */
async function report(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  if (required.input.grain !== "account" && required.input.grain !== "campaign") return failure({ code: "not_implemented" });
  const deadline = required.dependencies.clock.now({}) + 25000;
  const metadata = await readAccountCurrency({ ...required.dependencies, ...required.call.connection }, optional);
  if (!metadata.ok) return metadata;
  const windows = await reportWindows({ ...required, deadline }, optional);
  return windows.ok ? reportBatch({ ...required, ...windows.value, currency: metadata.value }) : windows;
}
/** Google-style split loop retains only disjoint child windows; single-day overflow stays unknown. */
async function reportWindows(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput; deadline: number }, optional?: CallOptions): Promise<Outcome<{ rows: MetricBatch["rows"]; complete: boolean }>> {
  const pending = [required.input.days], rows: MetricBatch["rows"] = [];
  let complete = true, requests = 1;
  while (pending.length > 0 && rows.length < 5000 && requests < 32 && required.dependencies.clock.now({}) < required.deadline) {
    const days = pending.shift()!;
    const response = await reportWindow({ ...required, input: { ...required.input, days } }, optional);
    requests += 1;
    if (!response.ok) return response;
    if (response.value === null) {
      const children = dateWindows({ days });
      complete = complete && children.length > 0;
      pending.unshift(...children);
      continue;
    }
    complete = complete && response.value.length < 5000 && response.value.length <= 5000 - rows.length;
    rows.push(...response.value.slice(0, 5000 - rows.length));
  }
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return { ok: true, value: { rows, complete: complete && pending.length === 0 } };
}
/** Bisect a half-open UTC interval; a single day has no smaller complete child. O(1). */
function dateWindows({ days }: { days: ReportMetricsInput["days"] }): ReportMetricsInput["days"][] {
  const length = (Date.parse(days.end) - Date.parse(days.start)) / 86400000;
  if (length <= 1) return [];
  const middle = new Date(Date.parse(days.start) + Math.ceil(length / 2) * 86400000).toISOString().slice(0, 10);
  return [{ start: days.start, end: middle }, { start: middle, end: days.end }];
}
/** One bounded analytics read; dates and tainted metric values validate within this window. */
async function reportWindow(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput }, optional?: CallOptions): Promise<Outcome<MetricBatch["rows"] | null>> {
  const { input } = required;
  const pivot = input.grain === "account" ? "ACCOUNT" : "CAMPAIGN";
  const range = `(start:${wireDate({ day: input.days.start })},end:${wireDate({ day: new Date(Date.parse(input.days.end) - 86400000).toISOString().slice(0, 10) })})`;
  const fields = "dateRange,pivotValues,costInLocalCurrency,impressions,clicks,externalWebsiteConversions,conversionValueInLocalCurrency";
  const url = `https://api.linkedin.com/rest/adAnalytics?q=analytics&pivot=${pivot}&timeGranularity=DAILY&dateRange=${range}&accounts=List(${encodeURIComponent("urn:li:sponsoredAccount:" + required.call.connection.accountId)})&fields=${fields}`;
  const response = await read({ ...required, id: "report.metrics.v1", request: { url, method: "GET", restliMethod: "FINDER" } }, optional);
  if (!response.ok) return response === oversizedBody ? { ok: true, value: null } : response;
  if (response.value.response.status !== 200) return failure({ code: "unavailable" });
  const parsed = analytics.safeParse(response.value.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.elements.length > 5000) return { ok: true, value: null };
  return decodeRows({ items: parsed.data.elements, input, accountId: required.call.connection.accountId });
}
/** Pure O(n) daily projection; any malformed row rejects the entire bounded response. */
function decodeRows(required: { items: z.infer<typeof analyticRow>[]; input: ReportMetricsInput; accountId: string }): Outcome<MetricBatch["rows"]> {
  const rows: MetricBatch["rows"] = [];
  for (const item of required.items) {
    const decoded = decodeRow({ item, input: required.input, accountId: required.accountId });
    if (!decoded.ok) return decoded;
    rows.push(decoded.value);
  }
  return { ok: true, value: rows };
}
/** Empty analytics is drained; the row ceiling leaves coverage unknown and a current UTC day stays stale. */
function reportBatch(required: { dependencies: Dependencies; call: Call; input: ReportMetricsInput; rows: MetricBatch["rows"]; currency: string; complete: boolean }): Outcome<MetricBatch> {
  const { rows, input } = required;
  const retrievedAt = required.dependencies.clock.now({});
  const complete = required.complete && rows.length < 5000;
  const batch = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "linkedin-ads", ...required.call.connection, currency: required.currency, timezone: "UTC", ...input, mapping: metricMapping, retrievedAt, dataThrough: complete ? Math.min(Date.parse(input.days.end), retrievedAt) : 0, complete, freshness: complete && Date.parse(input.days.end) <= Date.parse(new Date(retrievedAt).toISOString().slice(0, 10)) ? "fresh" : "stale", finality: "provisional", restated: false, rows });
  return batch.success ? { ok: true, value: batch.data } : failure({ code: "protocol_mismatch" });
}
function wireDate({ day }: { day: string }): string { const [year, month, date] = day.split("-").map(Number); return `(year:${year},month:${month},day:${date})`; }
/** Round-trip dates to reject impossible or expanded monthly ranges, never relabel them as daily. */
function dayText({ value }: { value: z.infer<typeof date> }): string {
  const text = new Date(Date.UTC(value.year, value.month - 1, value.day)).toISOString().slice(0, 10);
  return text === [String(value.year).padStart(4, "0"), String(value.month).padStart(2, "0"), String(value.day).padStart(2, "0")].join("-") ? text : "";
}
/** Preserve missing values; shared arithmetic rejects any precision loss. O(d), d<=80. */
function metricMicros({ value }: { value: string | null | undefined }): Outcome<string | null> {
  if (value == null) return { ok: true, value: null };
  const converted = decimalToMicros({ value, rounding: "reject" });
  return converted.ok ? converted : failure({ code: "protocol_mismatch" });
}
function decodeRow(required: { item: z.infer<typeof analyticRow>; input: ReportMetricsInput; accountId: string }): Outcome<MetricBatch["rows"][number]> {
  const { item, input } = required;
  const day = dayText({ value: item.dateRange.start });
  if (!day || day !== dayText({ value: item.dateRange.end }) || day < input.days.start || day >= input.days.end) return failure({ code: "protocol_mismatch" });
  const urn = item.pivotValues[0]!;
  const expectedPrefix = input.grain === "account" ? "urn:li:sponsoredAccount:" : "urn:li:sponsoredCampaign:";
  if (!urn.startsWith(expectedPrefix)) return failure({ code: "protocol_mismatch" });
  if (input.grain === "account" && urn !== expectedPrefix + required.accountId) return failure({ code: "forbidden" });
  const spend = metricMicros({ value: item.costInLocalCurrency });
  const conversions = metricMicros({ value: item.externalWebsiteConversions });
  const conversionValue = metricMicros({ value: item.conversionValueInLocalCurrency });
  if (!spend.ok) return spend;
  if (!conversions.ok) return conversions;
  if (!conversionValue.ok) return conversionValue;
  return { ok: true, value: { day, entity: input.grain === "account" ? { grain: "account" } : { grain: "campaign", vendorCampaignId: urn.slice(expectedPrefix.length) }, metrics: { spend: spend.value, impressions: item.impressions ?? null, clicks: item.clicks ?? null, vendorConversions: conversions.value, vendorConversionValue: conversionValue.value } } };
}
/** One account-scoped batch GET for all <=100 IDs; preserve input order and missing entities. */
async function status(required: { dependencies: Dependencies; call: Call; ids: string[] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  if (!z.array(vendorId).safeParse(required.ids).success) return failure({ code: "invalid_input" });
  const url = `https://api.linkedin.com/rest/adAccounts/${required.call.connection.accountId}/adCampaigns?ids=List(${required.ids.join(",")})`;
  const response = await read({ ...required, id: "campaign.status.v1", request: { url, method: "GET", restliMethod: "BATCH_GET" } }, optional);
  if (!response.ok) return response;
  const decoded = decodeCampaigns({ ...response.value, ids: required.ids, accountId: required.call.connection.accountId });
  if (!decoded.ok) return decoded;
  return { ok: true, value: campaignStatusOutputSchema.parse({ observedAt: required.dependencies.clock.now({}), complete: decoded.value.every(value => value.status !== "unknown"), campaigns: decoded.value }) };
}
const campaignBatch = z.object({ results: z.record(vendorId, campaign), errors: z.record(vendorId, z.object({ status: z.number().int().min(400).max(599) })).default({}) });
/** Reject unsolicited IDs, overlapping results/errors and foreign accounts before exposing any row.
 * O(n) time/space for <=100 requested IDs; errors and omitted IDs stay unknown. */
function decodeCampaigns(required: { response: Response; body: unknown; ids: string[]; accountId: string }): Outcome<CampaignStatusOutput["campaigns"]> {
  if (required.response.status === 404) return { ok: true, value: required.ids.map(vendorCampaignId => ({ vendorCampaignId, status: "unknown", disapprovalDescriptions: [] })) };
  if (required.response.status !== 200) return failure({ code: "unavailable" });
  const parsed = campaignBatch.safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const { results, errors } = parsed.data;
  const requested = new Set(required.ids);
  if ([...Object.keys(results), ...Object.keys(errors)].some(id => !requested.has(id))) return failure({ code: "protocol_mismatch" });
  for (const [id, item] of Object.entries(results)) {
    if (id !== item.id || errors[id] !== undefined) return failure({ code: "protocol_mismatch" });
    if (item.account !== "urn:li:sponsoredAccount:" + required.accountId) return failure({ code: "forbidden" });
  }
  return { ok: true, value: required.ids.map(vendorCampaignId => ({ vendorCampaignId, status: results[vendorCampaignId] ? campaignState({ item: results[vendorCampaignId]! }) : "unknown", disapprovalDescriptions: [] })) };
}
/** User ACTIVE alone is insufficient. Creative rejection explanations are not exposed by this endpoint. */
function campaignState({ item }: { item: z.infer<typeof campaign> }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (item.status === "PAUSED") return "paused";
  if (["ARCHIVED", "COMPLETED", "CANCELED", "CANCELLED", "REMOVED", "PENDING_DELETION"].includes(item.status)) return "ended";
  if (item.status === "DRAFT") return "pending";
  if (item.status === "ACTIVE" && item.servingStatuses?.length === 1 && item.servingStatuses[0] === "RUNNABLE") return "active";
  return "unknown";
}
function observe(required: { dependencies: Dependencies; call: Call; id: Id; result: Outcome<unknown> }): void {
  const context = required.call.context;
  try { required.dependencies.observer.observe({ operation: "linkedin-ads." + required.id, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* Durable audit stays with the host. */ }
}

/** Host-only halt: exact bound single campaign, PAUSED for either action; never currency or permit I/O.
 * O(n) digest validation (n=1), one bounded POST, no retries; transmission loss stays unknown. */
async function halt(required: { dependencies: Dependencies; call: Call; input: Call<"campaign.halt-stop.v1">["input"] }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<"campaign.halt-stop.v1">>> {
  const request = required.input;
  const binding = required.dependencies.configuration;
  if (request.entityIds.length !== 1 || !vendorIdSchema.safeParse(request.entityIds[0]).success) return failure({ code: "invalid_input" });
  const actual = { scope: request.scope, connectionId: request.connectionId, accountId: request.adAccountId, pluginDigest: request.pluginDigest, bindingId: request.bindingId };
  const expected = { scope: binding.scope, connectionId: binding.connectionId, accountId: binding.accountId, pluginDigest: binding.pluginDigest, bindingId: "linkedin-ads.stop.v1" };
  if (!isDeepStrictEqual(actual, expected)) return failure({ code: "forbidden" });
  const digest = stopArgumentsDigest(request);
  if (!digest.ok || digest.value !== request.argumentsDigest) return failure({ code: "conflict" });
  let issued = false;
  const dependencies = { ...required.dependencies, fetch: ((url, init) => { issued = true; return required.dependencies.fetch(url, init); }) as typeof fetch };
  const response = await read({ ...required, dependencies, id: "campaign.halt-stop.v1", request: pauseRequest({ accountId: binding.accountId, campaignId: request.entityIds[0]! }) }, optional);
  if (!response.ok) return issued && response.error.code === "unavailable" ? { ok: true, value: { status: "unknown", entityIds: request.entityIds } } : response;
  return { ok: true, value: { status: response.value.response.status === 204 ? "acknowledged" : "unknown", entityIds: request.entityIds } };
}
