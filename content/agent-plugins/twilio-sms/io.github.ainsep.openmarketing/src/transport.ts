import { z } from "zod";
import { definePluginTools, epochSchema, parseBoundary } from "@open-marketing/contracts";
import type { AppError, CallOptions, Outcome, PluginCapabilityDependencies, PluginToolsFactory } from "@open-marketing/contracts";
import { credentialSchema, configurationSchema, decodeTwilioRead, encodeTwilioRead, invocationSchema, twilioSmsTools } from "./commands.js";
import type { TwilioCommand, TwilioConfiguration, TwilioDependencies, TwilioInvocation, TwilioResult, TwilioSmsAdapter } from "./ports.js";
import type { Credential } from "./commands.js";
export type { Credential } from "./commands.js";

/** Pure discovery and parsing over the existing read schemas; declarations grant no authority. */
export const { tools, parseTool } = definePluginTools({ tools: twilioSmsTools.map(tool => ({
  name: tool.name, description: "Twilio SMS " + tool.name, effects: ["read"], inputSchema: tool.inputSchema,
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
    const dependencies: TwilioDependencies = { configuration: configuration.data,
      credentials: required.credentials, fetch: required.fetch, clock: required.clock, observer: required.observer,
      deadlineSignal: ({ timeoutMs }) => {
        const timer = new AbortController(), deadline = new AbortController();
        timers.push(timer);
        void required.wait({ milliseconds: timeoutMs }, { signal: timer.signal }).then(() => { if (!timer.signal.aborted) deadline.abort(); }, () => { if (!timer.signal.aborted) deadline.abort(); });
        return deadline.signal;
      },
    };
    try {
      return await createTwilioSmsAdapter(dependencies).invoke({ context: invocation.context, operationId: invocation.operationId, command: command.value as TwilioCommand }, options);
    } finally { timers.forEach(timer => timer.abort()); }
  } };
}

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
interface Prepared { configuration: TwilioConfiguration; invocation: TwilioInvocation }

/** Inert factory using server broker and injected guarded fetch, deadline, clock and observer.
 * @returns Typed read results/errors; no services, retries, sends or secret persistence.
 * @example createTwilioSmsAdapter({ configuration, credentials, fetch, deadlineSignal, clock, observer })
 * @complexity O(b) per invoke, b<=64KiB, one GET with a 15s deadline.
 */
export function createTwilioSmsAdapter(required: TwilioDependencies): TwilioSmsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    const result = await dispatch({ dependencies, prepared: prepared.value }, options);
    observe({ dependencies, input: prepared.value.invocation, result });
    return result;
  } };
}

/** Configuration and all identifiers validate before broker access. @complexity O(1). */
function prepare(required: { dependencies: TwilioDependencies; input: TwilioInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const config = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!config.ok) return config;
  const input = parseBoundary({ schema: invocationSchema, input: required.input });
  if (!input.ok) return input;
  const c = config.value;
  const scope = input.value.context.scope;
  if (scope.ownerId !== c.scope.ownerId || scope.workspaceId !== c.scope.workspaceId) return failure({ code: "forbidden" });
  return { ok: true, value: { configuration: c, invocation: input.value } };
}

/** Broker failures retain only their code, never text or retry authority.
 * Host guarded fetch retains current authority through egress. No retries. @complexity O(1) time/space.
 */
async function dispatch(required: { dependencies: TwilioDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<TwilioResult>> {
  const { dependencies, prepared } = required;
  const c = prepared.configuration;
  try {
    const credential = await dependencies.credentials.access({ connectionId: c.connectionId, accountId: c.accountId }, optional);
    if (!credential.ok) return failure({ code: credential.error.code });
    const parsed = parseCredential({ envelope: credential.value });
    if (!parsed.ok) return parsed;
    if (parsed.value.accountSid !== c.accountId) return failure({ code: "forbidden" });
    const url = encodeTwilioRead({ credential: parsed.value, command: prepared.invocation.command });
    if (url === null) return failure({ code: "unavailable" });
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const now = dependencies.clock.now({});
    if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
    if (parsed.value.expiresAt !== undefined && now >= parsed.value.expiresAt) return failure({ code: "expired" });
    return request({ dependencies, prepared: { ...prepared, url }, credential: parsed.value }, optional);
  } catch { return failure({ code: "unavailable" }); }
}

/** Only Basic API-key auth, fixed HTTPS origins and no redirects. Never return provider errors.
 * @complexity O(b) time/space, b<=64KiB; one 15s fetch including stream consumption.
 */
async function request(required: { dependencies: TwilioDependencies; prepared: Prepared & { url: string }; credential: Credential }, optional?: CallOptions): Promise<Outcome<TwilioResult>> {
  const { dependencies, prepared, credential } = required;
  try {
    const deadline = dependencies.deadlineSignal({ timeoutMs: 15000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    signal.throwIfAborted();
    const response = await dependencies.fetch(prepared.url, { method: "GET", redirect: "error", signal, headers: { Authorization: "Basic " + Buffer.from(credential.apiKeySid + ":" + credential.apiKeySecret).toString("base64"), Accept: "application/json" } });
    if (response.status !== 200) {
      await response.body?.cancel();
      signal.throwIfAborted();
      return httpFailure({ status: response.status, invocation: prepared.invocation });
    }
    const body = await readBody({ response });
    signal.throwIfAborted();
    if (!body.ok) return body;
    const data = decodeTwilioRead({ credential, command: prepared.invocation.command, input: body.value });
    if (!data.ok) return data;
    return { ok: true, value: { operationId: prepared.invocation.operationId, status: "succeeded", sendReadiness: "unknown", data: data.value } };
  } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
}

/** Discard provider bodies. Accounts 401 is ambiguous: Standard keys exclude Accounts even when valid.
 * @returns A permission-limited observation or sanitized failure. @complexity O(1) time/space.
 */
function httpFailure(required: { status: number; invocation: TwilioInvocation }): Outcome<TwilioResult> {
  const accountDenied = required.status === 401 && required.invocation.command.kind === "account_status";
  if (required.status === 403 || accountDenied) return { ok: true, value: { operationId: required.invocation.operationId, status: "permission_limited", sendReadiness: "unknown", data: null } };
  return failure({ code: required.status === 401 ? "unauthenticated" : "unavailable" });
}

/** Enforce bytes before JSON parsing, independent of Content-Length. @complexity O(b), b<=64KiB. */
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
      if (bytes > 65536) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}

/** Context IDs and outcome only; host owns durable pre-egress audit. @complexity O(1). */
function observe(required: { dependencies: TwilioDependencies; input: TwilioInvocation; result: Outcome<TwilioResult> }): void {
  const { input, result } = required;
  try { required.dependencies.observer.observe({ operation: "twilio-sms." + input.command.kind, outcome: result.ok ? result.value.status : result.error.code, correlationId: input.context.correlationId, traceId: input.context.traceId, runId: input.context.runId }); }
  catch { /* Telemetry cannot rewrite a read result; durable host audit remains authoritative. */ }
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Twilio read " + required.code, retryable: false } }; }
