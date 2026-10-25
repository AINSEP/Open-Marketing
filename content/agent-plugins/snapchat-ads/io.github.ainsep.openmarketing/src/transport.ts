import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, parseBoundary, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, decodeList, encodeCommand, failure, vendorId } from "./commands.js";
import { decodeReport, reportWindowValid } from "./reporting.js";
import type { SnapchatAdsAdapter, SnapchatConfiguration, SnapchatDependencies, SnapchatInvocation, SnapchatResult, SnapchatWireRequest } from "./ports.js";
/** Shared internal binding parser; the sole public module does not expose wire helpers. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId.nullable(), currency: z.string().regex(/^[A-Z]{3}$/),
  timezone: z.string().min(1).max(100), apiVersion: z.literal("v1"), pluginDigest: digestSchema });
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
type Prepared = { invocation: SnapchatInvocation; configuration: SnapchatConfiguration; request: SnapchatWireRequest; ownershipId?: string };
type Credential = z.infer<typeof credentialSchema>;

/** Create an inert read adapter. Credentials resolve per request before the existing server fence.
 * @param required - Binding, admission and injected server policy/token/fetch/clock/observer ports.
 * @returns Typed failures or projected pages/reports; no raw provider errors or tokens escape.
 * @example createSnapchatAdsAdapter({ configuration, admitted, gateway, credentials, fetch: guardedFetch, clock, observer })
 * @complexity O(b) time/space, b<=1MiB; one 15s GET, or two for campaign ownership + stats; no retry. */
export function createSnapchatAdsAdapter(required: SnapchatDependencies): SnapchatAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { async invoke(input, options = {}) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    const command = prepared.value.invocation.command;
    if (command.kind === "report" && command.campaignId) {
      const ownership = await dispatch({ dependencies, prepared: { ...prepared.value, ownershipId: command.campaignId,
        request: { method: "GET", url: "https://adsapi.snapchat.com/v1/campaigns/" + command.campaignId } } }, options);
      if (!ownership.ok) return ownership;
    }
    return dispatch({ dependencies, prepared: prepared.value }, options);
  } };
}
/** Closed, bounded invocation and binding validation before any credential lookup or network I/O. */
function prepare(required: { dependencies: SnapchatDependencies; input: SnapchatInvocation }, optional: CallOptions): Outcome<Prepared> {
  if (!required.dependencies.admitted) return failure({ code: "forbidden" });
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: invocationSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const configuration = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  const bound = configuration.value;
  const valid = validateBinding({ invocation: parsed.value, configuration: bound });
  if (!valid.ok) return valid;
  return { ok: true, value: { invocation: parsed.value, configuration: bound, request: encodeCommand({ command: parsed.value.command, configuration: bound }) } };
}
function validateBinding(required: { invocation: SnapchatInvocation; configuration: SnapchatConfiguration }): Outcome<void> {
  const scope = required.invocation.context.scope, bound = required.configuration;
  if (scope.ownerId !== bound.scope.ownerId || scope.workspaceId !== bound.scope.workspaceId) return failure({ code: "forbidden" });
  const command = required.invocation.command;
  if (bound.accountId === null && !["list_organizations", "list_accounts"].includes(command.kind)) return failure({ code: "forbidden" });
  if (command.kind === "report" && !reportWindowValid({ command, timezone: bound.timezone })) return failure({ code: "invalid_input" });
  return { ok: true, value: undefined };
}
/** Copy JSON before awaiting host callbacks; cycles/oversize inputs return typed failures. O(b<=64KiB). */
export function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const text = JSON.stringify(required.input);
    if (text === undefined || Buffer.byteLength(text) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}
/** Broker failures/exceptions are sanitized. A repeated execute callback cannot send twice;
 * the server's guarded fetch owns current admission/account/connection rechecks at actual egress. */
