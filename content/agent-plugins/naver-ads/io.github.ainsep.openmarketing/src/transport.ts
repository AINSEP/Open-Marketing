import { createHmac } from "node:crypto";
import { z } from "zod";
import { callContextSchema, campaignStatusInputSchema, campaignStatusOutputSchema, epochSchema, idSchema, metricBatchSchema, parseExactIntegerJson, reportMetricsInputSchema, scopeSchema, pluginConfigurationSchema, serviceContextSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, CampaignStatusOutput, CapabilityOutput, ClockPort, MetricBatch, ObserverPort, Outcome, PluginCapabilities, PluginCapability, PluginCapabilityDependencies, ReportMetricsInput } from "@open-marketing/contracts";
import { campaignIdSchema, customerIdSchema, encodeCommand, invocationSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";
import { decodeDailyMetrics, decodeEntities, decodeReport, inclusiveEnd, metricMapping, projectCampaignStatus } from "./reporting.js";
import type { EntityObservation } from "./reporting.js";

const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: customerIdSchema });
// Require the physical end of input; `$` also matches before a trailing newline.
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+(?![\s\S])/);
const credentialSchema = z.strictObject({ apiKey: secret, secretKey: secret, customerId: customerIdSchema });
const providerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
const text = z.string().min(1).max(1024);
const account = z.object({ adAccountNo: providerId, roleName: z.enum(["OWNER", "MASTER", "READ_ONLY"]), adAccount: z.object({ no: providerId, masterCustomerId: providerId, name: text, currency: z.literal("KRW") }) });
const accounts = z.object({ content: z.array(account).max(100), number: z.number().int().nonnegative(), size: z.number().int().min(1).max(100), last: z.boolean() });
const campaigns = z.array(z.object({ nccCampaignId: campaignIdSchema, customerId: providerId, name: text, campaignTp: z.enum(["WEB_SITE", "SHOPPING", "POWER_CONTENTS", "BRAND_SEARCH", "PLACE"]), status: z.enum(["ELIGIBLE", "PAUSED", "DELETED"]), userLock: z.boolean() })).max(100);
type Configuration = z.infer<typeof configurationSchema>;
type Invocation = z.input<typeof invocationSchema>;
type Credential = z.infer<typeof credentialSchema>;
/** Validated receipt; reads never imply campaign delivery or mutation. */
export interface NaverResult { readonly operationId: string; readonly status: "succeeded"; readonly data: unknown }
/** The existing paste-token broker returns untagged JSON in accessToken. It MUST authorize the
 * selected target account for this connection; the credential customerId is the key owner, not the target.
 * Guarded server fetch MUST recheck current admission/account/halt/policy and append egress audit
 * with the invocation's run/correlation/trace IDs on every call. No plugin-owned policy or gateway.
 */
