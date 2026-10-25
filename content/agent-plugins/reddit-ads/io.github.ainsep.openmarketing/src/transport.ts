import { z } from "zod";
import { boundedJsonSchema, callContextSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
import { accountIdSchema, encodeCommand, invocationSchema, nextPage } from "./commands.js";
import type { RedditAdsAdapter, RedditDependencies, RedditInvocation, RedditResult, RedditWireRequest } from "./ports.js";
import { decodeReport } from "./reporting.js";

const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: accountIdSchema.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable() });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const pageSchema = z.object({ data: z.unknown(), pagination: z.object({ next_url: z.string().max(4096).nullable().optional() }) });
const businessesSchema = z.array(z.object({ id: z.string().regex(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i), name: z.string().max(500) })).max(100);
type Prepared = { invocation: z.output<typeof invocationSchema>; configuration: z.output<typeof configurationSchema>; request: RedditWireRequest };

/** Inert read-only adapter; host policy remains authoritative, including guarded native fetch.
 * @example createRedditAdsAdapter({ configuration, admitted, credentials, fetch, createDeadline, clock, observer })
 * @returns An invoker returning typed failures or projected pages; never raw vendor errors/tokens.
 * @complexity O(b) time/space, <=64KiB input, <=1MiB response, one 15s request, zero retries.
 */
export function createRedditAdsAdapter(required: RedditDependencies): RedditAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { async invoke(input, options) {
    let result: Outcome<RedditResult>;
    try { result = await invoke({ dependencies, input }, options); }
    catch { result = failure({ code: options?.signal?.aborted ? "cancelled" : "unavailable" }); }
    observe({ dependencies, input, result });
    return result;
  } };
}

