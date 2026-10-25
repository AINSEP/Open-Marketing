import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome } from "@open-marketing/contracts";
import { decodeList, encodeCommand, failure, loginSchema, vendorId, yandexDirectCommandSchema } from "./commands.js";
import type { ParsedCommand, YandexDirectCommand, YandexDirectRequest } from "./commands.js";
import { decodeReport } from "./reporting.js";

const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId.optional(), clientLogin: loginSchema.optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), apiVersion: z.literal("v501"), pluginDigest: digestSchema, bindingId: idSchema });
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: yandexDirectCommandSchema, moneyExposure: z.null(), requiredLimit: z.null() });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
/** Host-owned binding. Discovery may omit account; all campaign/report calls require ID/login/currency. */
export type YandexDirectConfiguration = z.infer<typeof configurationSchema>;
/** Read-only host invocation; write/spend metadata cannot be supplied. */
export interface YandexDirectInvocation { readonly context: CallContext; readonly operationId: string; readonly command: YandexDirectCommand; readonly moneyExposure: null; readonly requiredLimit: null }
/** Sanitized reads only; entity states remain provider data, never a serving acknowledgement. */
export interface YandexDirectReadResult { readonly operationId: string; readonly status: "succeeded"; readonly observedState: "unknown"; readonly data: unknown }
/** Inert adapter; at most one bounded vendor call per invocation and no retries. */
export interface YandexDirectAdapter { invoke(required: YandexDirectInvocation, optional?: CallOptions): Promise<Outcome<YandexDirectReadResult>> }
/** Server rechecks live admission, connection, scope, bound ID/login/currency and read authority
 * AFTER credential lookup. Hold its safety fence through execute (existing zero-argument ABI).
 * Server owns rate limiting, durable operation identity and append-only egress audit. */
