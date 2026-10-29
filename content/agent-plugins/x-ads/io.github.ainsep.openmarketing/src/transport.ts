/** Server-loaded OAuth edge. Imports are inert; dependencies own all credentials and effects. */
import { createHash, createHmac, randomBytes } from "node:crypto";
import OAuth from "oauth-1.0a";
import { z } from "zod";
import { pluginConfigurationSchema, callContextSchema, serviceContextSchema, parseExactIntegerJson, campaignStatusInputSchema, campaignStatusOutputSchema, reportMetricsInputSchema, metricBatchSchema, digestSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, ClockPort, EffectEnvelope, IdPort, ObserverPort, Outcome, PluginCapability, PluginCapabilitiesFactory, MetricBatch, CampaignStatusOutput, MetricValues } from "@open-marketing/contracts";
import { commandSchema, readCommandSchema, cursorSchema, encodeCommand, vendorId } from "./commands.js";
import type { ParsedCommand, XCommand } from "./commands.js";
import { decodeReport, decodeDaily, decodeEntityPage, decodeActiveEntities, metricMapping } from "./reporting.js";
import type { XReport, XEntityPage, XDailyReport, XCapabilityEntity, XActivePage } from "./reporting.js";

export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/).optional(), pluginDigest: digestSchema, bindingId: idSchema, admitted: z.boolean() });
const readConfigurationSchema = configurationSchema.partial({ bindingId: true, admitted: true });
type ReadConfiguration = z.infer<typeof readConfigurationSchema>;
/** Legacy server-resolved account binding, never supplied in assistant arguments. */
export type XConfiguration = z.infer<typeof configurationSchema>;
/** Internal signed wire shape; JSON bodies are excluded from OAuth's form parameter set. */
export type WireRequest = { url: string; method: "GET" | "POST"; body?: string };
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: readCommandSchema });
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const pastedSchema = z.strictObject({ consumerKey: secret, consumerSecret: secret, accessToken: secret, accessTokenSecret: secret });
const credentialSchema = z.object({ accessToken: z.string().min(1).max(65536), expiresAt: epochSchema.optional() });
type Credential = z.infer<typeof pastedSchema> & { expiresAt?: number };
const account = z.object({ id: vendorId, name: z.string().max(1024), timezone: z.string().min(1).max(100), approval_status: z.string().min(1).max(64), deleted: z.boolean() });
const campaign = z.object({ id: vendorId, name: z.string().max(1024), entity_status: z.enum(["ACTIVE", "DRAFT", "PAUSED"]), currency: z.string().regex(/^[A-Z]{3}$/), deleted: z.boolean() });
const accountPage = z.object({ data: z.array(account).max(100), next_cursor: cursorSchema.nullable() });
const campaignPage = z.object({ data: z.array(campaign).max(100), next_cursor: cursorSchema.nullable(), request: z.object({ params: z.object({ account_id: vendorId }) }) });
type XPage = { items: z.infer<typeof account>[] | z.infer<typeof campaign>[]; cursor: string | null };
/** Read result; raw provider bodies, headers and credentials are never returned. */
export interface XResult { readonly operationId: string; readonly status: "succeeded"; readonly data: XPage | XReport | XEntityPage | XDailyReport | XActivePage; readonly rateLimit: { limit: number; remaining: number; resetAtSeconds: number } | null }
/** Existing server seams only. dispatch holds the ONE policy fence and rechecks lifecycle,
 * scope/account/connection after credential resolution, immediately before execute (foreign callback ABI).
 */
