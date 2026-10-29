import type { PluginCapabilitiesFactory, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { context, envelope, campaignPage, mapping, midnight, statsUrl, projectSeries, status } from "./metrics-status.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pluginConfigurationSchema, campaignStatusInputSchema, campaignStatusOutputSchema, reportMetricsInputSchema, metricBatchSchema, callContextSchema, epochSchema, idSchema, parseBoundary, parseExactIntegerJson } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, ReportMetricsInput, PluginCapability, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, decodeList, encodeCommand, failure, success, vendorId } from "./commands.js";
import { decodeReport, reportWindowValid } from "./reporting.js";
import type { SnapchatAdsAdapter, SnapchatConfiguration, SnapchatDependencies, SnapchatInvocation, SnapchatResult, SnapchatWireRequest } from "./ports.js";
import { configurationSchema } from "./ports.js";
export { configurationSchema } from "./ports.js";
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
type Prepared = { invocation: SnapchatInvocation; configuration: SnapchatConfiguration; request: SnapchatWireRequest; ownershipId?: string };
type Credential = z.infer<typeof credentialSchema>;

/** Create an inert read adapter. Credentials resolve per request before the existing server fence.
 * @param required - Binding and injected server policy/token/fetch/clock/observer ports.
 * @returns Typed failures or projected pages/reports; no raw provider errors or tokens escape.
 * @example createSnapchatAdsAdapter({ configuration, gateway, credentials, fetch: guardedFetch, clock, observer })
 * @complexity O(b) time/space, b<=1MiB; one 15s GET, or two for campaign ownership + stats; no retry. */
export function createSnapchatAdsAdapter(required: SnapchatDependencies): SnapchatAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return {
    async invoke(input, options = {}) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    const command = prepared.value.invocation.command;
    if (command.kind === "report" && command.campaignId) {
      const ownership = await dispatch({ dependencies, prepared: { ...prepared.value, ownershipId: command.campaignId,
        request: { method: "GET", url: "https://adsapi.snapchat.com/v1/campaigns/" + command.campaignId } } }, options);
      if (!ownership.ok) return ownership;
    }
    return dispatch({ dependencies, prepared: prepared.value }, options);
  } };
}
/** Closed, bounded invocation and binding validation before any credential lookup or network I/O. */
function prepare(required: { dependencies: SnapchatDependencies; input: SnapchatInvocation }, optional: CallOptions): Outcome<Prepared> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: invocationSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const configuration = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  const bound = configuration.value;
  const valid = validateBinding({ invocation: parsed.value, configuration: bound });
  if (!valid.ok) return valid;
  return { ok: true, value: { invocation: parsed.value, configuration: bound, request: encodeCommand({ command: parsed.value.command, configuration: bound }) } };
}
function validateBinding(required: { invocation: SnapchatInvocation; configuration: SnapchatConfiguration }): Outcome<void> {
  const scope = required.invocation.context.scope, bound = required.configuration;
  if (scope.ownerId !== bound.scope.ownerId || scope.workspaceId !== bound.scope.workspaceId) return failure({ code: "forbidden" });
  const command = required.invocation.command;
  if (bound.accountId === null && !["list_organizations", "list_accounts"].includes(command.kind)) return failure({ code: "forbidden" });
  if (command.kind === "report" && !reportWindowValid({ command, timezone: bound.timezone })) return failure({ code: "invalid_input" });
  return { ok: true, value: undefined };
}
/** Copy JSON before awaiting host callbacks; cycles/oversize inputs return typed failures. O(b<=64KiB). */
export function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const text = JSON.stringify(required.input);
    if (text === undefined || Buffer.byteLength(text) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}
/** Broker failures/exceptions are sanitized. A repeated execute callback cannot send twice;
 * the server's guarded fetch owns current admission/account/connection rechecks at actual egress. */
