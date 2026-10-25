import { createHmac } from "node:crypto";
import { z } from "zod";
import { epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, ClockPort, ObserverPort, Outcome } from "@open-marketing/contracts";
import { campaignIdSchema, customerIdSchema, encodeCommand, invocationSchema } from "./commands.js";
import type { ParsedCommand } from "./commands.js";
import { decodeReport } from "./reporting.js";

const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: customerIdSchema, credentialCustomerId: customerIdSchema, admitted: z.boolean() });
// Require the physical end of input; `$` also matches before a trailing newline.
const secret = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+(?![\s\S])/);
const credentialSchema = z.strictObject({ apiKey: secret, secretKey: secret, customerId: customerIdSchema });
const providerId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String);
const text = z.string().min(1).max(1024);
const account = z.object({ adAccountNo: providerId, roleName: z.enum(["OWNER", "MASTER", "READ_ONLY"]), adAccount: z.object({ no: providerId, masterCustomerId: providerId, name: text, currency: z.literal("KRW") }) });
const accounts = z.object({ content: z.array(account).max(100), number: z.number().int().nonnegative(), size: z.number().int().min(1).max(100), last: z.boolean() });
const campaigns = z.array(z.object({ nccCampaignId: campaignIdSchema, customerId: providerId, name: text, campaignTp: z.enum(["WEB_SITE", "SHOPPING", "POWER_CONTENTS", "BRAND_SEARCH", "PLACE"]), status: z.enum(["ELIGIBLE", "PAUSED", "DELETED"]), userLock: z.boolean() })).max(100);
type Configuration = z.infer<typeof configurationSchema>;
type Invocation = z.input<typeof invocationSchema>;
type Credential = z.infer<typeof credentialSchema>;
/** Validated receipt; reads never imply campaign delivery or mutation. */
export interface NaverResult { readonly operationId: string; readonly status: "succeeded"; readonly data: unknown }
/** The existing paste-token broker returns untagged JSON in accessToken. It MUST authorize the
 * selected target account for this connection; credentialCustomerId is the key owner, not the target.
 * Guarded server fetch MUST recheck current admission/account/halt/policy and append egress audit
 * with the invocation's run/correlation/trace IDs on every call. No plugin-owned policy or gateway.
 */
export interface NaverDependencies {
  readonly configuration: Configuration;
  readonly credentials: { access(required: { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<{ accessToken: string }>> };
  readonly fetch: typeof fetch;
  /** Server-owned timer factory; returns a signal that aborts after timeoutMs. */
  readonly createDeadline: (required: { timeoutMs: number }) => AbortSignal;
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
}
/** Inert adapter; callers may pass only the three closed read commands. */
export interface NaverAdsAdapter { invoke(required: Invocation, optional?: CallOptions): Promise<Outcome<NaverResult>> }
export type NaverConfiguration = Configuration;
export type NaverInvocation = Invocation;

/** Create one inert server-loaded adapter with injected credential broker and guarded fetch.
 * @param required - Server-owned selected binding and I/O; admitted:false denies before credentials.
 * @returns Typed read receipts/failures; no retries, services, caches or credential retention.
 * @example createNaverAdsAdapter({ configuration, credentials, fetch: guardedFetch, createDeadline, clock, observer })
 * @complexity O(b) time/space per call, input<=64KiB, response<=1MiB, one GET with a 15s deadline.
 */
export function createNaverAdsAdapter(required: NaverDependencies): NaverAdsAdapter {
  return { async invoke(input, options) {
    if (options?.signal?.aborted) return failure({ code: "cancelled" });
    const bounded = boundInput({ input });
    if (!bounded.ok) return bounded;
    const parsed = invocationSchema.safeParse(bounded.value);
    if (!parsed.success) return failure({ code: "invalid_input" });
    let result = await invokeRead({ dependencies: required, invocation: parsed.data }, options);
    if (options?.signal?.aborted) result = failure({ code: "cancelled" });
    try { required.observer.observe({ operation: "naver-ads." + parsed.data.command.kind, outcome: result.ok ? "succeeded" : result.error.code, correlationId: parsed.data.context.correlationId, traceId: parsed.data.context.traceId, runId: parsed.data.context.runId }); } catch { /* Telemetry cannot change a read result. */ }
    return result;
  } };
}

/** Reject tainted/cyclic or oversized invocation values before parsing or accessing credentials. */
function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const serialized = JSON.stringify(required.input);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Validate binding before credentials; isolate broker exceptions and discard all broker messages.
 * @complexity O(b) bounded parsing; one broker access followed by at most one vendor GET.
 */
async function invokeRead(required: { dependencies: NaverDependencies; invocation: z.output<typeof invocationSchema> }, optional?: CallOptions): Promise<Outcome<NaverResult>> {
  const { dependencies, invocation } = required;
  const binding = configurationSchema.safeParse(dependencies.configuration);
  if (!binding.success) return failure({ code: "invalid_input" });
  if (!binding.data.admitted) return failure({ code: "forbidden" });
  if (binding.data.scope.ownerId !== invocation.context.scope.ownerId || binding.data.scope.workspaceId !== invocation.context.scope.workspaceId) return failure({ code: "forbidden" });
  try {
    const accessed = await dependencies.credentials.access({ connectionId: binding.data.connectionId, accountId: binding.data.accountId }, optional);
    if (!accessed.ok) return failure({ code: accessed.error.code });
    const credential = parseCredential({ input: accessed.value.accessToken });
    if (!credential.ok) return credential;
    if (credential.value.customerId !== binding.data.credentialCustomerId) return failure({ code: "forbidden" });
    const response = await request({ dependencies, configuration: binding.data, command: invocation.command, credential: credential.value }, optional);
    if (!response.ok) return response;
    const data = decode({ input: response.value, command: invocation.command, accountId: binding.data.accountId, retrievedAt: dependencies.clock.now({}) });
    if (!data.ok) return data;
    return { ok: true, value: { operationId: invocation.operationId, status: "succeeded", data: data.value } };
  } catch { return failure({ code: "unavailable" }); }
}

/** Parse only bounded pasted JSON, never expose schema errors or secret-bearing broker output. */
function parseCredential(required: { input: unknown }): Outcome<Credential> {
  if (typeof required.input !== "string" || Buffer.byteLength(required.input) > 16384) return failure({ code: "unauthenticated" });
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(required.input));
    if (!parsed.success) return failure({ code: "unauthenticated" });
    return { ok: true, value: parsed.data };
  } catch { return failure({ code: "unauthenticated" }); }
}

