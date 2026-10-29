import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { callContextSchema, campaignStatusInputSchema, idSchema, pluginConfigurationSchema, reportMetricsInputSchema, scopeSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, CampaignStatusOutput, MetricBatch, Outcome, PluginCapabilities, PluginCapability, PluginCapabilityDependencies, ReportMetricsInput } from "@open-marketing/contracts";
import { commandSchema, encodeCommand, vendorIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";
import { decodeCampaignStatus, decodeMetricsCsv, decodePage } from "./reporting.js";
import type { LineAdsAdapter, LineAdsDependencies, LineAdsInvocation, LineAdsResult, LineAdsWireRequest } from "./ports.js";

const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Shared read/deployment binding parser; no caller-controlled account or origin. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema.nullable(), country: z.enum(["JP", "TW", "TH"]), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(128) });
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const bundleSchema = z.strictObject({ accessKey: secret, secretKey: secret, groupId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const tokenSchema = z.object({ accessToken: z.string().min(1).max(16384) });
type Prepared = { invocation: z.infer<typeof invocationSchema>; configuration: z.infer<typeof configurationSchema> };
type Binding = Pick<Prepared, "configuration">;

/** Inert server-loaded reads/auth adapter. The server owns admission and guarded egress.
 * @returns Three read operations with typed failures, one <=15s GET, <=1MiB result, no retries.
 * @example createLineAdsAdapter({ configuration, credentials, fetch: guardedFetch, clock, createDeadline, observer })
 * @complexity O(b) time/space for <=64KiB input and <=1MiB response; no startup effects.
 */
export function createLineAdsAdapter(required: LineAdsDependencies): LineAdsAdapter {
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies: required, input }, options);
    if (!prepared.ok) return prepared;
    const result = await dispatch({ dependencies: required, prepared: prepared.value }, options);
    observe({ dependencies: required, prepared: prepared.value, result });
    return result;
  } };
}

/** Snapshot validated inputs before awaits; regional metadata is validated by each caller.
 * @returns Prepared binding or typed denial/invalid input. O(b), <=64KiB; no credential access.
 */