async function dispatch(required: { dependencies: SnapchatDependencies; prepared: Prepared }, optional: CallOptions): Promise<Outcome<SnapchatResult>> {
  const { dependencies, prepared } = required;
  let sent = false;
  let result: Outcome<SnapchatResult>;
  try {
    const credential = await resolveCredential({ dependencies, configuration: prepared.configuration }, optional);
    if (!credential.ok) result = credential;
    else result = await dependencies.gateway.dispatch({ context: prepared.invocation.context, configuration: structuredClone(prepared.configuration),
      operation: prepared.invocation.command.kind, request: Object.freeze({ ...prepared.request }),
      effect: { operationId: prepared.invocation.operationId, connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId,
        effects: ["read"], moneyExposure: null, requiredLimit: null,
        argumentsDigest: createHash("sha256").update(JSON.stringify({ apiVersion: "v1", request: prepared.request })).digest("hex") },
      execute: async () => {
        if (sent) return failure({ code: "conflict" });
        const checked = beforeEgress({ dependencies, credential: credential.value }, optional);
        if (!checked.ok) return checked;
        sent = true;
        return send({ dependencies, prepared, credential: credential.value }, optional);
      } }, optional);
  } catch { result = failure({ code: "unavailable" }); }
  observe({ dependencies, prepared, result });
  return result;
}
/** Per-call broker lookup with schema validation; callers redact thrown broker faults. O(1) I/O. */
export async function resolveCredential(required: { dependencies: Pick<SnapchatDependencies, "credentials">; configuration: SnapchatConfiguration }, optional: CallOptions): Promise<Outcome<Credential>> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const result = await required.dependencies.credentials.access({ connectionId: required.configuration.connectionId, accountId: required.configuration.accountId }, optional);
  if (!result.ok) return failure({ code: result.error.code });
  return parseBoundary({ schema: credentialSchema, input: result.value });
}
/** Local cancellation/expiry checks; guarded fetch owns current server authority. O(1). */
export function beforeEgress(required: { dependencies: Pick<SnapchatDependencies, "clock">; credential: Credential }, optional: CallOptions): Outcome<void> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const now = required.dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (required.credential.expiresAt !== undefined && now >= required.credential.expiresAt) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}
/** One fixed GET, 15s deadline, no redirects/retries; streamed byte cap applies without Content-Length. */
async function send(required: { dependencies: SnapchatDependencies; prepared: Prepared; credential: Credential }, optional: CallOptions): Promise<Outcome<SnapchatResult>> {
  const deadline = AbortSignal.timeout(15000);
  const signal = optional.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  try {
    const response = await required.dependencies.fetch(required.prepared.request.url, { method: "GET", redirect: "error", signal,
      headers: { Authorization: "Bearer " + required.credential.accessToken, Accept: "application/json" } });
    if (response.status !== 200) { await response.body?.cancel(); return rejection({ status: response.status }); }
    const body = await readBody({ response });
    if (!body.ok) return body;
    if (optional.signal?.aborted) return failure({ code: "cancelled" });
    return decode({ ...required, body: body.value });
  } catch { return failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
}
function rejection(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
/** O(b) bytes/time/space, b<=1MiB. Malformed JSON and size failures never expose response bytes. */
async function readBody(required: { response: Response; exactMetrics?: true }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader(), chunks: Uint8Array[] = [];
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
    if (required.exactMetrics) return parseExactIntegerJson({ text }, { numericTextKeys: ["spend", "impressions", "swipes", "conversion_purchases", "conversion_purchases_value"] });
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}
function decode(required: { dependencies: SnapchatDependencies; prepared: Prepared; body: unknown }): Outcome<SnapchatResult> {
  const { invocation, configuration } = required.prepared;
  const retrievedAt = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(retrievedAt).success) return failure({ code: "invalid_input" });
  const data = invocation.command.kind === "report" && !required.prepared.ownershipId
    ? decodeReport({ body: required.body, command: invocation.command, configuration, retrievedAt })
    : decodeList({ ...required.prepared, body: required.body, command: invocation.command });
  return data.ok ? { ok: true, value: { operationId: invocation.operationId, status: "succeeded", observedState: "unknown", data: data.value } } : data;
}
/** IDs/outcome only; the host owns pre-egress audit. Telemetry failure cannot change a receipt. */
function observe(required: { dependencies: SnapchatDependencies; prepared: Prepared; result: Outcome<SnapchatResult> }): void {
  const context = required.prepared.invocation.context;
  try { required.dependencies.observer.observe({ operation: "snapchat-ads." + required.prepared.invocation.command.kind,
    outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Existing host audit remains authoritative. */ }
}

/** Private shared deployment/CAPI transport. Fixed callers supply URLs/body; query auth is CAPI-only.
 * @returns Bounded status/body or sanitized failure; writes treat every failure as uncertain.
 * @complexity O(b) time/space, b<=1MiB response, <=64KiB request; one <=15s fetch, no retry.
 */
export async function requestSnapchat(required: { fetch: typeof fetch; credential: Credential; exactMetrics?: true;
  request: { url: string; method: "GET" | "POST"; body?: string; authentication?: "query" } }, optional: CallOptions = {}): Promise<Outcome<{ status: number; body: unknown }>> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  if (Buffer.byteLength(required.request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const deadline = AbortSignal.timeout(15000);
  const signal = optional.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  const url = new URL(required.request.url);
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (required.request.authentication === "query") url.searchParams.set("access_token", required.credential.accessToken);
  else headers.Authorization = "Bearer " + required.credential.accessToken;
  try {
    const response = await required.fetch(url.href, { method: required.request.method, body: required.request.body, headers, signal, redirect: "error" });
    const body = await readBody({ response, exactMetrics: required.exactMetrics });
    return body.ok ? { ok: true, value: { status: response.status, body: body.value } } : body;
  } catch { return failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
}

/** Canonical reads use the host broker and guarded fetch; admission stays in the server.
 * @complexity One <=15s/1MiB request, no retries; observations contain IDs/outcomes only. */
export async function requestCapability(required: { dependencies: CapabilityDependencies; context: Parameters<PluginCapability>[0]["context"]; request: SnapchatWireRequest }, optional: CallOptions = {}): Promise<Outcome<unknown>> {
  const { dependencies, context } = required;
  let result: Outcome<unknown>;
  try { result = await executeCapability({ dependencies, request: required.request }, optional); }
  catch { result = failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
  try { dependencies.observer.observe({ operation: "snapchat-ads.capability", outcome: result.ok ? "succeeded" : result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: "runId" in context ? context.runId : undefined }); }
  catch { /* Host durable audit is authoritative. */ }
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return result;
}
/** Resolve a fresh credential then attempt one bounded read. The injected fetch owns the
 * server authority fence; expiry/cancellation failures return before egress. O(b<=1MiB). */
async function executeCapability(required: { dependencies: CapabilityDependencies; request: SnapchatWireRequest }, optional: CallOptions = {}): Promise<Outcome<unknown>> {
  const { dependencies, request } = required;
  let result: Outcome<unknown>;
  const access = await dependencies.credentials.access({ connectionId: dependencies.configuration.connectionId, accountId: dependencies.configuration.accountId! }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const credential = credentialSchema.safeParse(access.value);
  if (!credential.success) return failure({ code: "protocol_mismatch" });
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  if (credential.data.expiresAt !== undefined && dependencies.clock.now({}) >= credential.data.expiresAt) return failure({ code: "expired" });
  const response = await requestSnapchat({ fetch: dependencies.fetch, credential: credential.data, request, exactMetrics: true }, optional);
  result = response;
  if (response.ok) result = response.value.status === 200 ? { ok: true, value: response.value.body } : rejection({ status: response.value.status });
  return result;
}

/** Capability envelope and selection validated before broker/network work. O(b<=64KiB). */
function prepareCapability(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability>[0] }, optional?: CallOptions): Outcome<z.infer<typeof envelope>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const parsed = envelope.safeParse(bounded.value), config = required.dependencies.configuration;
  if (!parsed.success) return failure({ code: "invalid_input" });
  const { scope } = parsed.data.context, { connection } = parsed.data;
  if (scope.ownerId !== config.scope.ownerId || scope.workspaceId !== config.scope.workspaceId) return failure({ code: "forbidden" });
  if (connection.connectionId !== config.connectionId || connection.accountId !== config.accountId) return failure({ code: "forbidden" });
  return { ok: true, value: parsed.data };
}

/** DAY metrics retain account-local days, exact values and observed coverage.
 * @example capabilities["report.metrics.v1"]({ context, connection, input: { grain: "campaign", days } })
 * @complexity Two <=15s/1MiB account metadata/stats reads; O(r+c) time/space, r<=5,000. No retries/polling. */
export async function reportMetrics(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability<"report.metrics.v1">>[0] }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const checked = prepareCapability(required, optional);
  if (!checked.ok) return checked;
  const parsed = reportMetricsInputSchema.safeParse(checked.value.input);
  if (!parsed.success) return failure({ code: "invalid_input" });
  if (!["account", "campaign"].includes(parsed.data.grain)) return failure({ code: "not_implemented" });
  if (Date.parse(parsed.data.days.end) - Date.parse(parsed.data.days.start) > 31 * 86400000) return failure({ code: "limit_exceeded" });
  const account = await readAccount({ dependencies: required.dependencies, context: checked.value.context }, optional);
  if (!account.ok) return account;
  const plan = reportPlan({ input: parsed.data, timezone: account.value.timezone, now: required.dependencies.clock.now({}) });
  if (!plan.ok) return plan;
  const { days, start, end, timezone, grain } = plan.value;
  const url = statsUrl({ id: checked.value.connection.accountId, grain, start, end });
  const response = await requestCapability({ dependencies: required.dependencies, context: checked.value.context, request: { method: "GET", url } }, optional);
  if (!response.ok) return response;
  const projected = projectSeries({ input: response.value, id: checked.value.connection.accountId, grain, days, timezone, start, end });
  if (!projected.ok) return projected;
  return finishMetrics({ connection: checked.value.connection, dependencies: required.dependencies, currency: account.value.currency, timezone, grain, days, end, rows: projected.value.rows, dataThrough: projected.value.dataThrough, complete: projected.value.complete });
}

/** resolve account-local midnights and reject future ends; the 31-calendar-day cap is enforced in reportMetrics.
 * O(1) time/space, no effects. */
function reportPlan(required: { input: ReportMetricsInput; timezone: string; now: number }): Outcome<{ days: MetricBatch["days"]; start: string; end: string; timezone: string; grain: string }> {
  const { timezone, input: { days, grain } } = required;
  const start = midnight({ day: days.start, timezone }), end = midnight({ day: days.end, timezone });
  if (!start || !end) return failure({ code: "protocol_mismatch" });
  if (Date.parse(end) > required.now) return failure({ code: "limit_exceeded" });
  return { ok: true, value: { days, start, end, timezone, grain } };
}

const accountFacts = z.object({ id: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), timezone: metricBatchSchema.shape.timezone });
/** One bounded account GET supplies facts absent from install configuration. A foreign or
 * malformed account fails before stats. O(1) time/space after the <=1MiB bounded read. */
async function readAccount(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context> }, optional?: CallOptions): Promise<Outcome<z.infer<typeof accountFacts>>> {
  const id = required.dependencies.configuration.accountId;
  const response = await requestCapability({ ...required, request: { method: "GET", url: "https://adsapi.snapchat.com/v1/adaccounts/" + id } }, optional);
  if (!response.ok) return response;
  const page = z.object({ request_status: success, adaccounts: z.array(z.object({ sub_request_status: success, adaccount: accountFacts })).length(1) }).safeParse(response.value);
  if (!page.success) return failure({ code: "protocol_mismatch" });
  const account = page.data.adaccounts[0].adaccount;
  if (account.id !== id) return failure({ code: "forbidden" });
  return { ok: true, value: account };
}

/** Validate the final canonical batch; missing provider watermarks remain zero/stale. O(r<=5,000). */
function finishMetrics(required: { connection: { connectionId: string; accountId: string }; dependencies: CapabilityDependencies; currency: string; timezone: string; grain: string; days: MetricBatch["days"]; end: string; rows: MetricBatch["rows"]; dataThrough: number; complete: boolean }): Outcome<MetricBatch> {
  const { grain, days, end, rows, complete } = required;
  const dataThrough = required.dataThrough, retrievedAt = required.dependencies.clock.now({});
  const output = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "snapchat-ads", ...required.connection, currency: required.currency, timezone: required.timezone, grain, days, mapping,
    retrievedAt, dataThrough, complete, freshness: dataThrough >= Date.parse(end) && retrievedAt - dataThrough <= 21600000 ? "fresh" : "stale",
    finality: grain === "account" && dataThrough >= Date.parse(end) ? "final" : "provisional", restated: false, rows });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}

