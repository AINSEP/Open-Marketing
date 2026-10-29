import { z } from "zod";
import { appErrorSchema, callContextSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import { commandSchema, decodePagination, encodeCommand, failure, moneySchema, paginationSchema, responseIdSchema, vendorIdSchema } from "./commands.js";
import type { AppleRequest, ParsedCommand } from "./commands.js";

/** Internal boundary: accountId is an explicitly selected v1 ad-account ID, never a legacy org ID. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable() });
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const account = z.object({ adAccount: z.object({ id: responseIdSchema, name: z.string().max(1024), orgId: responseIdSchema }), roles: z.array(z.string().max(128)).max(32) });
const campaign = z.object({ id: responseIdSchema, adAccountId: responseIdSchema, name: z.string().max(1024), status: z.enum(["ENABLED", "PAUSED"]), dailyBudget: z.object({ value: moneySchema }).optional() });
const accountsSchema = z.object({ result: z.object({ acls: z.array(account).max(100) }).transform(value => value.acls), pagination: z.null().optional(), error: z.null().optional() });
const campaignsSchema = z.object({ result: z.array(campaign).max(100), pagination: paginationSchema, error: z.null().optional() });
// Bound provider error text/details for validation only; none is exposed in results or logs.
const providerError = z.object({ code: z.string().min(1).max(128), message: z.string().max(4096).nullable().optional(),
  details: z.array(z.object({ code: z.string().max(128), message: z.string().max(4096).nullable().optional() })).max(100).optional() });
const envelopeSchema = z.object({ error: providerError.nullable().optional() });
export type AppleSearchAdsConfiguration = z.infer<typeof configurationSchema>;
type Prepared = { input: z.infer<typeof invocationSchema>; configuration: AppleSearchAdsConfiguration };
/** Server-custody credential callback; discovery permits accountId:null with a scoped connection. */
export interface AppleSearchAdsDependencies {
  readonly configuration: AppleSearchAdsConfiguration;
  readonly admitted: boolean;
  readonly credentials: { access(required: { connectionId: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>> };
  /** Host MUST recheck plugin/connection/account authority after credential awaits at actual egress. Foreign fetch ABI. */
  readonly fetch: typeof fetch;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
export interface AppleSearchAdsPage {
  readonly source: "apple_search_ads";
  readonly apiVersion: "v1";
  readonly retrievedAt: number;
  readonly accountId: string | null;
  readonly pagination: (z.infer<typeof paginationSchema> & { returned: number; requestedLimit: number; coverage: "page" }) | null;
  readonly items: readonly z.infer<typeof account>[] | readonly z.infer<typeof campaign>[];
}
export interface AppleSearchAdsResult { readonly operationId: string; readonly status: "succeeded"; readonly data: AppleSearchAdsPage }

/** One read through server-supplied credentials and guarded fetch. admitted:false does no credential
 * lookup or network. No auth exchange, registry, retries or automatic pagination occurs here.
 * @param required - Context/operation, tainted command and injected dependencies.
 * @param optional - Caller cancellation. @returns Typed read result or sanitized failure; never throws vendor errors.
 * @example invokeAppleSearchAds({ context, operationId: "read", command: { kind: "list_accounts" }, dependencies })
 * @complexity O(b) time/space, input<=64KiB and response<=1MiB, one credential lookup and one fetch.
 */
export async function invokeAppleSearchAds(required: { context: CallContext; operationId: string; command: unknown; dependencies: AppleSearchAdsDependencies }, optional?: CallOptions): Promise<Outcome<AppleSearchAdsResult>> {
  if (!required.dependencies.admitted) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const prepared = prepare(required);
  if (!prepared.ok) return prepared;
  let result: Outcome<AppleSearchAdsResult>;
  try { result = await dispatch({ prepared: prepared.value, dependencies: required.dependencies }, optional); }
  catch { result = failure({ code: "unavailable" }); }
  observe({ dependencies: required.dependencies, prepared: prepared.value, result });
  return result;
}

/** Snapshot bounded input before the first await; reject cross-scope or unbound account operations.
 * @complexity O(b), b<=64KiB; no I/O. Unknown fields fail closed.
 */
function prepare(required: { context: CallContext; operationId: string; command: unknown; dependencies: AppleSearchAdsDependencies }): Outcome<Prepared> {
  try {
    const serialized = JSON.stringify({ context: required.context, operationId: required.operationId, command: required.command });
    if (Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    const input = invocationSchema.safeParse(JSON.parse(serialized));
    const configuration = configurationSchema.safeParse(required.dependencies.configuration);
    if (!input.success || !configuration.success) return failure({ code: "invalid_input" });
    const scope = input.data.context.scope;
    if (scope.ownerId !== configuration.data.scope.ownerId || scope.workspaceId !== configuration.data.scope.workspaceId) return failure({ code: "forbidden" });
    if (input.data.command.kind !== "list_accounts" && configuration.data.accountId === null) return failure({ code: "forbidden" });
    return { ok: true, value: { input: input.data, configuration: configuration.data } };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Recheck token expiry/admission/cancellation after broker access, then enter the host egress fence.
 * @complexity O(1), one callback; expiry is host-managed when omitted, never synthesized.
 */
async function dispatch(required: { prepared: Prepared; dependencies: AppleSearchAdsDependencies }, optional?: CallOptions): Promise<Outcome<AppleSearchAdsResult>> {
  const { prepared, dependencies } = required;
  const request = encodeCommand({ command: prepared.input.command });
  const preflight = checkTime({ dependencies });
  if (!preflight.ok) return preflight;
  const credential = await resolveCredential({ dependencies, configuration: prepared.configuration }, optional);
  if (!credential.ok) return credential;
  if (!dependencies.admitted) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const time = checkTime({ dependencies, expiresAt: credential.value.expiresAt });
  if (!time.ok) return time;
  const response = await send({ dependencies, request, token: credential.value.accessToken, accountId: prepared.input.command.kind === "list_accounts" ? null : prepared.configuration.accountId }, optional);
  if (!response.ok) return response;
  const retrievedAt = epochSchema.safeParse(dependencies.clock.now({}));
  if (!retrievedAt.success) return failure({ code: "invalid_input" });
  const data = decode({ prepared, input: response.value, retrievedAt: retrievedAt.data });
  return data.ok ? { ok: true, value: { operationId: prepared.input.operationId, status: "succeeded", data: data.value } } : data;
}

/** Parse broker output and scrub its errors; credentials never enter results or telemetry. @complexity O(1), one broker call. */
export async function resolveCredential(required: { dependencies: AppleSearchAdsDependencies; configuration: AppleSearchAdsConfiguration }, optional?: CallOptions): Promise<Outcome<z.infer<typeof credentialSchema>>> {
  const result = await required.dependencies.credentials.access({ connectionId: required.configuration.connectionId, accountId: required.configuration.accountId }, optional);
  if (!result.ok) {
    const error = appErrorSchema.safeParse(result.error);
    return failure({ code: error.success ? error.data.code : "unavailable" });
  }
  const parsed = credentialSchema.safeParse(result.value);
  return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "unauthenticated" });
}

/** Validate injected time and broker expiry; no hidden clock reads.
 * @complexity O(1), no hidden clock or I/O.
 */
function checkTime(required: { dependencies: AppleSearchAdsDependencies; expiresAt?: number }): Outcome<void> {
  const now = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (required.expiresAt !== undefined && now >= required.expiresAt) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}

/** Fixed HTTPS URL, no redirects, <=64KiB request, 15s fetch/body deadline; no automatic retry.
 * @complexity O(b) time/space, b<=1MiB. Foreign fetch errors stay inside this boundary.
 */
export async function send(required: { dependencies: AppleSearchAdsDependencies; request: AppleRequest; token: string; accountId: string | null }, optional?: CallOptions): Promise<Outcome<unknown>> {
  if (Buffer.byteLength(required.request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const signal = AbortSignal.any([AbortSignal.timeout(15000), ...(optional?.signal ? [optional.signal] : [])]);
  try {
    const headers: Record<string, string> = { Authorization: "Bearer " + required.token, "Content-Type": "application/json" };
    if (required.accountId !== null) headers["X-AP-Context"] = "adAccountId=" + required.accountId;
    const response = await required.dependencies.fetch(required.request.url, { method: required.request.method, body: required.request.body, headers, redirect: "error", signal });
    if (response.status !== 200) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
    const body = await readBody({ response, signal });
    if (signal.aborted) return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" });
    return body;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}

/** No provider messages or token echoes escape, including on throttling/redirects. @complexity O(1). */
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 400: return failure({ code: "invalid_input" });
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "unavailable" });
  }
}

/** Stream before JSON parsing; Content-Length is untrusted. Cancel on the deadline or caller abort.
 * @complexity O(b) time/space, b<=1MiB; no partial output on overflow or malformed JSON.
 */
async function readBody(required: { response: Response; signal: AbortSignal }): Promise<Outcome<unknown>> {
  if (required.signal.aborted) { await required.response.body?.cancel(); return failure({ code: "unavailable" }); }
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); }; // Abort callback ABI.
  required.signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    if (required.signal.aborted) return failure({ code: "unavailable" });
    return decodeJson({ chunks });
  }
  finally { required.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Validate JSON and bounded v1 errors without exposing provider text. @complexity O(b), b<=1MiB. */
function decodeJson(required: { chunks: Uint8Array[] }): Outcome<unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.concat(required.chunks).toString("utf8"));
    const envelope = envelopeSchema.safeParse(value);
    if (!envelope.success || envelope.data.error) return failure({ code: "protocol_mismatch" });
    return { ok: true, value };
  }
  catch { return failure({ code: "protocol_mismatch" }); }
}