export interface XDependencies {
  readonly configuration: ReadConfiguration;
  readonly credentials: { access(required: { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>> };
  readonly gateway: { dispatch(required: { context: CallContext; configuration: ReadConfiguration; operation: ParsedCommand["kind"]; request: ReturnType<typeof encodeCommand>; effect: EffectEnvelope; execute: () => Promise<Outcome<XResult>> }, optional?: CallOptions): Promise<Outcome<XResult>> };
  readonly fetch: typeof fetch; readonly clock: ClockPort; readonly ids: IdPort; readonly observer: ObserverPort;
  /** Host timer seam: return a signal that aborts after timeoutMs; no ambient timers in the plugin. */
  readonly timeoutSignal: (required: { timeoutMs: number }) => AbortSignal;
}
type Prepared = { context: CallContext; operationId: string; command: ParsedCommand; configuration: ReadConfiguration; request: ReturnType<typeof encodeCommand>; effect: EffectEnvelope };

/** Validate before credential access, then perform one server-fenced signed GET; never retry.
 * @param required - Context, operation identity, closed command and server dependencies.
 * @returns A projected read result or a redacted typed boundary failure.
 * @example await invokeXAds({ context, operationId: "read-1", command: { kind: "list_accounts" }, dependencies });
 * @complexity O(b+n*m), b<=1MiB, n,m<=100; one credential access and one GET.
 */
export async function invokeXAds(required: { context: CallContext; operationId: string; command: XCommand; dependencies: XDependencies }, optional: CallOptions = {}): Promise<Outcome<XResult>> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundedJson({ input: required.command });
  if (!bounded.ok) return bounded;
  const command = commandSchema.safeParse(bounded.value);
  if (!command.success) return failure({ code: "invalid_input" });
  return invokeRead({ ...required, command: command.data }, optional);
}
/** Private capability commands share the signed transport without becoming public tools. */
async function invokeRead(required: { context: CallContext; operationId: string; command: ParsedCommand; dependencies: XDependencies }, optional: CallOptions): Promise<Outcome<XResult>> {
  const prepared = prepare(required, optional);
  if (!prepared.ok) return prepared;
  let result: Outcome<XResult>;
  try { result = await dispatch({ prepared: prepared.value, dependencies: required.dependencies }, optional); }
  catch { result = failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
  observe({ dependencies: required.dependencies, prepared: prepared.value, result });
  return result;
}

/** Snapshot tainted input before awaits, enforce tenant equality before the host admission fence. @complexity O(b), b<=64KiB. */
function prepare(required: Parameters<typeof invokeRead>[0], optional: CallOptions): Outcome<Prepared> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const input = boundedJson({ input: { context: required.context, operationId: required.operationId, command: required.command } });
  if (!input.ok) return input;
  const invocation = invocationSchema.safeParse(input.value);
  const configuration = readConfigurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const { context, operationId, command } = invocation.data;
  const config = configuration.data;
  if (context.scope.ownerId !== config.scope.ownerId || context.scope.workspaceId !== config.scope.workspaceId) return failure({ code: "forbidden" });
  if (command.kind === "report" && !config.currency) return failure({ code: "invalid_input" });
  if ((command.kind === "report" || command.kind === "capability_daily") && command.entity === "ACCOUNT" && (command.entityIds.length !== 1 || command.entityIds[0] !== config.accountId)) return failure({ code: "forbidden" });
  const request = encodeCommand({ command, accountId: config.accountId });
  const effect: EffectEnvelope = { operationId, connectionId: config.connectionId, accountId: config.accountId, effects: ["read"], argumentsDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), moneyExposure: null, requiredLimit: null };
  return { ok: true, value: { context, operationId, command, configuration: config, request, effect } };
}

/** The host callback may execute only once; current authority belongs to gateway, not pasted tokens. @complexity O(b), one lookup/GET. */
async function dispatch(required: { prepared: Prepared; dependencies: XDependencies }, optional: CallOptions): Promise<Outcome<XResult>> {
  const { prepared, dependencies } = required;
  const credential = await resolveCredential({ dependencies, configuration: prepared.configuration }, optional);
  if (!credential.ok) return credential;
  let sent = false;
  return dependencies.gateway.dispatch({ context: prepared.context, configuration: prepared.configuration, operation: prepared.command.kind, request: { ...prepared.request }, effect: structuredClone(prepared.effect), execute: async () => {
    if (sent) return failure({ code: "conflict" });
    if (optional.signal?.aborted) return failure({ code: "cancelled" });
    sent = true;
    return sendRequest({ ...required, credential: credential.value }, optional);
  } }, optional);
}

/** Parse sealed plaintext as exactly four OAuth keys; discard broker messages and parse diagnostics. @complexity O(b), b<=64KiB. */
export async function resolveCredential(required: { dependencies: Pick<XDependencies, "credentials">; configuration: ReadConfiguration }, optional: CallOptions): Promise<Outcome<Credential>> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const result = await required.dependencies.credentials.access({ connectionId: required.configuration.connectionId, accountId: required.configuration.accountId }, optional);
  if (!result.ok) return failure({ code: result.error.code });
  const envelope = credentialSchema.safeParse(result.value);
  if (!envelope.success) return failure({ code: "unauthenticated" });
  const json = boundedJson({ serialized: envelope.data.accessToken });
  if (!json.ok) return failure({ code: "unauthenticated" });
  const credential = pastedSchema.safeParse(json.value);
  if (!credential.success) return failure({ code: "unauthenticated" });
  return { ok: true, value: { ...credential.data, expiresAt: envelope.data.expiresAt } };
}

/** Signing uses fixed validated nonce/time, overriding the library's hidden randomness/clock.
 * Decode query values here: oauth-1.0a's URL parser leaves form-encoded '+' as a literal plus.
 * RFC 5849 §3.4.1.3 includes query parameters, but excludes application/json bodies.
 * OAuth's two-string hash callback ABI is wrapped here; fixtures assert the actual Authorization header.
 * @complexity O(b log b) library parameter sort, O(b) storage, b<=64KiB; no I/O.
 */
function authorization(required: { request: WireRequest; credential: Credential; nonce: string; now: number }): string {
  const c = required.credential;
  const signer = new OAuth({ consumer: { key: c.consumerKey, secret: c.consumerSecret }, signature_method: "HMAC-SHA1", hash_function: (base: string, key: string) => createHmac("sha1", key).update(base).digest("base64") });
  signer.getNonce = () => required.nonce;
  signer.getTimeStamp = () => Math.floor(required.now / 1000);
  const url = new URL(required.request.url);
  const data = Object.fromEntries(url.searchParams);
  return signer.toHeader(signer.authorize({ url: url.origin + url.pathname, method: required.request.method, data }, { key: c.accessToken, secret: c.accessTokenSecret })).Authorization;
}

