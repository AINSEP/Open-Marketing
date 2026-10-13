import { z } from "zod";
import { digestSchema, effectEnvelopeSchema, idSchema } from "@open-marketing/contracts";
import type { CallOptions, ClockPort, EffectEnvelope, ObserverPort, Outcome } from "@open-marketing/contracts";
import { boundedJson, digest, failure, isUncertainFailure, parse } from "./boundary.js";
import { encodeCommand, invocationSchema } from "./commands.js";
import type { MetaInvocation } from "./commands.js";
import { verifyBinding } from "./evidence.js";
import type { MetaBinding } from "./evidence.js";
import type { MetaCall, MetaEvidencePort, MetaFederationHostPort, MetaGatewayPort, MetaSchemaPort } from "./ports.js";

const resultSchema = z.strictObject({ operationId: idSchema, status: z.enum(["succeeded", "failed", "unknown"]), content: z.array(z.json()).max(20) });
const jsonContent = z.strictObject({ type: z.literal("json"), data: z.record(z.string(), z.json()) });
const textContent = z.strictObject({ type: z.literal("text"), text: z.string().max(65536) });
/** Acknowledged writes remain unobserved until a separate verified readback. */
export interface MetaInvocationResult { readonly operationId: string; readonly status: "succeeded" | "unknown"; readonly data: unknown; readonly observedState: "unknown" }
export interface MetaAdsAdapter { invoke(required: MetaInvocation, optional?: CallOptions): Promise<Outcome<MetaInvocationResult>> }
interface Dependencies { evidence: MetaEvidencePort; gateway: MetaGatewayPort; schemas: MetaSchemaPort; clock: ClockPort; observer: ObserverPort; pluginDigest: string; timeoutMs: number }
interface Prepared { request: MetaInvocation; binding: MetaBinding; call: MetaCall; effect: EffectEnvelope }

/** Inert, evidence-gated codec around server-owned federation. It neither connects nor obtains credentials.
 * @param required - Trusted evidence/schema/gateway ports, injected clock/observer and installed digest.
 * @returns Bounded per-call adapter. Unknown writes are never retried; create ACKs do not prove PAUSED.
 * @example createMetaAdsAdapter({ evidence, gateway, schemas, clock, observer, pluginDigest })
 * @complexity O(s log k) validation/digests, one external dispatch, <=64KiB input and <=128KiB result.
 */
export function createMetaAdsAdapter(required: Omit<Dependencies, "timeoutMs">, optional: { timeoutMs?: number } = {}): MetaAdsAdapter {
  const dependencies: Dependencies = { ...required, timeoutMs: optional.timeoutMs ?? 15000 };
  return { async invoke(input, options) {
    const bounded = boundedJson({ input, maxBytes: 65536 });
    if (!bounded.ok) return bounded;
    const parsed = parse({ schema: invocationSchema, input: bounded.value });
    if (!parsed.ok) return parsed;
    const prepared = await prepare({ dependencies, request: parsed.value }, options);
    if (!prepared.ok) {
      observe({ dependencies, request: parsed.value, outcome: prepared.error.code });
      return prepared;
    }
    return dispatch({ dependencies, prepared: prepared.value }, options);
  } };
}

/** Resolve current evidence; exceptions before dispatch cannot be mistaken for vendor effects. @complexity O(s log k). */
async function prepare(required: { dependencies: Dependencies; request: MetaInvocation }, optional?: CallOptions): Promise<Outcome<Prepared>> {
  const { dependencies, request } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta call cancelled before dispatch" });
  if (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 60000) return failure({ code: "invalid_input", message: "Meta timeout must be 1..60000ms" });
  if (!digestSchema.safeParse(dependencies.pluginDigest).success) return failure({ code: "invalid_input", message: "Meta installed digest is invalid" });
  const encoded = encodeCommand({ input: request.command, accountId: request.accountId });
  if (!encoded.ok) return encoded;
  try {
    const evidence = await dependencies.evidence.resolve({ context: request.context, connectionId: request.connectionId, accountId: request.accountId, operation: request.command.kind }, optional);
    if (!evidence.ok) return evidence;
    const binding = verifyBinding({ input: evidence.value, request, claim: encoded.value.claim, pluginDigest: dependencies.pluginDigest, now: dependencies.clock.now({}) });
    if (!binding.ok) return binding;
    const validated = dependencies.schemas.validate({ schema: binding.value.inputSchema, value: encoded.value.arguments });
    if (!validated.ok) return validated;
    return prepareCall({ request, binding: binding.value, arguments: encoded.value.arguments, effects: encoded.value.effects });
  } catch { return failure({ code: "unavailable", message: "Meta admission boundary unavailable" }); }
}

/** Derive effects locally; server safety still verifies limits and exact authority. @complexity O(n log k). */
function prepareCall(required: { request: MetaInvocation; binding: MetaBinding; arguments: Readonly<Record<string, unknown>>; effects: readonly EffectEnvelope["effects"][number][] }): Outcome<Prepared> {
  const { request, binding } = required;
  if (required.effects.includes("ad_spend") && (!request.moneyExposure || !request.requiredLimit)) return failure({ code: "forbidden", message: "Meta spend requires exact exposure and verified limit evidence" });
  const argumentsDigest = digest({ value: required.arguments });
  const call = { operationId: request.operationId, connectionId: request.connectionId, toolName: binding.toolName, arguments: required.arguments, argumentsDigest, pluginDigest: binding.pluginDigest, schemaFingerprint: binding.schemaFingerprint };
  const effect = parse({ schema: effectEnvelopeSchema, input: { operationId: request.operationId, connectionId: request.connectionId, accountId: request.accountId, effects: required.effects, argumentsDigest, moneyExposure: request.moneyExposure, requiredLimit: request.requiredLimit } });
  if (!effect.ok) return effect;
  return { ok: true, value: { request, binding, call, effect: effect.value } };
}

