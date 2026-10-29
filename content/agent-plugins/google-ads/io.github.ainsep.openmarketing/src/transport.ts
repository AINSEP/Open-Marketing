import { z } from "zod";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, PluginCapabilityDependencies, ServiceContext } from "@open-marketing/contracts";
import { callContextSchema, metricBatchSchema, parseBoundary, parseExactIntegerJson, pluginConfigurationSchema, serviceContextSchema } from "@open-marketing/contracts";
import { failure, parse, success, id, numericId, object, text } from "./schema.ts";
import { transportBindingSchema } from "./schemas.ts";
import { metricSearchRows } from "./metrics.ts";
import type { AccountBinding, CredentialPort, GoogleTransportPort, HttpPort, HttpRequest, VendorRequest } from "./types.ts";

const dataManagerScope = "https://www.googleapis.com/auth/datamanager";
const managerSchema = z.string().regex(/^[1-9][0-9]{9}$/).optional();
const credentialSchema = z.object({
  accessToken: z.string().min(1).max(4096).regex(/^[^\r\n]+$/),
  loginCustomerId: managerSchema, developerToken: z.string().regex(/^[A-Za-z0-9]{22}$/).optional(),
});
/** Fresh canonical binding for reads, halt and deployment; configuration fails before effects.
 * Tokens are resolved and validated at each request, never retained between calls. O(1).
 * @example createCallTransport({ dependencies }, { signal })
 */
export function createCallTransport(required: { dependencies: PluginCapabilityDependencies }, optional?: CallOptions) {
  const { dependencies } = required;
  const configuration = parseBoundary({ schema: pluginConfigurationSchema, input: dependencies.configuration });
  if (!configuration.ok) return configuration;
  const manager = managerSchema.safeParse(configuration.value.settings.loginCustomerId);
  if (!manager.success) return failure<never>({ code: "invalid_input", message: "Invalid Google manager setting" });
  const { scope, connectionId, accountId } = configuration.value;
  const binding = { scope, connectionId, customerId: accountId };
  const signal = readSignal({ signal: optional?.signal });
  const transport = createGoogleRestTransport({ binding,
    credentials: { access: async () => {
      const credential = await dependencies.credentials.access({ connectionId, accountId }, { ...optional, signal });
      if (!credential.ok) return credential;
      const developerToken = credential.value.secrets?.developerToken;
      const loginCustomerId = manager.data;
      return parseBoundary({ schema: credentialSchema, input: { accessToken: credential.value.accessToken,
        ...(developerToken === undefined ? {} : { developerToken }), ...(loginCustomerId === undefined ? {} : { loginCustomerId }) } });
    } },
    http: createHttpAdapter({ fetch: dependencies.fetch, observer: dependencies.observer, signal }),
  });
  return success({ value: { binding, transport, configuration: configuration.value } });
}
/** Caller cancellation can only shorten the shared 30s call deadline. O(1), no I/O. */
export function readSignal({ signal }: { signal?: AbortSignal }): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
}
/** OAuth credentials remain in the server/plugin path. Fixed Search and Data Manager
 * endpoints, per-advertiser credential lookup, no retries or legacy upload.
 * @example createGoogleRestTransport({ binding, credentials, http }) */
export function createGoogleRestTransport(required: { binding: Pick<AccountBinding, "scope" | "connectionId" | "customerId">; credentials: CredentialPort; http: HttpPort }): GoogleTransportPort {
  return { request: input => restRequest({ ...required, input }) };
}
/** Validate scoped credentials before choosing one fixed provider endpoint. */
async function restRequest(required: { binding: Pick<AccountBinding, "scope" | "connectionId" | "customerId">; credentials: CredentialPort; http: HttpPort; input: VendorRequest }): Promise<Outcome<unknown>> {
  const binding = parse<Pick<AccountBinding, "scope" | "connectionId" | "customerId">>({ schema: transportBindingSchema, input: { scope: required.binding.scope, connectionId: required.binding.connectionId, customerId: required.binding.customerId } });
  if (!binding.ok) return binding;
  const access = checkDataManagerAccess(required);
  if (!access.ok) return access;
  const manager = access.value;
  const credential = await required.credentials.access({ binding: binding.value, ...(manager ? { requiredScope: dataManagerScope, cloudProjectId: required.input.cloudProjectId } : {}) });
  if (!credential.ok) return credential;
  const checked = checkCredential({ credential: credential.value, input: required.input, manager });
  if (!checked.ok) return checked;
  const headers = credentialHeaders({ credential: credential.value, manager });
  const response = await sendRequest({ ...required, binding: binding.value, headers });
  if (!response.ok) return response;
  if (response.value.status < 200 || response.value.status >= 300) return failure({ code: "unavailable", message: "Google request failed; reconciliation may be required" });
  return success({ value: response.value.body });
}
/** Google Ads compatibility headers never cross into Data Manager. O(1), no I/O. */
function credentialHeaders(required: { credential: { accessToken: string; loginCustomerId?: string; developerToken?: string }; manager: boolean }): Record<string, string> {
  const { credential, manager } = required;
  const headers: Record<string, string> = { Authorization: "Bearer " + credential.accessToken, "Content-Type": "application/json" };
  if (manager) return headers;
  if (credential.loginCustomerId) headers["login-customer-id"] = credential.loginCustomerId;
  if (credential.developerToken) headers["developer-token"] = credential.developerToken;
  return headers;
}
/** Search-only hosts remain valid; ingestion requires GET diagnostics; Google enforces the OAuth scope.
 * Returns whether this request needs Data Manager OAuth. O(1) time/space. */
