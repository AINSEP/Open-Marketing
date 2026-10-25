import { createHash } from "node:crypto";
import { z } from "zod";
import { digestSchema, epochSchema, idSchema, parseBoundary, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import { cursor, encodeCommand, invocationSchema, vendorId } from "./commands.js";
import { failure } from "./ports.js";
import type { PinterestAdsAdapter, PinterestDependencies, PinterestInvocation, PinterestResult, PinterestWireRequest } from "./ports.js";
import { decodeReport } from "./reporting.js";

const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorId.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), apiVersion: z.literal("v5"), pluginDigest: digestSchema, bindingId: idSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const account = z.object({ id: vendorId, name: z.string().max(256).optional(), currency: z.string().regex(/^[A-Z]{3}$/).optional(), time_zone: z.string().min(1).max(128).optional() });
const campaign = z.object({ id: vendorId, ad_account_id: vendorId, name: z.string().max(256).optional(), status: z.enum(["ACTIVE", "PAUSED", "ARCHIVED", "DRAFT", "DELETED_DRAFT"]).optional() });
interface Prepared { configuration: z.infer<typeof configurationSchema>; invocation: z.infer<typeof invocationSchema>; request: PinterestWireRequest; effect: EffectEnvelope }

/** Inert server adapter; typed failures, no retries. Gateway rechecks authority after token lookup.
 * @param required - Host-held binding, admission, gateway, broker, fetch, deadline, clock and observer.
 * @returns One read invocation boundary; no token or raw vendor error escapes.
 * @example createPinterestAdsAdapter({ configuration, admitted: true, gateway, credentials, fetch, deadline, clock, observer })
 * @complexity O(b) time/space, <=64KiB input and <=1MiB response, one 15s request.
 */
