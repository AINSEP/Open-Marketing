import { z } from "zod";
import { digestSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import { domainSchema, encodeResendCommand, invocationSchema, resendEmailDigest } from "./commands.js";
import type { ResendEmailAdapter, ResendEmailDependencies, ResendEmailInvocation, ResendEmailRequest, ResendEmailResult } from "./ports.js";

const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, pluginDigest: digestSchema, bindingId: idSchema });
const tokenSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) });
const pageSchema = z.object({ data: z.array(domainSchema).max(100), has_more: z.boolean() });
interface Prepared { input: ResendEmailInvocation; request: ResendEmailRequest; effect: EffectEnvelope }

/** Inert server adapter. Boundary failures are typed, provider errors are never echoed.
 * @param required - Injected broker, fenced gateway, fetch, deadline, clock and observer.
 * @returns Read-only one-request adapter with typed failures and no retries.
 * @example createResendEmailAdapter({ configuration, gateway, credentials, fetch: hostFetch, deadline, clock, observer })
 * @complexity O(b) time/space, input<=64KiB, response<=1MiB, one 10s request.
 */
export function createResendEmailAdapter(required: ResendEmailDependencies): ResendEmailAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return { async invoke(input, options) {
    const prepared = prepare({ dependencies, input }, options);
    if (!prepared.ok) return prepared;
    const result = await dispatch({ dependencies, prepared: prepared.value }, options);
    observe({ dependencies, prepared: prepared.value, result });
    return result;
  } };
}
/** Parse a bounded snapshot before broker I/O; same-scope binding and exact wire digest. @complexity O(b). */
function prepare(required: { dependencies: ResendEmailDependencies; input: ResendEmailInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const bytes = JSON.stringify(required.input);
    if (Buffer.byteLength(bytes) > 65536) return failure({ code: "limit_exceeded" });
    const parsed = invocationSchema.safeParse(JSON.parse(bytes));
    const configuration = configurationSchema.safeParse(required.dependencies.configuration);
    if (!parsed.success || !configuration.success) return failure({ code: "invalid_input" });
    const input = parsed.data;
    if (resendEmailDigest({ value: input.context.scope }) !== resendEmailDigest({ value: configuration.data.scope })) return failure({ code: "forbidden" });
    const request = Object.freeze(encodeResendCommand({ command: input.command }));
    const effect: EffectEnvelope = { operationId: input.operationId, connectionId: configuration.data.connectionId, accountId: null,
      effects: ["read"], argumentsDigest: resendEmailDigest({ value: { command: input.command, request } }), moneyExposure: null, requiredLimit: null };
    return { ok: true, value: { input, request, effect } };
  } catch { return failure({ code: "invalid_input" }); }
}
/** Broker first, then the host's final checks and execute under its barrier. One callback use.
 * No token/provider error crosses this boundary. @complexity O(b).
 */
async function dispatch(required: { dependencies: ResendEmailDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<ResendEmailResult>> {
  const { dependencies, prepared } = required;
  let sent = false;
  try {
    const credential = await dependencies.credentials.access({ connectionId: dependencies.configuration.connectionId }, optional);
    if (!credential.ok) return failure({ code: credential.error.code });
    const token = tokenSchema.safeParse(credential.value);
    if (!token.success) return failure({ code: "unauthenticated" });
    return await dependencies.gateway.dispatch({ context: structuredClone(prepared.input.context), configuration: structuredClone(dependencies.configuration),
      command: structuredClone(prepared.input.command), request: prepared.request, effect: structuredClone(prepared.effect), execute: async () => {
        if (sent) return failure({ code: "conflict" });
        if (optional?.signal?.aborted) return failure({ code: "cancelled" });
        sent = true;
        return send({ dependencies, prepared, accessToken: token.data.accessToken }, optional);
      } }, optional);
  } catch { return failure({ code: "unavailable" }); }
}
/** Fixed HTTPS origin, redirect rejection and bounded stream under a 10s cancellation deadline.
 * Fetch is the platform callback ABI. No await between final checks and starting fetch. @complexity O(b).
 */
async function send(required: { dependencies: ResendEmailDependencies; prepared: Prepared; accessToken: string }, optional?: CallOptions): Promise<Outcome<ResendEmailResult>> {
  const { dependencies, prepared } = required;
  try {
    const deadline = dependencies.deadline({ timeoutMs: 10000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    if (signal.aborted) return failure({ code: "unavailable" });
    const response = await dependencies.fetch("https://api.resend.com" + prepared.request.path, {
      method: prepared.request.method, redirect: "error", signal,
      headers: { Authorization: "Bearer " + required.accessToken, "Content-Type": "application/json" },
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      return failure({ code: response.status === 401 || response.status === 403 ? "forbidden" : "unavailable" });
    }
    const body = await readBody({ response });
    return decode({ prepared, body });
  } catch { return failure({ code: "unavailable" }); }
}
/** Do not trust Content-Length. Cap includes whitespace; malformed/oversized responses cannot succeed. */
async function readBody(required: { response: Response }): Promise<unknown> {
  if (!required.response.body) return null;
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return null; }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { reader.releaseLock(); }
}
/** Validate provider IDs and pages atomically; list cursors only, no provider URL following. @complexity O(n), n<=100. */
function decode(required: { prepared: Prepared; body: unknown }): Outcome<ResendEmailResult> {
  const { prepared } = required;
  const command = prepared.input.command;
  const page = command.domainId ? domainSchema.transform(domain => ({ data: [domain], has_more: false })).safeParse(required.body) : pageSchema.safeParse(required.body);
  if (!page.success) return failure({ code: "protocol_mismatch" });
  const domains = page.data.data;
  if (domains.length > command.limit || new Set(domains.map(domain => domain.id)).size !== domains.length) return failure({ code: "protocol_mismatch" });
  if (command.domainId && domains[0]?.id !== command.domainId) return failure({ code: "protocol_mismatch" });
  if (page.data.has_more && domains.length === 0) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { operationId: prepared.input.operationId, status: "succeeded", domains, nextCursor: page.data.has_more ? domains.at(-1)!.id : null } };
}
function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "Resend request " + required.code, retryable: false } }; }
/** Correlated outcome only. Telemetry cannot replace a receipt; durable audit is host-owned. */
function observe(required: { dependencies: ResendEmailDependencies; prepared: Prepared; result: Outcome<ResendEmailResult> }): void {
  const context = required.prepared.input.context;
  try { required.dependencies.observer.observe({ operation: "resend-email." + required.prepared.input.command.kind,
    outcome: required.result.ok ? required.result.value.status : required.result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
  } catch { /* Host audit remains authoritative. */ }
}