function prepare(required: { dependencies: LineAdsDependencies; input: LineAdsInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundedInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const invocation = invocationSchema.safeParse(bounded.value);
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const { scope } = invocation.data.context;
  if (!sameScope({ first: scope, second: configuration.data.scope })) return failure({ code: "forbidden" });
  if (configuration.data.accountId === null && invocation.data.command.kind !== "list_accounts") return failure({ code: "forbidden" });
  return { ok: true, value: { invocation: invocation.data, configuration: configuration.data } };
}
function sameScope(required: { first: Prepared["configuration"]["scope"]; second: Prepared["configuration"]["scope"] }): boolean {
  return required.first.ownerId === required.second.ownerId && required.first.workspaceId === required.second.workspaceId;
}
function validTime(required: { now: number }): boolean { return Number.isSafeInteger(required.now) && required.now >= 0 && required.now <= 4102444800000; }
/** JSON boundary rejects cycles/oversize without exposing caller data. O(b), <=64KiB accepted. */
export function boundedInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const json = JSON.stringify(required.input);
    if (json === undefined || Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Secrets resolve once; recheck live binding after that await and immediately at fetch.
 * @returns Validated receipt or redacted boundary failure; O(b), one network call, no retries.
 */
async function dispatch(required: { dependencies: LineAdsDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<LineAdsResult>> {
  const { dependencies, prepared } = required;
  const response = await requestLineAds({ ...required, request: prepared.invocation.command }, optional);
  if (!response.ok) return response;
  try {
    const retrievedAt = dependencies.clock.now({});
    if (!validTime({ now: retrievedAt })) return failure({ code: "invalid_input" });
    const data = decodePage({ input: response.value, command: prepared.invocation.command, configuration: prepared.configuration, retrievedAt });
    return data.ok ? { ok: true, value: { operationId: prepared.invocation.operationId, status: "succeeded", observedState: "unknown", data: data.value } } : data;
  } catch { return failure({ code: "unavailable" }); }
}
/** Plugin-internal transport shared by reads and the fixed deployment. Caller validates scope and account metadata.
 * Fresh custody and binding rechecks and <=15s/1MiB bounds on every request; no retry.
 */
export async function requestLineAds(required: { dependencies: LineAdsDependencies; prepared: Binding; request: ParsedCommand | LineAdsWireRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, prepared } = required;
  if (!current(required)) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const access = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, optional);
    if (!access.ok) return failure({ code: access.error.code });
    if (!current(required)) return failure({ code: "forbidden" });
    const bundle = parseBundle({ input: access.value });
    if (!bundle.ok) return bundle;
    const request = "kind" in required.request ? encodeCommand({ command: required.request, accountId: prepared.configuration.accountId, groupId: bundle.value.groupId }) : required.request;
    if (!current(required)) return failure({ code: "forbidden" });
    const deadline = dependencies.createDeadline({ timeoutMs: 15000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    return await requestLineRead({ dependencies, request, bundle: bundle.value }, { ...optional, signal });
  } catch { return failure({ code: "unavailable" }); }
}
/** Parse the sealed paste value locally; invalid/legacy bearer tokens never reach LINE. O(b). */
function parseBundle(required: { input: unknown }): Outcome<z.infer<typeof bundleSchema>> {
  const token = tokenSchema.safeParse(required.input);
  if (!token.success) return failure({ code: "unauthenticated" });
  try {
    const parsed = bundleSchema.safeParse(JSON.parse(token.data.accessToken));
    return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "unauthenticated" });
  } catch { return failure({ code: "unauthenticated" }); }
}
function current(required: { dependencies: LineAdsDependencies; prepared: Binding }): boolean {
  const parsed = configurationSchema.safeParse(required.dependencies.configuration);
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(required.prepared.configuration);
}

/** LINE uses padded URL-safe Base64 (including '='), unlike common unpadded JWT encoders.
 * Canonical URI excludes query; POST signs the exact serialized body and application/json.
 * @returns Bearer signature matching the official sample. O(b) bounded bytes; no effects.
 */
function signedHeaders(required: { request: LineAdsWireRequest; bundle: z.infer<typeof bundleSchema>; now: number }): Record<string, string> {
  const date = new Date(required.now);
  const header = base64({ text: JSON.stringify({ alg: "HS256", kid: required.bundle.accessKey, typ: "text/plain" }) });
  const body = required.request.method === "POST" ? required.request.body : "";
  const contentType = required.request.method === "POST" ? "application/json" : "";
  const payload = [createHash("sha256").update(body).digest("hex"), contentType, date.toISOString().slice(0, 10).replaceAll("-", ""), new URL(required.request.url).pathname].join("\n");
  const input = header + "." + base64({ text: payload });
  const signature = createHmac("sha256", required.bundle.secretKey).update(input).digest("base64").replaceAll("+", "-").replaceAll("/", "_");
  return { Date: date.toUTCString(), Authorization: "Bearer " + input + "." + signature, ...(contentType ? { "Content-Type": contentType } : {}) };
}
function base64(required: { text: string }): string { return Buffer.from(required.text).toString("base64").replaceAll("+", "-").replaceAll("/", "_"); }

/** Fixed-origin request; abort covers response streaming, redirects/error bodies never escape.
 * @returns Parsed JSON, UTF-8 CSV text or typed status/codec failure. O(b), <=1MiB, caller signal; no retries.
 */
async function requestLineRead(required: { dependencies: Pick<LineAdsDependencies, "fetch" | "clock">; request: LineAdsWireRequest; bundle: z.infer<typeof bundleSchema>; text?: boolean }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const signal = optional?.signal;
  try {
    const now = required.dependencies.clock.now({});
    if (!validTime({ now })) return failure({ code: "invalid_input" });
    const headers = signedHeaders({ request: required.request, bundle: required.bundle, now });
    if (signal?.aborted) return failure({ code: "cancelled" });
    const response = await required.dependencies.fetch(required.request.url, { method: required.request.method, ...(required.request.method === "POST" ? { body: required.request.body } : {}), redirect: "error", signal, headers });
    if (response.status !== 200) { await response.body?.cancel(); return rejection({ status: response.status }); }
    return await readBody({ response, text: required.text });
  } catch { return transportFailure({ signal: optional?.signal }); }
}
function transportFailure(required: { signal?: AbortSignal }): Outcome<never> { return failure({ code: required.signal?.aborted ? "cancelled" : "unavailable" }); }

/** Count streamed bytes before parsing; Content-Length cannot bypass the 1MiB cap. O(b). */
async function readBody(required: { response: Response; text?: boolean }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    return { ok: true, value: required.text ? text : JSON.parse(text) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}
function rejection(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "unavailable" });
  }
}
/** Redacted non-retryable boundary failure; unknown creates must reconcile, never retry. */
export function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "LINE request " + required.code, retryable: false } }; }
/** IDs/outcomes only; guarded fetch owns dispatch-time policy and durable server egress audit. */
function observe(required: { dependencies: LineAdsDependencies; prepared: Prepared; result: Outcome<LineAdsResult> }): void {
  const context = required.prepared.invocation.context;
  try { required.dependencies.observer.observe({ operation: "line-ads." + required.prepared.invocation.command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot rewrite the read receipt. */ }
}

type StatusCall = Parameters<PluginCapability<"campaign.status.v1">>[0];
type MetricsCall = Parameters<PluginCapability<"report.metrics.v1">>[0];
const capabilityConfiguration = pluginConfigurationSchema.extend({ accountId: vendorIdSchema });
const capabilityCall = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]),
  connection: z.strictObject({ connectionId: idSchema, accountId: vendorIdSchema }), input: z.unknown() });

