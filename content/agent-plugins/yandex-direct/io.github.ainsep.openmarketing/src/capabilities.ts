/** Canonical daily reporting and status reads; vendor codecs stay inside this plugin. */
import { z } from "zod";
import { callContextSchema, serviceContextSchema, pluginConfigurationSchema, capabilityCatalog, campaignStatusOutputSchema, epochSchema, idSchema, metricBatchSchema, metricMappingSchema, parseExactIntegerJson } from "@open-marketing/contracts";
import type { CallOptions, CapabilityOutput, CampaignStatusOutput, MetricBatch, MetricGrain, Outcome, PluginCapability, PluginCapabilitiesFactory, PluginCapabilityDependencies, ReportMetricsInput } from "@open-marketing/contracts";
import { checkCredential, requestYandexRead } from "./transport.js";
import { failure, vendorId, loginSchema } from "./commands.js";

type ReadId = "report.metrics.v1" | "campaign.status.v1";
type Call<K extends ReadId = ReadId> = Parameters<PluginCapability<K>>[0];
const envelope = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]), connection: z.strictObject({ connectionId: idSchema, accountId: vendorId }), input: z.unknown() });
/** Canonical host dependencies; guarded fetch owns admission, authority and audit. */
export type YandexCapabilityDependencies = PluginCapabilityDependencies;
type BoundDependencies = PluginCapabilityDependencies & { credential: Extract<ReturnType<typeof checkCredential>, { ok: true }>["value"]; currency: string };
const baseMetrics = {
  spend: { vendorField: "Cost", meaning: "Cost of clicks in account-currency micros, excluding VAT and discounts; vendor rounds to 10,000 micros." },
  impressions: { vendorField: "Impressions", meaning: "Vendor-reported ad impressions." },
  clicks: { vendorField: "Clicks", meaning: "Vendor-reported ad clicks, not unique visitors or sessions." },
};
/** Conversion goals/attribution are not selected by this binding, so conversion metrics are unsupported. */
export const metricMapping = metricMappingSchema.parse({ pluginId: "yandex-direct", version: "v501-daily-1", grains: { account: baseMetrics, campaign: baseMetrics, ad_group: baseMetrics, ad: baseMetrics } });
const grainColumns = { account: [], campaign: ["CampaignId"], ad_group: ["CampaignId", "AdGroupId"], ad: ["CampaignId", "AdGroupId", "AdId"] } as const;
const reportTypes = { account: "ACCOUNT_PERFORMANCE_REPORT", campaign: "CAMPAIGN_PERFORMANCE_REPORT", ad_group: "ADGROUP_PERFORMANCE_REPORT", ad: "AD_PERFORMANCE_REPORT" } as const;
const counter = z.string().regex(/^(0|[1-9]\d{0,37})$/).nullable();
const reportRow = z.object({ Date: z.iso.date(), CampaignId: vendorId.optional(), AdGroupId: vendorId.optional(), AdId: vendorId.optional(), Impressions: counter, Clicks: counter, Cost: counter });
const campaign = z.object({ Id: z.union([vendorId, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]), Currency: z.string().regex(/^[A-Z]{3}$/), Status: idSchema, State: idSchema, StatusPayment: idSchema, StatusClarification: z.string().max(1000).optional() });
const statusPage = z.object({ result: z.object({ Campaigns: z.array(campaign).max(100), LimitedBy: z.number().int().optional() }) });

/** Bind inert canonical handlers; no credentials or HTTP at construction.
 * @example createCapabilities({ configuration, credentials, fetch, clock, observer, wait })
 * @complexity O(b+n) per bounded page; <=5 reads, <=5,000 rows, host deadline, zero retries. */