/** Snapshot and validate authority-bearing data before any await or credential lookup. O(b). */
function prepare(required: { dependencies: RedditDependencies; input: RedditInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (!boundedJsonSchema.safeParse(required.input).success) return failure({ code: "invalid_input" });
  const invocation = invocationSchema.safeParse(required.input);
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  const bound = configuration.data;
  if (!sameScope({ first: invocation.data.context.scope, second: bound.scope })) return failure({ code: "forbidden" });
  const discovery = ["list_businesses", "list_accounts"].includes(invocation.data.command.kind);
  if (!discovery && (bound.accountId === null || bound.currency === null)) return failure({ code: "invalid_input" });
  if (!required.dependencies.admitted({ context: invocation.data.context })) return failure({ code: "forbidden" });
  const request = encodeCommand({ command: invocation.data.command, accountId: bound.accountId });
  if (!request.ok) return request;
  return { ok: true, value: { invocation: invocation.data, configuration: bound, request: request.value } };
}
/** Both ownership dimensions must match before credentials are resolved. O(1). */
function sameScope(required: { first: Scope; second: Scope }): boolean { return required.first.ownerId === required.second.ownerId && required.first.workspaceId === required.second.workspaceId; }

/** Credentials are resolved once, then expiry/cancellation/current admission rechecked at egress. O(b). */
async function invoke(required: { dependencies: RedditDependencies; input: RedditInvocation }, optional?: CallOptions): Promise<Outcome<RedditResult>> {
  const prepared = prepare(required, optional);
  if (!prepared.ok) return prepared;
  const { dependencies } = required;
  const { configuration, invocation, request } = prepared.value;
  const access = await dependencies.credentials.access({ connectionId: configuration.connectionId, accountId: configuration.accountId }, optional);
  if (!access.ok) return failure({ code: access.error.code });
  const credential = credentialSchema.safeParse(access.value);
  if (!credential.success) return failure({ code: "unauthenticated" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (credential.data.expiresAt !== undefined && now >= credential.data.expiresAt) return failure({ code: "expired" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (!dependencies.admitted({ context: invocation.context })) return failure({ code: "forbidden" });
  const response = await send({ dependencies, request, token: credential.data.accessToken }, optional);
  if (!response.ok) return response;
  return decodePage({ prepared: prepared.value, input: response.value, retrievedAt: dependencies.clock.now({}) });
}

/** Native fetch ABI with a host-created 15s deadline and optional caller cancellation.
 * No redirect/retry; errors and status bodies are never returned. O(b), b<=1MiB.
 */
async function send(required: { dependencies: RedditDependencies; request: RedditWireRequest; token: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { request } = required;
  if (Buffer.byteLength(request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const deadline = required.dependencies.createDeadline({ timeoutMs: 15000 });
  const signal = optional?.signal ? AbortSignal.any([optional.signal, deadline]) : deadline;
  const response = await required.dependencies.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal, headers: { Authorization: "Bearer " + required.token, Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Open-Marketing:reddit-ads:0.1.0" } });
  if (response.status !== 200) {
    await response.body?.cancel();
    return httpFailure({ status: response.status });
  }
  if (response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    await response.body?.cancel();
    return failure({ code: "protocol_mismatch" });
  }
  return readBody({ response });
}

/** Stream into a fixed buffer before parsing; Content-Length is never trusted. O(b) time/space. */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const bytes = Buffer.alloc(1048576);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > bytes.length) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return decodeJson({ text: bytes.subarray(0, length).toString("utf8") });
  }
  finally { reader.releaseLock(); }
}
/** Malformed bounded JSON is a protocol failure; stream/abort errors reach the I/O wrapper. */
function decodeJson(required: { text: string }): Outcome<unknown> {
  try { return { ok: true, value: JSON.parse(required.text, exactMetric) as unknown }; }
  catch { return failure({ code: "protocol_mismatch" }); }
}
/** Native JSON reviver ABI (three positional arguments): inspect source before double rounding.
 * Numeric metric lexemes must be exact safe decimal integers; unsupported engines fail closed.
 * Thrown parse errors are contained by decodeJson. O(k), k<=1MiB source characters.
 */
function exactMetric(key: string, value: unknown, context?: { source: string }): unknown {
  if (!["spend", "impressions", "clicks"].includes(key) || typeof value !== "number") return value;
  if (!Number.isSafeInteger(value) || context?.source !== String(value)) throw new Error("Invalid Reddit integer");
  return value;
}

/** Project only sourced data, then validate pagination before returning any result. O(n), n<=100. */
function decodePage(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<RedditResult> {
  const { invocation, request } = required.prepared;
  const page = pageSchema.safeParse(required.input);
  if (!page.success || !epochSchema.safeParse(required.retrievedAt).success) return failure({ code: "protocol_mismatch" });
  const next = nextPage({ next: page.data.pagination.next_url, request, pageToken: invocation.command.pageToken });
  if (!next.ok) return next;
  const data = projectData({ prepared: required.prepared, input: page.data.data, retrievedAt: required.retrievedAt });
  if (!data.ok) return data;
  return { ok: true, value: { operationId: invocation.operationId, status: "succeeded", observedState: "unknown", data: { ...data.value, nextPageToken: next.value, incomplete: next.value !== null } } };
}
/** Separate vendor report/business schemas; never return a partly validated collection. O(n). */
function projectData(required: { prepared: Prepared; input: unknown; retrievedAt: number }): Outcome<object> {
  const { invocation, configuration } = required.prepared;
  if (invocation.command.kind === "report") {
    return decodeReport({ input: required.input, command: invocation.command, accountId: configuration.accountId!, currency: configuration.currency!, retrievedAt: required.retrievedAt });
  }
  const businesses = businessesSchema.safeParse(required.input);
  if (!businesses.success || businesses.data.length > invocation.command.pageSize) return failure({ code: "protocol_mismatch" });
  if (new Set(businesses.data.map(row => row.id)).size !== businesses.data.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { businesses: businesses.data } };
}

/** Credential/vendor errors stay sanitized. 429 is surfaced without an automatic retry. */
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Reddit read failed (" + required.code + ")", retryable: false } }; }
/** Correlated, secret-free observations; telemetry failure cannot change an already completed read. */
function observe(required: { dependencies: RedditDependencies; input: RedditInvocation; result: Outcome<RedditResult> }): void {
  try {
    const parsed = callContextSchema.safeParse(required.input?.context);
    if (!parsed.success) return;
    const context = parsed.data;
    required.dependencies.observer.observe({ operation: "reddit-ads.read", outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
  }
  catch { /* Host observer failure must not leak secrets or cause a duplicate request. */ }
}