export interface NaverDependencies {
  readonly configuration: Configuration;
  readonly credentials: { access(required: { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>> };
  readonly fetch: typeof fetch;
  /** Server-owned timer factory; returns a signal that aborts after timeoutMs. */
  readonly createDeadline: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
/** Inert adapter; callers may pass only the three closed read commands. */
export interface NaverAdsAdapter { invoke(required: Invocation, optional?: CallOptions): Promise<Outcome<NaverResult>> }
export type NaverConfiguration = Configuration;
export type NaverInvocation = Invocation;

/** Create one inert server-loaded adapter with injected credential broker and guarded fetch.
 * @param required - Server-owned selected binding and guarded I/O.
 * @returns Typed read receipts/failures; no retries, services, caches or credential retention.
 * @example createNaverAdsAdapter({ configuration, credentials, fetch: guardedFetch, createDeadline, clock, observer })
 * @complexity O(b) time/space per call, input<=64KiB, response<=1MiB, one GET with a 15s deadline.
 */
export function createNaverAdsAdapter(required: NaverDependencies): NaverAdsAdapter {
  return { async invoke(input, options) {
    if (options?.signal?.aborted) return failure({ code: "cancelled" });
    const bounded = boundInput({ input });
    if (!bounded.ok) return bounded;
    const parsed = invocationSchema.safeParse(bounded.value);
    if (!parsed.success) return failure({ code: "invalid_input" });
    let result = await invokeRead({ dependencies: required, invocation: parsed.data }, options);
    if (options?.signal?.aborted) result = failure({ code: "cancelled" });
    try { required.observer.observe({ operation: "naver-ads." + parsed.data.command.kind, outcome: result.ok ? "succeeded" : result.error.code, correlationId: parsed.data.context.correlationId, traceId: parsed.data.context.traceId, runId: parsed.data.context.runId }); } catch { /* Telemetry cannot change a read result. */ }
    return result;
  } };
}

/** Reject tainted/cyclic or oversized invocation values before parsing or accessing credentials. */
function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const serialized = JSON.stringify(required.input);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Validate binding before credentials; isolate broker exceptions and discard all broker messages.
 * @complexity O(b) bounded parsing; one broker access followed by at most one vendor GET.
 */
async function invokeRead(required: { dependencies: NaverDependencies; invocation: z.output<typeof invocationSchema> }, optional?: CallOptions): Promise<Outcome<NaverResult>> {
  const { dependencies, invocation } = required;
  const binding = configurationSchema.safeParse(dependencies.configuration);
  if (!binding.success) return failure({ code: "invalid_input" });
  if (binding.data.scope.ownerId !== invocation.context.scope.ownerId || binding.data.scope.workspaceId !== invocation.context.scope.workspaceId) return failure({ code: "forbidden" });
  try {
    const accessed = await dependencies.credentials.access({ connectionId: binding.data.connectionId, accountId: binding.data.accountId }, optional);
    if (!accessed.ok) return failure({ code: accessed.error.code });
    const credential = parseCredential({ input: accessed.value.accessToken });
    if (!credential.ok) return credential;
    const response = await request({ dependencies, configuration: binding.data, command: invocation.command, credential: credential.value }, optional);
    if (!response.ok) return response;
    const data = decode({ input: response.value, command: invocation.command, accountId: binding.data.accountId, retrievedAt: dependencies.clock.now({}) });
    if (!data.ok) return data;
    return { ok: true, value: { operationId: invocation.operationId, status: "succeeded", data: data.value } };
  } catch { return failure({ code: "unavailable" }); }
}

/** Parse only bounded pasted JSON, never expose schema errors or secret-bearing broker output. */
function parseCredential(required: { input: unknown }): Outcome<Credential> {
  if (typeof required.input !== "string" || Buffer.byteLength(required.input) > 16384) return failure({ code: "unauthenticated" });
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(required.input));
    if (!parsed.success) return failure({ code: "unauthenticated" });
    return { ok: true, value: parsed.data };
  } catch { return failure({ code: "unauthenticated" }); }
}

/** Fixed origin, path-only HMAC, redirect rejection and caller cancellation. Sign with injected time
 * immediately before guarded fetch; zero automatic retries (including 429).
 * @complexity O(b) time/space, response<=1MiB, request URL<=64KiB, one GET<=15s.
 */
async function request(required: { dependencies: NaverDependencies; configuration: Configuration; command: ParsedCommand; credential: Credential }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, configuration, command, credential } = required;
  return requestWire({ dependencies, accountId: command.kind === "list_accounts" ? credential.customerId : configuration.accountId, credential, wire: encodeCommand({ command }) }, optional);
}
/** Shared HMAC GET; only canonical reads request exact metric tokens or missing-ID handling.
 * All routes are constructed inside the plugin. O(b) time/space, response<=1MiB, no retries.
 */