/** Check signing inputs at the egress boundary; no implicit token lifetime or nonce fallback. @complexity O(1). */
function signingInputs(required: { dependencies: Pick<XDependencies, "clock" | "ids">; credential: Credential }): Outcome<{ now: number; nonce: string }> {
  const now = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (required.credential.expiresAt !== undefined && now >= required.credential.expiresAt) return failure({ code: "expired" });
  const nonce = required.dependencies.ids.next({});
  if (!z.string().regex(/^[A-Za-z0-9_-]{1,256}$/).safeParse(nonce).success) return failure({ code: "invalid_input" });
  return { ok: true, value: { now, nonce } };
}

/** One fixed-origin GET; no redirects or retries, deadline covers streamed body consumption. @complexity O(b), b<=1MiB. */
async function sendRequest(required: { prepared: Prepared; dependencies: XDependencies; credential: Credential }, optional: CallOptions): Promise<Outcome<XResult>> {
  const { dependencies, prepared } = required;
  const response = await requestXAds({ ...required, request: prepared.request, isCurrent: () => true }, optional);
  if (!response.ok) return response;
  const retrievedAt = dependencies.clock.now({});
  if (!epochSchema.safeParse(retrievedAt).success) return failure({ code: "invalid_input" });
  const data = decodeData({ prepared, input: response.value.body, retrievedAt });
  if (!data.ok) return data;
  return { ok: true, value: { operationId: prepared.operationId, status: "succeeded", data: data.value, rateLimit: response.value.rateLimit } };
}

/** Shared internal HTTP edge for reads, paused deployment and server conversions. The owning
 * host fence must guard fetch; isCurrent rechecks authority immediately before egress.
 * @complexity O(b log b) signing, O(b) body storage, b<=1MiB; one <=15s request, no retries.
 */
export async function requestXAds(required: { dependencies: Omit<XDependencies, "gateway">; request: WireRequest; credential: Credential; isCurrent: () => boolean }, optional: CallOptions = {}): Promise<Outcome<{ status: number; body: unknown; rateLimit: XResult["rateLimit"] }>> {
  const { dependencies, request, credential } = required;
  try {
    const signing = signingInputs({ dependencies, credential });
    if (!signing.ok) return signing;
    const deadline = dependencies.timeoutSignal({ timeoutMs: 15000 });
    const signal = optional.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    signal.throwIfAborted();
    const headers = { Authorization: authorization({ request, credential, ...signing.value }), ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) };
    if (!required.isCurrent()) return failure({ code: "forbidden" });
    const response = await dependencies.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal, headers });
    return await readResponse({ response, request, signal });
  } catch { return failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
}

/** Discard provider errors; successful status alone cannot bypass bounded body parsing. O(b), b<=1MiB. */
async function readResponse(required: { response: Response; request: WireRequest; signal: AbortSignal }): ReturnType<typeof requestXAds> {
  const { response, request, signal } = required;
  if (response.status !== 200 && !(request.method === "POST" && response.status === 201)) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
  const body = await readBody({ response, signal, request });
  if (!body.ok) return body;
  return { ok: true, value: { status: response.status, body: body.value, rateLimit: rateLimit({ response }) } };
}

