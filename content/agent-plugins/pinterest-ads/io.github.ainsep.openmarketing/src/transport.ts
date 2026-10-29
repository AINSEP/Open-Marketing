import type { PluginCapabilitiesFactory, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { context, envelope, account as metricsAccount, campaign as statusCampaign, projectMetrics, projectStatus } from "./metrics-status.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { pluginConfigurationSchema, campaignStatusInputSchema, campaignStatusOutputSchema, reportMetricsInputSchema, digestSchema, epochSchema, idSchema, parseBoundary, scopeSchema, parseExactIntegerJson } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, PluginCapability, CallContext, CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import { cursor, encodeCommand, invocationSchema, vendorId } from "./commands.js";
import { failure } from "./ports.js";
import type { PinterestAdsAdapter, PinterestDependencies, PinterestInvocation, PinterestResult, PinterestWireRequest, PinterestWriteRequest } from "./ports.js";
import { decodeReport } from "./reporting.js";

/** Shared binding schema for reads and internal server jobs; parsing performs no effects. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), apiVersion: z.literal("v5"), pluginDigest: digestSchema, bindingId: idSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const account = z.object({ id: vendorId, name: z.string().max(256).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), time_zone: z.string().min(1).max(128).optional() });
const campaign = z.object({ id: vendorId, ad_account_id: vendorId, name: z.string().max(256).optional(), status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DRAFT", "DELETED_DRAFT"]).optional() });
interface Prepared { configuration: z.infer<typeof configurationSchema>; invocation: z.infer<typeof invocationSchema>; request: PinterestWireRequest; effect: EffectEnvelope }

/** Inert server adapter; typed failures, no retries. Gateway rechecks authority after token lookup.
 * @param required - Host-held binding, gateway, broker, fetch, deadline, clock and observer.
 * @returns One read invocation boundary; no token or raw vendor error escapes.
 * @example createPinterestAdsAdapter({ configuration, gateway, credentials, fetch, deadline, clock, observer })
 * @complexity O(b) time/space, <=64KiB input and <=1MiB response, one 15s request.
 */
export function createPinterestAdsAdapter(required: PinterestDependencies): PinterestAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return {
    async invoke(input, options) {
    try {
      const prepared = prepare({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      const result = await dispatch({ dependencies, prepared: prepared.value }, options).catch(() => failure({ code: "unavailable" }));
      observe({ dependencies, prepared: prepared.value, result });
      return result;
    } catch { return failure({ code: "invalid_input" }); }
  } };
}

/** Bound and validate all input before any credential/network I/O. @complexity O(b), b<=64KiB. */
function prepare(required: { dependencies: PinterestDependencies; input: PinterestInvocation }, options?: CallOptions): Outcome<Prepared> {
  if (options?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const invocation = parseBoundary({ schema: invocationSchema, input: bounded.value });
  if (!invocation.ok) return invocation;
  const configuration = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  const scope = invocation.value.context.scope;
  if (scope.ownerId !== configuration.value.scope.ownerId || scope.workspaceId !== configuration.value.scope.workspaceId) return failure({ code: "forbidden" });
  const now = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  const request = encodeCommand({ command: invocation.value.command, configuration: configuration.value, now });
  if (!request.ok) return request;
  const effect: EffectEnvelope = { operationId: invocation.value.operationId, connectionId: configuration.value.connectionId, accountId: configuration.value.accountId, effects: ["read"], argumentsDigest: createHash("sha256").update(JSON.stringify(request.value)).digest("hex"), moneyExposure: null, requiredLimit: null };
  return { ok: true, value: { invocation: invocation.value, configuration: configuration.value, request: request.value, effect } };
}

/** Token precedes the host fence; execute can send once only. @complexity O(1), one broker lookup. */
async function dispatch(required: { dependencies: PinterestDependencies; prepared: Prepared }, options?: CallOptions): Promise<Outcome<PinterestResult>> {
  const { dependencies, prepared } = required;
  const token = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, options);
  if (!token.ok) return failure({ code: token.error.code });
  const credential = credentialSchema.safeParse(token.value);
  if (!credential.success) return failure({ code: "protocol_mismatch" });
  let sent = false;
  return dependencies.gateway.dispatch({ context: prepared.invocation.context, configuration: structuredClone(prepared.configuration), operation: prepared.invocation.command.kind, request: Object.freeze({ ...prepared.request }), effect: structuredClone(prepared.effect), execute: async () => {
    if (sent) return failure({ code: "conflict" });
    if (options?.signal?.aborted) return failure({ code: "cancelled" });
    const now = dependencies.clock.now({});
    if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
    if (credential.data.expiresAt !== undefined && now >= credential.data.expiresAt) return failure({ code: "expired" });
    sent = true;
    return send({ dependencies, prepared, accessToken: credential.data.accessToken }, options);
  } }, options);
}

/** Fixed origin, no redirects, bounded body under the same 15s deadline. @complexity O(b), b<=1MiB. */
async function send(required: { dependencies: PinterestDependencies; prepared: Prepared; accessToken: string }, options?: CallOptions): Promise<Outcome<PinterestResult>> {
  const deadline = required.dependencies.deadline({ timeoutMs: 15000 });
  const signal = options?.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  try {
    const response = await required.dependencies.fetch(required.prepared.request.url, { method: "GET", redirect: "error", signal, headers: { Authorization: "Bearer " + required.accessToken, Accept: "application/json" } });
    if (response.status !== 200) {
      await response.body?.cancel();
      return statusFailure({ status: response.status });
    }
    const body = await readBody({ response, signal });
    if (!body.ok) return options?.signal?.aborted ? failure({ code: "cancelled" }) : body;
    const retrievedAt = required.dependencies.clock.now({});
    if (!epochSchema.safeParse(retrievedAt).success) return failure({ code: "invalid_input" });
    const decoded = decode({ prepared: required.prepared, body: body.value, retrievedAt });
    if (!decoded.ok) return decoded;
    return { ok: true, value: { operationId: required.prepared.invocation.operationId, status: "succeeded", observedState: "unknown", data: decoded.value } };
  } catch { return failure({ code: options?.signal?.aborted ? "cancelled" : "unavailable" }); }
}

/** Snapshot JSON before awaits; reject oversized or unserializable boundaries. O(b), b<=64KiB. */
export function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const bytes = JSON.stringify(required.input);
    if (bytes === undefined || Buffer.byteLength(bytes) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(bytes) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Fresh broker lookup; validate tainted token and redact opaque broker faults. O(1) I/O. */
export async function resolveCredential(required: { dependencies: Omit<PinterestDependencies, "gateway"> }, optional?: CallOptions): Promise<Outcome<z.infer<typeof credentialSchema>>> {
  const { dependencies } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const token = await dependencies.credentials.access({ connectionId: dependencies.configuration.connectionId, accountId: dependencies.configuration.accountId }, optional);
    if (!token.ok) return failure({ code: token.error.code });
    const parsed = credentialSchema.safeParse(token.value);
    return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "protocol_mismatch" });
  } catch { return failure({ code: "unavailable" }); }
}