export interface YandexDirectDependencies {
  readonly configuration: YandexDirectConfiguration; readonly admitted: () => boolean;
  readonly credentials: { access(required: { connectionId: string; accountId?: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number }>> };
  readonly gateway: { dispatch(required: { context: CallContext; configuration: YandexDirectConfiguration; operation: YandexDirectCommand["kind"]; request: YandexDirectRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<YandexDirectReadResult>> }, optional?: CallOptions): Promise<Outcome<YandexDirectReadResult>> };
  /** Host creates a fresh signal that aborts after milliseconds, covering fetch and body reads. */
  readonly createDeadline: (required: { milliseconds: number }) => AbortSignal;
  readonly fetch: typeof fetch; readonly clock: ClockPort; readonly observer: ObserverPort;
}
type Prepared = { configuration: YandexDirectConfiguration; context: CallContext; operationId: string; command: ParsedCommand; request: YandexDirectRequest; effect: EffectEnvelope };

/** No import/factory I/O. Admission is checked before credentials and again at actual egress.
 * @example createYandexDirectAdapter({ configuration, admitted, credentials, gateway, createDeadline, fetch, clock, observer })
 * @complexity O(b+n*m) bounded parsing, <=64KiB input, <=1MiB response, one 15s call. */
export function createYandexDirectAdapter(required: YandexDirectDependencies): YandexDirectAdapter {
  const dependencies = { ...required, configuration: { ...required.configuration, scope: { ...required.configuration.scope } } };
  return { async invoke(input, options) {
    try {
      if (!dependencies.admitted()) return failure({ code: "forbidden" });
      if (options?.signal?.aborted) return failure({ code: "cancelled" });
      const prepared = prepare({ input, configuration: dependencies.configuration });
      if (!prepared.ok) return prepared;
      // Opaque credential/gateway exceptions are boundary failures, still observable without text.
      const result = await dispatch({ dependencies, prepared: prepared.value }, options).catch(() => failure({ code: "unavailable" }));
      observe({ dependencies, prepared: prepared.value, result });
      return result;
    } catch { return failure({ code: "unavailable" }); }
  } };
}
/** Snapshot and validate before asynchronous work; user data never selects identity or egress.
 * @complexity O(b) time/space, input <=64KiB; no effects. */
function prepare(required: { input: YandexDirectInvocation; configuration: YandexDirectConfiguration }): Outcome<Prepared> {
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const invocation = invocationSchema.safeParse(bounded.value);
  const configuration = configurationSchema.safeParse(required.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const { context, operationId, command } = invocation.data;
  const config = configuration.data;
  if (context.scope.ownerId !== config.scope.ownerId || context.scope.workspaceId !== config.scope.workspaceId) return failure({ code: "forbidden" });
  if (command.kind !== "list_accounts" && (!config.accountId || !config.clientLogin || !config.currency)) return failure({ code: "invalid_input" });
  const request = encodeCommand({ command, clientLogin: config.clientLogin });
  const argumentsDigest = createHash("sha256").update(JSON.stringify({ configuration: config, request })).digest("hex");
  return { ok: true, value: { configuration: config, context, operationId, command, request, effect: { operationId, connectionId: config.connectionId, accountId: config.accountId ?? null, effects: ["read"], argumentsDigest, moneyExposure: null, requiredLimit: null } } };
}
/** Snapshot JSON before parsing; cyclic/non-JSON inputs fail before secrets or network access.
 * @complexity O(b) serialization, accepts <=64KiB. */
function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const serialized = JSON.stringify(required.input);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}
/** Token resolution precedes host authority check. One execute callback can send only once.
 * @complexity O(1) orchestration, one credential lookup, no retry or retained token. */
async function dispatch(required: { dependencies: YandexDirectDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<YandexDirectReadResult>> {
  const { dependencies, prepared } = required;
  const resolved = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, optional);
  if (!resolved.ok) return failure({ code: resolved.error.code });
  const credential = credentialSchema.safeParse(resolved.value);
  if (!credential.success) return failure({ code: "unauthenticated" });
  let sent = false;
  return dependencies.gateway.dispatch({ context: prepared.context, configuration: structuredClone(prepared.configuration), operation: prepared.command.kind,
    request: Object.freeze({ ...prepared.request }), effect: structuredClone(prepared.effect), execute: async () => {
      if (sent) return failure({ code: "conflict" });
      if (!dependencies.admitted()) return failure({ code: "forbidden" });
      if (optional?.signal?.aborted) return failure({ code: "cancelled" });
      const now = dependencies.clock.now({});
      if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
      if (credential.data.expiresAt !== undefined && now >= credential.data.expiresAt) return failure({ code: "expired" });
      sent = true;
      return send({ dependencies, prepared, token: credential.data.accessToken }, optional);
    } }, optional);
}
/** Fixed HTTPS request; redirects forbidden, injected deadline covers fetch and streamed body.
 * Catch only at the external edge; never return tainted vendor text. @complexity O(b), b<=1MiB. */
async function send(required: { dependencies: YandexDirectDependencies; prepared: Prepared; token: string }, optional?: CallOptions): Promise<Outcome<YandexDirectReadResult>> {
  try {
    const deadline = required.dependencies.createDeadline({ milliseconds: 15000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    const request = required.prepared.request;
    const response = await required.dependencies.fetch(request.url, { method: request.method, body: request.body, headers: { ...request.headers, Authorization: "Bearer " + required.token }, redirect: "error", signal });
    if (response.status !== 200) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
    const body = await readBody({ response });
    if (!body.ok) return body;
    const data = decode({ prepared: required.prepared, text: body.value, retrievedAt: required.dependencies.clock.now({}) });
    return data.ok ? { ok: true, value: { operationId: required.prepared.operationId, status: "succeeded", observedState: "unknown", data: data.value } } : data;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "unavailable" });
  }
}
/** Stream cap is authoritative even without Content-Length; cancel immediately on overflow.
 * @complexity O(b) time/space, b<=1MiB; no JSON parsing until bounded. */
async function readBody(required: { response: Response }): Promise<Outcome<string>> {
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
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } finally { reader.releaseLock(); }
}
/** Entity envelopes and TSV are distinct; HTTP 200 vendor errors are never success.
 * @complexity O(b+n*m) bounded validation; no partial data or provider links escape. */
function decode(required: { prepared: Prepared; text: string; retrievedAt: number }): Outcome<unknown> {
  const { command, configuration } = required.prepared;
  if (!epochSchema.safeParse(required.retrievedAt).success) return failure({ code: "protocol_mismatch" });
  if (command.kind === "report") return decodeReport({ ...required, command, accountId: configuration.accountId!, currency: configuration.currency! });
  try {
    const input: unknown = JSON.parse(required.text);
    if (z.object({ error: z.unknown() }).safeParse(input).success) return failure({ code: "unavailable" });
    return decodeList({ input, command, accountId: configuration.accountId });
  } catch { return failure({ code: "protocol_mismatch" }); }
}
/** Existing observer ABI carries IDs/outcomes only; durable egress audit belongs to the gateway. */
function observe(required: { dependencies: YandexDirectDependencies; prepared: Prepared; result: Outcome<YandexDirectReadResult> }): void {
  const { context, command } = required.prepared;
  try { required.dependencies.observer.observe({ operation: "yandex-direct." + command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot alter the read outcome; the host audit remains authoritative. */ }
}