/** Reject tainted pages as a whole; never follow a provider URL or leak unknown fields. @complexity O(n), n<=100. */
function decodeData(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<XResult["data"]> {
  const { prepared } = required;
  if (prepared.command.kind === "capability_active") return decodeActiveEntities({ input: required.input, ...prepared.command, accountId: prepared.configuration.accountId });
  if (prepared.command.kind === "capability_daily") return decodeDaily({ input: required.input, command: prepared.command, accountId: prepared.configuration.accountId });
  if (prepared.command.kind === "capability_entities") return decodeEntityPage({ input: required.input, resource: prepared.command.resource, accountId: prepared.configuration.accountId, requestedIds: prepared.command.entityIds });
  if (prepared.command.kind === "report") return decodeReport({ ...required, command: prepared.command, accountId: prepared.configuration.accountId, currency: prepared.configuration.currency! });
  const parsed = prepared.command.kind === "list_accounts" ? accountPage.safeParse(required.input) : campaignPage.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if ("request" in parsed.data && parsed.data.request.params.account_id !== prepared.configuration.accountId) return failure({ code: "protocol_mismatch" });
  const items = parsed.data.data;
  if (items.length > prepared.command.count || new Set(items.map(item => item.id)).size !== items.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { items, cursor: parsed.data.next_cursor } };
}

/** Byte bound precedes parsing; abort cancels even a pending read and forbids partial success.
 * Stream errors/aborts propagate to sendRequest's redacted boundary; listener and lock are released.
 * @complexity O(b) time/space, b<=1MiB.
 */
async function readBody(required: { response: Response; signal: AbortSignal; request: WireRequest }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  // Cancellation closes pending reads even when an injected fetch does not wire its body to the signal.
  const abort = () => { void reader.cancel().catch(() => undefined); };
  required.signal.addEventListener("abort", abort, { once: true });
  try {
    if (required.signal.aborted) abort();
    required.signal.throwIfAborted();
    let chunk = await reader.read();
    while (!chunk.done) {
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
      chunk = await reader.read();
    }
    required.signal.throwIfAborted();
    // Daily arrays need original numeric text even when a fractional token rounds to a safe integer.
    const daily = new URL(required.request.url).searchParams.get("granularity") === "DAY";
    return parseExactIntegerJson({ text: Buffer.concat(chunks).toString("utf8") }, daily ? { numericTextKeys: ["0", "1", "2", "3", "4", "5", "6"] } : undefined);
  } finally { required.signal.removeEventListener("abort", abort); reader.releaseLock(); }
}

/** JSON adapter edge catches cycles and parse errors without exposing content. @complexity O(b), <=configured fixed call bound. */
export function boundedJson(required: { input?: unknown; serialized?: string; maxBytes?: number }): Outcome<unknown> {
  try {
    const serialized = required.serialized ?? JSON.stringify(required.input);
    if (serialized === undefined || Buffer.byteLength(serialized) > (required.maxBytes ?? 65536)) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Prefer account limits when present. Return only validated integers for host pacing; never retry here. @complexity O(1). */
function rateLimit(required: { response: Response }): XResult["rateLimit"] {
  const h = required.response.headers;
  const prefix = h.has("x-account-rate-limit-limit") ? "x-account-rate-limit-" : "x-rate-limit-";
  const values = ["limit", "remaining", "reset"].map(key => h.get(prefix + key));
  if (values.some(value => value === null || !/^[0-9]{1,15}$/.test(value))) return null;
  const [limit, remaining, resetAtSeconds] = values.map(Number);
  return { limit, remaining, resetAtSeconds };
}
function httpFailure(required: { status: number }): Outcome<never> {
  const codes: Partial<Record<number, AppError["code"]>> = { 401: "unauthenticated", 403: "forbidden", 429: "limit_exceeded" };
  return failure({ code: codes[required.status] ?? "unavailable" });
}
export function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "X Ads request failed (" + required.code + ")", retryable: false } }; }
/** Telemetry is bounded and secret-free; observer failure cannot change the read outcome. @complexity O(1). */
function observe(required: { dependencies: XDependencies; prepared: Prepared; result: Outcome<XResult> }): void {
  try { required.dependencies.observer.observe({ operation: "x_ads." + required.prepared.command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: required.prepared.context.correlationId, traceId: required.prepared.context.traceId, runId: required.prepared.context.runId }); }
  catch { /* Observer is a foreign boundary; never replace the vendor result. */ }
}

const capabilityConnection = z.strictObject({ connectionId: idSchema, accountId: vendorId });
type MetricsCall = Parameters<PluginCapability<"report.metrics.v1">>[0] & { dependencies: XDependencies };
type StatusCall = Parameters<PluginCapability<"campaign.status.v1">>[0] & { dependencies: XDependencies };
type CapabilityRead = (required: { command: ParsedCommand }) => Promise<Outcome<XResult["data"]>>;
/** Bind the existing signed reads to host effects, without I/O at construction.
 * Random OAuth nonces remain independent across factories with identical call identity.
 * @example createCapabilities({ configuration, credentials, fetch, clock, observer, wait })
 * @complexity O(1) construction; each call retains at most 200 cancellable wait handles.
 */
export const createCapabilities: PluginCapabilitiesFactory = required => {
  const invoke = async (call: Parameters<PluginCapability<"report.metrics.v1">>[0] | Parameters<PluginCapability<"campaign.status.v1">>[0], options?: CallOptions) => {
    const config = pluginConfigurationSchema.safeParse(required.configuration);
    if (!config.success) return failure({ code: "invalid_input" });
    const timers: AbortController[] = [];
    const dependencies: XDependencies = { ...required,
      configuration: { scope: config.data.scope, connectionId: config.data.connectionId, accountId: config.data.accountId, pluginDigest: config.data.pluginDigest },
      gateway: { dispatch: input => input.execute() },
      ids: { next: () => randomBytes(16).toString("hex") },
      timeoutSignal: ({ timeoutMs }) => {
        const timer = new AbortController(), deadline = new AbortController();
        timers.push(timer);
        void required.wait({ milliseconds: timeoutMs }, { signal: timer.signal }).then(() => { if (!timer.signal.aborted) deadline.abort(); }, () => { if (!timer.signal.aborted) deadline.abort(); });
        return deadline.signal;
      },
    };
    try {
      return "grain" in call.input ? await reportMetrics({ ...call, input: call.input, dependencies }, options) : await campaignStatus({ ...call, input: call.input, dependencies }, options);
    } catch { return failure({ code: options?.signal?.aborted ? "cancelled" : "invalid_input" }); }
    finally { timers.forEach(timer => timer.abort()); }
  };
  return { "report.metrics.v1": (call, options) => invoke(call, options) as Promise<Outcome<MetricBatch>>, "campaign.status.v1": (call, options) => invoke(call, options) as Promise<Outcome<CampaignStatusOutput>> };
};
/** Daily metrics across the three documented placements. Account supports impressions only;
 * campaign/line-item/promoted-tweet grains require verified parents. Windows above seven days
 * and unresolved timezone history return not_implemented. No retries or invented zero rows.
 * @example reportMetrics({ dependencies, context, connection, input })
 * @returns Frozen-schema batch or typed boundary failure. O(e*d), <=5,000 rows/100 calls/25s.
 */