async function requestWire(required: { dependencies: Pick<NaverDependencies, "fetch" | "clock"> & Partial<Pick<NaverDependencies, "createDeadline">>; accountId: string; credential: Credential;
  wire: { path: string; query: URLSearchParams }; numericTextKeys?: readonly string[]; missingAsNull?: boolean }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, credential, wire } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  const url = "https://api.searchad.naver.com" + wire.path + "?" + wire.query;
  // Closed command fields bound generated URLs below 1KiB, well within the 64KiB request cap.
  const signature = createHmac("sha256", credential.secretKey).update(`${now}.GET.${wire.path}`).digest("base64");
  const deadline = dependencies.createDeadline?.({ timeoutMs: 15000 });
  const signal = deadline && optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline ?? optional?.signal;
  try {
    const response = await dependencies.fetch(url, { method: "GET", redirect: "error", signal, headers: { "X-Timestamp": String(now), "X-API-KEY": credential.apiKey, "X-Customer": required.accountId, "X-Signature": signature } });
    return await readWireResponse({ response, deadline, numericTextKeys: required.numericTextKeys, missingAsNull: required.missingAsNull }, optional);
  } catch { return failure({ code: "unavailable" }); }
}
/** Strip HTTP error bodies; never expose a partial or cancelled successful report. */
async function readWireResponse(required: { response: Response; deadline?: AbortSignal; numericTextKeys?: readonly string[]; missingAsNull?: boolean }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { response } = required;
  if (response.status === 404 && required.missingAsNull) { await response.body?.cancel(); return { ok: true, value: null }; }
  if (response.status !== 200) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
  const body = await readBody({ response }, { numericTextKeys: required.numericTextKeys });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (required.deadline?.aborted) return failure({ code: "unavailable" });
  return body;
}

/** Stream JSON for reads/readback; reject missing, malformed or invalid UTF-8 bodies.
 * @complexity O(b) time/space, b<=1MiB; oversized streams are cancelled, never partially returned.
 */
export async function readBody(required: { response: Response }, optional?: { numericTextKeys?: readonly string[] }): Promise<Outcome<unknown>> {
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
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    if (optional?.numericTextKeys) return parseExactIntegerJson({ text }, { numericTextKeys: optional.numericTextKeys });
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}

/** Validate every row before release; foreign ownership or mixed-validity pages reject as a whole.
 * @complexity O(n) time/space for n<=100 accounts/campaigns; stats contain at most one row.
 */
function decode(required: { input: unknown; command: ParsedCommand; accountId: string; retrievedAt: number }): Outcome<unknown> {
  const command = required.command;
  if (command.kind === "report") return decodeReport({ ...required, command });
  if (command.kind === "list_accounts") return decodeAccounts({ input: required.input, command });
  const parsed = campaigns.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.length > command.pageSize || parsed.data.some(row => row.customerId !== required.accountId)) return failure({ code: "protocol_mismatch" });
  if (new Set(parsed.data.map(row => row.nccCampaignId)).size !== parsed.data.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { items: parsed.data, nextCursor: parsed.data.length === command.pageSize ? parsed.data.at(-1)!.nccCampaignId : null } };
}
function decodeAccounts(required: { input: unknown; command: Extract<ParsedCommand, { kind: "list_accounts" }> }): Outcome<unknown> {
  const parsed = accounts.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const page = parsed.data;
  if (page.number !== required.command.page || page.size !== required.command.pageSize || page.content.length > page.size) return failure({ code: "protocol_mismatch" });
  if (page.content.some(row => row.adAccountNo !== row.adAccount.no)) return failure({ code: "protocol_mismatch" });
  if (new Set(page.content.map(row => row.adAccountNo)).size !== page.content.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { items: page.content, nextPage: page.last ? null : page.number + 1 } };
}
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Naver read failed", retryable: false } }; }

const capabilityConfiguration = pluginConfigurationSchema.extend({ accountId: customerIdSchema });
const capabilityEnvelope = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]),
  connection: z.strictObject({ connectionId: idSchema, accountId: customerIdSchema }), input: z.unknown() });
type ReadId = "report.metrics.v1" | "campaign.status.v1";
type ReadCall = Parameters<PluginCapability<ReadId>>[0];
type Execution = { dependencies: PluginCapabilityDependencies; configuration: z.infer<typeof capabilityConfiguration>; signal?: AbortSignal; requests: number; deadline: number };
type Discovery = { items: EntityObservation[]; complete: boolean };

