/** Fixed-origin GET transport. Credentials, fetch and deadline creation belong to the host. */
import { parseBoundary } from "@open-marketing/contracts";
import type { AppError, CallOptions, ObserverPort, Outcome } from "@open-marketing/contracts";
import { bindingSchema, contextSchema, credentialSchema, dailyMetrics, requestSchema } from "./schemas.ts";
import type { Binding, Context, Credential, GoogleRequest } from "./schemas.ts";

export interface CredentialPort {
  /** Server owns storage/refresh. Must honor signal; never returns credentials to the agent. */
  access(required: { context: Context; connectionId: string; signal: AbortSignal }): Promise<Outcome<Credential>>;
}
export interface DeadlinePort {
  /** Return a signal bounded by timeoutMs and the caller's signal, without extending either. */
  signal(required: { timeoutMs: number; signal?: AbortSignal }): AbortSignal;
}
export interface TransportDependencies { fetch: typeof fetch; credentials: CredentialPort; deadline: DeadlinePort; observer: ObserverPort }

/** Read one bound Google resource; <=1 MiB, 15 seconds, no redirects or retries.
 * Returns sanitized typed errors, never vendor error bodies/tokens. O(b) time/space, b<=1 MiB.
 * @example readGoogleJson({ ...host, binding, context, request: { kind: "locations" } })
 */
export async function readGoogleJson(required: TransportDependencies & { binding: Binding; context: Context; request: GoogleRequest }, optional: CallOptions = {}): Promise<Outcome<unknown>> {
  const binding = parseBoundary({ schema: bindingSchema, input: required.binding });
  const context = parseBoundary({ schema: contextSchema, input: required.context });
  const request = parseBoundary({ schema: requestSchema, input: required.request });
  if (!binding.ok) return binding;
  if (!context.ok) return context;
  if (!request.ok) return request;
  if (!sameScope({ binding: binding.value, context: context.value })) return failure({ code: "forbidden", message: "GBP binding scope mismatch" });
  const signal = required.deadline.signal({ timeoutMs: 15000, signal: optional.signal });
  const result = await performGet({ ...required, binding: binding.value, context: context.value, request: request.value, signal }, optional);
  required.observer.observe({ operation: `google-business-profile.${request.value.kind}`, outcome: result.ok ? "ok" : result.error.code, correlationId: context.value.correlationId, traceId: context.value.traceId, ...("runId" in context.value ? { runId: context.value.runId } : {}) });
  return result;
}
/** Pure scope check shared by plugin and transport; constant time/space. */
export function sameScope({ binding, context }: { binding: Binding; context: Context }): boolean {
  return binding.scope.ownerId === context.scope.ownerId && binding.scope.workspaceId === context.scope.workspaceId;
}
/** O(1) construction with fixed origins and schema-validated resource names. */
function requestUrl({ binding, request }: { binding: Binding; request: GoogleRequest }): URL {
  if (request.kind === "locations") {
    const url = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${binding.accountName}/locations`);
    url.searchParams.set("readMask", "name,title");
    url.searchParams.set("pageSize", "100");
    if (request.pageToken) url.searchParams.set("pageToken", request.pageToken);
    return url;
  }
  const url = new URL(`https://businessprofileperformance.googleapis.com/v1/${binding.locationName}:fetchMultiDailyMetricsTimeSeries`);
  for (const metric of dailyMetrics) url.searchParams.append("dailyMetrics", metric);
  addDate({ url, prefix: "start_date", day: request.days.start });
  addDate({ url, prefix: "end_date", day: new Date(Date.parse(request.days.end) - 86400000).toISOString().slice(0, 10) });
  return url;
}
function addDate({ url, prefix, day }: { url: URL; prefix: string; day: string }): void {
  const [year, month, dayOfMonth] = day.split("-");
  url.searchParams.set(`dailyRange.${prefix}.year`, String(Number(year)));
  url.searchParams.set(`dailyRange.${prefix}.month`, String(Number(month)));
  url.searchParams.set(`dailyRange.${prefix}.day`, String(Number(dayOfMonth)));
}
/** Credential/fetch exceptions are contained here; injected adapters must honor signal. */
async function performGet(required: TransportDependencies & { binding: Binding; context: Context; request: GoogleRequest; signal: AbortSignal }, optional: CallOptions): Promise<Outcome<unknown>> {
  try {
    required.signal.throwIfAborted();
    const access = await required.credentials.access({ context: required.context, connectionId: required.binding.connectionId, signal: required.signal });
    required.signal.throwIfAborted();
    if (!access.ok) return failure({ code: access.error.code, message: "GBP credentials unavailable; reconnect or configure the server" });
    const token = parseBoundary({ schema: credentialSchema, input: access.value });
    if (!token.ok) return failure({ code: "unauthenticated", message: "Invalid GBP credentials; reconnect" });
    required.signal.throwIfAborted();
    const url = requestUrl(required);
    const response = await required.fetch(url, { method: "GET", redirect: "error", signal: required.signal, headers: { Authorization: `Bearer ${token.value.accessToken}`, Accept: "application/json" } });
    const rejected = responseFailure({ response, url });
    if (rejected) { void response.body?.cancel().catch(() => {}); return rejected; }
    return await readBody({ response, signal: required.signal });
  } catch {
    if (optional.signal?.aborted) return failure({ code: "cancelled", message: "GBP read cancelled" });
    if (required.signal.aborted) return failure({ code: "expired", message: "GBP read deadline exceeded" });
    return failure({ code: "unavailable", message: "GBP transport or JSON response unavailable" });
  }
}
/** Stream cap applies to decoded bytes even without Content-Length; abort cancels stalled bodies. */
export async function readBody({ response, signal }: { response: Response; signal: AbortSignal }): Promise<Outcome<unknown>> {
  if (!response.body) return failure({ code: "unavailable", message: "Empty GBP response" });
  const reader = response.body.getReader();
  const cancel = (): void => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    signal.throwIfAborted();
    let part = await reader.read();
    while (!part.done) {
      size += part.value.byteLength;
      if (size > 1048576) { cancel(); return failure({ code: "limit_exceeded", message: "GBP response exceeds 1 MiB" }); }
      chunks.push(part.value);
      part = await reader.read();
    }
    signal.throwIfAborted();
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } finally { signal.removeEventListener("abort", cancel); cancel(); reader.releaseLock(); }
}
/** Reject redirects before parsing; caller cancels rejected bodies without reading vendor errors. */
export function responseFailure({ response, url }: { response: Response; url: URL }): Outcome<never> | undefined {
  if (response.redirected || response.url && response.url !== url.href) return failure({ code: "forbidden", message: "GBP redirect rejected" });
  if (!response.ok) return httpFailure({ status: response.status });
  return undefined;
}
/** Constant HTTP failure mapping shared by native reads and publishing; no vendor body is read. */
export function httpFailure({ status }: { status: number }): Outcome<never> {
  if (status === 401) return failure({ code: "unauthenticated", message: "GBP sign-in expired; reconnect" });
  if (status === 403) return failure({ code: "forbidden", message: "GBP access denied; check project approval and profile access" });
  if (status >= 300 && status < 400) return failure({ code: "forbidden", message: "GBP redirect rejected" });
  return failure({ code: "unavailable", message: "GBP request failed" });
}
/** Stable failure constructor; messages must be plugin-owned, never vendor text. */
export function failure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}
