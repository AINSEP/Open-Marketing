import type { ObserverPort, Outcome } from "@open-marketing/contracts";
import { failure, parse, success, id, numericId, object, text } from "./schema.ts";
import { bindingSchema } from "./schemas.ts";
import type { AccountBinding, CredentialPort, GoogleTransportPort, HttpPort, VendorRequest } from "./types.ts";

/** Tokenless v25 access uses the Cloud project owning the OAuth credentials.
 * Credential lookup and HTTPS stay inside the server/plugin path. No retry.
 * @example createGoogleRestTransport({ binding, credentials, http }) */
export function createGoogleRestTransport(required: { binding: AccountBinding; credentials: CredentialPort; http: HttpPort }): GoogleTransportPort {
  return { request: input => restRequest({ ...required, input }) };
}
async function restRequest(required: { binding: AccountBinding; credentials: CredentialPort; http: HttpPort; input: VendorRequest }): Promise<Outcome<unknown>> {
  const binding = parse<AccountBinding>({ schema: bindingSchema, input: required.binding });
  if (!binding.ok) return binding;
  const credential = await required.credentials.access({ binding: binding.value });
  if (!credential.ok) return credential;
  const checked = parse<{ accessToken: string; loginCustomerId?: string }>({ schema: object({ properties: { accessToken: { ...text, maxLength: 4096, pattern: "^[^\\r\\n]+$" }, loginCustomerId: { ...numericId, minLength: 10, maxLength: 10 } }, optional: ["loginCustomerId"] }), input: credential.value });
  if (!checked.ok) return checked;
  const headers: Record<string, string> = { Authorization: "Bearer " + checked.value.accessToken, "Content-Type": "application/json" };
  if (checked.value.loginCustomerId) headers["login-customer-id"] = checked.value.loginCustomerId;
  const suffix = endpoint({ method: required.input.method });
  const response = await required.http.post({ url: `https://googleads.googleapis.com/v25/customers/${binding.value.customerId}/${suffix}`, headers, body: JSON.stringify(required.input.body), timeoutMs: 15000, maxBytes: 1048576, context: required.input.context, operationId: required.input.operationId });
  if (!response.ok) return response;
  if (response.value.status < 200 || response.value.status >= 300) return failure({ code: "unavailable", message: "Google Ads request failed; reconciliation may be required" });
  return success({ value: response.value.body });
}
function endpoint(required: { method: VendorRequest["method"] }): string {
  switch (required.method) {
    case "search": return "googleAds:search";
    case "mutate": return "googleAds:mutate";
    case "upload": return "conversionUploads:uploadClickConversions";
    default: { const exhaustive: never = required.method; return exhaustive; }
  }
}
/** Real bounded HTTP adapter. Inject fetch; redirects, retries and credential logging
 * are disabled. Network/parse errors return unavailable, never remote success.
 * @complexity O(b), b<=1MiB; one request with a 15s maximum deadline.
 * @example createHttpAdapter({ fetch: hostFetch, observer }) */
export function createHttpAdapter(required: { fetch: typeof fetch; observer: ObserverPort }): HttpPort {
  return { post: input => post({ ...required, input }) };
}
async function post(required: { fetch: typeof fetch; observer: ObserverPort; input: Parameters<HttpPort["post"]>[0] }): Promise<Outcome<{ status: number; body: unknown; requestId?: string }>> {
  const { input } = required;
  if (!/^https:\/\/googleads\.googleapis\.com\/v25\/customers\/[0-9]{10}\/(googleAds:(search|mutate)|conversionUploads:uploadClickConversions)$/.test(input.url)) return failure({ code: "forbidden", message: "HTTP destination is outside Google plugin scope" });
  if (Buffer.byteLength(input.body) > input.maxBytes) return failure({ code: "limit_exceeded", message: "Vendor request exceeds payload bound" });
  let outcome: Outcome<{ status: number; body: unknown; requestId?: string }>;
  try {
    const response = await required.fetch(input.url, { method: "POST", headers: input.headers, body: input.body, redirect: "error", signal: AbortSignal.timeout(Math.min(input.timeoutMs, 15000)) });
    const body = await readBody({ response, maxBytes: Math.min(input.maxBytes, 1048576) });
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
function observe(required: { observer: ObserverPort; input: Parameters<HttpPort["post"]>[0]; outcome: string }): void {
  try { required.observer.observe({ operation: "google-ads.http", outcome: required.outcome, correlationId: required.input.context.correlationId, traceId: required.input.context.traceId, runId: required.input.context.runId }); }
  catch { /* Telemetry cannot reclassify a transmitted write. Required audit belongs to host dispatch. */ }
}