/** Bind status and daily count reporting; spend remains unavailable until its unit is documented.
 * The server alone owns authority.
 * @example createCapabilities({ configuration, credentials, fetch, clock, observer, wait })
 */
export function createCapabilities(required: PluginCapabilityDependencies): PluginCapabilities {
  return { "campaign.status.v1": (call, options) => invokeStatus({ dependencies: required, call }, options),
    "report.metrics.v1": (call, options) => invokeMetrics({ dependencies: required, call }, options) };
}
/** Parse and snapshot before credentials; configuration uses the shared server shape. */
function prepareCapability(required: { dependencies: PluginCapabilityDependencies; call: StatusCall | Parameters<PluginCapability<"report.metrics.v1">>[0]; schema: z.ZodType }, optional?: CallOptions): Outcome<z.infer<typeof capabilityConfiguration>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundedInput({ input: required.call });
  if (!bounded.ok) return bounded;
  const call = capabilityCall.safeParse(bounded.value);
  const config = capabilityConfiguration.safeParse(required.dependencies.configuration);
  if (!call.success || !config.success || !required.schema.safeParse(call.data.input).success) return failure({ code: "invalid_input" });
  const binding = config.data;
  if (call.data.connection.connectionId !== binding.connectionId || call.data.connection.accountId !== binding.accountId || !sameScope({ first: call.data.context.scope, second: binding.scope })) return failure({ code: "forbidden" });
  return { ok: true, value: binding };
}
/** Read account facts and named campaign observations under the host cancellation signal.
 * No local timeout or retries. O(b+n), <=1MiB/response, <=100 campaigns. */