export async function reportMetrics(required: MetricsCall, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  try {
    const input = reportMetricsInputSchema.safeParse(required.input);
    if (!input.success) return failure({ code: "invalid_input" });
    const prepared = prepareCapability(required, optional);
    if (!prepared.ok) return prepared;
    if (Date.parse(input.data.days.end) - Date.parse(input.data.days.start) > 604800000) return failure({ code: "not_implemented" });
    const result = await readMetrics({ dependencies: required.dependencies, input: input.data, prepared: prepared.value });
    if (prepared.value.signal.aborted) return failure({ code: optional?.signal?.aborted ? "cancelled" : "expired" });
    return result;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
/** Capability-specific orchestration; the wrapper owns validation, exception and deadline handling. */
async function readMetrics(required: { dependencies: XDependencies; input: MetricsCall["input"]; prepared: Extract<ReturnType<typeof prepareCapability>, { ok: true }>["value"] }): Promise<Outcome<MetricBatch>> {
  const read = required.prepared.read;
  const account = await entityPages({ read, resource: "account" });
  if (!account.ok) return account;
  const metadata = account.value[0];
  const currency = await readCurrency({ read });
  if (!currency.ok) return currency;
  const window = dailyWindow({ days: required.input.days, metadata, now: required.dependencies.clock.now({}) });
  if (!window.ok) return window;
  const entities = await metricEntities({ read, grain: required.input.grain, accountId: required.prepared.connection.accountId, currency: currency.value, window: window.value });
  if (!entities.ok) return entities;
  const metrics = await collectDaily({ read, entities: entities.value, input: required.input, window: window.value });
  if (!metrics.ok) return metrics;
  const retrievedAt = required.dependencies.clock.now({});
  const output = metricBatchSchema.safeParse({ schema: "report.metrics.v1", pluginId: "x-ads", ...required.prepared.connection, currency: currency.value,
    timezone: metadata.timezone, ...required.input, mapping: metricMapping, retrievedAt, dataThrough: metrics.value.complete ? Math.min(window.value.end, retrievedAt) : 0,
    complete: metrics.value.complete, freshness: "stale", finality: "provisional", restated: false, rows: metrics.value.rows });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}
/** X accounts omit currency; sample one bounded campaign page without walking history.
 * Empty accounts cannot establish monetary metadata through the existing read commands.
 * O(n) time/space, n<=100; one GET, no paging or inferred currency from settings.
 */
async function readCurrency({ read }: { read: CapabilityRead }): Promise<Outcome<string>> {
  const page = await read({ command: { kind: "capability_entities", resource: "campaign" } });
  if (!page.ok) return page;
  if (!("kind" in page.value) || page.value.kind !== "entities") return failure({ code: "protocol_mismatch" });
  const currency = page.value.items[0]?.currency;
  if (!currency) return failure({ code: "not_implemented" });
  if (page.value.items.some(item => item.currency !== currency)) return failure({ code: "forbidden" });
  return { ok: true, value: currency };
}
/** Requested campaigns only. Unknown non-serving codes do not become guessed disapprovals.
 * @example campaignStatus({ dependencies, context, connection, input: { vendorCampaignIds: ["camp1"] } })
 * @returns Frozen-schema status with explicit unknown missing IDs. O(n), <=100 campaigns.
 */
export async function campaignStatus(required: StatusCall, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  try {
    const input = campaignStatusInputSchema.safeParse(required.input);
    if (!input.success || input.data.vendorCampaignIds.some(id => !vendorId.safeParse(id).success)) return failure({ code: "invalid_input" });
    const prepared = prepareCapability(required, optional);
    if (!prepared.ok) return prepared;
    const result = await readStatusOutput({ read: prepared.value.read, ids: input.data.vendorCampaignIds, dependencies: required.dependencies });
    if (prepared.value.signal.aborted) return failure({ code: optional?.signal?.aborted ? "cancelled" : "expired" });
    return result;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
/** Project bounded vendor reason evidence without guessing status; preserve requested coverage.
 * O(n) time/space, n<=100 requested campaigns; reasons already validated at <=20x1000 chars. */
async function readStatusOutput(required: { read: CapabilityRead; ids: string[]; dependencies: XDependencies }): Promise<Outcome<CampaignStatusOutput>> {
  const campaigns = await entityPages({ read: required.read, resource: "campaign", entityIds: required.ids });
  if (!campaigns.ok) return campaigns;
  const byId = new Map(campaigns.value.map(item => [item.id, item]));
  const output = campaignStatusOutputSchema.safeParse({ observedAt: required.dependencies.clock.now({}), complete: byId.size === required.ids.length,
    campaigns: required.ids.map(vendorCampaignId => ({ vendorCampaignId, status: xStatus({ campaign: byId.get(vendorCampaignId) }), disapprovalDescriptions: byId.get(vendorCampaignId)?.reasons_not_servable ?? [] })) });
  return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
}
/** Validate and snapshot context/binding before any credential lookup. Preserve service identity,
 * share one total deadline/request cap, and use the existing policy/audit fence for every call.
 */
function prepareCapability(required: MetricsCall | StatusCall, optional?: CallOptions): Outcome<{ read: CapabilityRead; signal: AbortSignal; connection: MetricsCall["connection"] }> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const service = serviceContextSchema.safeParse(required.context);
  const context = callContextSchema.safeParse(service.success ? { scope: service.data.scope, principal: { kind: "service", serviceId: service.data.serviceId }, correlationId: service.data.correlationId, traceId: service.data.traceId } : required.context);
  const connection = capabilityConnection.safeParse(required.connection), config = readConfigurationSchema.safeParse(required.dependencies.configuration);
  if (!context.success || !connection.success || !config.success) return failure({ code: "invalid_input" });
  if (connection.data.connectionId !== config.data.connectionId || connection.data.accountId !== config.data.accountId) return failure({ code: "forbidden" });
  if (context.data.scope.ownerId !== config.data.scope.ownerId || context.data.scope.workspaceId !== config.data.scope.workspaceId) return failure({ code: "forbidden" });
  const signal = optional?.signal ?? new AbortController().signal;
  const deadline = required.dependencies.clock.now({}) + 25000;
  const read = capabilityReader({ dependencies: required.dependencies, context: context.data, configuration: config.data, signal, deadline });
  return { ok: true, value: { read, signal, connection: connection.data } };
}
/** Per-invocation state only; each vendor attempt rechecks the captured account/currency binding. */
function capabilityReader({ dependencies, context, configuration, signal, deadline }: { dependencies: XDependencies; context: CallContext; configuration: ReadConfiguration; signal: AbortSignal; deadline: number }): CapabilityRead {
  let requests = 0;
  return async input => {
    if (++requests > 100) return failure({ code: "limit_exceeded" });
    if (signal.aborted) return failure({ code: "expired" });
    if (!sameReadBinding({ current: dependencies.configuration, captured: configuration })) return failure({ code: "forbidden" });
    const remaining = deadline - dependencies.clock.now({});
    if (remaining <= 0) return failure({ code: "limit_exceeded" });
    const soft = dependencies.timeoutSignal({ timeoutMs: remaining });
    const result = await invokeRead({ dependencies, context, operationId: context.correlationId, command: input.command }, { signal: AbortSignal.any([signal, soft]) });
    if (soft.aborted && !signal.aborted) return failure({ code: "limit_exceeded" });
    if (signal.aborted) return failure({ code: "expired" });
    return result.ok ? { ok: true, value: result.value.data } : result;
  };
}

/** A workflow cannot silently switch accounts between discovery and analytics. */
function sameReadBinding(required: { current: ReadConfiguration; captured: ReadConfiguration }): boolean {
  return required.current.connectionId === required.captured.connectionId && required.current.accountId === required.captured.accountId;
}
/** Bounded discovery rejects repeated cursors, duplicate IDs and nonterminal overflow. */
async function entityPages(required: { read: CapabilityRead; resource: XEntityPage["resource"]; entityIds?: string[] }): Promise<Outcome<XCapabilityEntity[]>> {
  const items: XCapabilityEntity[] = [], cursors = new Set<string>(), ids = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await entityPage({ ...required, cursor, ids });
    if (!page.ok) return page;
    page.value.items.forEach(item => ids.add(item.id)); items.push(...page.value.items);
    if (items.length > 1000) return failure({ code: "limit_exceeded" });
    if (page.value.cursor === null) return { ok: true, value: items };
    if (cursors.has(page.value.cursor)) return failure({ code: "protocol_mismatch" });
    cursors.add(page.value.cursor); cursor = page.value.cursor;
  }
}
/** A single page validates its closed result kind and rejects IDs repeated across pages. */
async function entityPage(required: { read: CapabilityRead; resource: XEntityPage["resource"]; entityIds?: string[]; cursor?: string; ids: Set<string> }): Promise<Outcome<XEntityPage>> {
  const page = await required.read({ command: { kind: "capability_entities", resource: required.resource, cursor: required.cursor, entityIds: required.entityIds } });
  if (!page.ok) return page;
  if (!("kind" in page.value) || page.value.kind !== "entities") return failure({ code: "protocol_mismatch" });
  if (page.value.items.some(item => required.ids.has(item.id))) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: page.value };
}
type MetricEntity = MetricBatch["rows"][number]["entity"];
type Placement = XActivePage["items"][number]["placements"][number];
type DailyEntity = { id: string; entity: MetricEntity; placements: Placement[] };
/** Discover only window-active entities, then fetch their metadata and required parents.
 * O(e) rows and batched metadata reads, e<=1,000; no full-history catalog traversal.
 */
async function metricEntities(required: { read: CapabilityRead; grain: MetricBatch["grain"]; accountId: string; currency: string; window: { start: number; end: number } }): Promise<Outcome<DailyEntity[]>> {
  if (required.grain === "account") return { ok: true, value: [{ id: required.accountId, entity: { grain: "account" }, placements: ["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"] }] };
  const types = { campaign: "CAMPAIGN", ad_group: "LINE_ITEM", ad: "PROMOTED_TWEET" } as const;
  const active = await required.read({ command: { kind: "capability_active", entity: types[required.grain], window: required.window } });
  if (!active.ok) return active;
  if (!("kind" in active.value) || active.value.kind !== "active") return failure({ code: "protocol_mismatch" });
  const metadata = await targetedEntities({ read: required.read, resource: required.grain, entityIds: active.value.items.map(item => item.entity_id) });
  if (!metadata.ok) return metadata;
  const hierarchy = await entityHierarchy({ ...required, grain: required.grain, items: metadata.value });
  if (!hierarchy.ok) return hierarchy;
  const placements = new Map(active.value.items.map(item => [item.entity_id, item.placements]));
  return { ok: true, value: hierarchy.value.map(item => ({ ...item, placements: placements.get(item.id)! })) };
}
/** Batch exact IDs, rejecting missing metadata instead of inventing parent links. O(e), e<=1,000. */
async function targetedEntities(required: { read: CapabilityRead; resource: XEntityPage["resource"]; entityIds: string[] }): Promise<Outcome<XCapabilityEntity[]>> {
  const ids = [...new Set(required.entityIds)], items: XCapabilityEntity[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const page = await entityPages({ ...required, entityIds: ids.slice(offset, offset + 100) });
    if (!page.ok) return page;
    items.push(...page.value);
  }
  return items.length === ids.length ? { ok: true, value: items } : failure({ code: "protocol_mismatch" });
}
/** Resolve only the parents of the selected rows and validate campaign currency. O(e), e<=1,000. */
async function entityHierarchy(required: { read: CapabilityRead; grain: "campaign" | "ad_group" | "ad"; currency: string; items: XCapabilityEntity[] }): Promise<Outcome<{ id: string; entity: MetricEntity }[]>> {
  const groups = required.grain === "ad" ? await targetedEntities({ read: required.read, resource: "ad_group", entityIds: required.items.map(item => item.line_item_id!) }) : { ok: true as const, value: required.items };
  if (!groups.ok) return groups;
  const campaignIds = required.grain === "campaign" ? required.items.map(item => item.id) : groups.value.map(item => item.campaign_id!);
  const campaigns = required.grain === "campaign" ? { ok: true as const, value: required.items } : await targetedEntities({ read: required.read, resource: "campaign", entityIds: campaignIds });
  if (!campaigns.ok) return campaigns;
  if (campaigns.value.some(item => item.currency !== required.currency)) return failure({ code: "forbidden" });
  const parents = new Map(groups.value.map(item => [item.id, item.campaign_id!]));
  return { ok: true, value: required.items.map(item => ({ id: item.id, entity: hierarchyEntity({ grain: required.grain, item, parents }) })) };
}
/** Pure projection after parent metadata was validated; no inferred identifiers. */
function hierarchyEntity(required: { grain: "campaign" | "ad_group" | "ad"; item: XCapabilityEntity; parents: Map<string, string> }): MetricEntity {
  const { item } = required;
  switch (required.grain) {
    case "campaign": return { grain: "campaign", vendorCampaignId: item.id };
    case "ad_group": return { grain: "ad_group", vendorCampaignId: item.campaign_id!, vendorAdGroupId: item.id };
    case "ad": return { grain: "ad", vendorCampaignId: required.parents.get(item.line_item_id!)!, vendorAdGroupId: item.line_item_id!, vendorAdId: item.id };
  }
}
/** Current-offset rule is documented by X. Reject switch-history gaps, DST discontinuities and
 * subhour offsets rather than relabelling historical account days. O(d), d<=7; no clock read.
 */
function dailyWindow(required: { days: MetricBatch["days"]; metadata: XCapabilityEntity; now: number }): Outcome<{ start: number; end: number }> {
  const timezone = required.metadata.timezone, switched = required.metadata.timezone_switch_at;
  if (!timezone || !switched || !epochSchema.safeParse(required.now).success) return failure({ code: "not_implemented" });
  const offset = timezoneOffset({ timezone, epoch: required.now });
  const start = Date.parse(required.days.start) - offset, end = Date.parse(required.days.end) - offset;
  if (start < Date.parse(switched) || !Number.isInteger(offset / 3600000)) return failure({ code: "not_implemented" });
  for (let day = start; day <= end; day += 86400000) if (timezoneOffset({ timezone, epoch: day }) !== offset) return failure({ code: "not_implemented" });
  return { ok: true, value: { start, end } };
}
/** Intl resolves only the supplied timezone/epoch; malformed vendor metadata fails at the outer boundary. */
function timezoneOffset(required: { timezone: string; epoch: number }): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: required.timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(required.epoch);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(required.epoch / 1000) * 1000;
}
/** Combine each of the three disjoint placements exactly once. A missing placement row makes
 * every metric for that entity/day unavailable; explicit nulls were decoded as zero. O(e*d).
 */
