import type { ObserverPort, Outcome } from "@open-marketing/contracts";
import { failure, parse, success, id, numericId, object, text } from "./schema.ts";
import { bindingSchema } from "./schemas.ts";
import type { AccountBinding, CredentialPort, GoogleTransportPort, HttpPort, HttpRequest, VendorRequest } from "./types.ts";

const dataManagerScope = "https://www.googleapis.com/auth/datamanager";
/** OAuth credentials remain in the server/plugin path. Fixed Search and Data Manager
 * endpoints, per-advertiser scope/project lookup, no retries or legacy upload.
 * @example createGoogleRestTransport({ binding, credentials, http }) */
export function createGoogleRestTransport(required: { binding: AccountBinding; credentials: CredentialPort; http: HttpPort }): GoogleTransportPort {
  return { request: input => restRequest({ ...required, input }) };
}
/** Validate scoped credentials before choosing one fixed provider endpoint. */
async function restRequest(required: { binding: AccountBinding; credentials: CredentialPort; http: HttpPort; input: VendorRequest }): Promise<Outcome<unknown>> {
  const binding = parse<AccountBinding>({ schema: bindingSchema, input: required.binding });
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
/** Search-only hosts remain valid; ingestion requires a project and GET diagnostics.
 * Returns whether this request needs Data Manager OAuth. O(1) time/space. */
function checkDataManagerAccess(required: { input: VendorRequest; http: HttpPort }): Outcome<boolean> {
  const manager = required.input.method === "ingest" || required.input.method === "request_status";
  if (!manager) return success({ value: false });
  if (!required.http.get) return failure({ code: "unavailable", message: "Data Manager requires bounded GET diagnostics" });
  if (!parse({ schema: id, input: required.input.cloudProjectId }).ok) return failure({ code: "invalid_input", message: "Data Manager OAuth project is required" });
  return success({ value: true });
}
/** Tainted broker output must attest to the requested scope and OAuth project. */
function checkCredential(required: { credential: unknown; input: VendorRequest; manager: boolean }): Outcome<void> {
  const parsed = parse<{ accessToken: string; loginCustomerId?: string; scopes?: string[]; cloudProjectId?: string }>({ schema: object({ properties: {
    accessToken: { ...text, maxLength: 4096, pattern: "^[^\\r\\n]+$" }, loginCustomerId: { ...numericId, minLength: 10, maxLength: 10 },
    developerToken: { type: "string", pattern: "^[A-Za-z0-9]{22}$", minLength: 22, maxLength: 22 },
    scopes: { type: "array", items: { ...text, maxLength: 256 }, minItems: 1, maxItems: 32 }, cloudProjectId: id,
  }, optional: ["loginCustomerId", "developerToken", "scopes", "cloudProjectId"] }), input: required.credential });
  if (!parsed.ok) return parsed;
  if (!required.manager) return success({ value: undefined });
  if (parsed.value.cloudProjectId !== required.input.cloudProjectId || !parsed.value.scopes?.includes(dataManagerScope)) return failure({ code: "forbidden", message: "Data Manager credential scope/project mismatch" });
  return success({ value: undefined });
}
/** Exactly one bounded POST or diagnostic GET. URL is never selected by tools.
 * POST googleAds:search is read-only by API contract, including reconciliation;
 * mutation uses the separate googleAds:mutate endpoint. */
async function sendRequest(required: { binding: AccountBinding; http: HttpPort; input: VendorRequest; headers: Record<string, string> }): Promise<Outcome<{ status: number; body: unknown; requestId?: string }>> {
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
function endpoint(required: { binding: AccountBinding; method: Exclude<VendorRequest["method"], "request_status"> }): string {
  switch (required.method) {
    case "search": return `https://googleads.googleapis.com/v25/customers/${required.binding.customerId}/googleAds:search`;
    case "mutate": return `https://googleads.googleapis.com/v25/customers/${required.binding.customerId}/googleAds:mutate`;
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
  if (required.method === "POST") return /^https:\/\/googleads\.googleapis\.com\/v25\/customers\/[0-9]{10}\/googleAds:(search|mutate)$/.test(required.url) || required.url === "https://datamanager.googleapis.com/v1/events:ingest";
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
  return success({ value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown });
}
function requestId(required: { value: string | null }): { requestId?: string } {
  const parsed = parse<string>({ schema: id, input: required.value });
  return parsed.ok ? { requestId: parsed.value } : {};
}
function observe(required: { observer: ObserverPort; input: HttpRequest; outcome: string }): void {
  try { required.observer.observe({ operation: "google-ads.http", outcome: required.outcome, correlationId: required.input.context.correlationId, traceId: required.input.context.traceId, runId: required.input.context.runId }); }
  catch { /* Required audit is enforced by host authority; optional telemetry cannot rewrite a provider receipt. */ }
}