/** Route validated responses without passing unconsumed provider fields to the agent. @complexity O(b), b<=1MiB. */
function decode(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<AppleSearchAdsPage> {
  const { prepared, input, retrievedAt } = required;
  const command = prepared.input.command;
  return decodeList({ input, command, configuration: prepared.configuration, retrievedAt });
}

/** Reject mixed-validity and duplicate lists atomically; ACLs contain ad-account identity and roles only.
 * @complexity O(n) time/space, n<=100; never follows provider links.
 */
function decodeList(required: { input: unknown; command: ParsedCommand; configuration: AppleSearchAdsConfiguration; retrievedAt: number }): Outcome<AppleSearchAdsPage> {
  const parsed = required.command.kind === "list_accounts" ? accountsSchema.safeParse(required.input) : campaignsSchema.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const items = parsed.data.result;
  const ids = items.map(item => "id" in item ? item.id : item.adAccount.id);
  if (new Set(ids).size !== ids.length) return failure({ code: "protocol_mismatch" });
  if (required.command.kind === "list_campaigns" && items.some(item => "adAccountId" in item && item.adAccountId !== required.configuration.accountId)) return failure({ code: "protocol_mismatch" });
  let pagination: AppleSearchAdsPage["pagination"] = null;
  if (parsed.data.pagination != null) {
    const bounds = required.command.kind === "list_accounts" ? { offset: 0, limit: 100 } : required.command;
    const page = decodePagination({ pagination: parsed.data.pagination, ...bounds, returned: items.length });
    if (!page.ok) return page;
    pagination = page.value;
  }
  return { ok: true, value: { source: "apple_search_ads", apiVersion: "v1", accountId: required.configuration.accountId, retrievedAt: required.retrievedAt, items, pagination } };
}

/** Best-effort sanitized operation outcome, with existing run/correlation/trace IDs. @complexity O(1). */
function observe(required: { dependencies: AppleSearchAdsDependencies; prepared: Prepared; result: Outcome<AppleSearchAdsResult> }): void {
  const { correlationId, traceId, runId } = required.prepared.input.context;
  try { required.dependencies.observer.observe({ operation: "apple-search-ads." + required.prepared.input.command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId, traceId, runId }); }
  catch { /* Telemetry cannot change an already completed read. */ }
}
