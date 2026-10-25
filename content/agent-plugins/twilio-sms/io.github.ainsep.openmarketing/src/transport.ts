import { createHash } from "node:crypto";
import { z } from "zod";
import { epochSchema, parseBoundary } from "@open-marketing/contracts";
import type { AppError, CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import { configurationSchema, decodeTwilioRead, encodeTwilioRead, invocationSchema } from "./commands.js";
import type { TwilioConfiguration, TwilioDependencies, TwilioInvocation, TwilioResult, TwilioSmsAdapter } from "./ports.js";

const credentialSchema = z.strictObject({ accountSid: configurationSchema.shape.accountSid, apiKeySid: z.string().regex(/^SK[0-9a-fA-F]{32}$/), apiKeySecret: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
interface Prepared { configuration: TwilioConfiguration; invocation: TwilioInvocation; url: string; effect: EffectEnvelope }

/** Inert factory using server broker/gateway and injected fetch, deadline, clock and observer.
 * @returns Typed read results/errors; no services, retries, sends or secret persistence.
 * @example createTwilioSmsAdapter({ configuration, credentials, gateway, fetch, deadlineSignal, clock, observer })
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

/** Admission and all identifiers validate before broker or gateway access. @complexity O(1). */
function prepare(required: { dependencies: TwilioDependencies; input: TwilioInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const config = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!config.ok) return config;
  if (!config.value.admitted) return failure({ code: "forbidden" });
  const input = parseBoundary({ schema: invocationSchema, input: required.input });
  if (!input.ok) return input;
  const c = config.value;
  const scope = input.value.context.scope;
  if (scope.ownerId !== c.scope.ownerId || scope.workspaceId !== c.scope.workspaceId || input.value.command.connectionId !== c.connectionId) return failure({ code: "forbidden" });
  const url = encodeTwilioRead({ configuration: c, command: input.value.command });
  if (url === null) return failure({ code: "unavailable" });
  const argumentsDigest = createHash("sha256").update(JSON.stringify({ pluginDigest: c.pluginDigest, command: input.value.command, url })).digest("hex");
  const effect: EffectEnvelope = { operationId: input.value.operationId, connectionId: c.connectionId, accountId: c.accountSid, effects: ["read"], argumentsDigest, moneyExposure: null, requiredLimit: null };
  return { ok: true, value: { configuration: c, invocation: input.value, url, effect } };
}

/** Broker/gateway failures retain only their code, never text or retry authority.
 * Host authority remains current at execute. No retries. @complexity O(1) time/space.
 */
async function dispatch(required: { dependencies: TwilioDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<TwilioResult>> {
  const { dependencies, prepared } = required;
  const c = prepared.configuration;
  try {
    const credential = await dependencies.credentials.access({ context: structuredClone(prepared.invocation.context), connectionId: c.connectionId, accountSid: c.accountSid }, optional);
    if (!credential.ok) return failure({ code: credential.error.code });
    const parsed = credentialSchema.safeParse(credential.value);
    if (!parsed.success) return failure({ code: "unauthenticated" });
    if (parsed.data.accountSid !== c.accountSid) return failure({ code: "forbidden" });
    let executed = false;
    const result = await dependencies.gateway.dispatch({
      context: structuredClone(prepared.invocation.context), configuration: structuredClone(c), command: structuredClone(prepared.invocation.command), effect: structuredClone(prepared.effect),
      execute: async () => {
        if (executed) return failure({ code: "conflict" });
        executed = true;
        if (optional?.signal?.aborted) return failure({ code: "cancelled" });
        const now = dependencies.clock.now({});
        if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
        if (parsed.data.expiresAt !== undefined && now >= parsed.data.expiresAt) return failure({ code: "expired" });
        return request({ dependencies, prepared, credential: parsed.data }, optional);
      },
    }, optional);
    return result.ok ? result : failure({ code: result.error.code });
  } catch { return failure({ code: "unavailable" }); }
}

/** Only Basic API-key auth, fixed HTTPS origins and no redirects. Never return provider errors.
 * @complexity O(b) time/space, b<=64KiB; one 15s fetch including stream consumption.
 */
async function request(required: { dependencies: TwilioDependencies; prepared: Prepared; credential: z.infer<typeof credentialSchema> }, optional?: CallOptions): Promise<Outcome<TwilioResult>> {
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
    const data = decodeTwilioRead({ configuration: prepared.configuration, command: prepared.invocation.command, input: body.value });
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
