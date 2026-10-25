import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, digestSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { commandSchema, decodeList, request, userSchema, vendorIdSchema } from "./commands.js";
import { runReport } from "./reporting.js";
import { failure } from "./ports.js";
import type { MicrosoftAdsAdapter, MicrosoftAdsDependencies, MicrosoftAdsInvocation, MicrosoftAdsWireRequest, MicrosoftAdsIoDependencies } from "./ports.js";
export const configurationSchema = z.strictObject({ scope: scopeSchema, admitted: z.boolean().default(false), connectionId: idSchema, accountId: vendorIdSchema.nullable(), customerId: vendorIdSchema.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), pluginDigest: digestSchema, bindingId: idSchema });
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const credentialSchema = z.object({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });
type Execution = { dependencies: MicrosoftAdsDependencies; input: MicrosoftAdsInvocation; signal: AbortSignal };
type Credentials = [z.infer<typeof credentialSchema>, z.infer<typeof credentialSchema>];
/** Late parsed bodies are failure evidence for deployment checkpoints, never successful reads. */
export type MicrosoftAdsTransportResult = Outcome<unknown> & { receivedBody?: unknown };
/** Inert factory; only invoke performs I/O through the server gateway.
 * @param required - Server binding and injected effects; no ambient auth or configuration.
 * @returns Read adapter with explicit failures, no retries. @complexity O(b), bounded bytes/rows.
 * @example createMicrosoftAdsAdapter({ configuration, credentials, gateway, fetch, clock, timeoutSignal, observer, wait, download, archiveReader })
 */
export function createMicrosoftAdsAdapter(required: MicrosoftAdsDependencies): MicrosoftAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { async invoke(input, options) {
    const checked = prepare({ dependencies, input }, options);
    if (!checked.ok) return checked;
    const deadlineSignal = dependencies.timeoutSignal({ milliseconds: 60000 });
    const signal = options?.signal ? AbortSignal.any([options.signal, deadlineSignal]) : deadlineSignal;
    const execution = { dependencies, input: checked.value, signal };
    let result: Outcome<unknown>;
    try { result = await execute(execution); } catch { result = failure({ code: signal.aborted ? "expired" : "unavailable" }); }
    if (signal.aborted) result = failure({ code: "expired" });
    if (options?.signal?.aborted) result = failure({ code: "cancelled" });
    observe({ execution, result });
    if (!result.ok) return result;
    return { ok: true, value: { operationId: checked.value.operationId, status: "succeeded", observedState: "unknown", data: result.value } };
  } };
}
/** Parse/snapshot before I/O; deny missing admission and cross-workspace/account bindings. @complexity O(b<=16KiB). */
function prepare(required: { dependencies: MicrosoftAdsDependencies; input: MicrosoftAdsInvocation }, optional?: CallOptions): Outcome<MicrosoftAdsInvocation> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try { if (Buffer.byteLength(JSON.stringify(required.input)) > 16384) return failure({ code: "limit_exceeded" }); } catch { return failure({ code: "invalid_input" }); }
  const input = invocationSchema.safeParse(required.input);
  const config = configurationSchema.safeParse(required.dependencies.configuration);
  if (!input.success || !config.success) return failure({ code: "invalid_input" });
  if (!config.data.admitted) return failure({ code: "forbidden" });
  const scope = input.data.context.scope;
  if (scope.ownerId !== config.data.scope.ownerId || scope.workspaceId !== config.data.scope.workspaceId) return failure({ code: "forbidden" });
  if (!accountBound({ input: input.data, configuration: config.data })) return failure({ code: "forbidden" });
  return { ok: true, value: input.data };
}
function accountBound(required: { input: MicrosoftAdsInvocation; configuration: MicrosoftAdsDependencies["configuration"] }): boolean {
  if (required.input.command.kind === "list_accounts") return true;
  return required.configuration.accountId !== null && required.configuration.customerId !== null && required.configuration.currency !== null;
}
/** One account query or bounded report workflow. POST queries remain read effects. @complexity O(n), n<=10000. */
async function execute(required: Execution): Promise<Outcome<unknown>> {
  const { command } = required.input;
  const config = required.dependencies.configuration;
  const rpc = (input: { request: MicrosoftAdsWireRequest }) => dispatch({ execution: required, request: input.request, execute: () => send({ execution: required, request: input.request }) });
  const download: MicrosoftAdsDependencies["download"] = input => dispatch({ execution: required, request: { url: input.url, method: "GET" }, execute: () => required.dependencies.download(input, { signal: required.signal }) });
  if (command.kind === "report") return runReport({ dependencies: required.dependencies, command, rpc, download }, { signal: required.signal });
  let wire: MicrosoftAdsWireRequest;
  if (command.kind === "list_accounts") {
    const user = await rpc({ request: request({ service: "CustomerManagement", path: "User/Query", body: {} }) });
    if (!user.ok) return user;
    const parsed = userSchema.safeParse(user.value);
    if (!parsed.success) return failure({ code: "protocol_mismatch" });
    wire = request({ service: "CustomerManagement", path: "Accounts/Search", body: { Predicates: [{ Field: "UserId", Operator: "Equals", Value: parsed.data.User.Id }], Ordering: [{ Field: "Id", Order: "Ascending" }], PageInfo: { Index: command.pageIndex ?? 0, Size: command.pageSize ?? 100 } } });
  } else wire = request({ service: "CampaignManagement", path: "Campaigns/QueryByAccountId", body: { AccountId: Number(config.accountId), CampaignType: "Search" } });
  const response = await rpc({ request: wire });
  if (!response.ok) return response;
  return decodeList({ input: response.value, command, configuration: config });
}
/** Each RPC/download enters the same host policy/audit with fresh admission and binding checks.
 * Executes at most once; RPC credentials are resolved only inside the fence. @complexity O(b<=1MiB).
 */