/** Inert canonical handlers. The server supplies authority; plugins receive only scoped I/O.
 * @example createCapabilities({ configuration, credentials, fetch, clock, observer, wait })
 * @complexity <=100 signed GETs and <=5,000 output rows under a 25s pre-issue budget and the host deadline; no retries.
 */
export function createCapabilities(required: PluginCapabilityDependencies): PluginCapabilities {
  return { "report.metrics.v1": (call, options) => invokeCapability({ dependencies: required, call, id: "report.metrics.v1" }, options),
    "campaign.status.v1": (call, options) => invokeCapability({ dependencies: required, call, id: "campaign.status.v1" }, options) };
}
/** Validate closed inputs and account/scope binding before credentials. Snapshot accepted values. */
function prepareCapability(required: { dependencies: PluginCapabilityDependencies; call: ReadCall; id: ReadId }, optional?: CallOptions): Outcome<{ call: ReadCall; configuration: Execution["configuration"] }> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.call });
  if (!bounded.ok) return bounded;
  const parsed = capabilityEnvelope.safeParse(bounded.value);
  const config = capabilityConfiguration.safeParse(required.dependencies.configuration);
  if (!parsed.success || !config.success) return failure({ code: "invalid_input" });
  const schema = required.id === "report.metrics.v1" ? reportMetricsInputSchema : campaignStatusInputSchema;
  const input = schema.safeParse(parsed.data.input);
  if (!input.success) return failure({ code: "invalid_input" });
  const binding = config.data, call = parsed.data;
  if (call.connection.connectionId !== binding.connectionId || call.connection.accountId !== binding.accountId) return failure({ code: "forbidden" });
  if (call.context.scope.ownerId !== binding.scope.ownerId || call.context.scope.workspaceId !== binding.scope.workspaceId) return failure({ code: "forbidden" });
  return { ok: true, value: { call: { ...call, input: input.data }, configuration: binding } };
}
/** The host owns the deadline; no inner timer discards completed observations. */
async function invokeCapability<K extends ReadId>(required: { dependencies: PluginCapabilityDependencies; call: Parameters<PluginCapability<K>>[0]; id: K }, optional?: CallOptions): Promise<Outcome<CapabilityOutput<K>>> {
  const prepared = prepareCapability(required, optional);
  if (!prepared.ok) return prepared;
  const execution: Execution = { dependencies: required.dependencies, configuration: prepared.value.configuration, signal: optional?.signal, requests: 0, deadline: required.dependencies.clock.now({}) + 25000 };
  try {
    const result = await executeCapability({ execution, call: prepared.value.call });
    const outcome = optional?.signal?.aborted ? failure({ code: "cancelled" }) : result;
    observeCapability({ dependencies: required.dependencies, call: prepared.value.call, id: required.id, result: outcome });
    return outcome as Outcome<CapabilityOutput<K>>;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
async function executeCapability(required: { execution: Execution; call: ReadCall }): Promise<Outcome<MetricBatch | CampaignStatusOutput>> {
  if ("grain" in required.call.input) return reportMetrics({ ...required, input: required.call.input });
  return campaignStatus({ ...required, ids: required.call.input.vendorCampaignIds });
}
/** Call-local bounds share the existing partial-result paths; no timers or retries. */
function exhausted({ execution }: { execution: Execution }): boolean {
  return execution.requests >= 100 || execution.dependencies.clock.now({}) >= execution.deadline;
}
/** Fresh host custody before every fixed-origin read. No plugin admission or approval dependency. */
async function capabilityRead(required: { execution: Execution; path: string; query?: URLSearchParams; missingAsNull?: boolean }): Promise<Outcome<unknown>> {
  const { execution } = required;
  if (execution.signal?.aborted) return failure({ code: "cancelled" });
  if (exhausted({ execution })) return failure({ code: "limit_exceeded" });
  execution.requests += 1;
  const configuration = execution.configuration;
  const accessed = await execution.dependencies.credentials.access({ connectionId: configuration.connectionId, accountId: configuration.accountId }, { signal: execution.signal });
  if (!accessed.ok) return failure({ code: accessed.error.code });
  const credential = parseCredential({ input: accessed.value.accessToken });
  if (!credential.ok) return credential;
  return requestWire({ dependencies: { fetch: execution.dependencies.fetch, clock: execution.dependencies.clock }, accountId: required.path === "/ad-accounts" ? credential.value.customerId : configuration.accountId, credential: credential.value,
    wire: { path: required.path, query: required.query ?? new URLSearchParams() }, numericTextKeys: ["salesAmt", "impCnt", "clkCnt", "ccnt"], missingAsNull: required.missingAsNull }, { signal: execution.signal });
}
/** Exhaust NEXT pages; full pages require another request, including a final empty page.
 * O(n) time/space, n<=5,000, sharing the operation's 100-read budget. No vendor links followed.
 */
async function collectLevel(required: { execution: Execution; grain: "campaign" | "ad_group" | "ad"; parent?: EntityObservation["entity"] }): Promise<Outcome<Discovery>> {
  const items: EntityObservation[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  while (!exhausted({ execution: required.execution })) {
    const decoded = await readEntityPage({ ...required, cursor });
    if (!decoded.ok) return decoded;
    if (decoded.value.some(item => seen.has(item.id))) return failure({ code: "protocol_mismatch" });
    decoded.value.forEach(item => seen.add(item.id));
    const available = 5000 - items.length;
    items.push(...decoded.value.slice(0, available));
    if (decoded.value.length > available) return { ok: true, value: { items, complete: false } };
    if (required.grain === "ad" || decoded.value.length < 100) return { ok: true, value: { items, complete: true } };
    cursor = decoded.value.at(-1)!.id;
  }
  return { ok: true, value: { items, complete: false } };
}
async function readEntityPage(required: { execution: Execution; grain: "campaign" | "ad_group" | "ad"; parent?: EntityObservation["entity"]; cursor?: string }): Promise<Outcome<EntityObservation[]>> {
  const response = await capabilityRead({ execution: required.execution, ...discoveryRequest(required) });
  return response.ok ? decodeEntities({ ...required, input: response.value, accountId: required.execution.configuration.accountId }) : response;
}
/** Encode documented hierarchy selectors; no caller-controlled paths or vendor pagination links. */
function discoveryRequest(required: { grain: "campaign" | "ad_group" | "ad"; parent?: EntityObservation["entity"]; cursor?: string }): { path: string; query: URLSearchParams } {
  const query = new URLSearchParams();
  if (required.grain === "ad" && required.parent?.grain === "ad_group") {
    query.set("nccAdgroupId", required.parent.vendorAdGroupId);
    return { path: "/ncc/ads", query };
  }
  query.set("recordSize", "100"); query.set("selector", "NEXT");
  if (required.cursor) query.set("baseSearchId", required.cursor);
  if (required.grain === "ad_group" && required.parent?.grain === "campaign") query.set("nccCampaignId", required.parent.vendorCampaignId);
  return { path: required.grain === "campaign" ? "/ncc/campaigns" : "/ncc/adgroups", query };
}
/** Bounded hierarchy fan-out; repeated child IDs across parents reject rather than double count. */
async function collectChildren(required: { execution: Execution; parents: EntityObservation[]; grain: "ad_group" | "ad" }): Promise<Outcome<Discovery>> {
  const items: EntityObservation[] = [], seen = new Set<string>();
  let complete = true;
  for (const [index, parent] of required.parents.entries()) {
    const result = await collectLevel({ execution: required.execution, grain: required.grain, parent: parent.entity });
    if (!result.ok) return result;
    if (result.value.items.some(item => seen.has(item.id))) return failure({ code: "protocol_mismatch" });
    result.value.items.forEach(item => seen.add(item.id));
    const available = 5000 - items.length;
    items.push(...result.value.items.slice(0, available));
    complete = complete && result.value.complete;
    if (result.value.items.length > available || (exhausted({ execution: required.execution }) && index < required.parents.length - 1)) return { ok: true, value: { items, complete: false } };
  }
  return { ok: true, value: { items, complete } };
}
/** Traverse only the requested grain, carrying exhausted coverage through each bounded parent level. */
async function discoverMetrics(required: { execution: Execution; grain: ReportMetricsInput["grain"] }): Promise<Outcome<Discovery>> {
  const campaigns = await collectLevel({ execution: required.execution, grain: "campaign" });
  if (!campaigns.ok || required.grain === "campaign") return campaigns;
  const groups = await collectChildren({ execution: required.execution, parents: campaigns.value.items, grain: "ad_group" });
  if (!groups.ok) return groups;
  groups.value.complete = groups.value.complete && campaigns.value.complete;
  if (required.grain === "ad_group") return groups;
  const ads = await collectChildren({ execution: required.execution, parents: groups.value.items, grain: "ad" });
  if (!ads.ok) return ads;
  return { ok: true, value: { items: ads.value.items, complete: ads.value.complete && groups.value.complete } };
}
/** Daily per-entity reads only; account totals are unsupported. Exhausted empty discovery is complete.
 * O(n+d) time/space bounded by 100 requests and 5,000 retained rows. Unknown coverage stays stale.
 */
async function reportMetrics(required: { execution: Execution; call: ReadCall; input: ReportMetricsInput }): Promise<Outcome<MetricBatch>> {
  if (required.input.grain === "account") return failure({ code: "not_implemented" });
  const metadata = await accountCurrency({ execution: required.execution });
  if (!metadata.ok) return metadata;
  const discovered = await discoverMetrics({ execution: required.execution, grain: required.input.grain });
  if (!discovered.ok) return discovered;
  const rows: MetricBatch["rows"] = [];
  let complete = discovered.value.complete;
  for (const observation of discovered.value.items) {
    const decoded = await readEntityMetrics({ ...required, observation, rowBudget: 5000 - rows.length });
    if (!decoded.ok) return decoded;
    rows.push(...decoded.value.rows);
    if (!decoded.value.complete) { complete = false; break; }
  }
  const parsed = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "naver-ads", ...required.call.connection,
    currency: metadata.value, timezone: "Asia/Seoul", ...required.input, mapping: metricMapping, retrievedAt: required.execution.dependencies.clock.now({}),
    dataThrough: 0, complete, freshness: "stale", finality: "provisional", restated: false, rows });
  return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "protocol_mismatch" });
}
/** Resolve the selected delegated customer's currency via key-owner account discovery.
 * At most the shared 100-read budget, no advertiser-account/customer-ID conflation. */
