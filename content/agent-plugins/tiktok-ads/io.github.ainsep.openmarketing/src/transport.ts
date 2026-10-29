import { z } from "zod";
import { callContextSchema, idSchema, parseBoundary, parseExactIntegerJson, serviceContextSchema } from "@open-marketing/contracts";
import type { CallOptions, ObserverPort, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { decodeTikTokAcknowledgement, decodeTikTokRead, encodeTikTokCommand, failure, tiktokCommandSchema, tiktokHaltCommandSchema, tiktokStatus, vendorIdSchema } from "./commands.js";
import type { TikTokEncoded, TikTokReadCommand } from "./commands.js";
import { tiktokEventsPayloadSchema } from "./events-payload.js";
import type { TikTokCredentialPort, TikTokEgressPort, TikTokEgressRequest } from "./ports.js";

// Access-Token confirmed by TikTok-owned SDK source; admission:false covers the
// fixture-labelled UNVERIFIED response shapes recorded in primary-sources.json.
const vendor = { baseUrl: "https://business-api.tiktok.com/open_api/v1.3/", tokenHeader: "Access-Token" } as const;
const timeoutMs = 15000;
const maxBytes = 1048576;
const egressCommandSchema = z.union([tiktokCommandSchema, tiktokHaltCommandSchema, z.strictObject({ kind: z.literal("track-event"), payload: tiktokEventsPayloadSchema })]);
const inputSchema = z.strictObject({ context: z.union([callContextSchema, serviceContextSchema]), connectionId: idSchema, accountId: vendorIdSchema, operationId: idSchema, request: egressCommandSchema, isCurrent: z.custom<() => boolean>(value => typeof value === "function") });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7E]+$/) });
type Dependencies = { fetch: typeof fetch; credentials: TikTokCredentialPort; observer: ObserverPort };

/** Project canonical call-scoped credentials onto the strict transport credential shape.
 * Context belongs to the host; expiry/secrets never enter vendor codecs. O(1), no cache.
 * @example createTikTokCredentials({ credentials: dependencies.credentials })
 */
export function createTikTokCredentials(required: Pick<PluginCapabilityDependencies, "credentials">): TikTokCredentialPort {
  return { async access(input, options) {
    const access = await required.credentials.access({ connectionId: input.connectionId, accountId: input.accountId }, options);
    return access.ok ? { ok: true, value: { accessToken: access.value.accessToken } } : access;
  } };
}

/** Server supplies fetch/credentials/observer; import and construction perform no I/O.
 * One GET/POST, no redirects or retries, 15s deadline and 1 MiB response ceiling.
 * @example createTikTokFetchEgress({ fetch: hostFetch, credentials, observer })
 * @complexity Each send is O(b+n) time/space, b <= 1 MiB, n <= 100 rows.
 */
export function createTikTokFetchEgress(required: Dependencies): TikTokEgressPort {
  return { send: (input, options) => observedSend({ dependencies: required, input }, options) };
}

/** Opaque broker/fetch errors become redacted typed values; telemetry never erases a result. */
async function observedSend(required: { dependencies: Dependencies; input: TikTokEgressRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const parsed = parseBoundary({ schema: inputSchema, input: required.input });
  if (!parsed.ok) return parsed;
  let result: Outcome<unknown>;
  try { result = await send({ dependencies: required.dependencies, input: parsed.value }, optional); }
  catch (error) { result = refusedBeforeEgress({ error }) ? failure({ code: "forbidden", message: "TikTok request refused before any network call" }) : failure({ code: "unavailable", message: "TikTok transport failed" }); }
  const context = parsed.value.context;
  try { required.dependencies.observer.observe({ operation: "tiktok-ads.http", outcome: result.ok ? "received" : result.error.code, correlationId: context.correlationId, traceId: context.traceId, ...("runId" in context ? { runId: context.runId } : {}) }); }
  catch { /* The host owns durable audit; telemetry cannot rewrite the provider result. */ }
  return result;
}

/** The host fetch guard marks refusals raised before native fetch; only those prove nothing was sent. O(1). */
function refusedBeforeEgress(required: { error: unknown }): boolean {
  return typeof required.error === "object" && required.error !== null && (required.error as { refusedBeforeEgress?: unknown }).refusedBeforeEgress === true;
}

/** Credential resolution consumes the same deadline; revoke/cancel before fetch means zero egress. */
async function send(required: { dependencies: Dependencies; input: TikTokEgressRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { input, dependencies } = required;
  const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(optional?.signal ? [optional.signal] : [])]);
  const ready = checkFence({ input, signal });
  if (!ready.ok) return ready;
  const encoded = encodeTikTokEgress({ input: input.request, accountId: input.accountId });
  if (!encoded.ok) return encoded;
  const access = await dependencies.credentials.access({ context: input.context, connectionId: input.connectionId, accountId: input.accountId }, { signal });
  if (!access.ok) return failure({ code: access.error.code, message: "TikTok credentials unavailable" });
  const credential = parseBoundary({ schema: credentialSchema, input: access.value });
  if (!credential.ok) return credential;
  const current = checkFence({ input, signal });
  if (!current.ok) return current;
  if (encoded.value.method === "GET") {
    const body = await requestTikTokRead({ fetch: dependencies.fetch, wire: encoded.value, token: credential.value.accessToken }, { signal });
    return body.ok ? decodeTikTokRead({ input: body.value, command: input.request as TikTokReadCommand, accountId: input.accountId }) : body;
  }
  const response = await fetchOnce({ dependencies, wire: encoded.value, token: credential.value.accessToken, signal });
  return receiveWrite({ response });
}

