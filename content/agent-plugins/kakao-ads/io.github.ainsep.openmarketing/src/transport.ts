import { z } from "zod";
import { epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome } from "@open-marketing/contracts";
import { encodeKakaoCommand, invocationSchema } from "./commands.js";
import type { KakaoWireRequest } from "./commands.js";
import type { KakaoAdsAdapter, KakaoDependencies, KakaoInvocation, KakaoResult } from "./ports.js";
import { decodeKakaoReport, reportBeforeToday } from "./reporting.js";

const vendorId = z.union([z.string().regex(/^[1-9][0-9]{0,18}$/), z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: z.string().regex(/^[1-9][0-9]{0,18}$/).nullable(), admitted: z.boolean() });
const credentialSchema = z.object({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const entity = z.object({ id: vendorId, name: z.string().max(1024), config: z.enum(["ON", "OFF", "DEL"]), adAccountId: vendorId.optional() });
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const accountPage = z.object({ content: z.array(entity).max(10), number: integer, size: z.literal(10), totalElements: integer, totalPages: integer, page: integer });
const campaignPage = z.object({ content: z.array(entity).max(1000) });
type Prepared = { invocation: KakaoInvocation; request: KakaoWireRequest; configuration: z.infer<typeof configurationSchema> };

/** Inert factory; the host supplies its current-authority guarded fetch and credential broker.
 * @param required - Server-owned binding, credentials, fetch, clock, deadline signal and observer.
 * @returns One read adapter; boundary failures are typed and redacted, with zero retries.
 * @example createKakaoAdsAdapter({ configuration, credentials, fetch: guardedFetch, clock, createDeadlineSignal, observer })
 * @complexity O(b+n) time/space, input<=64KiB, response<=1MiB, rows<=1000; one 15s GET.
 */
export function createKakaoAdsAdapter(required: KakaoDependencies): KakaoAdsAdapter {
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies: required, input }, options);
    if (!prepared.ok) return prepared;
    let outcome: Outcome<KakaoResult>;
    try { outcome = await execute({ dependencies: required, prepared: prepared.value }, options); }
    catch { outcome = failure({ code: "unavailable" }); }
    observe({ dependencies: required, invocation: prepared.value.invocation, outcome });
    return outcome;
  } };
}

/** Parse and bind before credential access. Unadmitted calls cannot resolve secrets. @complexity O(b), b<=64KiB. */
function prepare(required: { dependencies: KakaoDependencies; input: KakaoInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const invocation = invocationSchema.safeParse(bounded.value);
  const configuration = configurationSchema.safeParse(required.dependencies.configuration);
  if (!invocation.success || !configuration.success) return failure({ code: "invalid_input" });
  if (!configuration.data.admitted) return failure({ code: "forbidden" });
  const scope = invocation.data.context.scope;
  if (scope.ownerId !== configuration.data.scope.ownerId || scope.workspaceId !== configuration.data.scope.workspaceId) return failure({ code: "forbidden" });
  if (invocation.data.command.kind !== "list_accounts" && configuration.data.accountId === null) return failure({ code: "invalid_input" });
  return { ok: true, value: { invocation: invocation.data, configuration: configuration.data, request: encodeKakaoCommand({ command: invocation.data.command, accountId: configuration.data.accountId }) } };
}

/** JSON is tainted, including serialization errors/cycles. @complexity O(b) JSON traversal. */
function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const serialized = JSON.stringify(required.input);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Credentials resolve once. The host guarded fetch rechecks authority after this await.
 * No network on expired tokens, invalid dates or revoked local admission. @complexity One broker call and one GET.
 */
async function execute(required: { dependencies: KakaoDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<KakaoResult>> {
  const { dependencies, prepared } = required;
  const now = dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000 - 32400000) return failure({ code: "unavailable" });
  const command = prepared.invocation.command;
  if (command.kind === "report" && !reportBeforeToday({ end: command.end, now })) return failure({ code: "invalid_input" });
  const credential = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, optional);
  if (!credential.ok) return failure({ code: credential.error.code });
  const token = checkCredential({ input: credential.value, now: dependencies.clock.now({}) });
  if (!token.ok) return token;
  if (!dependencies.configuration.admitted) return failure({ code: "forbidden" });
  const body = await request({ dependencies, request: prepared.request, token: token.value }, optional);
  if (!body.ok) return body;
  return decode({ prepared, body: body.value, retrievedAt: dependencies.clock.now({}) });
}
/** Business tokens have no assumed lifetime; honor optional broker expiry only. @complexity O(b), b<=4096. */
function checkCredential(required: { input: unknown; now: number }): Outcome<string> {
  const parsed = credentialSchema.safeParse(required.input);
  if (!parsed.success) return failure({ code: "unauthenticated" });
  if (parsed.data.expiresAt !== undefined && parsed.data.expiresAt <= required.now) return failure({ code: "expired" });
  return { ok: true, value: parsed.data.accessToken };
}

/** Native fetch callback ABI; fixed origin, redirect refusal and an injected deadline covering streamed body.
 * Error bodies never escape. @complexity O(b) time/space, b<=1MiB; no retries.
 */
async function request(required: { dependencies: KakaoDependencies; request: KakaoWireRequest; token: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const deadline = required.dependencies.createDeadlineSignal({ timeoutMs: 15000 });
  const signal = AbortSignal.any([deadline, ...optional?.signal ? [optional.signal] : []]);
  try {
    const headers: Record<string, string> = { Authorization: "Bearer " + required.token };
    if (required.request.accountId !== null) headers.adAccountId = required.request.accountId;
    const response = await required.dependencies.fetch(required.request.url, { method: "GET", headers, redirect: "error", signal });
    const body = await readBody({ response });
    if (response.status === 200) return body;
    return statusFailure({ status: response.status, body });
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
function statusFailure(required: { status: number; body: Outcome<unknown> }): Outcome<never> {
  const error = z.object({ code: z.number().int() }).safeParse(required.body.ok ? required.body.value : null);
  if (required.status === 400 && error.success && error.data.code === -10) return failure({ code: "limit_exceeded" });
  switch (required.status) {
    case 429: return failure({ code: "limit_exceeded" });
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 400: return failure({ code: "invalid_input" });
    default: return failure({ code: "unavailable" });
  }
}

/** Bound actual streamed bytes, not Content-Length. Always release the reader. @complexity O(b), b<=1MiB. */
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
    try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }; }
    catch { return failure({ code: "protocol_mismatch" }); }
  } finally { reader.releaseLock(); }
}