/** Shared fixed-origin transport, final synchronous fence, no redirects/retries; body/status stay private.
 * Host-fenced fetch owns durable egress audit/current approval. O(b), <=1MiB and <=15s per call.
 */
export async function requestPinterest(required: { dependencies: Pick<PinterestDependencies, "fetch" | "clock" | "observer"> & Partial<Pick<PinterestDependencies, "deadline">>; context: Pick<CallContext, "correlationId" | "traceId" | "runId">; request: PinterestWriteRequest; credential: z.infer<typeof credentialSchema>; isCurrent?: () => boolean; exactMetrics?: true; expectedStatus?: 200 }, optional?: CallOptions): Promise<Outcome<{ status: number; body: unknown }>> {
  const { dependencies, request, credential } = required;
  let result: Outcome<{ status: number; body: unknown }>;
  try {
    const deadline = dependencies.deadline?.({ timeoutMs: 15000 }) ?? AbortSignal.timeout(15000);
    const signal = AbortSignal.any([deadline, optional?.signal ?? deadline]);
    if (signal.aborted) return failure({ code: "cancelled" });
    const checked = checkEgress(required);
    if (!checked.ok) return checked;
    const response = await dependencies.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal, headers: { Authorization: "Bearer " + credential.accessToken, Accept: "application/json", "Content-Type": "application/json" } });
    if (required.expectedStatus !== undefined && response.status !== required.expectedStatus) {
      await response.body?.cancel();
      return statusFailure({ status: response.status });
    }
    const body = await readBody({ response, signal, exactMetrics: required.exactMetrics });
    result = body.ok ? { ok: true, value: { status: response.status, body: body.value } } : body;
  } catch { result = failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
  try { dependencies.observer.observe({ operation: "pinterest-ads.http", outcome: result.ok ? String(result.value.status) : result.error.code, ...required.context }); }
  catch { /* Durable audit remains host-owned; telemetry cannot erase an outcome. */ }
  return result;
}

