import { createHash, createHmac } from "node:crypto";
import { z } from "zod";
import { callContextSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, encodeCommand, vendorIdSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";
import { decodePage } from "./reporting.js";
import type { LineAdsAdapter, LineAdsDependencies, LineAdsInvocation, LineAdsResult, LineAdsWireRequest } from "./ports.js";

const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Shared read/deployment binding parser; no caller-controlled account or origin. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema.nullable(), country: z.enum(["JP", "TW", "TH"]), currency: z.string().regex(/^[A-Z]{3}$/), timezone: z.string().min(1).max(128) });
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const bundleSchema = z.strictObject({ accessKey: secret, secretKey: secret, groupId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) });
const tokenSchema = z.object({ accessToken: z.string().min(1).max(16384) });
type Prepared = { invocation: z.infer<typeof invocationSchema>; configuration: z.infer<typeof configurationSchema> };
type Binding = Pick<Prepared, "configuration">;

/** Inert server-loaded reads/auth adapter. Dependencies remain live for admission withdrawal.
 * @returns Three read operations with typed failures, one <=15s GET, <=1MiB result, no retries.
 * @example createLineAdsAdapter({ admitted, configuration, credentials, fetch: guardedFetch, clock, createDeadline, observer })
 * @complexity O(b) time/space for <=64KiB input and <=1MiB response; no startup effects.
 */
export function createLineAdsAdapter(required: LineAdsDependencies): LineAdsAdapter {
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies: required, input }, options);
    if (!prepared.ok) return prepared;
    const result = await dispatch({ dependencies: required, prepared: prepared.value }, options);
    observe({ dependencies: required, prepared: prepared.value, result });
    return result;
  } };
}

/** Snapshot validated inputs before awaits. JP reads only until regional evidence closes.
 * @returns Prepared binding or typed denial/invalid input. O(b), <=64KiB; no credential access.
 */