/** One egress handoff, no reconnect/retry. Post-handoff write failures remain unknown.
 * @complexity One bounded gateway call plus O(n) output parsing, O(n) space.
 */
async function dispatch(required: { dependencies: Dependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<MetaInvocationResult>> {
  const { dependencies, prepared } = required;
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Meta call cancelled before dispatch" });
  let result: Outcome<MetaInvocationResult>;
  try {
    const response = await dependencies.gateway.invoke({ context: prepared.request.context, call: prepared.call, effect: prepared.effect, timeoutMs: dependencies.timeoutMs }, optional);
    result = decodeResponse({ response, prepared, schemas: dependencies.schemas });
  } catch { result = uncertainResult({ prepared }); }
  observe({ dependencies, request: prepared.request, outcome: result.ok ? result.value.status : result.error.code });
  return result;
}

/** Malformed acknowledgements cannot establish a successful write; valid host denials remain denials. @complexity O(n). */
function decodeResponse(required: { response: Outcome<unknown>; prepared: Prepared; schemas: MetaSchemaPort }): Outcome<MetaInvocationResult> {
  if (!required.response.ok) return decodeFailure({ response: required.response, prepared: required.prepared });
  const bounded = boundedJson({ input: required.response.value, maxBytes: 131072 });
  if (!bounded.ok) return uncertainResult({ prepared: required.prepared });
  const parsed = parse({ schema: resultSchema, input: bounded.value });
  if (!parsed.ok) return uncertainResult({ prepared: required.prepared });
  const result = parsed.value;
  if (result.operationId !== required.prepared.call.operationId) return uncertainResult({ prepared: required.prepared });
  if (result.status === "unknown") return unknown({ operationId: result.operationId });
  if (result.status === "failed") return uncertainResult({ prepared: required.prepared });
  const extracted = extractData({ content: result.content });
  if (!extracted.ok) return uncertainResult({ prepared: required.prepared });
  const checked = required.schemas.validate({ schema: required.prepared.binding.outputSchema, value: extracted.value });
  if (!checked.ok) return uncertainResult({ prepared: required.prepared });
  return { ok: true, value: { operationId: result.operationId, status: "succeeded", data: extracted.value, observedState: "unknown" } };
}

/** Preserve explicit preflight denials, but never infer no-write from transport loss. @complexity O(1). */
function decodeFailure(required: { response: Extract<Outcome<unknown>, { ok: false }>; prepared: Prepared }): Outcome<MetaInvocationResult> {
  if (isUncertainFailure({ error: required.response.error })) return uncertainResult({ prepared: required.prepared });
  return required.response;
}

/** Prefer the host's single JSON projection; otherwise require a single JSON text block. Never scrape prose.
 * @complexity O(n) time/space for <=20 bounded blocks.
 */
function extractData(required: { content: readonly unknown[] }): Outcome<unknown> {
  const structured = required.content.filter(item => jsonContent.safeParse(item).success);
  if (structured.length === 1) return { ok: true, value: jsonContent.parse(structured[0]).data };
  if (structured.length > 1 || required.content.length !== 1) return failure({ code: "protocol_mismatch", message: "Ambiguous Meta result content" });
  const text = textContent.safeParse(required.content[0]);
  if (!text.success) return failure({ code: "protocol_mismatch", message: "Meta result has no structured JSON" });
  try { return { ok: true, value: JSON.parse(text.data.text) as unknown }; }
  catch { return failure({ code: "protocol_mismatch", message: "Meta result text is not JSON" }); }
}

/** Read failures are unavailable; writes may already have happened. @complexity O(1). */
function uncertainResult(required: { prepared: Prepared }): Outcome<MetaInvocationResult> {
  if (required.prepared.effect.effects.includes("read")) return failure({ code: "unavailable", message: "Meta read response unavailable" });
  return unknown({ operationId: required.prepared.call.operationId });
}
function unknown(required: { operationId: string }): Outcome<MetaInvocationResult> {
  return { ok: true, value: { ...required, status: "unknown", data: null, observedState: "unknown" } };
}

/** Only references/outcomes enter telemetry. Telemetry failure cannot rewrite vendor outcome. */
function observe(required: { dependencies: Dependencies; request: MetaInvocation; outcome: string }): void {
  const context = required.request.context;
  try { required.dependencies.observer.observe({ operation: "meta-ads." + required.request.command.kind, outcome: required.outcome, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Outcome remains available for durable host audit/reconciliation. */ }
}

/** Reuses j10's server-owned Jini-backed federation through its public structural seam.
 * Host owns the final trusted effect resolver, bounded transport, credentials and exact confirmations.
 * @example createHostedMetaGateway({ host, timeoutMs: 15000 })
 * @complexity O(1) wrapper, one host invocation. No connection or service startup.
 */
export function createHostedMetaGateway(required: { host: MetaFederationHostPort; timeoutMs: number }): MetaGatewayPort {
  return { async invoke(input, options) {
    if (input.timeoutMs !== required.timeoutMs) return failure({ code: "invalid_input", message: "Meta and federation timeout configuration differ" });
    return required.host.invoke({ context: input.context, call: input.call }, options);
  } };
}