/** Synchronous final transport checks; the injected fetch supplies the host's current authority. O(1). */
function checkEgress(required: { dependencies: Pick<PinterestDependencies, "fetch" | "clock" | "observer"> & Partial<Pick<PinterestDependencies, "deadline">>; request: PinterestWriteRequest; credential: z.infer<typeof credentialSchema>; isCurrent?: () => boolean }): Outcome<void> {
  if (!required.request.url.startsWith("https://api.pinterest.com/v5/ad_accounts")) return failure({ code: "invalid_input" });
  const now = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (required.credential.expiresAt !== undefined && now >= required.credential.expiresAt) return failure({ code: "expired" });
  if (required.isCurrent?.() === false) return failure({ code: "forbidden" });
  return { ok: true, value: undefined };
}
function statusFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "unavailable" });
  }
}

/** Abort also cancels stalled response streams; Content-Length is never trusted. @complexity O(b), b<=1MiB. */
async function readBody(required: { response: Response; signal: AbortSignal; exactMetrics?: true }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  required.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (!required.signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    if (required.signal.aborted) return failure({ code: "unavailable" });
    const text = Buffer.concat(chunks).toString("utf8");
    if (required.exactMetrics) return parseExactIntegerJson({ text }, { numericTextKeys: ["SPEND_IN_MICRO_DOLLAR", "TOTAL_IMPRESSION", "TOTAL_CLICKTHROUGH", "TOTAL_CONVERSIONS"] });
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { required.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Reject a whole page for duplicate/foreign records, strip unconsumed fields and return only cursor.
 * @complexity O(n) time/space, n<=100; report decoder separately bounds rows to 9000.
 */
function decode(required: { prepared: Prepared; body: unknown; retrievedAt: number }): Outcome<unknown> {
  const { command } = required.prepared.invocation;
  const { accountId, currency } = required.prepared.configuration;
  if (command.kind === "report") return decodeReport({ input: required.body, command, accountId: accountId!, currency: currency!, retrievedAt: required.retrievedAt });
  const item = command.kind === "list_accounts" ? account : campaign;
  const parsed = z.object({ items: z.array(item).max(command.pageSize), bookmark: cursor.nullable().optional() }).safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const keys = parsed.data.items.map(value => value.id);
  if (new Set(keys).size !== keys.length) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_campaigns" && parsed.data.items.some(value => "ad_account_id" in value && value.ad_account_id !== accountId)) return failure({ code: "forbidden" });
  return { ok: true, value: { items: parsed.data.items, nextPageToken: parsed.data.bookmark ?? null } };
}
/** Correlation IDs and outcome only; durable egress audit belongs to the host. */
function observe(required: { dependencies: PinterestDependencies; prepared: Prepared; result: Outcome<PinterestResult> }): void {
  const { context, command } = required.prepared.invocation;
  try { required.dependencies.observer.observe({ operation: "pinterest-ads." + command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot replace the receipt; host audit remains authoritative. */ }
}

/** Canonical reads use host-guarded fetch; only the server invoker owns admission.
 * Credential lookup precedes each <=15s/1MiB request. O(b) bounded bytes, no retry. */
export async function requestCapability(required: { dependencies: CapabilityDependencies; context: Parameters<PluginCapability>[0]["context"]; request: PinterestWireRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, context } = required;
  const ids = { correlationId: context.correlationId, traceId: context.traceId, runId: "runId" in context ? context.runId : undefined };
  let result: Outcome<{ status: number; body: unknown }>;
  try { result = await executeCapability({ dependencies, request: required.request, context: ids }, optional); }
  catch { result = failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
  try { dependencies.observer.observe({ operation: "pinterest-ads.capability", outcome: result.ok ? "succeeded" : result.error.code, ...ids }); }
  catch { /* Host durable audit is authoritative. */ }
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return result.ok ? { ok: true, value: result.value.body } : result;
}
/** Resolve a fresh credential then attempt one bounded read. The injected fetch owns the
 * server authority fence; expiry/cancellation failures return before egress. O(b<=1MiB). */
async function executeCapability(required: { dependencies: CapabilityDependencies; context: Pick<CallContext, "correlationId" | "traceId" | "runId">; request: PinterestWireRequest }, optional: CallOptions = {}): Promise<Outcome<{ status: number; body: unknown }>> {
  const { dependencies, request } = required;
  const access = await dependencies.credentials.access({ connectionId: dependencies.configuration.connectionId, accountId: dependencies.configuration.accountId! }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const credential = credentialSchema.safeParse(access.value);
  if (!credential.success) return failure({ code: "protocol_mismatch" });
  return requestPinterest({ dependencies, context: required.context, request, credential: credential.data, exactMetrics: true, expectedStatus: 200 }, optional);
}

/** Snapshot and validate capability binding before I/O. O(b), b<=64KiB; no effects. */
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

/** Account DAY analytics default to UTC for every account; local-time beta is not selected.
 * @example capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })
 * @complexity Two <=15s/1MiB guarded reads; O(r) time/space, r<=5,000. No retries. */
export async function reportMetrics(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability<"report.metrics.v1">>[0] }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const checked = prepareCapability(required, optional);
  if (!checked.ok) return checked;
  const parsed = reportMetricsInputSchema.safeParse(checked.value.input);
  if (!parsed.success) return failure({ code: "invalid_input" });
  if (parsed.data.grain !== "account") return failure({ code: "not_implemented" });
  const now = required.dependencies.clock.now({}), { days } = parsed.data;
  const today = Math.floor(now / 86400000) * 86400000;
  if (Date.parse(days.start) < today - 89 * 86400000 || Date.parse(days.end) > today) return failure({ code: "limit_exceeded" });
  const base = "https://api.pinterest.com/v5/ad_accounts/" + checked.value.connection.accountId;
  const bound = await readAccount({ dependencies: required.dependencies, context: checked.value.context, base }, optional);
  if (!bound.ok) return bound;
  const url = new URL(base + "/analytics");
  url.search = new URLSearchParams({ start_date: days.start, end_date: days.end, granularity: "DAY", columns: "SPEND_IN_MICRO_DOLLAR,TOTAL_IMPRESSION,TOTAL_CLICKTHROUGH,TOTAL_CONVERSIONS", click_window_days: "30", engagement_window_days: "30", view_window_days: "1", conversion_report_time: "TIME_OF_AD_ACTION" }).toString();
  const response = await requestCapability({ dependencies: required.dependencies, context: checked.value.context, request: { method: "GET", url: url.href } }, optional);
  if (!response.ok) return response;
  return projectMetrics({ input: response.value, connection: checked.value.connection, days, currency: bound.value.currency, retrievedAt: required.dependencies.clock.now({}) });
}

/** Read campaign configuration and child rejection reasons without treating one rejected ad as
 * campaign disapproval. Vendor summary_status takes precedence over configuration.
 * @example capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["456"] } })
 * @complexity O(c+a), <=5 campaigns/10 sequential reads, <=100 ads per campaign; no pagination follow. */
export async function campaignStatus(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability<"campaign.status.v1">>[0] }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  const checked = prepareCapability(required, optional);
  if (!checked.ok) return checked;
  const input = campaignStatusInputSchema.safeParse(checked.value.input);
  if (!input.success || !input.data.vendorCampaignIds.every(id => vendorId.safeParse(id).success)) return failure({ code: "invalid_input" });
  if (input.data.vendorCampaignIds.length > 5) return failure({ code: "limit_exceeded" });
  const campaigns: CampaignStatusOutput["campaigns"] = [];
  let complete = true;
  for (const id of input.data.vendorCampaignIds) {
    const result = await readStatus({ dependencies: required.dependencies, context: checked.value.context, accountId: checked.value.connection.accountId, id }, optional);
    if (!result.ok) return result;
    campaigns.push(result.value.campaign);
    complete = complete && result.value.complete;
  }
  const output = campaignStatusOutputSchema.safeParse({ observedAt: required.dependencies.clock.now({}), complete, campaigns });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}

/** Account-scoped reads reject foreign/duplicate children atomically; partial pages are explicit. */
async function readStatus(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context>; accountId: string; id: string }, optional?: CallOptions): Promise<Outcome<{ campaign: CampaignStatusOutput["campaigns"][number]; complete: boolean }>> {
  const base = "https://api.pinterest.com/v5/ad_accounts/" + required.accountId;
  const result = await requestCapability({ ...required, request: { method: "GET", url: base + "/campaigns/" + required.id } }, optional);
  if (!result.ok) return result;
  const parsed = statusCampaign.safeParse(result.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.id !== required.id || parsed.data.ad_account_id !== required.accountId) return failure({ code: "forbidden" });
  const ads = await requestCapability({ ...required, request: { method: "GET", url: base + "/ads?campaign_ids=" + required.id + "&page_size=100" } }, optional);
  if (!ads.ok) return ads;
  return projectStatus({ input: ads.value, item: parsed.data, accountId: required.accountId, id: required.id });
}

/** One bounded owned-account read. Local-time beta support is not inferred from a timezone label. */
async function readAccount(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context>; base: string }, optional?: CallOptions): Promise<Outcome<z.infer<typeof metricsAccount>>> {
  const read = await requestCapability({ ...required, request: { method: "GET", url: required.base } }, optional);
  if (!read.ok) return read;
  const bound = metricsAccount.safeParse(read.value);
  if (!bound.success) return failure({ code: "protocol_mismatch" });
  if (bound.data.id !== required.dependencies.configuration.accountId) return failure({ code: "forbidden" });
  return { ok: true, value: bound.data };
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