async function accountCurrency(required: { execution: Execution }): Promise<Outcome<string>> {
  for (let page = 0; !exhausted({ execution: required.execution }); page += 1) {
    const response = await capabilityRead({ ...required, path: "/ad-accounts", query: new URLSearchParams({ page: String(page), size: "100" }) });
    if (!response.ok) return response;
    const decoded = decodeAccounts({ input: response.value, command: { kind: "list_accounts", page, pageSize: 100 } });
    if (!decoded.ok) return decoded;
    // decodeAccounts already validated the whole page, cursor, size and account identities.
    const parsed = accounts.parse(response.value);
    const selected = parsed.content.find(item => item.adAccount.masterCustomerId === required.execution.configuration.accountId);
    if (selected) return { ok: true, value: selected.adAccount.currency };
    if (parsed.last) return failure({ code: "forbidden" });
  }
  return failure({ code: "limit_exceeded" });
}
/** Split each entity's half-open range into <=92 inclusive KST days, sharing call/row bounds.
 * O(n) retained rows, <=100 sequential requests overall. Budget exhaustion preserves prior rows. */
async function readEntityMetrics(required: { execution: Execution; observation: EntityObservation; input: ReportMetricsInput; rowBudget: number }): Promise<Outcome<{ rows: MetricBatch["rows"]; complete: boolean }>> {
  const rows: MetricBatch["rows"] = [];
  let start = required.input.days.start;
  while (start < required.input.days.end && !exhausted({ execution: required.execution }) && rows.length < required.rowBudget) {
    const end = new Date(Math.min(Date.parse(start) + 92 * 86400000, Date.parse(required.input.days.end))).toISOString().slice(0, 10);
    const decoded = await readDailyMetrics({ ...required, days: { start, end } });
    if (!decoded.ok) return decoded;
    const available = required.rowBudget - rows.length;
    rows.push(...decoded.value.slice(0, available));
    if (decoded.value.length > available) return { ok: true, value: { rows, complete: false } };
    start = end;
  }
  return { ok: true, value: { rows, complete: start === required.input.days.end } };
}
/** One single-ID daily GET; validate dates against this chunk rather than the whole window. */
async function readDailyMetrics(required: { execution: Execution; observation: EntityObservation; days: ReportMetricsInput["days"] }): Promise<Outcome<MetricBatch["rows"]>> {
  const query = new URLSearchParams({ id: required.observation.id, fields: JSON.stringify(["salesAmt", "impCnt", "clkCnt", "ccnt"]),
    timeRange: JSON.stringify({ since: required.days.start, until: inclusiveEnd({ days: required.days }) }), timeIncrement: "1" });
  const response = await capabilityRead({ execution: required.execution, path: "/stats", query });
  return response.ok ? decodeDailyMetrics({ input: response.value, observation: required.observation, days: required.days }) : response;
}
/** Read named campaigns and their scoped child review evidence. Missing/unfinished entities remain
 * unknown; request exhaustion preserves completed observations. At most 100 reads, no retries.
 */
