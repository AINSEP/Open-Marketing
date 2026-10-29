import { z } from "zod";
import { definePluginTools, epochSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome, PluginCapabilityDependencies, PluginToolsFactory } from "@open-marketing/contracts";
import { accountSchema, invocationSchema, sendersSchema, templatesSchema, vendorIdSchema, whatsappBusinessTools } from "./commands.js";
import type { WhatsAppReadCommand } from "./commands.js";
import type { WhatsAppBusinessAdapter, WhatsAppConfiguration, WhatsAppDependencies, WhatsAppInvocation, WhatsAppReadResult, WhatsAppWireRequest } from "./ports.js";

export const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorIdSchema });
/** Pure discovery and parsing over the existing read schemas; declarations grant no authority. */
export const { tools, parseTool } = definePluginTools({ tools: whatsappBusinessTools.map(tool => ({
  name: tool.name, description: "WhatsApp Business " + tool.name, effects: ["read"], inputSchema: tool.inputSchema,
})) });

/** Bind standard host invocations to the existing read adapter, with call-local wait cleanup.
 * @returns An inert invoker; invalid configuration/input or a foreign connection fails before I/O.
 * @example createTools({ configuration, credentials, fetch, clock, observer, wait })
 * @complexity O(1) construction; each invoke retains one deadline and one bounded GET.
 */
export function createTools(required: PluginCapabilityDependencies): ReturnType<PluginToolsFactory> {
  return { async invoke(invocation, options) {
    const configuration = configurationSchema.safeParse(required.configuration);
    if (!configuration.success) return failure({ code: "invalid_input" });
    const connection = invocation.connection;
    if (connection.accountId === null || connection.connectionId !== configuration.data.connectionId || connection.accountId !== configuration.data.accountId) return failure({ code: "forbidden" });
    const command = parseTool({ name: invocation.name, input: invocation.input });
    if (!command.ok) return command;
    const timers: AbortController[] = [];
    const dependencies: WhatsAppDependencies = { configuration: configuration.data,
      credentials: required.credentials, fetch: required.fetch, clock: required.clock, observer: required.observer,
      createDeadline: ({ timeoutMs }) => {
        const timer = new AbortController(), deadline = new AbortController();
        timers.push(timer);
        void required.wait({ milliseconds: timeoutMs }, { signal: timer.signal }).then(() => { if (!timer.signal.aborted) deadline.abort(); }, () => { if (!timer.signal.aborted) deadline.abort(); });
        return deadline.signal;
      },
    };
    try {
      return await createWhatsAppBusinessAdapter(dependencies).invoke({ context: invocation.context, operationId: invocation.operationId, command: command.value as WhatsAppReadCommand }, options);
    } finally { timers.forEach(timer => timer.abort()); }
  } };
}

/** Fixed supported Graph version; install settings cannot override vendor paths. */
export const apiVersion = "v26.0";
const secretValue = z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const graphId = z.string().regex(/^[0-9]{1,32}$/);
// Resolve the token card per call; WABA identity must match the host account binding.
const credentialSchema = z.strictObject({ accessToken: secretValue, wabaId: graphId.optional(), phoneNumberId: graphId.optional(), appSecret: secretValue.optional() });
export type Credential = z.infer<typeof credentialSchema> & { expiresAt?: number };

/** Decode the broker's JSON card for this call only; malformed cards return a fixed, secret-free failure.
 * @complexity O(b) time/space, card JSON capped at 16KiB; no I/O. */
export function parseCredential(required: { envelope: { accessToken: string; expiresAt?: number } }): Outcome<Credential> {
  try {
    if (required.envelope.accessToken.length > 16384) return failure({ code: "unauthenticated" });
    const card = credentialSchema.safeParse(JSON.parse(required.envelope.accessToken) as unknown);
    if (!card.success) return failure({ code: "unauthenticated" });
    return { ok: true, value: { ...card.data, expiresAt: required.envelope.expiresAt } };
  } catch { return failure({ code: "unauthenticated" }); }
}
type Invocation = z.infer<typeof invocationSchema>;
interface Prepared { configuration: WhatsAppConfiguration; invocation: Invocation; request: WhatsAppWireRequest }

/** Inert factory; invoke returns typed failures and performs one admitted, bounded GET.
 * @example createWhatsAppBusinessAdapter({ configuration, credentials, fetch, clock, observer, createDeadline })
 * @complexity O(b) time/space, b<=1MiB per response; no retries or automatic pagination.
 */
export function createWhatsAppBusinessAdapter(required: WhatsAppDependencies): WhatsAppBusinessAdapter {
  const configuration = configurationSchema.safeParse(required.configuration);
  return { async invoke(input, options) {
    if (!configuration.success) return failure({ code: "invalid_input" });
    try {
      const prepared = prepare({ configuration: configuration.data, input }, options);
      if (!prepared.ok) return prepared;
      return await dispatch({ dependencies: required, prepared: prepared.value }, options);
    } catch { return failure({ code: "unavailable" }); }
  } };
}

