import type { PluginCapabilitiesFactory, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { context, envelope, vendorId, projectStatus, projectMetrics } from "./metrics-status.js";
import { z } from "zod";
import { pluginConfigurationSchema, campaignStatusInputSchema, campaignStatusOutputSchema, boundedJsonSchema, callContextSchema, epochSchema, idSchema, scopeSchema, reportMetricsInputSchema, parseExactIntegerJson } from "@open-marketing/contracts";
import type { CampaignStatusOutput, MetricBatch, PluginCapability, AppError, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
import { accountIdSchema, encodeCommand, invocationSchema, nextPage } from "./commands.js";
import type { RedditAdsAdapter, RedditDependencies, RedditInvocation, RedditResult, RedditWireRequest } from "./ports.js";
import { decodeReport, encodeDailyReport } from "./reporting.js";

export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: accountIdSchema.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable() });
const accountFacts = z.object({ id: accountIdSchema, currency: z.string().regex(/^[A-Z]{3}$/) });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const pageSchema = z.object({ data: z.unknown(), pagination: z.object({ next_url: z.string().max(4096).nullable().optional() }) });
const dailyPageSchema = pageSchema.extend({ data: z.object({ metrics: z.array(z.unknown()) }) });
const businessesSchema = z.array(z.object({ id: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i), name: z.string().max(500) })).max(100);
type Prepared = { invocation: z.output<typeof invocationSchema>; configuration: z.output<typeof configurationSchema>; request: RedditWireRequest };

/** Inert read-only adapter; host policy remains authoritative, including guarded native fetch.
 * @example createRedditAdsAdapter({ configuration, credentials, fetch, createDeadline, clock, observer })
 * @returns An invoker returning typed failures or projected pages; never raw vendor errors/tokens.
 * @complexity O(b) time/space, <=64KiB input, <=1MiB response, one 15s request, zero retries.
 */
export function createRedditAdsAdapter(required: RedditDependencies): RedditAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return {
    async invoke(input, options) {
    let result: Outcome<RedditResult>;
    try { result = await invoke({ dependencies, input }, options); }
    catch { result = failure({ code: options?.signal?.aborted ? "cancelled" : "unavailable" }); }
    observe({ dependencies, input, result });
    return result;
  } };
}

