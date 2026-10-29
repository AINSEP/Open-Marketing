import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, serviceContextSchema, campaignStatusInputSchema, campaignStatusOutputSchema, reportMetricsInputSchema, digestSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapability, MetricBatch, CampaignStatusOutput } from "@open-marketing/contracts";
import { commandSchema, decodeList, request, userSchema, vendorIdSchema } from "./commands.js";
import { runReport, runMetricsReport, runCampaignStatus } from "./reporting.js";
import { failure } from "./ports.js";
import type { MicrosoftAdsAdapter, MicrosoftAdsDependencies, MicrosoftAdsInvocation, MicrosoftAdsWireRequest, MicrosoftAdsIoDependencies } from "./ports.js";
export const configurationSchema = z.strictObject({ scope: scopeSchema, admitted: z.boolean().default(false), connectionId: idSchema, accountId: vendorIdSchema.nullable(), customerId: vendorIdSchema.nullable(), currency: z.string().regex(/^[A-Z]{3}$/).nullable(), pluginDigest: digestSchema, bindingId: idSchema });
const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Shared header-safe OAuth token and optional expiry, parsed on each credential access. */
export const credentialSchema = z.object({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() });
type Execution = { dependencies: MicrosoftAdsDependencies; input: MicrosoftAdsInvocation; signal: AbortSignal };
/** Declared plugin secret and OAuth share one bound, header-safe credential result. */
export const pluginCredentialSchema = credentialSchema.extend({ secrets: z.object({ developerToken: credentialSchema.shape.accessToken }) });
type Credentials = z.infer<typeof pluginCredentialSchema>;
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
/** Parse/snapshot before I/O; deny cross-workspace/account bindings before the host fence. @complexity O(b<=16KiB). */
function prepare(required: { dependencies: MicrosoftAdsDependencies; input: MicrosoftAdsInvocation }, optional?: CallOptions): Outcome<MicrosoftAdsInvocation> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try { if (Buffer.byteLength(JSON.stringify(required.input)) > 16384) return failure({ code: "limit_exceeded" }); } catch { return failure({ code: "invalid_input" }); }
  const input = invocationSchema.safeParse(required.input);
  const config = configurationSchema.safeParse(required.dependencies.configuration);
  if (!input.success || !config.success) return failure({ code: "invalid_input" });
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
/** Host credential wrappers recheck live binding around the bound lookup; guarded fetch checks again.
 * Strip late response evidence from public read failures. Secrets never leave headers.
 * @complexity One credential read and one <=15s RPC, zero retries.
 */
async function send(required: { execution: Execution; request: MicrosoftAdsWireRequest }): Promise<Outcome<unknown>> {
  const result = await requestMicrosoftAds({ dependencies: required.execution.dependencies, request: required.request }, { signal: required.execution.signal });
  return result.ok ? result : failure({ code: result.error.code });
}
/** Plugin-private transport shared by reads and owning server jobs. The host fetch MUST fence
 * current admission, account binding, exact approval/consent and audit after credential awaits.
 * Expired parsed responses retain a tainted body only for candidate-ID checkpointing.
 * @complexity One credential read, one <=15s RPC and <=1MiB response; no retry.
 */
export async function requestMicrosoftAds(required: { dependencies: MicrosoftAdsIoDependencies; request: MicrosoftAdsWireRequest }, optional?: CallOptions): Promise<MicrosoftAdsTransportResult> {
  const { dependencies } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const deadline = dependencies.timeoutSignal({ milliseconds: 15000 });
  const signal = optional?.signal ? AbortSignal.any([optional.signal, deadline]) : deadline;
  const config = dependencies.configuration;
  const credentials = await resolveCredentials({ dependencies, signal });
  if (!credentials.ok) return credentials;
  if (signal.aborted) return failure({ code: "expired" });
  return postMicrosoftAds({ fetch: dependencies.fetch, request: required.request, accessToken: credentials.value.accessToken, developerToken: credentials.value.secrets.developerToken, accountId: config.accountId, customerId: config.customerId, signal });
}
/** Shared JSON POST with header-only secrets and static response failures; no retries.
 * @complexity One request, O(b<=1MiB) time/space. Caller owns credentials and deadline.
 */