/** Fixed origin, path-only HMAC, redirect rejection and caller cancellation. Sign with injected time
 * immediately before guarded fetch; zero automatic retries (including 429).
 * @complexity O(b) time/space, response<=1MiB, request URL<=64KiB, one GET<=15s.
 */
async function request(required: { dependencies: NaverDependencies; configuration: Configuration; command: ParsedCommand; credential: Credential }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const { dependencies, configuration, command, credential } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (!dependencies.configuration.admitted) return failure({ code: "forbidden" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  const wire = encodeCommand({ command });
  const url = "https://api.searchad.naver.com" + wire.path + "?" + wire.query;
  // Closed command fields bound generated URLs below 1KiB, well within the 64KiB request cap.
  const signature = createHmac("sha256", credential.secretKey).update(`${now}.GET.${wire.path}`).digest("base64");
  const deadline = dependencies.createDeadline({ timeoutMs: 15000 });
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  try {
    const response = await dependencies.fetch(url, { method: "GET", redirect: "error", signal, headers: { "X-Timestamp": String(now), "X-API-KEY": credential.apiKey, "X-Customer": command.kind === "list_accounts" ? credential.customerId : configuration.accountId, "X-Signature": signature } });
    if (response.status !== 200) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
    const body = await readBody({ response });
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    if (deadline.aborted) return failure({ code: "unavailable" });
    return body;
  } catch { return failure({ code: "unavailable" }); }
}

/** Stream JSON for reads/readback; reject missing, malformed or invalid UTF-8 bodies.
 * @complexity O(b) time/space, b<=1MiB; oversized streams are cancelled, never partially returned.
 */
export async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
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
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}

/** Validate every row before release; foreign ownership or mixed-validity pages reject as a whole.
 * @complexity O(n) time/space for n<=100 accounts/campaigns; stats contain at most one row.
 */
function decode(required: { input: unknown; command: ParsedCommand; accountId: string; retrievedAt: number }): Outcome<unknown> {
  const command = required.command;
  if (command.kind === "report") return decodeReport({ ...required, command });
  if (command.kind === "list_accounts") return decodeAccounts({ input: required.input, command });
  const parsed = campaigns.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.length > command.pageSize || parsed.data.some(row => row.customerId !== required.accountId)) return failure({ code: "protocol_mismatch" });
  if (new Set(parsed.data.map(row => row.nccCampaignId)).size !== parsed.data.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { items: parsed.data, nextCursor: parsed.data.length === command.pageSize ? parsed.data.at(-1)!.nccCampaignId : null } };
}
function decodeAccounts(required: { input: unknown; command: Extract<ParsedCommand, { kind: "list_accounts" }> }): Outcome<unknown> {
  const parsed = accounts.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const page = parsed.data;
  if (page.number !== required.command.page || page.size !== required.command.pageSize || page.content.length > page.size) return failure({ code: "protocol_mismatch" });
  if (page.content.some(row => row.adAccountNo !== row.adAccount.no)) return failure({ code: "protocol_mismatch" });
  if (new Set(page.content.map(row => row.adAccountNo)).size !== page.content.length) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { items: page.content, nextPage: page.last ? null : page.number + 1 } };
}
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Naver read failed", retryable: false } }; }