function checkDataManagerAccess(required: { input: VendorRequest; http: HttpPort }): Outcome<boolean> {
  const manager = required.input.method === "ingest" || required.input.method === "request_status";
  if (!manager) return success({ value: false });
  if (!required.http.get) return failure({ code: "unavailable", message: "Data Manager requires bounded GET diagnostics" });
  return success({ value: true });
}
/** Validate tainted broker output shape; scope/project attestation is not required (canonical broker returns token/expiry only). */
function checkCredential(required: { credential: unknown; input: VendorRequest; manager: boolean }): Outcome<void> {
  const parsed = parse<{ accessToken: string; loginCustomerId?: string; scopes?: string[]; cloudProjectId?: string }>({ schema: object({ properties: {
    accessToken: { ...text, maxLength: 4096, pattern: "^[^\\r\\n]+$" }, loginCustomerId: { ...numericId, minLength: 10, maxLength: 10 },
    developerToken: { type: "string", pattern: "^[A-Za-z0-9]{22}$", minLength: 22, maxLength: 22 },
    scopes: { type: "array", items: { ...text, maxLength: 256 }, minItems: 1, maxItems: 32 }, cloudProjectId: id,
  }, optional: ["loginCustomerId", "developerToken", "scopes", "cloudProjectId"] }), input: required.credential });
  if (!parsed.ok) return parsed;
  return success({ value: undefined });
}
/** Exactly one bounded POST or diagnostic GET. URL is never selected by tools.
 * POST googleAds:search is read-only by API contract, including reconciliation;
 * mutation uses the separate googleAds:mutate endpoint. */
async function sendRequest(required: { binding: Pick<AccountBinding, "scope" | "connectionId" | "customerId">; http: HttpPort; input: VendorRequest; headers: Record<string, string> }): Promise<Outcome<{ status: number; body: unknown; requestId?: string }>> {
  const bounds = { headers: required.headers, timeoutMs: 15000, maxBytes: 1048576, context: required.input.context, operationId: required.input.operationId };
  if (required.input.method === "request_status") {
    const receipt = parse<{ requestId: string }>({ schema: object({ properties: { requestId: id } }), input: required.input.body });
    if (!receipt.ok) return receipt;
    if (!required.http.get) return failure({ code: "unavailable", message: "Data Manager diagnostics unavailable" });
    return required.http.get({ ...bounds, url: "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=" + encodeURIComponent(receipt.value.requestId) });
  }
  const url = endpoint({ binding: required.binding, method: required.input.method });
  return required.http.post({ ...bounds, url, body: JSON.stringify(required.input.body) });
}
function endpoint(required: { binding: Pick<AccountBinding, "scope" | "connectionId" | "customerId">; method: Exclude<VendorRequest["method"], "request_status"> }): string {
  switch (required.method) {
    case "search": return `https://googleads.googleapis.com/v26/customers/${required.binding.customerId}/googleAds:search`;
    case "mutate": return `https://googleads.googleapis.com/v26/customers/${required.binding.customerId}/googleAds:mutate`;
    case "ingest": return "https://datamanager.googleapis.com/v1/events:ingest";
    default: { const exhaustive: never = required.method; return exhaustive; }
  }
}
/** Inject fetch and the owning job's cancellation signal; redirects, retries and secret logging
 * are disabled. Both methods combine cancellation with 15s/1MiB ceilings and emit sanitized observations.
 * @complexity O(b), b<=1MiB time/space; one request, no polling.
 * @example createHttpAdapter({ fetch: hostFetch, observer }) */