export const createCapabilities: PluginCapabilitiesFactory = required => {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { "report.metrics.v1": (call, options) => invoke({ dependencies, call, id: "report.metrics.v1" }, options), "campaign.status.v1": (call, options) => invoke({ dependencies, call, id: "campaign.status.v1" }, options) };
};
/** Validate account, scope and closed capability input before credentials; all failures are typed. */
async function invoke<K extends ReadId>(required: { dependencies: YandexCapabilityDependencies; call: Call<K>; id: K }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    if (!optional?.signal) return failure({ code: "invalid_input" });
    const parsed = envelope.extend({ input: capabilityCatalog[required.id].input }).safeParse(required.call);
    const config = pluginConfigurationSchema.extend({ accountId: vendorId }).safeParse(required.dependencies.configuration);
    if (!parsed.success || !config.success) return failure({ code: "invalid_input" });
    const call = parsed.data as Call;
    const binding = config.data;
    if (call.connection.connectionId !== binding.connectionId || call.connection.accountId !== binding.accountId || call.context.scope.ownerId !== binding.scope.ownerId || call.context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden" });
    const resolved = await resolveAccount({ dependencies: { ...required.dependencies, configuration: binding }, call }, optional);
    if (!resolved.ok) return resolved;
    const dependencies = resolved.value;
    const result = await execute({ ...required, dependencies, call, input: parsed.data.input }, optional);
    observe({ ...required, call, result });
    if (optional.signal.aborted) return failure({ code: "cancelled" });
    // Each vendor codec validates its complete output before returning it.
    return result as Outcome<CapabilityOutput<K>>;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
async function execute(required: { dependencies: BoundDependencies; call: Call; id: ReadId; input: ReportMetricsInput | { vendorCampaignIds: string[] } }, optional?: CallOptions): Promise<Outcome<MetricBatch | CampaignStatusOutput>> {
  if ("grain" in required.input) return report({ ...required, input: required.input }, optional);
  return status({ ...required, ids: required.input.vendorCampaignIds }, optional);
}
/** Resolve one credential and verify clients.get identity/currency for this invocation.
 * O(b), <=1MiB response, one metadata read; settings never supply account facts.
 */
async function resolveAccount(required: { dependencies: PluginCapabilityDependencies; call: Call }, optional?: CallOptions): Promise<Outcome<BoundDependencies>> {
  const { dependencies, call } = required;
  const access = await dependencies.credentials.access(call.connection, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const credential = checkCredential({ input: access.value, now: dependencies.clock.now({}) });
  if (!credential.ok) return credential;
  const response = await requestYandexRead({ dependencies, token: credential.value.accessToken, request: {
    url: "https://api.direct.yandex.com/json/v501/clients", method: "POST", headers: { "Content-Type": "application/json; charset=utf-8", "Client-Login": credential.value.clientLogin },
    body: JSON.stringify({ method: "get", params: { FieldNames: ["ClientId", "Login", "Currency"] } }),
  } }, optional);
  if (!response.ok) return response;
  const json = parseExactIntegerJson({ text: response.value });
  if (!json.ok) return json;
  const providerId = z.union([vendorId, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
  const parsed = z.object({ result: z.object({ Clients: z.array(z.object({ ClientId: providerId, Login: loginSchema, Currency: z.string().regex(/^[A-Z]{3}$/) })).length(1) }) }).safeParse(json.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const account = parsed.data.result.Clients[0];
  if (account.ClientId !== call.connection.accountId || account.Login !== credential.value.clientLogin) return failure({ code: "forbidden" });
  return { ok: true, value: { ...dependencies, credential: credential.value, currency: account.Currency } };
}
/** One authenticated fixed-route read through the host's guarded fetch after credential resolution.
 * @complexity O(b) bounded response; no retries, provider-controlled URLs or retained tokens. */
async function read(required: { dependencies: BoundDependencies; call: Call; id: ReadId; body: object; reports: boolean }, optional?: CallOptions): Promise<Outcome<string>> {
  const { dependencies } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (dependencies.credential.expiresAt !== undefined && dependencies.credential.expiresAt <= now) return failure({ code: "expired" });
  const headers = { "Content-Type": "application/json; charset=utf-8", "Client-Login": dependencies.credential.clientLogin, ...(required.reports ? { processingMode: "online", returnMoneyInMicros: "true", skipReportHeader: "true", skipColumnHeader: "false", skipReportSummary: "true" } : {}) };
  return requestYandexRead({ dependencies, token: dependencies.credential.accessToken, request: { url: "https://api.direct.yandex.com/json/v501/" + (required.reports ? "reports" : "campaigns"), method: "POST", headers, body: JSON.stringify(required.body) } }, optional);
}
/** Page one custom date range; a bound returns honest partial coverage.
 * @complexity O(n) time/space, <=5,000 rows; no missing-day filling or aggregation. */
async function report(required: { dependencies: BoundDependencies; call: Call; input: ReportMetricsInput }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const { input, dependencies } = required;
  const rows: MetricBatch["rows"] = [];
  const { start, end } = input.days;
  let offset = 0;
  let finished = false;
  for (let reads = 0; reads < 5 && rows.length < 5000; reads += 1) {
    const columns = ["Date", ...grainColumns[input.grain], "Impressions", "Clicks", "Cost"];
    const body = { params: { SelectionCriteria: { DateFrom: start, DateTo: new Date(Date.parse(end) - 86400000).toISOString().slice(0, 10) }, FieldNames: columns, Page: { Limit: 1000, Offset: offset }, OrderBy: columns.slice(0, -3).map(Field => ({ Field, SortOrder: "ASCENDING" })), ReportName: "OM daily " + input.grain + " " + start + " " + end + " " + offset, ReportType: reportTypes[input.grain], DateRangeType: "CUSTOM_DATE", Format: "TSV", IncludeVAT: "NO", IncludeDiscount: "NO" } };
    const page = await read({ ...required, id: "report.metrics.v1", reports: true, body }, optional);
    if (!page.ok) return page;
    const decoded = decodePage({ text: page.value, columns, grain: input.grain, start, end });
    if (!decoded.ok) return decoded;
    rows.push(...decoded.value.slice(0, 5000 - rows.length));
    if (decoded.value.length === 1000) { offset += 1000; continue; }
    finished = true; break;
  }
  const retrievedAt = dependencies.clock.now({});
  // Europe/Moscow uses UTC+3 throughout the API's retained reporting period.
  const dataThrough = finished ? Math.min(Date.parse(end) - 3 * 3600000, retrievedAt) : 0;
  const parsed = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "yandex-direct", ...required.call.connection, currency: dependencies.currency, timezone: "Europe/Moscow", ...input, mapping: metricMapping, retrievedAt, dataThrough, complete: finished, freshness: "stale", finality: "provisional", restated: false, rows });
  return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "protocol_mismatch" });
}
/** Reject a partial-invalid page and duplicate identities atomically through the final batch schema. */
function decodePage(required: { text: string; columns: string[]; grain: MetricGrain; start: string; end: string }): Outcome<MetricBatch["rows"]> {
  const lines = required.text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.shift() !== required.columns.join("\t") || lines.length > 1000) return failure({ code: "protocol_mismatch" });
  const rows: MetricBatch["rows"] = [];
  for (const line of lines) {
    const cells = line.split("\t");
    if (cells.length !== required.columns.length) return failure({ code: "protocol_mismatch" });
    const row = reportRow.safeParse(Object.fromEntries(required.columns.map((name, index) => [name, cells[index] === "--" ? null : cells[index]])));
    if (!row.success || row.data.Date < required.start || row.data.Date >= required.end) return failure({ code: "protocol_mismatch" });
    rows.push({ day: row.data.Date, entity: entity({ grain: required.grain, row: row.data }), metrics: { spend: row.data.Cost, impressions: row.data.Impressions, clicks: row.data.Clicks } });
  }
  return { ok: true, value: rows };
}
function entity(required: { grain: MetricGrain; row: z.infer<typeof reportRow> }): MetricBatch["rows"][number]["entity"] {
  const row = required.row;
  switch (required.grain) {
    case "account": return { grain: "account" };
    case "campaign": return { grain: "campaign", vendorCampaignId: row.CampaignId! };
    case "ad_group": return { grain: "ad_group", vendorCampaignId: row.CampaignId!, vendorAdGroupId: row.AdGroupId! };
    case "ad": return { grain: "ad", vendorCampaignId: row.CampaignId!, vendorAdGroupId: row.AdGroupId!, vendorAdId: row.AdId! };
  }
}
/** Bound account/login plus returned currency establish the campaign binding; never infer absent IDs. */
async function status(required: { dependencies: BoundDependencies; call: Call; ids: string[] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  if (!z.array(vendorId).safeParse(required.ids).success) return failure({ code: "invalid_input" });
  const response = await read({ ...required, id: "campaign.status.v1", reports: false, body: { method: "get", params: { SelectionCriteria: { Ids: required.ids.map(Number) }, FieldNames: ["Id", "Currency", "Status", "State", "StatusPayment", "StatusClarification"], Page: { Limit: 100, Offset: 0 } } } }, optional);
  if (!response.ok) return response;
  const page = statusPage.safeParse(JSON.parse(response.value));
  if (!page.success) return failure({ code: "protocol_mismatch" });
  const campaigns = new Map<string, CampaignStatusOutput["campaigns"][number]>();
  for (const row of page.data.result.Campaigns) {
    if (!required.ids.includes(row.Id) || campaigns.has(row.Id)) return failure({ code: "protocol_mismatch" });
    if (row.Currency !== required.dependencies.currency) return failure({ code: "forbidden" });
    campaigns.set(row.Id, { vendorCampaignId: row.Id, status: campaignState({ row }), disapprovalDescriptions: [row.StatusClarification].filter((text): text is string => Boolean(text) && row.Status === "REJECTED") });
  }
  const values = required.ids.map(vendorCampaignId => campaigns.get(vendorCampaignId) ?? { vendorCampaignId, status: "unknown" as const, disapprovalDescriptions: [] });
  return { ok: true, value: campaignStatusOutputSchema.parse({ observedAt: required.dependencies.clock.now({}), complete: page.data.result.LimitedBy === undefined && values.every(row => row.status !== "unknown"), campaigns: values }) };
}
function campaignState({ row }: { row: z.infer<typeof campaign> }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (row.Status === "REJECTED") return "disapproved";
  if (["DRAFT", "MODERATION"].includes(row.Status)) return "pending";
  if (["ARCHIVED", "ENDED"].includes(row.State)) return "ended";
  if (["OFF", "SUSPENDED"].includes(row.State)) return "paused";
  if (row.Status === "ACCEPTED" && row.State === "ON" && row.StatusPayment === "ALLOWED") return "active";
  return "unknown";
}
function observe(required: { dependencies: YandexCapabilityDependencies; call: Call; id: ReadId; result: Outcome<unknown> }): void {
  const context = required.call.context;
  try { required.dependencies.observer.observe({ operation: "yandex-direct." + required.id, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* Host audit remains authoritative. */ }
}