/** Narrow wrapper around fetch's foreign ABI; fixed URL and token header, never redirects. O(b). */
async function fetchOnce(required: { dependencies: Pick<Dependencies, "fetch">; wire: TikTokEncoded | { method: "POST"; path: "event/track/"; body: Record<string, unknown> }; token: string; signal?: AbortSignal }): Promise<Response> {
  const { wire, token, signal, dependencies } = required;
  const url = vendor.baseUrl + wire.path + (wire.method === "GET" ? "?" + new URLSearchParams(wire.parameters).toString() : "");
  return dependencies.fetch(url, { method: wire.method, headers: { [vendor.tokenHeader]: token, Accept: "application/json", ...(wire.method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(wire.method === "POST" ? { body: JSON.stringify(wire.body) } : {}), redirect: "error", signal });
}

/** POST receipts use the original acknowledgement decoder; malformed receipts stay uncertain. */
async function receiveWrite(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.ok) {
    await required.response.body?.cancel();
    return failure({ code: "unavailable", message: "TikTok HTTP request rejected" });
  }
  const body = await readBody(required);
  if (!body.ok) return failure({ code: "unavailable", message: "TikTok write receipt unknown" });
  const acknowledgement = decodeTikTokAcknowledgement({ input: body.value });
  return acknowledgement.ok ? acknowledgement : failure({ code: "unavailable", message: "TikTok write receipt unknown" });
}

/** Closed backend routes reuse the same credentialed transport; no arbitrary URL/body.
 * O(n) bounded schema validation; stop <=100 IDs, Events exactly one digest-only web event.
 */
export function encodeTikTokEgress(required: { input: unknown; accountId: string }): Outcome<TikTokEncoded | { method: "POST"; path: "event/track/"; body: Record<string, unknown> }> {
  const account = parseBoundary({ schema: vendorIdSchema, input: required.accountId });
  if (!account.ok) return account;
  const parsed = parseBoundary({ schema: egressCommandSchema, input: required.input });
  if (!parsed.ok) return parsed;
  if (parsed.value.kind === "track-event") return { ok: true, value: { method: "POST", path: "event/track/", body: parsed.value.payload } };
  if (parsed.value.kind === "halt-stop") return { ok: true, value: { method: "POST", path: "campaign/status/update/", body: { advertiser_id: account.value, campaign_ids: parsed.value.campaignIds, operation_status: tiktokStatus.disabled } } };
  return encodeTikTokCommand({ input: parsed.value, accountId: account.value });
}

function checkFence(required: { input: TikTokEgressRequest; signal: AbortSignal }): Outcome<void> {
  if (required.signal.aborted) return failure({ code: "cancelled", message: "TikTok call cancelled or timed out" });
  if (!required.input.isCurrent()) return failure({ code: "forbidden", message: "TikTok dispatch authority withdrawn" });
  return { ok: true, value: undefined };
}

/** Count bytes while streaming, including when Content-Length is absent or false.
 * @complexity O(b) time/space; at most 1 MiB retained, plus the current fetch chunk.
 */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "invalid_input", message: "TikTok response is empty" });
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return failure({ code: "limit_exceeded", message: "TikTok response exceeds 1 MiB" });
      }
      chunks.push(chunk.value);
    }
    const parsed = parseExactIntegerJson({ text: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) });
    return parsed.ok ? parsed : failure({ code: "invalid_input", message: "TikTok response is incomplete or invalid JSON" });
  } catch { return failure({ code: "invalid_input", message: "TikTok response is incomplete or invalid JSON" }); }
  finally { reader.releaseLock(); }
}

/** Shared GET edge for existing reads and canonical handlers. Caller owns the invocation deadline.
 * One fixed-origin GET, no redirects/retries, <=1 MiB body; explicit cancelled/unavailable errors.
 * @example requestTikTokRead({ fetch: guardedFetch, wire, token }, { signal })
 */
export async function requestTikTokRead(required: { fetch: typeof fetch; wire: Extract<TikTokEncoded, { method: "GET" }>; token: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "TikTok read cancelled" });
  const signal = optional?.signal;
  try {
    const response = await fetchOnce({ dependencies: { fetch: required.fetch }, wire: required.wire, token: required.token, signal });
    if (!response.ok) { await response.body?.cancel(); return failure({ code: "unavailable", message: "TikTok HTTP read rejected" }); }
    return await readBody({ response });
  } catch { return failure({ code: signal?.aborted ? "cancelled" : "unavailable", message: "TikTok read failed" }); }
}