async function dispatch<T>(required: { execution: Execution; request: MicrosoftAdsWireRequest; execute: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  const { dependencies, input, signal } = required.execution;
  let sent = false;
  return dependencies.gateway.dispatch({ context: input.context, configuration: dependencies.configuration, operation: input.command.kind, request: required.request,
    effect: { operationId: input.operationId, connectionId: dependencies.configuration.connectionId, accountId: dependencies.configuration.accountId, effects: ["read"], argumentsDigest: createHash("sha256").update(JSON.stringify(required.request)).digest("hex"), moneyExposure: null, requiredLimit: null },
    execute: async () => {
      if (sent) return failure({ code: "conflict" });
      sent = true;
      if (signal.aborted) return failure({ code: "expired" });
      return required.execute();
    },
  }, { signal });
}
/** Host credential wrappers recheck live binding around BOTH reads; guarded fetch checks again.
 * Strip late response evidence from public read failures. Secrets never leave headers.
 * @complexity Two credential reads and one <=15s RPC, zero retries.
 */
async function send(required: { execution: Execution; request: MicrosoftAdsWireRequest }): Promise<Outcome<unknown>> {
  const result = await requestMicrosoftAds({ dependencies: required.execution.dependencies, request: required.request }, { signal: required.execution.signal });
  return result.ok ? result : failure({ code: result.error.code });
}
/** Plugin-private transport shared by reads and owning server jobs. The host fetch MUST fence
 * current admission, account binding, exact approval/consent and audit after credential awaits.
 * Expired parsed responses retain a tainted body only for candidate-ID checkpointing.
 * @complexity Two credential reads, one <=15s RPC and <=1MiB response; no retry.
 */
export async function requestMicrosoftAds(required: { dependencies: MicrosoftAdsIoDependencies; request: MicrosoftAdsWireRequest }, optional?: CallOptions): Promise<MicrosoftAdsTransportResult> {
  const { dependencies } = required;
  if (!dependencies.configuration.admitted) return failure({ code: "forbidden" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const deadline = dependencies.timeoutSignal({ milliseconds: 15000 });
  const signal = optional?.signal ? AbortSignal.any([optional.signal, deadline]) : deadline;
  const config = dependencies.configuration;
  const credentials = await resolveCredentials({ dependencies, signal });
  if (!credentials.ok) return credentials;
  if (!config.admitted) return failure({ code: "forbidden" });
  if (signal.aborted) return failure({ code: "expired" });
  const headers: Record<string, string> = { Authorization: "Bearer " + credentials.value[0].accessToken, DeveloperToken: credentials.value[1].accessToken, "Content-Type": "application/json" };
  if (config.accountId) headers.CustomerAccountId = config.accountId;
  if (config.customerId) headers.CustomerId = config.customerId;
  const response = await dependencies.fetch(required.request.url, { method: "POST", body: required.request.body, headers, redirect: "error", signal });
  return readResponse({ response, signal });
}
/** Bound and parse the response; a deadline rejects success while preserving received evidence.
 * @complexity O(b<=1MiB) time/space; no additional requests or retries.
 */
async function readResponse(required: { response: Response; signal: AbortSignal }): Promise<MicrosoftAdsTransportResult> {
  const { response, signal } = required;
  if (response.status !== 200) { await response.body?.cancel(); return failure({ code: response.status === 429 ? "limit_exceeded" : "unavailable" }); }
  const result = await readJson({ response });
  if (signal.aborted && result.ok) return { ...failure({ code: "expired" }), receivedBody: result.value };
  if (signal.aborted) return failure({ code: "expired" });
  return result;
}
/** Two host-scoped secret reads; strip tainted errors and validate header-safe tokens/expiry. @complexity O(1). */
async function resolveCredentials(required: { dependencies: MicrosoftAdsIoDependencies; signal: AbortSignal }): Promise<Outcome<Credentials>> {
  const { dependencies, signal } = required;
  const config = dependencies.configuration;
  const token = await dependencies.credentials.access({ connectionId: config.connectionId, accountId: config.accountId }, { signal });
  if (!token.ok) return failure({ code: token.error.code });
  const developer = await dependencies.credentials.access({ connectionId: "developer-token.microsoft-ads", accountId: null }, { signal });
  if (!developer.ok) return failure({ code: developer.error.code });
  const credentials = z.tuple([credentialSchema, credentialSchema]).safeParse([token.value, developer.value]);
  if (!credentials.success) return failure({ code: "unauthenticated" });
  const now = dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (credentials.data.some(item => item.expiresAt !== undefined && item.expiresAt <= now)) return failure({ code: "expired" });
  return { ok: true, value: credentials.data };
}
/** Bound streamed bytes before JSON parsing, irrespective of Content-Length. @complexity O(b<=1MiB). */
async function readJson(required: { response: Response }): Promise<Outcome<unknown>> {
  const reader = required.response.body?.getReader();
  if (!reader) return failure({ code: "protocol_mismatch" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
    chunks.push(part.value);
  }
  try { return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown }; } catch { return failure({ code: "protocol_mismatch" }); }
}
/** Correlation-only telemetry; durable egress audit is server-owned. @complexity O(1). */
function observe(required: { execution: Execution; result: Outcome<unknown> }): void {
  const { context, command } = required.execution.input;
  try { required.execution.dependencies.observer.observe({ operation: "microsoft-ads." + command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); } catch { /* Host audit remains authoritative. */ }
}