/** Validate and bind before credentials or HTTP I/O. @complexity O(b), input<=64KiB. */
function prepare(required: { configuration: WhatsAppConfiguration; input: WhatsAppInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  let serialized: string | undefined;
  try { serialized = JSON.stringify(required.input); }
  catch { return failure({ code: "invalid_input" }); }
  if (!serialized || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
  const parsed = invocationSchema.safeParse(JSON.parse(serialized));
  if (!parsed.success) return failure({ code: "invalid_input" });
  const scope = parsed.data.context.scope;
  if (scope.ownerId !== required.configuration.scope.ownerId || scope.workspaceId !== required.configuration.scope.workspaceId) return failure({ code: "forbidden" });
  const request = encodeRequest({ configuration: required.configuration, invocation: parsed.data });
  return { ok: true, value: { configuration: required.configuration, invocation: parsed.data, request } };
}

/** Pure fixed endpoint selection; cursor values only fill encoded query parameters. @complexity O(b). */
function encodeRequest(required: { configuration: WhatsAppConfiguration; invocation: Invocation }): WhatsAppWireRequest {
  const { configuration, invocation: { command } } = required;
  const base = `https://graph.facebook.com/${apiVersion}/${configuration.accountId}`;
  if (command.kind === "get_account_status") return { method: "GET", url: base + "?fields=id,name,business_verification_status,account_review_status" };
  const endpoint = command.kind === "list_senders" ? "phone_numbers" : "message_templates";
  const fields = command.kind === "list_senders" ? "id,display_phone_number,verified_name,quality_rating,name_status,code_verification_status,messaging_limit_tier" : "id,name,language,status,category";
  const query = new URLSearchParams({ fields, limit: String(command.limit) });
  if (command.after !== undefined) query.set("after", command.after);
  return { method: "GET", url: `${base}/${endpoint}?${query}` };
}

/** Host guarded effects own current authority and durable audit; telemetry excludes request/response data.
 * @complexity O(b), one broker access and one GET at most.
 */
async function dispatch(required: { dependencies: WhatsAppDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<WhatsAppReadResult>> {
  const { dependencies, prepared } = required;
  let result: Outcome<WhatsAppReadResult>;
  try {
    result = await executeRead({ dependencies, prepared }, optional);
  } catch { result = failure({ code: "unavailable" }); }
  if (optional?.signal?.aborted) result = failure({ code: "cancelled" });
  try {
    dependencies.observer.observe({ operation: "whatsapp-business." + prepared.invocation.command.kind, outcome: result.ok ? "succeeded" : result.error.code,
      correlationId: prepared.invocation.context.correlationId, traceId: prepared.invocation.context.traceId, runId: prepared.invocation.context.runId });
  } catch { /* Host audit is authoritative; telemetry cannot change the read result. */ }
  return result;
}

/** Broker output is tainted. Cancellation and expiry recheck immediately before fetch.
 * @complexity O(b) response validation; one 15s GET with redirects disabled and zero retries.
 */
async function executeRead(required: { dependencies: WhatsAppDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<WhatsAppReadResult>> {
  const { dependencies, prepared } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const credential = await dependencies.credentials.access({ connectionId: prepared.configuration.connectionId, accountId: prepared.configuration.accountId }, optional);
  if (!credential.ok) return failure({ code: credential.error.code });
  const parsed = parseCredential({ envelope: credential.value });
  if (!parsed.ok) return parsed;
  if (parsed.value.wabaId !== prepared.configuration.accountId) return failure({ code: "forbidden" });
  const now = dependencies.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (parsed.value.expiresAt !== undefined && now >= parsed.value.expiresAt) return failure({ code: "expired" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  return fetchRead({ dependencies, prepared, accessToken: parsed.value.accessToken }, optional);
}

/** One bounded GET; caller cancellation is classified by dispatch, deadlines as unavailable.
 * @complexity O(b) time/space, b<=1MiB; injected deadline covers fetch and body consumption.
 */
async function fetchRead(required: { dependencies: WhatsAppDependencies; prepared: Prepared; accessToken: string }, optional?: CallOptions): Promise<Outcome<WhatsAppReadResult>> {
  const { dependencies, prepared } = required;
  const deadline = dependencies.createDeadline({ timeoutMs: 15000 });
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  if (signal.aborted) return failure({ code: "unavailable" });
  const response = await dependencies.fetch(prepared.request.url, { method: "GET", redirect: "error", signal, headers: { Authorization: "Bearer " + required.accessToken } });
  if (signal.aborted) { await response.body?.cancel(); return failure({ code: "unavailable" }); }
  if (!response.ok) { await response.body?.cancel(); return httpFailure({ status: response.status }); }
  const body = await readBody({ response });
  if (signal.aborted) return failure({ code: "unavailable" });
  if (!body.ok) return body;
  return decode({ prepared, body: body.value });
}

/** Stream cap is enforced before JSON parsing, independent of Content-Length. @complexity O(b), b<=1MiB. */
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
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}

/** Schema-project one page; never follow provider links or turn missing status into readiness. @complexity O(n), n<=100. */
function decode(required: { prepared: Prepared; body: unknown }): Outcome<WhatsAppReadResult> {
  const { configuration, invocation } = required.prepared;
  if (invocation.command.kind === "get_account_status") {
    const parsed = accountSchema.safeParse(required.body);
    if (!parsed.success || parsed.data.id !== configuration.accountId) return failure({ code: "protocol_mismatch" });
    return { ok: true, value: { operationId: invocation.operationId, data: parsed.data } };
  }
  const schema = invocation.command.kind === "list_senders" ? sendersSchema : templatesSchema;
  const parsed = schema.safeParse(required.body);
  if (!parsed.success || parsed.data.data.length > invocation.command.limit) return failure({ code: "protocol_mismatch" });
  const cursor = parsed.data.paging?.next === undefined ? null : parsed.data.paging.cursors!.after!;
  return { ok: true, value: { operationId: invocation.operationId, data: { items: parsed.data.data, cursor } } };
}

/** Redacted HTTP classification; provider bodies and tokens never become error text. @complexity O(1). */
function httpFailure(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: required.status >= 500 ? "unavailable" : "protocol_mismatch" });
  }
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "WhatsApp Business request failed", retryable: false } }; }