export async function postMicrosoftAds(required: { fetch: typeof fetch; request: MicrosoftAdsWireRequest; accessToken: string; developerToken: string; accountId?: string | null; customerId?: string | null; signal: AbortSignal }): Promise<MicrosoftAdsTransportResult> {
  const { signal } = required;
  const headers: Record<string, string> = { Authorization: "Bearer " + required.accessToken, DeveloperToken: required.developerToken, "Content-Type": "application/json" };
  if (required.accountId) headers.CustomerAccountId = required.accountId;
  if (required.customerId) headers.CustomerId = required.customerId;
  const response = await required.fetch(required.request.url, { method: "POST", body: required.request.body, headers, redirect: "error", signal });
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
/** One host-scoped lookup; strip tainted errors and validate header-safe tokens/expiry. @complexity O(1). */
async function resolveCredentials(required: { dependencies: MicrosoftAdsIoDependencies; signal: AbortSignal }): Promise<Outcome<Credentials>> {
  const { dependencies, signal } = required;
  const config = dependencies.configuration;
  const token = await dependencies.credentials.access({ connectionId: config.connectionId, accountId: config.accountId }, { signal });
  if (!token.ok) return failure({ code: token.error.code });
  const credentials = pluginCredentialSchema.safeParse(token.value);
  if (!credentials.success) return failure({ code: "unauthenticated" });
  const now = dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (credentials.data.expiresAt !== undefined && credentials.data.expiresAt <= now) return failure({ code: "expired" });
  return { ok: true, value: credentials.data };
}
/** Bound streamed bytes irrespective of Content-Length, shared by JSON and ZIP downloads.
 * @complexity O(b) time/space, b<=maxBytes; cancels the reader on overflow.
 */
export async function readBounded(required: { response: Response; maxBytes: number }): Promise<Outcome<Uint8Array>> {
  const reader = required.response.body?.getReader();
  if (!reader) return failure({ code: "protocol_mismatch" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > required.maxBytes) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
    chunks.push(part.value);
  }
  return { ok: true, value: Buffer.concat(chunks) };
}
/** Parse bounded JSON without exposing provider bodies in errors. @complexity O(b<=1MiB). */
async function readJson(required: { response: Response }): Promise<Outcome<unknown>> {
  const bytes = await readBounded({ ...required, maxBytes: 1048576 });
  if (!bytes.ok) return bytes;
  try { return { ok: true, value: JSON.parse(Buffer.from(bytes.value).toString("utf8")) as unknown }; } catch { return failure({ code: "protocol_mismatch" }); }
}
/** Correlation-only telemetry; durable egress audit is server-owned. @complexity O(1). */
function observe(required: { execution: Execution; result: Outcome<unknown> }): void {
  const { context, command } = required.execution.input;
  try { required.execution.dependencies.observer.observe({ operation: "microsoft-ads." + command.kind, outcome: required.result.ok ? "succeeded" : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); } catch { /* Host audit remains authoritative. */ }
}

const capabilityConnection = z.strictObject({ connectionId: idSchema, accountId: vendorIdSchema });
type MetricsCall = Parameters<PluginCapability<"report.metrics.v1">>[0] & { dependencies: MicrosoftAdsDependencies };
type StatusCall = Parameters<PluginCapability<"campaign.status.v1">>[0] & { dependencies: MicrosoftAdsDependencies };
/** Read UTC daily performance for any server-bound account timezone.
 * @example reportMetrics({ dependencies, context, connection, input })
 * @returns Frozen-schema batch or typed failure. @complexity O(b+n), <=8MiB/5,000 rows/25s reporting budget.
 */
export async function reportMetrics(required: MetricsCall, optional?: CallOptions): Promise<Outcome<MetricBatch>> {
  try {
    const input = reportMetricsInputSchema.safeParse(required.input);
    if (!input.success) return failure({ code: "invalid_input" });
    const execution = capabilityExecution({ ...required, command: { kind: "report", window: { start: Date.parse(input.data.days.start), end: Date.parse(input.data.days.end) } } }, optional);
    if (!execution.ok) return execution;
    const e = execution.value;
    const result = await runMetricsReport({ dependencies: e.dependencies, input: input.data, rpc: capabilityRpc({ execution: e }),
      download: input => dispatch({ execution: e, request: { url: input.url, method: "GET" }, execute: () => e.dependencies.download(input, { signal: e.signal }) }),
    }, { signal: e.signal });
    observe({ execution: e, result });
    if (e.signal.aborted) return failure({ code: optional?.signal?.aborted ? "cancelled" : "expired" });
    return result;
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
/** Scoped Search campaign lifecycle plus editorial reasons; other campaign types are unverified.
 * @example campaignStatus({ dependencies, context, connection, input: { vendorCampaignIds: ["456"] } })
 * @returns Frozen-schema observations, including unknown missing IDs. O(n), <=1,000 RPCs/60s.
 */
export async function campaignStatus(required: StatusCall, optional?: CallOptions): Promise<Outcome<CampaignStatusOutput>> {
  try {
    const input = campaignStatusInputSchema.safeParse(required.input);
    if (!input.success || input.data.vendorCampaignIds.some(id => !vendorIdSchema.safeParse(id).success)) return failure({ code: "invalid_input" });
    const execution = capabilityExecution({ ...required, command: { kind: "list_campaigns" } }, optional);
    if (!execution.ok) return execution;
    const e = execution.value;
    const result = await runCampaignStatus({ campaignIds: input.data.vendorCampaignIds, accountId: e.dependencies.configuration.accountId!, rpc: capabilityRpc({ execution: e, deadline: e.dependencies.clock.now({}) + 25000 }), clock: e.dependencies.clock });
    observe({ execution: e, result });
    if (e.signal.aborted) return failure({ code: optional?.signal?.aborted ? "cancelled" : "expired" });
    if (!result.ok) return result;
    const output = campaignStatusOutputSchema.safeParse(result.value);
    return output.success ? { ok: true, value: output.data } : failure({ code: "protocol_mismatch" });
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}
/** Parse the frozen context/connection and preserve service identity through the existing fence. */
function capabilityExecution(required: { context: MetricsCall["context"]; connection: MetricsCall["connection"]; dependencies: MicrosoftAdsDependencies; command: MicrosoftAdsInvocation["command"] }, optional?: CallOptions): Outcome<Execution> {
  const service = serviceContextSchema.safeParse(required.context);
  const context: unknown = service.success ? { scope: service.data.scope, principal: { kind: "service", serviceId: service.data.serviceId }, correlationId: service.data.correlationId, traceId: service.data.traceId } : required.context;
  const parsedContext = callContextSchema.safeParse(context);
  const connection = capabilityConnection.safeParse(required.connection);
  if (!parsedContext.success || !connection.success) return failure({ code: "invalid_input" });
  const config = required.dependencies.configuration;
  if (connection.data.connectionId !== config.connectionId || connection.data.accountId !== config.accountId) return failure({ code: "forbidden" });
  const input = prepare({ dependencies: required.dependencies, input: { context: parsedContext.data, operationId: parsedContext.data.correlationId, command: required.command } }, optional);
  if (!input.ok) return input;
  const deadline = required.dependencies.timeoutSignal({ milliseconds: 60000 });
  return { ok: true, value: { dependencies: { ...required.dependencies, configuration: structuredClone(config) }, input: input.value, signal: optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline } };
}
/** One capped read workflow. Status RPCs share a 25s soft budget; only its exhaustion becomes partial coverage. Caller cancellation and credential expiry remain failures. */
function capabilityRpc({ execution, deadline }: { execution: Execution; deadline?: number }): (required: { request: MicrosoftAdsWireRequest }) => Promise<Outcome<unknown>> {
  let requests = 0;
  return async input => {
    if (++requests > 1000) return failure({ code: "limit_exceeded" });
    if (execution.signal.aborted) return failure({ code: "expired" });
    if (deadline === undefined) return dispatch({ execution, request: input.request, execute: () => send({ execution, request: input.request }) });
    const remaining = deadline - execution.dependencies.clock.now({});
    if (remaining <= 0) return failure({ code: "limit_exceeded" });
    const softDeadline = execution.dependencies.timeoutSignal({ milliseconds: remaining });
    const bounded = { ...execution, signal: AbortSignal.any([execution.signal, softDeadline]) };
    let result: Outcome<unknown>;
    try {
      result = await dispatch({ execution: bounded, request: input.request, execute: () => send({ execution: bounded, request: input.request }) });
    } catch {
      result = failure({ code: execution.signal.aborted ? "expired" : "unavailable" });
    }
    return softDeadline.aborted && !execution.signal.aborted ? failure({ code: "limit_exceeded" }) : result;
  };
}