/** Snapshot and validate authority-bearing data before any await or credential lookup. O(b). */
function prepare(required: { dependencies: RedditDependencies; input: RedditInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (!boundedJsonSchema.safeParse(required.input).success) return failure({ code: "invalid_input" });
  const invocation = invocationSchema.safeParse(required.input);
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const bound = configuration.data;
  if (!sameScope({ first: invocation.data.context.scope, second: bound.scope })) return failure({ code: "forbidden" });
  const discovery = ["list_businesses", "list_accounts"].includes(invocation.data.command.kind);
  if (!discovery && (bound.accountId === null || bound.currency === null)) return failure({ code: "invalid_input" });
  const request = encodeCommand({ command: invocation.data.command, accountId: bound.accountId });
  if (!request.ok) return request;
  return { ok: true, value: { invocation: invocation.data, configuration: bound, request: request.value } };
}
/** Both ownership dimensions must match before credentials are resolved. O(1). */
function sameScope(required: { first: Scope; second: Scope }): boolean { return required.first.ownerId === required.second.ownerId && required.first.workspaceId === required.second.workspaceId; }

/** Credentials are resolved once, then expiry/cancellation rechecked at egress. O(b). */
async function invoke(required: { dependencies: RedditDependencies; input: RedditInvocation }, optional?: CallOptions): Promise<Outcome<RedditResult>> {
  const prepared = prepare(required, optional);
  if (!prepared.ok) return prepared;
  const { dependencies } = required;
  const { configuration, invocation, request } = prepared.value;
  const access = await dependencies.credentials.access({ connectionId: configuration.connectionId, accountId: configuration.accountId }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const credential = credentialSchema.safeParse(access.value);
  if (!credential.success) return failure({ code: "unauthenticated" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (credential.data.expiresAt !== undefined && now >= credential.data.expiresAt) return failure({ code: "expired" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const response = await send({ dependencies, request, token: credential.data.accessToken }, optional);
  if (!response.ok) return response;
  return decodePage({ prepared: prepared.value, input: response.value, retrievedAt: dependencies.clock.now({}) });
}

/** Native fetch ABI with a host-created 15s deadline and optional caller cancellation.
 * No redirect/retry; errors and status bodies are never returned. O(b), b<=1MiB.
 */
async function send(required: { dependencies: RedditDependencies; request: RedditWireRequest; token: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { request } = required;
  if (Buffer.byteLength(request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const deadline = required.dependencies.createDeadline({ timeoutMs: 15000 });
  const signal = optional?.signal ? AbortSignal.any([optional.signal, deadline]) : deadline;
  const response = await required.dependencies.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal, headers: { Authorization: "Bearer " + required.token, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Open-Marketing:reddit-ads:0.1.0" } });
  if (response.status !== 200) {
    await response.body?.cancel();
    return httpFailure({ status: response.status });
  }
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    await response.body?.cancel();
    return failure({ code: "protocol_mismatch" });
  }
  return readBody({ response });
}

/** Stream into a fixed buffer before parsing; Content-Length is never trusted. O(b) time/space. */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const bytes = Buffer.alloc(1048576);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.length) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return decodeJson({ text: bytes.subarray(0, length).toString("utf8") });
  }
  finally { reader.releaseLock(); }
}
/** Malformed bounded JSON is a protocol failure; stream/abort errors reach the I/O wrapper. */
function decodeJson(required: { text: string }): Outcome<unknown> {
  return parseExactIntegerJson(required, { numericTextKeys: ["spend", "impressions", "clicks"] });
}

/** Project only sourced data, then validate pagination before returning any result. O(n), n<=100. */
function decodePage(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<RedditResult> {
  const { invocation, request } = required.prepared;
  const page = pageSchema.safeParse(required.input);
  if (!page.success || !epochSchema.safeParse(required.retrievedAt).success) return failure({ code: "protocol_mismatch" });
  const next = nextPage({ next: page.data.pagination.next_url, request, pageToken: invocation.command.pageToken });
  if (!next.ok) return next;
  const data = projectData({ prepared: required.prepared, input: page.data.data, retrievedAt: required.retrievedAt });
  if (!data.ok) return data;
  return { ok: true, value: { operationId: invocation.operationId, status: "succeeded", observedState: "unknown", data: { ...data.value, nextPageToken: next.value, incomplete: next.value !== null } } };
}
/** Separate vendor report/business schemas; never return a partly validated collection. O(n). */
function projectData(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<object> {
  const { invocation, configuration } = required.prepared;
  if (invocation.command.kind === "report") {
    return decodeReport({ input: required.input, command: invocation.command, accountId: configuration.accountId!, currency: configuration.currency!, retrievedAt: required.retrievedAt });
  }
  const businesses = businessesSchema.safeParse(required.input);
  if (!businesses.success || businesses.data.length > invocation.command.pageSize) return failure({ code: "protocol_mismatch" });
  if (new Set(businesses.data.map(row => row.id)).size !== businesses.data.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { businesses: businesses.data } };
}

/** Credential/vendor errors stay sanitized. 429 is surfaced without an automatic retry. */
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Reddit read failed (" + required.code + ")", retryable: false } }; }
/** Correlated, secret-free observations; telemetry failure cannot change an already completed read. */
function observe(required: { dependencies: RedditDependencies; input: RedditInvocation; result: Outcome<RedditResult> }): void {
  try {
    const parsed = callContextSchema.safeParse(required.input?.context);
    if (!parsed.success) return;
    const context = parsed.data;
    required.dependencies.observer.observe({ operation: "reddit-ads.read", outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
  }
  catch { /* Host observer failure must not leak secrets or cause a duplicate request. */ }
}

/** Canonical status reads use only the broker and host-guarded fetch; no plugin authority.
 * @complexity One <=15s/1MiB request, no retry; errors and observations stay redacted. */
export async function requestCapability(required: { dependencies: CapabilityDependencies; context: Parameters<PluginCapability>[0]["context"]; request: RedditWireRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, context } = required;
  let result: Outcome<unknown>;
  try { result = await executeCapability({ dependencies, request: required.request }, optional); }
  catch { result = failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
  try { dependencies.observer.observe({ operation: "reddit-ads.capability", outcome: result.ok ? "succeeded" : result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: "runId" in context ? context.runId : undefined }); }
  catch { /* Host durable audit remains authoritative. */ }
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return result;
}
/** Resolve a fresh credential then attempt one bounded read. The injected fetch owns the
 * server authority fence; expiry/cancellation failures return before egress. O(b<=1MiB). */
async function executeCapability(required: { dependencies: CapabilityDependencies; request: RedditWireRequest }, optional: CallOptions = {}): Promise<Outcome<unknown>> {
  const { dependencies, request } = required;
  let result: Outcome<unknown>;
  const access = await dependencies.credentials.access({ connectionId: dependencies.configuration.connectionId, accountId: dependencies.configuration.accountId! }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const credential = credentialSchema.safeParse(access.value), now = dependencies.clock.now({});
  if (!credential.success || !epochSchema.safeParse(now).success) return failure({ code: "protocol_mismatch" });
  if (credential.data.expiresAt !== undefined && now >= credential.data.expiresAt) return failure({ code: "expired" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const deadline = AbortSignal.timeout(15000);
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  const response = await dependencies.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal, headers: { Authorization: "Bearer " + credential.data.accessToken, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Open-Marketing:reddit-ads:0.1.0" } });
  if (response.status !== 200) { await response.body?.cancel(); result = httpFailure({ status: response.status }); }
  else result = await readBody({ response });
  return result;
}

/** Snapshot/validate all authority-bearing input before credentials; no effects. O(b<=64KiB). */
function prepareCapability(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability>[0] }, optional?: CallOptions): Outcome<z.infer<typeof envelope>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const text = JSON.stringify(required.input);
    if (Buffer.byteLength(text) > 65536) return failure({ code: "limit_exceeded" });
    const input = envelope.safeParse(JSON.parse(text)), config = required.dependencies.configuration;
    if (!input.success) return failure({ code: "invalid_input" });
    const { context, connection } = input.data;
    if (context.scope.ownerId !== config.scope.ownerId || context.scope.workspaceId !== config.scope.workspaceId) return failure({ code: "forbidden" });
    if (connection.connectionId !== config.connectionId || connection.accountId !== config.accountId) return failure({ code: "forbidden" });
    return { ok: true, value: input.data };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Read bounded UTC daily pages with vendor account currency and exact integers.
 * @example capabilities["report.metrics.v1"]({ context, connection, input: { grain: "account", days } })
 * @complexity One account GET plus <=50 report POSTs under a 25s pre-issue budget, each <=15s/1MiB; <=5,000 rows, no retries. */
export async function reportMetrics(required: { dependencies: CapabilityDependencies; input: Parameters<PluginCapability<"report.metrics.v1">>[0] }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const checked = prepareCapability(required, optional);
  if (!checked.ok) return checked;
  const parsed = reportMetricsInputSchema.safeParse(checked.value.input);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const { grain, days } = parsed.data;
  if (grain !== "account" && grain !== "campaign") return failure({ code: "not_implemented" });
  if (Date.parse(days.end) - Date.parse(days.start) > 31 * 86400000) return failure({ code: "limit_exceeded" });
  const deadline = required.dependencies.clock.now({}) + 25000;
  const account = await readAccount({ dependencies: required.dependencies, context: checked.value.context }, optional);
  if (!account.ok) return account;
  const request: RedditWireRequest = { method: "POST", url: "https://ads-api.reddit.com/api/v3/ad_accounts/" + checked.value.connection.accountId + "/reports?page.size=100", body: encodeDailyReport({ input: parsed.data }) };
  return readDailyPages({ dependencies: required.dependencies, context: checked.value.context, request, connection: checked.value.connection, grain, days, currency: account.value.currency, deadline }, optional);
}

/** Fixed account lookup validates identity and currency before report egress. O(1), one read. */
async function readAccount(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context> }, optional?: CallOptions): Promise<Outcome<z.infer<typeof accountFacts>>> {
  const accountId = required.dependencies.configuration.accountId;
  const response = await requestCapability({ ...required, request: { method: "GET", url: "https://ads-api.reddit.com/api/v3/ad_accounts/" + accountId } }, optional);
  if (!response.ok) return response;
  const parsed = z.object({ data: accountFacts }).safeParse(response.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.data.id !== accountId) return failure({ code: "forbidden" });
  return { ok: true, value: parsed.data.data };
}

/** Follow validated tokens on the fixed account URL, repeating the same read-only POST body.
 * O(r+n) time/space, r<=50 requests and n<=5,000 retained rows under a 25s pre-issue budget; bounds return incomplete coverage.
 * Malformed links/pages and duplicate rows fail atomically; no vendor URL is dispatched directly.
 */
async function readDailyPages(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context>; request: RedditWireRequest; connection: { connectionId: string; accountId: string }; grain: "account" | "campaign"; days: MetricBatch["days"]; currency: string; deadline: number }, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  const items: unknown[] = [];
  const baseUrl = required.request.url;
  let request = required.request;
  let pageToken: string | undefined;
  let finished = false;
  for (let requests = 0; !finished && requests < 50 && items.length < 5000 && required.dependencies.clock.now({}) < required.deadline; requests += 1) {
    const response = await requestCapability({ dependencies: required.dependencies, context: required.context, request }, optional);
    if (!response.ok) return response;
    const page = dailyPageSchema.safeParse(response.value);
    if (!page.success) return failure({ code: "protocol_mismatch" });
    const next = nextPage({ next: page.data.pagination.next_url, request, pageToken });
    if (!next.ok) return next;
    const remaining = 5000 - items.length;
    items.push(...page.data.data.metrics.slice(0, remaining));
    finished = next.value === null && page.data.data.metrics.length <= remaining;
    pageToken = next.value ?? undefined;
    request = { ...required.request, url: baseUrl + "&page.token=" + encodeURIComponent(String(next.value)) };
  }
  return projectMetrics({ ...required, input: { metrics: items }, complete: finished, retrievedAt: required.dependencies.clock.now({}) });
}

/** Effective status takes precedence over configured state; unknown/billing states stay unknown.
 * No unverified rejection-description fields are invented.
 * @example capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["456"] } })
 * @complexity <=10 sequential <=15s/1MiB guarded GETs, O(c<=10), no retries. */
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

/** One v3 GET validates both campaign and account identity before reading effective state. */
async function readStatus(required: { dependencies: CapabilityDependencies; context: z.infer<typeof context>; id: string; accountId: string }, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput["campaigns"][number]>> {
  const response = await requestCapability({ ...required, request: { method: "GET", url: "https://ads-api.reddit.com/api/v3/campaigns/" + required.id } }, optional);
  if (!response.ok) return response;
  return projectStatus({ input: response.value, id: required.id, accountId: required.accountId });
}

/** Bind canonical reads to host I/O; construction is inert and grants no authority.
 * Invalid configuration fails before credentials. O(1), no effects until a handler is called.
 * @example createCapabilities({ fetch, credentials, clock, observer, wait, configuration }) */
export const createCapabilities: PluginCapabilitiesFactory = required => {
  const configuration = pluginConfigurationSchema.extend({ accountId: accountIdSchema }).safeParse(required.configuration);
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