async function collectDaily(required: { read: CapabilityRead; entities: DailyEntity[]; input: MetricsCall["input"]; window: { start: number; end: number } }): Promise<Outcome<{ rows: MetricBatch["rows"]; complete: boolean }>> {
  const dayCount = (required.window.end - required.window.start) / 86400000;
  if (required.entities.length * dayCount > 5000) return failure({ code: "limit_exceeded" });
  const rows: MetricBatch["rows"] = [];
  let complete = true;
  for (let offset = 0; offset < required.entities.length; offset += 20) {
    const batch = await dailyEntityBatch({ ...required, entities: required.entities.slice(offset, offset + 20), dayCount });
    if (!batch.ok && batch.error.code === "limit_exceeded") { complete = false; break; }
    if (!batch.ok) return batch;
    rows.push(...batch.value.rows); complete = complete && batch.value.complete;
  }
  return { ok: true, value: { rows, complete } };
}
/** One <=20-entity chunk; absent entities never become zero-valued daily observations. */
async function dailyEntityBatch(required: Parameters<typeof collectDaily>[0] & { dayCount: number }): Promise<Outcome<{ rows: MetricBatch["rows"]; complete: boolean }>> {
  const entityTypes = { account: "ACCOUNT", campaign: "CAMPAIGN", ad_group: "LINE_ITEM", ad: "PROMOTED_TWEET" } as const;
  const observations = new Map<string, { count: number; metrics: MetricValues }>();
  let complete = true;
  for (const placement of ["ALL_ON_TWITTER", "SPOTLIGHT", "TREND"] as const) {
    const entities = required.entities.filter(item => item.placements.includes(placement));
    if (!entities.length) continue;
    const result = await required.read({ command: { kind: "capability_daily", entity: entityTypes[required.input.grain], entityIds: entities.map(item => item.id), window: required.window, placement } });
    if (!result.ok) return result;
    if (!("kind" in result.value) || result.value.kind !== "daily") return failure({ code: "protocol_mismatch" });
    complete = complete && result.value.complete;
    for (const row of result.value.rows) {
      const key = row.entityId + ":" + row.index, previous = observations.get(key);
      observations.set(key, { count: (previous?.count ?? 0) + 1, metrics: sumMetrics({ previous: previous?.metrics, current: row.metrics }) });
    }
  }
  const rows = required.entities.flatMap(item => Array.from({ length: required.dayCount }, (_, index) => combinedRow({ item, index, start: required.input.days.start, observation: observations.get(item.id + ":" + index), account: required.input.grain === "account" })).filter(row => row !== null));
  return { ok: true, value: { rows, complete } };
}
/** Exact sums propagate unavailable cells; the first placement initializes from observed values. */
function sumMetrics(required: { previous?: MetricValues; current: MetricValues }): MetricValues {
  if (!required.previous) return required.current;
  const metrics: MetricValues = {};
  for (const key of ["spend", "impressions", "clicks"] as const) {
    if (required.current[key] === undefined) continue;
    const left = required.previous[key], right = required.current[key];
    metrics[key] = left == null || right === null ? null : (BigInt(left) + BigInt(right!)).toString();
  }
  return metrics;
}
/** No entity observed on any placement means no row. Partial placement coverage means null. */
function combinedRow(required: { item: DailyEntity; index: number; start: string; observation?: { count: number; metrics: MetricValues }; account: boolean }): MetricBatch["rows"][number] | null {
  if (!required.observation) return null;
  const unavailable = required.account ? { impressions: null } : { impressions: null, clicks: null, spend: null };
  return { day: new Date(Date.parse(required.start) + required.index * 86400000).toISOString().slice(0, 10), entity: required.item.entity, metrics: required.observation.count === required.item.placements.length ? required.observation.metrics : unavailable };
}
/** Only documented lifecycle/servability signals map; arbitrary reason strings stay unknown. */
function xStatus({ campaign }: { campaign?: XCapabilityEntity }): CampaignStatusOutput["campaigns"][number]["status"] {
  if (!campaign) return "unknown";
  if (campaign.deleted) return "ended";
  if (campaign.entity_status === "PAUSED") return "paused";
  if (campaign.entity_status === "DRAFT") return "pending";
  if (campaign.entity_status === "ACTIVE" && campaign.servable === true && campaign.reasons_not_servable?.length === 0) return "active";
  return "unknown";
}