export function createPinterestAdsAdapter(required: PinterestDependencies): PinterestAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { async invoke(input, options) {
    try {
      const prepared = prepare({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      const result = await dispatch({ dependencies, prepared: prepared.value }, options).catch(() => failure({ code: "unavailable" }));
      observe({ dependencies, prepared: prepared.value, result });
      return result;
    } catch { return failure({ code: "invalid_input" }); }
  } };
}

/** Bound and validate all input before any credential/network I/O. @complexity O(b), b<=64KiB. */
function prepare(required: { dependencies: PinterestDependencies; input: PinterestInvocation }, options?: CallOptions): Outcome<Prepared> {
  if (!required.dependencies.admitted) return failure({ code: "forbidden" });
  if (options?.signal?.aborted) return failure({ code: "cancelled" });
  const serialized = JSON.stringify(required.input);
  if (serialized === undefined || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
  const invocation = parseBoundary({ schema: invocationSchema, input: JSON.parse(serialized) as unknown });
  if (!invocation.ok) return invocation;
  const configuration = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  const scope = invocation.value.context.scope;
  if (scope.ownerId !== configuration.value.scope.ownerId || scope.workspaceId !== configuration.value.scope.workspaceId) return failure({ code: "forbidden" });
  const now = required.dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  const request = encodeCommand({ command: invocation.value.command, configuration: configuration.value, now });
  if (!request.ok) return request;
  const effect: EffectEnvelope = { operationId: invocation.value.operationId, connectionId: configuration.value.connectionId, accountId: configuration.value.accountId, effects: ["read"], argumentsDigest: createHash("sha256").update(JSON.stringify(request.value)).digest("hex"), moneyExposure: null, requiredLimit: null };
  return { ok: true, value: { invocation: invocation.value, configuration: configuration.value, request: request.value, effect } };
}

/** Token precedes the host fence; execute can send once only. @complexity O(1), one broker lookup. */
async function dispatch(required: { dependencies: PinterestDependencies; prepared: Prepared }, options?: CallOptions): Promise<Outcome<PinterestResult>> {
  const { dependencies, prepared } = required;
  const token = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, options);
  if (!token.ok) return failure({ code: token.error.code });
  const credential = credentialSchema.safeParse(token.value);
  if (!credential.success) return failure({ code: "protocol_mismatch" });
  let sent = false;
  return dependencies.gateway.dispatch({ context: prepared.invocation.context, configuration: structuredClone(prepared.configuration), operation: prepared.invocation.command.kind, request: Object.freeze({ ...prepared.request }), effect: structuredClone(prepared.effect), execute: async () => {
    if (sent) return failure({ code: "conflict" });
    if (options?.signal?.aborted) return failure({ code: "cancelled" });
    const now = dependencies.clock.now({});
    if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
    if (credential.data.expiresAt !== undefined && now >= credential.data.expiresAt) return failure({ code: "expired" });
    sent = true;
    return send({ dependencies, prepared, accessToken: credential.data.accessToken }, options);
  } }, options);
}

/** Fixed origin, no redirects, bounded body under the same 15s deadline. @complexity O(b), b<=1MiB. */
async function send(required: { dependencies: PinterestDependencies; prepared: Prepared; accessToken: string }, options?: CallOptions): Promise<Outcome<PinterestResult>> {
  const deadline = required.dependencies.deadline({ timeoutMs: 15000 });
  const signal = options?.signal ? AbortSignal.any([deadline, options.signal]) : deadline;
  try {
    const response = await required.dependencies.fetch(required.prepared.request.url, { method: "GET", redirect: "error", signal, headers: { Authorization: "Bearer " + required.accessToken, Accept: "application/json" } });
    if (response.status !== 200) {
      await response.body?.cancel();
      return statusFailure({ status: response.status });
    }
    const body = await readBody({ response, signal });
    if (!body.ok) return options?.signal?.aborted ? failure({ code: "cancelled" }) : body;
    const retrievedAt = required.dependencies.clock.now({});
    if (!epochSchema.safeParse(retrievedAt).success) return failure({ code: "invalid_input" });
    const decoded = decode({ prepared: required.prepared, body: body.value, retrievedAt });
    if (!decoded.ok) return decoded;
    return { ok: true, value: { operationId: required.prepared.invocation.operationId, status: "succeeded", observedState: "unknown", data: decoded.value } };
  } catch { return failure({ code: options?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
function statusFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "unavailable" });
  }
}

/** Abort also cancels stalled response streams; Content-Length is never trusted. @complexity O(b), b<=1MiB. */
async function readBody(required: { response: Response; signal: AbortSignal }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  required.signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      if (required.signal.aborted) return failure({ code: "unavailable" });
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    if (required.signal.aborted) return failure({ code: "unavailable" });
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { required.signal.removeEventListener("abort", cancel); reader.releaseLock(); }
}

/** Reject a whole page for duplicate/foreign records, strip unconsumed fields and return only cursor.
 * @complexity O(n) time/space, n<=100; report decoder separately bounds rows to 9000.
 */
function decode(required: { prepared: Prepared; body: unknown; retrievedAt: number }): Outcome<unknown> {
  const { command } = required.prepared.invocation;
  const { accountId, currency } = required.prepared.configuration;
  if (command.kind === "report") return decodeReport({ input: required.body, command, accountId: accountId!, currency: currency!, retrievedAt: required.retrievedAt });
  const item = command.kind === "list_accounts" ? account : campaign;
  const parsed = z.object({ items: z.array(item).max(command.pageSize), bookmark: cursor.nullable().optional() }).safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const keys = parsed.data.items.map(value => value.id);
  if (new Set(keys).size !== keys.length) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_campaigns" && parsed.data.items.some(value => "ad_account_id" in value && value.ad_account_id !== accountId)) return failure({ code: "forbidden" });
  return { ok: true, value: { items: parsed.data.items, nextPageToken: parsed.data.bookmark ?? null } };
}
/** Correlation IDs and outcome only; durable egress audit belongs to the host. */
function observe(required: { dependencies: PinterestDependencies; prepared: Prepared; result: Outcome<PinterestResult> }): void {
  const { context, command } = required.prepared.invocation;
  try { required.dependencies.observer.observe({ operation: "pinterest-ads." + command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot replace the receipt; host audit remains authoritative. */ }
}