export function createHttpAdapter(required: { fetch: typeof fetch; observer: ObserverPort; signal?: AbortSignal }): HttpPort {
  return {
    post: input => httpRequest({ ...required, input }, { method: "POST" }),
    get: input => httpRequest({ ...required, input }, { method: "GET" }),
  };
}
/** Method-specific allowlist; fixed diagnostics path with one bounded receipt ID. */
function permittedDestination(required: { url: string; method: "POST" | "GET" }): boolean {
  if (required.method === "POST") return /^https:\/\/googleads\.googleapis\.com\/v26\/customers\/[0-9]{10}\/googleAds:(search|mutate)$/.test(required.url) || required.url === "https://datamanager.googleapis.com/v1/events:ingest";
  if (!required.url.startsWith("https://datamanager.googleapis.com/v1/requestStatus:retrieve?")) return false;
  const url = new URL(required.url);
  if (url.hash || url.searchParams.size !== 1 || !url.searchParams.has("requestId")) return false;
  return parse({ schema: id, input: url.searchParams.get("requestId") }).ok;
}
/** Catch fetch/JSON failures only at the real adapter edge, preserving typed errors. */
async function httpRequest(required: { fetch: typeof fetch; observer: ObserverPort; signal?: AbortSignal; input: HttpRequest & { body?: string } }, optional: { method: "POST" | "GET" }): Promise<Outcome<{ status: number; body: unknown; requestId?: string }>> {
  const { input } = required;
  if (!permittedDestination({ url: input.url, method: optional.method })) return failure({ code: "forbidden", message: "HTTP destination is outside Google plugin scope" });
  const maxBytes = Math.min(input.maxBytes, 1048576);
  if (Buffer.byteLength(input.body ?? "") > maxBytes) return failure({ code: "limit_exceeded", message: "Vendor request exceeds payload bound" });
  let outcome: Outcome<{ status: number; body: unknown; requestId?: string }>;
  try {
    const timeout = AbortSignal.timeout(Math.min(input.timeoutMs, 15000));
    const signal = required.signal ? AbortSignal.any([required.signal, timeout]) : timeout;
    const response = await required.fetch(input.url, { method: optional.method, headers: input.headers, body: input.body, redirect: "error", signal });
    const body = await readBody({ response, maxBytes });
    if (!body.ok) outcome = body;
    else outcome = success({ value: { status: response.status, body: body.value, ...requestId({ value: response.headers.get("request-id") }) } });
  } catch { outcome = failure({ code: "unavailable", message: "Google transport outcome is unknown" }); }
  observe({ observer: required.observer, input, outcome: outcome.ok ? "received" : outcome.error.code });
  return outcome;
}
async function readBody(required: { response: Response; maxBytes: number }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "invalid_input", message: "Empty Google response" });
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > required.maxBytes) { await reader.cancel(); return failure({ code: "limit_exceeded", message: "Google response exceeds payload bound" }); }
    chunks.push(chunk.value);
  }
  return parseExactIntegerJson({ text: Buffer.concat(chunks).toString("utf8") }, { numericTextKeys: ["conversions", "conversionsValue"] });
}
function requestId(required: { value: string | null }): { requestId?: string } {
  const parsed = parse<string>({ schema: id, input: required.value });
  return parsed.ok ? { requestId: parsed.value } : {};
}
function observe(required: { observer: ObserverPort; input: HttpRequest; outcome: string }): void {
  try { required.observer.observe({ operation: "google-ads.http", outcome: required.outcome, correlationId: required.input.context.correlationId, traceId: required.input.context.traceId, runId: required.input.context.runId }); }
  catch { /* Required audit is enforced by host authority; optional telemetry cannot rewrite a provider receipt. */ }
}

type ReadBinding = Pick<AccountBinding, "scope" | "connectionId" | "customerId">;
export type ReadDependencies = { binding: ReadBinding; transport: GoogleTransportPort; clock: ClockPort };
export const accountSchema = z.object({ id: z.string().regex(/^[1-9][0-9]{9}$/), currencyCode: metricBatchSchema.shape.currency, timeZone: metricBatchSchema.shape.timezone });

/** Normalize the two host context ABIs; typed failures contain no supplied values. */
export function readContext({ context }: { context: CallContext | ServiceContext }): Outcome<CallContext> {
  const service = serviceContextSchema.safeParse(context);
  if (!service.success) return parseBoundary({ schema: callContextSchema, input: context });
  const { serviceId, ...rest } = service.data;
  return parseBoundary({ schema: callContextSchema, input: { ...rest, principal: { kind: "service", serviceId } } });
}

/** Metadata is read even for empty reports. Never accept currency/timezone from install settings.
 * O(1) projection; one bounded customer search, explicit missing/foreign metadata failures.
 */
export async function readAccount(required: { dependencies: ReadDependencies; context: CallContext }, optional?: CallOptions): Promise<Outcome<z.infer<typeof accountSchema>>> {
  const response = await search({ ...required, query: "SELECT customer.id, customer.currency_code, customer.time_zone FROM customer LIMIT 2" }, optional);
  if (!response.ok) return response;
  if (!response.value.complete || response.value.rows.length !== 1) return failure({ code: "unavailable", message: "Google account metadata unavailable" });
  const account = parseBoundary({ schema: accountSchema, input: response.value.rows[0].customer });
  if (!account.ok) return account;
  if (account.value.id !== required.dependencies.binding.customerId) return failure({ code: "forbidden", message: "Foreign Google account metadata" });
  return account;
}

/** One bounded search through the existing transport, preserving cancellation and typed failures. */
export async function search(required: { dependencies: ReadDependencies; context: CallContext; query: string }, optional?: CallOptions): Promise<ReturnType<typeof metricSearchRows>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google read cancelled" });
  const result = await required.dependencies.transport.request({ method: "search", context: required.context, operationId: required.context.correlationId, body: { query: required.query } });
  if (!result.ok) return result;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Google read cancelled" });
  return metricSearchRows({ value: result.value });
}