async function campaignStatus(required: { execution: Execution; ids: string[] }): Promise<Outcome<CampaignStatusOutput>> {
  if (!z.array(campaignIdSchema).safeParse(required.ids).success) return failure({ code: "invalid_input" });
  const campaigns: CampaignStatusOutput["campaigns"] = [];
  let complete = true;
  for (const id of required.ids) {
    const observed = await readCampaignStatus({ execution: required.execution, id });
    if (!observed.ok) return observed;
    campaigns.push(observed.value.campaign);
    complete = complete && observed.value.complete;
  }
  const parsed = campaignStatusOutputSchema.safeParse({ observedAt: required.execution.dependencies.clock.now({}), complete, campaigns });
  return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "protocol_mismatch" });
}
/** Preserve a direct campaign observation even if the remaining budget cannot finish child reviews. */
async function readCampaignStatus(required: { execution: Execution; id: string }): Promise<Outcome<{ campaign: CampaignStatusOutput["campaigns"][number]; complete: boolean }>> {
  const unknown = { ok: true as const, value: { campaign: { vendorCampaignId: required.id, status: "unknown" as const, disapprovalDescriptions: [] }, complete: false } };
  if (exhausted({ execution: required.execution })) return unknown;
  const response = await capabilityRead({ execution: required.execution, path: "/ncc/campaigns/" + required.id, missingAsNull: true });
  if (!response.ok) return response;
  if (response.value === null) return unknown;
  const decoded = decodeEntities({ input: [response.value], grain: "campaign", accountId: required.execution.configuration.accountId });
  if (!decoded.ok) return decoded;
  const campaign = decoded.value[0]!;
  if (campaign.id !== required.id) return failure({ code: "protocol_mismatch" });
  const groups = await collectLevel({ execution: required.execution, grain: "ad_group", parent: campaign.entity });
  if (!groups.ok) return groups;
  const ads = await collectChildren({ execution: required.execution, grain: "ad", parents: groups.value.items });
  if (!ads.ok) return ads;
  const coverage = groups.value.complete && ads.value.complete;
  const projected = projectCampaignStatus({ campaign, children: [...groups.value.items, ...ads.value.items], complete: coverage });
  return { ok: true, value: { campaign: projected, complete: coverage && projected.status !== "unknown" } };
}
function observeCapability(required: { dependencies: PluginCapabilityDependencies; call: ReadCall; id: ReadId; result: Outcome<unknown> }): void {
  const context = required.call.context;
  try { required.dependencies.observer.observe({ operation: "naver-ads." + required.id, outcome: required.result.ok ? "succeeded" : required.result.error.code,
    correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* Host audit remains authoritative. */ }
}