async function invokeStatus(required: { dependencies: PluginCapabilityDependencies; call: StatusCall }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  const prepared = prepareCapability({ ...required, schema: campaignStatusInputSchema }, optional);
  if (!prepared.ok) return prepared;
  const input = campaignStatusInputSchema.parse(required.call.input);
  if (!z.array(vendorIdSchema).safeParse(input.vendorCampaignIds).success) return failure({ code: "invalid_input" });
  try {
    const result = await readStatus({ dependencies: required.dependencies, configuration: prepared.value, ids: input.vendorCampaignIds }, optional);
    const outcome = optional?.signal?.aborted ? failure({ code: "cancelled" }) : result;
    observeCapability({ ...required, operation: "campaign.status.v1", result: outcome });
    return outcome;
  } catch { return transportFailure({ signal: optional?.signal }); }
}
/** Fresh host custody for each canonical request; shares signing and the 1MiB JSON/CSV reader. */
async function capabilityRead(required: { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration>; path: string; query?: URLSearchParams; body?: string; text?: boolean }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const access = await required.dependencies.credentials.access({ connectionId: required.configuration.connectionId, accountId: required.configuration.accountId }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const bundle = parseBundle({ input: access.value });
  if (!bundle.ok) return bundle;
  const path = required.path === "accounts" ? `groups/${bundle.value.groupId}/adaccounts` : `adaccounts/${required.configuration.accountId}/${required.path}`;
  const url = `https://ads.line.me/api/v3/${path}` + (required.query ? `?${required.query}` : "");
  const request: LineAdsWireRequest = required.body === undefined ? { method: "GET", url } : { method: "POST", url, body: required.body };
  return requestLineRead({ dependencies: required.dependencies, bundle: bundle.value, request, text: required.text }, optional);
}
const accountMetadata = z.object({ id: z.union([vendorIdSchema, z.number().int().positive().safe().transform(String)]), country: z.enum(["JP", "TW", "TH"]), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(128) });
const accountMetadataPage = z.object({ datas: z.array(accountMetadata).max(100), paging: z.object({ page: z.number().int().positive(), size: z.literal(100), totalElements: z.number().int().nonnegative() }) });
/** Validate one group account page separately from pagination; malformed metadata fails closed. */
async function readAccountPage(required: { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration>; page: number }, optional?: CallOptions): Promise<Outcome<z.infer<typeof accountMetadataPage>>> {
  const response = await capabilityRead({ ...required, path: "accounts", query: new URLSearchParams({ page: String(required.page), size: "100", includeRemoved: "true" }) }, optional);
  if (!response.ok) return response;
  const parsed = accountMetadataPage.safeParse(response.value);
  if (!parsed.success || parsed.data.paging.page !== required.page) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data };
}
/** Authenticated group discovery establishes region/currency/timezone; no install setting is trusted.
 * <=20 pages, paced at 2 reads/second. TW/TH status uses the same documented Management API. */