async function dispatch(required: { dependencies: SnapchatDependencies; prepared: Prepared }, optional: CallOptions): Promise<Outcome<SnapchatResult>> {
  const { dependencies, prepared } = required;
  let sent = false;
  let result: Outcome<SnapchatResult>;
  try {
    const credential = await resolveCredential({ dependencies, configuration: prepared.configuration }, optional);
    if (!credential.ok) result = credential;
    else result = await dependencies.gateway.dispatch({ context: prepared.invocation.context, configuration: structuredClone(prepared.configuration),
      operation: prepared.invocation.command.kind, request: Object.freeze({ ...prepared.request }),
      effect: { operationId: prepared.invocation.operationId, connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId,
        effects: ["read"], moneyExposure: null, requiredLimit: null,
        argumentsDigest: createHash("sha256").update(JSON.stringify({ apiVersion: "v1", request: prepared.request })).digest("hex") },
      execute: async () => {
        if (sent) return failure({ code: "conflict" });
        const checked = beforeEgress({ dependencies, credential: credential.value }, optional);
        if (!checked.ok) return checked;
        sent = true;
        return send({ dependencies, prepared, credential: credential.value }, optional);
      } }, optional);
  } catch { result = failure({ code: "unavailable" }); }
  observe({ dependencies, prepared, result });
  return result;
}
/** Per-call broker lookup with schema validation; callers redact thrown broker faults. O(1) I/O. */
export async function resolveCredential(required: { dependencies: Pick<SnapchatDependencies, "credentials">; configuration: SnapchatConfiguration }, optional: CallOptions): Promise<Outcome<Credential>> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const result = await required.dependencies.credentials.access({ connectionId: required.configuration.connectionId, accountId: required.configuration.accountId }, optional);
  if (!result.ok) return failure({ code: result.error.code });
  return parseBoundary({ schema: credentialSchema, input: result.value });
}
/** Local admission/cancellation/expiry checks; guarded fetch owns current server authority. O(1). */
export function beforeEgress(required: { dependencies: Pick<SnapchatDependencies, "admitted" | "clock">; credential: Credential }, optional: CallOptions): Outcome<void> {
  if (!required.dependencies.admitted) return failure({ code: "forbidden" });
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  const now = required.dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (required.credential.expiresAt !== undefined && now >= required.credential.expiresAt) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}
/** One fixed GET, 15s deadline, no redirects/retries; streamed byte cap applies without Content-Length. */
async function send(required: { dependencies: SnapchatDependencies; prepared: Prepared; credential: Credential }, optional: CallOptions): Promise<Outcome<SnapchatResult>> {
  const deadline = AbortSignal.timeout(15000);
  const signal = optional.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  try {
    const response = await required.dependencies.fetch(required.prepared.request.url, { method: "GET", redirect: "error", signal,
      headers: { Authorization: "Bearer " + required.credential.accessToken, Accept: "application/json" } });
    if (response.status !== 200) { await response.body?.cancel(); return rejection({ status: response.status }); }
    const body = await readBody({ response });
    if (!body.ok) return body;
    if (optional.signal?.aborted) return failure({ code: "cancelled" });
    return decode({ ...required, body: body.value });
  } catch { return failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
}
function rejection(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
/** O(b) bytes/time/space, b<=1MiB. Malformed JSON and size failures never expose response bytes. */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}
function decode(required: { dependencies: SnapchatDependencies; prepared: Prepared; body: unknown }): Outcome<SnapchatResult> {
  const { invocation, configuration } = required.prepared;
  const retrievedAt = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(retrievedAt).success) return failure({ code: "invalid_input" });
  const data = invocation.command.kind === "report" && !required.prepared.ownershipId
    ? decodeReport({ body: required.body, command: invocation.command, configuration, retrievedAt })
    : decodeList({ ...required.prepared, body: required.body, command: invocation.command });
  return data.ok ? { ok: true, value: { operationId: invocation.operationId, status: "succeeded", observedState: "unknown", data: data.value } } : data;
}
/** IDs/outcome only; the host owns pre-egress audit. Telemetry failure cannot change a receipt. */
function observe(required: { dependencies: SnapchatDependencies; prepared: Prepared; result: Outcome<SnapchatResult> }): void {
  const context = required.prepared.invocation.context;
  try { required.dependencies.observer.observe({ operation: "snapchat-ads." + required.prepared.invocation.command.kind,
    outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Existing host audit remains authoritative. */ }
}

/** Private shared deployment/CAPI transport. Fixed callers supply URLs/body; query auth is CAPI-only.
 * @returns Bounded status/body or sanitized failure; writes treat every failure as uncertain.
 * @complexity O(b) time/space, b<=1MiB response, <=64KiB request; one <=15s fetch, no retry.
 */
export async function requestSnapchat(required: { fetch: typeof fetch; credential: Credential;
  request: { url: string; method: "GET" | "POST"; body?: string; authentication?: "query" } }, optional: CallOptions = {}): Promise<Outcome<{ status: number; body: unknown }>> {
  if (optional.signal?.aborted) return failure({ code: "cancelled" });
  if (Buffer.byteLength(required.request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const deadline = AbortSignal.timeout(15000);
  const signal = optional.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  const url = new URL(required.request.url);
  const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" };
  if (required.request.authentication === "query") url.searchParams.set("access_token", required.credential.accessToken);
  else headers.Authorization = "Bearer " + required.credential.accessToken;
  try {
    const response = await required.fetch(url.href, { method: required.request.method, body: required.request.body, headers, signal, redirect: "error" });
    const body = await readBody({ response });
    return body.ok ? { ok: true, value: { status: response.status, body: body.value } } : body;
  } catch { return failure({ code: optional.signal?.aborted ? "cancelled" : "unavailable" }); }
}