/** Reject entire mixed/duplicate pages. Provider additions are stripped, never followed.
 * Campaign lists have no account field guaranteed: host binding plus fixed account header owns scope.
 * @complexity O(n) time/space, n<=1000; no per-row I/O.
 */
function decode(required: { prepared: Prepared; body: unknown; retrievedAt: number }): Outcome<KakaoResult> {
  const { command, operationId } = required.prepared.invocation;
  if (!epochSchema.safeParse(required.retrievedAt).success) return failure({ code: "unavailable" });
  if (command.kind === "report") {
    const report = decodeKakaoReport({ input: required.body, ...command, accountId: required.prepared.configuration.accountId!, retrievedAt: required.retrievedAt });
    return report.ok ? { ok: true, value: { operationId, data: report.value } } : report;
  }
  return decodeList(required);
}
/** Account page offsets must match the requested page; no automatic pagination. @complexity O(n), n<=1000. */
function decodeList(required: { prepared: Prepared; body: unknown }): Outcome<KakaoResult> {
  const { command, operationId } = required.prepared.invocation;
  const page = (command.kind === "list_accounts" ? accountPage : campaignPage).safeParse(required.body);
  if (!page.success) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_accounts" && "number" in page.data && "page" in page.data) {
    if (page.data.number !== (command.page ?? 0) || page.data.page !== page.data.number) return failure({ code: "protocol_mismatch" });
  }
  if (new Set(page.data.content.map(item => item.id)).size !== page.data.content.length) return failure({ code: "protocol_mismatch" });
  if (command.kind === "list_campaigns" && page.data.content.some(item => item.adAccountId !== undefined && item.adAccountId !== required.prepared.configuration.accountId)) return failure({ code: "forbidden" });
  return { ok: true, value: { operationId, data: page.data } };
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Kakao request " + required.code, retryable: false } }; }

/** Correlation/outcome only; host owns durable egress audit. @complexity O(1). */
function observe(required: { dependencies: KakaoDependencies; invocation: KakaoInvocation; outcome: Outcome<KakaoResult> }): void {
  const context = required.invocation.context;
  try { required.dependencies.observer.observe({ operation: "kakao-ads." + required.invocation.command.kind, outcome: required.outcome.ok ? "succeeded" : required.outcome.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot rewrite an observed read result; host audit is authoritative. */ }
}