/** Configured ACTIVE does not prove serving: only DELIVERING maps to active. Campaign review
 * reasons are unverified; child rejection never escalates to campaign disapproval.
 * @example capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds } })
 * @complexity <=10 sequential <=15s/1MiB GETs, O(c), c<=10; no retries or truncation. */
export async function campaignStatus(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability<"campaign.status.v1">>[0] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  const checked = prepareCapability(required, optional);
  if (!checked.ok) return checked;
  const input = campaignStatusInputSchema.safeParse(checked.value.input);
  if (!input.success || !input.data.vendorCampaignIds.every(id => vendorId.safeParse(id).success)) return failure({ code: "invalid_input" });
  if (input.data.vendorCampaignIds.length > 10) return failure({ code: "limit_exceeded" });
  const campaigns: CampaignStatusOutput["campaigns"] = [];
  for (const id of input.data.vendorCampaignIds) {
    const result = await readStatus({ dependencies: required.dependencies, context: checked.value.context, id, accountId: checked.value.connection.accountId }, optional);
    if (!result.ok) return result;
    campaigns.push(result.value);
  }
  const output = campaignStatusOutputSchema.safeParse({ observedAt: required.dependencies.clock.now({}), complete: true, campaigns });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}

/** One campaign read verifies both requested identity and bound account before projection. */
async function readStatus(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context>; id: string; accountId: string }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput["campaigns"][number]>> {
  const response = await requestCapability({ ...required, request: { method: "GET", url: "https://adsapi.snapchat.com/v1/campaigns/" + required.id } }, optional);
  if (!response.ok) return response;
  const page = campaignPage.safeParse(response.value);
  if (!page.success || page.data.campaigns.length !== 1 || page.data.paging?.next_link) return failure({ code: "protocol_mismatch" });
  const item = page.data.campaigns[0].campaign;
  if (item.id !== required.id || item.ad_account_id !== required.accountId) return failure({ code: "forbidden" });
  return { ok: true, value: { vendorCampaignId: required.id, status: status({ campaign: item }), disapprovalDescriptions: [] } };
}

/** Bind canonical reads to host I/O; construction is inert and grants no authority.
 * Invalid configuration fails before credentials. O(1), no effects until a handler is called.
 * @example createCapabilities({ fetch, credentials, clock, observer, wait, configuration }) */
export const createCapabilities: PluginCapabilitiesFactory = required => {
  const configuration = pluginConfigurationSchema.extend({ accountId: vendorId }).safeParse(required.configuration);
  return {
    "report.metrics.v1": async (input, options) => {
      if (!configuration.success) return failure({ code: "invalid_input" });
      return reportMetrics({ dependencies: { ...required, configuration: configuration.data }, input }, options).catch(() => failure({ code: options?.signal?.aborted ? "cancelled" : "unavailable" }));
    },
    "campaign.status.v1": async (input, options) => {
      if (!configuration.success) return failure({ code: "invalid_input" });
      return campaignStatus({ dependencies: { ...required, configuration: configuration.data }, input }, options).catch(() => failure({ code: options?.signal?.aborted ? "cancelled" : "unavailable" }));
    },
  };
};
type CapabilityDependencies = PluginCapabilityDependencies;