function prepare(required: { dependencies: LineAdsDependencies; input: LineAdsInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (required.dependencies.admitted !== true) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundedInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const invocation = invocationSchema.safeParse(bounded.value);
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const { scope } = invocation.data.context;
  if (!sameScope({ first: scope, second: configuration.data.scope })) return failure({ code: "forbidden" });
  if (configuration.data.country !== "JP") return failure({ code: "unavailable" });
  if (configuration.data.accountId === null && invocation.data.command.kind !== "list_accounts") return failure({ code: "forbidden" });
  return { ok: true, value: { invocation: invocation.data, configuration: configuration.data } };
}
function sameScope(required: { first: Prepared["configuration"]["scope"]; second: Prepared["configuration"]["scope"] }): boolean {
  return required.first.ownerId === required.second.ownerId && required.first.workspaceId === required.second.workspaceId;
}
function validTime(required: { now: number }): boolean { return Number.isSafeInteger(required.now) && required.now >= 0 && required.now <= 4102444800000; }
/** JSON boundary rejects cycles/oversize without exposing caller data. O(b), <=64KiB accepted. */
export function boundedInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const json = JSON.stringify(required.input);
    if (json === undefined || Buffer.byteLength(json) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Secrets resolve once; recheck live admission/binding after that await and immediately at fetch.
 * @returns Validated receipt or redacted boundary failure; O(b), one network call, no retries.
 */
async function dispatch(required: { dependencies: LineAdsDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<LineAdsResult>> {
  const { dependencies, prepared } = required;
  const response = await requestLineAds({ ...required, request: prepared.invocation.command }, optional);
  if (!response.ok) return response;
  try {
    const retrievedAt = dependencies.clock.now({});
    if (!validTime({ now: retrievedAt })) return failure({ code: "invalid_input" });
    const data = decodePage({ input: response.value, command: prepared.invocation.command, configuration: prepared.configuration, retrievedAt });
    return data.ok ? { ok: true, value: { operationId: prepared.invocation.operationId, status: "succeeded", observedState: "unknown", data: data.value } } : data;
  } catch { return failure({ code: "unavailable" }); }
}
/** Plugin-internal transport shared by reads and the fixed deployment. Caller validates scope/region.
 * Fresh custody, live admission/binding rechecks and <=15s/1MiB bounds on every request; no retry.
 */
export async function requestLineAds(required: { dependencies: LineAdsDependencies; prepared: Binding; request: ParsedCommand | LineAdsWireRequest }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, prepared } = required;
  if (!current(required)) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const access = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, optional);
    if (!access.ok) return failure({ code: access.error.code });
    if (!current(required)) return failure({ code: "forbidden" });
    const bundle = parseBundle({ input: access.value });
    if (!bundle.ok) return bundle;
    const request = "kind" in required.request ? encodeCommand({ command: required.request, accountId: prepared.configuration.accountId, groupId: bundle.value.groupId }) : required.request;
    return await send({ ...required, request, bundle: bundle.value }, optional);
  } catch { return failure({ code: "unavailable" }); }
}
/** Parse the sealed paste value locally; invalid/legacy bearer tokens never reach LINE. O(b). */
function parseBundle(required: { input: unknown }): Outcome<z.infer<typeof bundleSchema>> {
  const token = tokenSchema.safeParse(required.input);
  if (!token.success) return failure({ code: "unauthenticated" });
  try {
    const parsed = bundleSchema.safeParse(JSON.parse(token.data.accessToken));
    return parsed.success ? { ok: true, value: parsed.data } : failure({ code: "unauthenticated" });
  } catch { return failure({ code: "unauthenticated" }); }
}
function current(required: { dependencies: LineAdsDependencies; prepared: Binding }): boolean {
  const parsed = configurationSchema.safeParse(required.dependencies.configuration);
  return required.dependencies.admitted === true && parsed.success && JSON.stringify(parsed.data) === JSON.stringify(required.prepared.configuration);
}

/** LINE uses padded URL-safe Base64 (including '='), unlike common unpadded JWT encoders.
 * Canonical URI excludes query; POST signs the exact serialized body and application/json.
 * @returns Bearer signature matching the official sample. O(b) bounded bytes; no effects.
 */
function signedHeaders(required: { request: LineAdsWireRequest; bundle: z.infer<typeof bundleSchema>; now: number }): Record<string, string> {
  const date = new Date(required.now);
  const header = base64({ text: JSON.stringify({ alg: "HS256", kid: required.bundle.accessKey, typ: "text/plain" }) });
  const body = required.request.method === "POST" ? required.request.body : "";
  const contentType = required.request.method === "POST" ? "application/json" : "";
  const payload = [createHash("sha256").update(body).digest("hex"), contentType, date.toISOString().slice(0, 10).replaceAll("-", ""), new URL(required.request.url).pathname].join("\n");
  const input = header + "." + base64({ text: payload });
  const signature = createHmac("sha256", required.bundle.secretKey).update(input).digest("base64").replaceAll("+", "-").replaceAll("/", "_");
  return { Date: date.toUTCString(), Authorization: "Bearer " + input + "." + signature, ...(contentType ? { "Content-Type": contentType } : {}) };
}
function base64(required: { text: string }): string { return Buffer.from(required.text).toString("base64").replaceAll("+", "-").replaceAll("/", "_"); }

/** Fixed-origin request; abort covers response streaming, redirects/error bodies never escape.
 * @returns Parsed JSON or typed status/codec failure. O(b), <=1MiB, <=15s; no retries.
 */
async function send(required: { dependencies: LineAdsDependencies; prepared: Binding; request: LineAdsWireRequest; bundle: z.infer<typeof bundleSchema> }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const deadline = required.dependencies.createDeadline({ timeoutMs: 15000 });
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  try {
    const now = required.dependencies.clock.now({});
    if (!validTime({ now })) return failure({ code: "invalid_input" });
    const headers = signedHeaders({ request: required.request, bundle: required.bundle, now });
    if (signal.aborted) return failure({ code: "cancelled" });
    if (!current(required)) return failure({ code: "forbidden" });
    const response = await required.dependencies.fetch(required.request.url, { method: required.request.method, ...(required.request.method === "POST" ? { body: required.request.body } : {}), redirect: "error", signal, headers });
    if (response.status !== 200) { await response.body?.cancel(); return rejection({ status: response.status }); }
    return await readBody({ response });
  } catch { return transportFailure({ signal: optional?.signal }); }
}
function transportFailure(required: { signal?: AbortSignal }): Outcome<never> { return failure({ code: required.signal?.aborted ? "cancelled" : "unavailable" }); }

/** Count streamed bytes before parsing; Content-Length cannot bypass the 1MiB cap. O(b). */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
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
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}
function rejection(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "unavailable" });
  }
}
/** Redacted non-retryable boundary failure; unknown creates must reconcile, never retry. */
export function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "LINE request " + required.code, retryable: false } }; }
/** IDs/outcomes only; guarded fetch owns dispatch-time policy and durable server egress audit. */
function observe(required: { dependencies: LineAdsDependencies; prepared: Prepared; result: Outcome<LineAdsResult> }): void {
  const context = required.prepared.invocation.context;
  try { required.dependencies.observer.observe({ operation: "line-ads." + required.prepared.invocation.command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot rewrite the read receipt. */ }
}