async function readAccount(required: { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration> }, optional?: CallOptions): Promise<Outcome<z.infer<typeof accountMetadata>>> {
  for (let page = 1; page <= 20; page += 1) {
    const response = await readAccountPage({ ...required, page }, optional);
    if (!response.ok) return response;
    const selected = response.value.datas.find(item => item.id === required.configuration.accountId);
    if (selected) return { ok: true, value: selected };
    if (page * 100 >= response.value.paging.totalElements) return failure({ code: "forbidden" });
    const waited = await required.dependencies.wait({ milliseconds: 500 }, optional);
    if (!waited.ok) return waited;
  }
  return failure({ code: "limit_exceeded" });
}
/** One IDs-filtered GET; keep removed entities and never follow vendor links. */
async function readStatus(required: { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration>; ids: string[] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  const metadata = await readAccount(required, optional);
  if (!metadata.ok) return metadata;
  const waited = await required.dependencies.wait({ milliseconds: 500 }, optional);
  if (!waited.ok) return waited;
  const query = new URLSearchParams({ includeRemoved: "true", page: "1", size: "100" });
  for (const id of required.ids) query.append("ids", id);
  const response = await capabilityRead({ ...required, path: "campaigns", query }, optional);
  if (!response.ok) return response;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return decodeCampaignStatus({ input: response.value, ids: required.ids, observedAt: required.dependencies.clock.now({}) });
}
const reportSchema = z.object({ id: z.number().int().positive().safe(), status: z.enum(["CREATED", "PREPARING", "ERROR", "READY"]) });
const reportsSchema = z.object({ datas: z.array(reportSchema).length(1) });
const reportLevels = { account: "ADACCOUNT", campaign: "CAMPAIGN", ad_group: "ADGROUP", ad: "AD" } as const;

/** One temporary report attempt, observed under the host signal; no persisted report or retries.
 * @returns Validated metrics or a redacted failure. O(b+n), <=1MiB CSV and <=5,000 output rows.
 */
async function invokeMetrics(required: { dependencies: PluginCapabilityDependencies; call: MetricsCall }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const prepared = prepareCapability({ ...required, schema: reportMetricsInputSchema }, optional);
  if (!prepared.ok) return prepared;
  const input = reportMetricsInputSchema.parse(required.call.input);
  const deadline = required.dependencies.clock.now({}) + 25000;
  try {
    const result = await readMetrics({ dependencies: required.dependencies, configuration: prepared.value, input, deadline }, optional);
    const outcome = optional?.signal?.aborted ? failure({ code: "cancelled" }) : result;
    observeCapability({ ...required, operation: "report.metrics.v1", result: outcome });
    return outcome;
  } catch { return transportFailure({ signal: optional?.signal }); }
}
/** Pace report requests and check the soft budget immediately before issuing each request.
 * Host cancellation bounds in-flight I/O; this deadline starts no timers. O(b), <=1MiB/response.
 */
async function requestReport(required: Parameters<typeof capabilityRead>[0] & { deadline: number; delay: number }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const waited = await required.dependencies.wait({ milliseconds: required.delay }, optional);
  if (!waited.ok) return waited;
  if (required.dependencies.clock.now({}) >= required.deadline) return { ok: false, error: { code: "unavailable", message: "LINE report not ready", retryable: true } };
  return capabilityRead(required, optional);
}
/** Poll only our submitted report ID. Pending reports wait 2s; vendor ERROR is non-retryable.
 * @returns READY or a typed failure; sequential requests bounded by the injected 25s budget.
 */
async function pollReport(required: { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration>; id: number; deadline: number }, optional?: CallOptions): Promise<Outcome<void>> {
  let delay = 500;
  while (true) {
    const response = await requestReport({ ...required, path: "pfreports", query: new URLSearchParams({ ids: String(required.id), page: "1", size: "1" }), delay }, optional);
    if (!response.ok) return response;
    const parsed = reportsSchema.safeParse(response.value);
    if (!parsed.success || parsed.data.datas[0].id !== required.id) return failure({ code: "protocol_mismatch" });
    const status = parsed.data.datas[0].status;
    if (status === "ERROR") return failure({ code: "unavailable" });
    if (status === "READY") return { ok: true, value: undefined };
    delay = 2000;
  }
}
/** Discover account facts, submit once, poll, then download UTF-8 CSV through fixed LINE routes.
 * @returns All rows or a failure, never partial success. O(b+n); no per-row I/O or retained state.
 */
async function readMetrics(required: { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration>; input: ReportMetricsInput; deadline: number }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const metadata = await readAccount(required, optional);
  if (!metadata.ok) return metadata;
  const { grain, days } = required.input;
  const until = new Date(Date.parse(days.end) - 86400000).toISOString().slice(0, 10);
  const created = await requestReport({ ...required, path: "pfreports", delay: 500, body: JSON.stringify({ level: reportLevels[grain], since: days.start, until,
    breakdown: { time: "DAY" }, filtering: { idType: "ADACCOUNT", ids: [required.configuration.accountId] }, includeRemove: true, fileFormat: "CSV", locale: "en" }) }, optional);
  if (!created.ok) return created;
  const parsed = reportSchema.safeParse(created.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.status === "ERROR") return failure({ code: "unavailable" });
  const ready = await pollReport({ ...required, id: parsed.data.id }, optional);
  if (!ready.ok) return ready;
  const csv = await requestReport({ ...required, path: `pfreports/${parsed.data.id}/download`, text: true, delay: 500 }, optional);
  if (!csv.ok) return csv;
  return decodeMetricsCsv({ text: csv.value, input: required.input, connection: required.configuration, currency: metadata.value.currency,
    timezone: metadata.value.timezone, retrievedAt: required.dependencies.clock.now({}) });
}
/** Emit only operation/outcome and caller correlation; telemetry failure cannot change the result. */
function observeCapability(required: { dependencies: PluginCapabilityDependencies; call: StatusCall | MetricsCall; operation: "campaign.status.v1" | "report.metrics.v1"; result: Outcome<unknown> }): void {
  const context = required.call.context;
  try { required.dependencies.observer.observe({ operation: "line-ads." + required.operation, outcome: required.result.ok ? "succeeded" : required.result.error.code,
    correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* Host audit remains authoritative. */ }
}
