/** Server-loaded OAuth edge. Imports are inert; dependencies own all credentials and effects. */
import { createHash, createHmac } from "node:crypto";
import OAuth from "oauth-1.0a";
import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, ClockPort, EffectEnvelope, IdPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import { commandSchema, cursorSchema, encodeCommand, vendorId } from "./commands.js";
import type { ParsedCommand, XCommand } from "./commands.js";
import { decodeReport } from "./reporting.js";
import type { XReport } from "./reporting.js";

export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId, currency: z.string().regex(/^[A-Z]{3}$/), pluginDigest: digestSchema, bindingId: idSchema, admitted: z.boolean() });
/** Server-owned account/currency/admission binding, never supplied in assistant arguments. */
export type XConfiguration = z.infer<typeof configurationSchema>;
/** Internal signed wire shape; JSON bodies are excluded from OAuth's form parameter set. */
export type WireRequest = { url: string; method: "GET" | "POST"; body?: string };
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
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
export interface XResult { readonly operationId: string; readonly status: "succeeded"; readonly data: XPage | XReport; readonly rateLimit: { limit: number; remaining: number; resetAtSeconds: number } | null }
/** Existing server seams only. dispatch holds the ONE policy fence and rechecks lifecycle,
 * scope/account/connection after credential resolution, immediately before execute (foreign callback ABI).
 */
export interface XDependencies {
  readonly configuration: XConfiguration;
  readonly credentials: { access(required: { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>> };
  readonly gateway: { dispatch(required: { context: CallContext; configuration: XConfiguration; operation: XCommand["kind"]; request: ReturnType<typeof encodeCommand>; effect: EffectEnvelope; execute: () => Promise<Outcome<XResult>> }, optional?: CallOptions): Promise<Outcome<XResult>> };
  readonly fetch: typeof fetch; readonly clock: ClockPort; readonly ids: IdPort; readonly observer: ObserverPort;
  /** Host timer seam: return a signal that aborts after timeoutMs; no ambient timers in the plugin. */
  readonly timeoutSignal: (required: { timeoutMs: number }) => AbortSignal;
}
type Prepared = { context: CallContext; operationId: string; command: ParsedCommand; configuration: XConfiguration; request: ReturnType<typeof encodeCommand>; effect: EffectEnvelope };

/** Validate before credential access, then perform one server-fenced signed GET; never retry.
 * @param required - Context, operation identity, closed command and server dependencies.
 * @returns A projected read result or a redacted typed boundary failure.
 * @example await invokeXAds({ context, operationId: "read-1", command: { kind: "list_accounts" }, dependencies });
 * @complexity O(b+n*m), b<=1MiB, n,m<=100; one credential access and one GET.
 */
export async function invokeXAds(required: { context: CallContext; operationId: string; command: XCommand; dependencies: XDependencies }, optional: CallOptions = {}): Promise<Outcome<XResult>> {
  const prepared = prepare(required, optional);
  if (!prepared.ok) return prepared;
  let result: Outcome<XResult>;
  try { result = await dispatch({ prepared: prepared.value, dependencies: required.dependencies }, optional); }
  catch { result = failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
  observe({ dependencies: required.dependencies, prepared: prepared.value, result });
  return result;
}

/** Snapshot tainted input before awaits, enforce admission and tenant equality. @complexity O(b), b<=64KiB. */
function prepare(required: Parameters<typeof invokeXAds>[0], optional: CallOptions): Outcome<Prepared> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const input = boundedJson({ input: { context: required.context, operationId: required.operationId, command: required.command } });
  if (!input.ok) return input;
  const invocation = invocationSchema.safeParse(input.value);
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const { context, operationId, command } = invocation.data;
  const config = configuration.data;
  if (!config.admitted || context.scope.ownerId !== config.scope.ownerId || context.scope.workspaceId !== config.scope.workspaceId) return failure({ code: "forbidden" });
  if (command.kind === "report" && command.entity === "ACCOUNT" && (command.entityIds.length !== 1 || command.entityIds[0] !== config.accountId)) return failure({ code: "forbidden" });
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
export async function resolveCredential(required: { dependencies: Pick<XDependencies, "credentials">; configuration: XConfiguration }, optional: CallOptions): Promise<Outcome<Credential>> {
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
  const response = await requestXAds({ ...required, request: prepared.request, isCurrent: () => dependencies.configuration.admitted }, optional);
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
    if (!dependencies.configuration.admitted || !required.isCurrent()) return failure({ code: "forbidden" });
    const response = await dependencies.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal, headers });
    return await readResponse({ response, request, signal });
  } catch { return failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
}

/** Discard provider errors; successful status alone cannot bypass bounded body parsing. O(b), b<=1MiB. */
async function readResponse(required: { response: Response; request: WireRequest; signal: AbortSignal }): ReturnType<typeof requestXAds> {
  const { response, request, signal } = required;
  if (response.status !== 200 && !(request.method === "POST" && response.status === 201)) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
  const body = await readBody({ response, signal });
  if (!body.ok) return body;
  return { ok: true, value: { status: response.status, body: body.value, rateLimit: rateLimit({ response }) } };
}

/** Reject tainted pages as a whole; never follow a provider URL or leak unknown fields. @complexity O(n), n<=100. */
function decodeData(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<XResult["data"]> {
  const { prepared } = required;
  if (prepared.command.kind === "report") return decodeReport({ ...required, command: prepared.command, accountId: prepared.configuration.accountId, currency: prepared.configuration.currency });
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
async function readBody(required: { response: Response; signal: AbortSignal }): Promise<Outcome<unknown>> {
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
    const parsed = boundedJson({ serialized: Buffer.concat(chunks).toString("utf8"), maxBytes: 1048576 });
    return parsed.ok ? parsed : failure({ code: "protocol_mismatch" });
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
