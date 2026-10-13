import { z } from "zod";
import { generationCostQuoteSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { OperationRuntimeDeps } from "@jini-ai/integrations/media-providers";
import { bindingSchema, callContextSchema, intentSchema, mcpPayloadSchema, pricingSchema, wireSchema } from "./schemas.js";
import { HiggsfieldBoundaryError } from "./types.js";
import type { HiggsfieldDependencies, HiggsfieldRuntimeBinding } from "./types.js";
import { bindHiggsfieldEffect } from "./effects.js";
import { createHiggsfieldAdapter, imageArguments, HIGGSFIELD_MCP_URL, CALL_TIMEOUT_MS, MAX_PROVIDER_BYTES } from "./adapter.js";
import { failure, portBoundary, unwrap } from "./results.js";
import { matchesPricing } from "./pricing.js";
import { parseProviderJson } from "./provider-results.js";

type HttpClient = NonNullable<OperationRuntimeDeps["httpClient"]>;
type HttpRequest = Parameters<HttpClient["send"]>[0]["request"];
type Wire = z.infer<typeof wireSchema>;
const federatedContentSchema = z.array(z.union([
  z.strictObject({ type: z.literal("json"), data: z.unknown() }),
  z.strictObject({ type: z.literal("text"), text: z.string().max(MAX_PROVIDER_BYTES) }),
])).max(16);

/** Canonical catalog namespace required by the federation registry. @complexity O(i), bounded ID. */
export function higgsfieldToolName(required: { connectionId: string; name: "generate_image" | "job_status" }): string {
  return `io.github.ainsep.openmarketing.${required.connectionId}.${required.name}`;
}

/** Inert Jini/federation bridge. The host owns admission, safety, credentials and real MCP transport.
 * The synthetic HttpClient never opens a socket. Do not replace it with raw fetch or a bearer signer.
 * @example const binding = createHiggsfieldRuntimeBinding({ dependencies });
 * @returns Parsed private snapshot or typed invalid_input/conflict/forbidden; no startup effects.
 * @complexity O(p) bounded input copying; each later send makes one bounded host invocation.
 */
export function createHiggsfieldRuntimeBinding(required: { dependencies: HiggsfieldDependencies }): Outcome<HiggsfieldRuntimeBinding> {
  const parsed = snapshotDependencies(required);
  if (!parsed.ok) return parsed;
  const d = parsed.value;
  let handoff: Promise<Outcome<void>> | null = null;
  let submissionStarted = false;
  const httpClient: HttpClient = { async send(input) {
    const wire = unwrap({ outcome: parseWireRequest({ request: input.request }) });
    if (wire.name === "generate_image" && submissionStarted) throw new HiggsfieldBoundaryError({ code: "conflict", message: "Generation already handed off; reconcile instead of resubmitting" });
    const execution = executeWire({ dependencies: d, wire, request: input.request });
    if (wire.name === "generate_image") {
      submissionStarted = true;
      handoff = execution.then(outcome => outcome.ok ? { ok: true as const, value: undefined } : outcome);
    }
    const response = unwrap({ outcome: await execution });
    return { status: 200, headers: { "content-type": "application/json" }, bodyText: JSON.stringify(response), bodyTruncated: false };
  } };
  return { ok: true, value: {
    adapter: createHiggsfieldAdapter({ dependencies: d }), httpClient,
    signer: input => ({ url: input.request.url, init: input.request.init }),
    awaitHandoff: () => handoff ?? Promise.resolve(failure({ code: "conflict", message: "Generation handoff has not started" })),
  } };
}

/** Copy parsed input objects so caller edits cannot alter the queued vendor request/quote. */
function snapshotDependencies(required: { dependencies: HiggsfieldDependencies }): Outcome<HiggsfieldDependencies> {
  const d = required.dependencies;
  const parsed = z.strictObject({ binding: bindingSchema, intent: intentSchema, context: callContextSchema, quote: generationCostQuoteSchema, pricing: pricingSchema.nullable() }).safeParse({
    binding: d.binding, intent: d.intent, context: d.context, quote: d.quote, pricing: d.pricing,
  });
  if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid Higgsfield runtime inputs" });
  const snapshot = { ...d, ...parsed.data };
  const valid = validateSnapshot({ dependencies: snapshot });
  if (!valid.ok) return valid;
  return { ok: true, value: snapshot };
}

/** Quote remains immutable after expiry for status/recovery. Freshness is rechecked only at submit. */
function validateSnapshot(required: { dependencies: HiggsfieldDependencies }): Outcome<void> {
  const { binding: b, intent: i, context: c, quote: q } = required.dependencies;
  if (b.scope.ownerId !== c.scope.ownerId || b.scope.workspaceId !== c.scope.workspaceId) return failure({ code: "forbidden", message: "Higgsfield binding belongs to another scope" });
  if (c.principal.kind === "owner" && c.principal.ownerId !== c.scope.ownerId) return failure({ code: "forbidden", message: "Higgsfield owner scope mismatch" });
  if (q.pluginId !== b.pluginId || q.pluginDigest !== b.pluginDigest || q.modelConfigurationDigest !== b.configurationDigest || i.configurationDigest !== b.configurationDigest || q.argumentsDigest !== i.argumentsDigest) {
    return failure({ code: "conflict", message: "Higgsfield quote/intent binding changed" });
  }
  if (q.status !== "known") {
    if (q.estimated !== null || q.upperBound !== null) return failure({ code: "forbidden", message: "Unverifiable Higgsfield quote cannot contain money" });
    return { ok: true, value: undefined };
  }
  return validateKnownPrice(required);
}

/** Zero-priced generations need reviewed zero evidence just like other known prices. */
function validateKnownPrice(required: { dependencies: HiggsfieldDependencies }): Outcome<void> {
  const d = required.dependencies;
  const p = d.pricing;
  if (p === null || !matchesPricing({ pricing: p, binding: d.binding, intent: d.intent, now: p.observedAt })) return failure({ code: "forbidden", message: "Known quote has no matching pricing evidence" });
  const expected = p.unitUpperBound;
  const q = d.quote;
  if (q.pricingEvidenceId !== p.evidenceId || q.expiresAt > p.expiresAt) return failure({ code: "conflict", message: "Pricing evidence changed" });
  if (q.estimated?.currency !== expected.currency || q.upperBound?.currency !== expected.currency || q.estimated?.minorUnits !== expected.minorUnits || q.upperBound?.minorUnits !== expected.minorUnits) {
    return failure({ code: "conflict", message: "Quoted monetary bound changed" });
  }
  return { ok: true, value: undefined };
}

/** Refuse foreign requests, credentials and protocol inflation before invoking any host port. */
function parseWireRequest(required: { request: HttpRequest }): Outcome<Wire> {
  const r = required.request;
  if (r.method !== "POST" || r.url !== HIGGSFIELD_MCP_URL || typeof r.body !== "string") return failure({ code: "forbidden", message: "Only Higgsfield bridge requests are allowed" });
  if (Object.keys(r.headers).some(key => !["content-type", "accept"].includes(key.toLowerCase()))) return failure({ code: "forbidden", message: "Credential/configuration headers refused by Higgsfield bridge" });
  const json = parseProviderJson({ text: r.body });
  if (!json.ok) return json;
  return parseBoundary({ schema: wireSchema, input: json.value });
}

/** Revalidate effect/pins/ownership and hand off once through the current host safety/credential fence.
 * Full call deadline (not Jini's grace period) bounds slow auth/admission. Unknown is not retryable.
 * @complexity O(p) bounded digest work and a constant number of host calls.
 */
function executeWire(required: { dependencies: HiggsfieldDependencies; wire: Wire; request: HttpRequest }): Promise<Outcome<z.infer<typeof mcpPayloadSchema>>> {
  const d = required.dependencies;
  return portBoundary({ execute: () => d.deadlines.run({ timeoutMs: CALL_TIMEOUT_MS,
    execute: input => executeBoundedWire({ ...required, request: { ...required.request, signal: input.signal } }) }, { signal: required.request.signal }) });
}

/** Runs only under the injected deadline; local job ownership and slow host admission share it. */
async function executeBoundedWire(required: { dependencies: HiggsfieldDependencies; wire: Wire; request: HttpRequest }): Promise<Outcome<z.infer<typeof mcpPayloadSchema>>> {
  const d = required.dependencies;
  const valid = await validateWireIntent(required);
  if (!valid.ok) return valid;
  const argumentsDigest = d.digest.digest({ arguments: required.wire.arguments });
  if (!argumentsDigest.ok) return argumentsDigest;
  const schemaFingerprint = required.wire.name === "generate_image" ? d.binding.generationSchemaFingerprint : d.binding.statusSchemaFingerprint;
  const operationId = required.wire.name === "generate_image" ? d.intent.operationId : d.ids.next({});
  const identity = idSchema.safeParse(operationId);
  if (!identity.success) return failure({ code: "invalid_input", message: "Invalid Higgsfield operation identity" });
  const effects = bindHiggsfieldEffect({ binding: d.binding, toolName: required.wire.name, operationId, argumentsDigest: argumentsDigest.value,
    intentArgumentsDigest: d.intent.argumentsDigest, schemaFingerprint, quote: d.quote, now: d.clock.now({}) });
  if (!effects.ok) return effects;
  const result = await invokeHost({ ...required, operationId, argumentsDigest: argumentsDigest.value, schemaFingerprint });
  if (!result.ok) return result;
  return decodeFederatedResult({ result: result.value, operationId });
}

/** No alternate prompt/model/parameters, no synchronous status mode and no cross-operation job read. */
async function validateWireIntent(required: { dependencies: HiggsfieldDependencies; wire: Wire; request: HttpRequest }): Promise<Outcome<void>> {
  const d = required.dependencies;
  if (required.request.signal?.aborted) return failure({ code: "cancelled", message: "Higgsfield call cancelled before handoff" });
  if (required.wire.name === "generate_image") {
    const reviewed = d.digest.digest({ arguments: imageArguments({ dependencies: d }) });
    const actual = d.digest.digest({ arguments: required.wire.arguments });
    if (!reviewed.ok) return reviewed;
    if (!actual.ok) return actual;
    if (reviewed.value !== actual.value) return failure({ code: "conflict", message: "Higgsfield outbound arguments changed" });
    return { ok: true, value: undefined };
  }
  const status = z.strictObject({ jobId: idSchema }).safeParse(required.wire.arguments);
  if (!status.success) return failure({ code: "invalid_input", message: "Invalid Higgsfield status request" });
  return d.jobs.verify({ context: d.context, operationId: d.intent.operationId, providerJobId: status.data.jobId }, { signal: required.request.signal });
}

type FederationResult = Awaited<ReturnType<HiggsfieldDependencies["federation"]["invoke"]>> extends Outcome<infer T> ? T : never;
/** The only vendor invocation seam; every poll obtains current host authority and credential use.
 * Telemetry has only operation/outcome/context IDs. Prompts, signed URLs and provider text stay out.
 */
async function invokeHost(required: {
  dependencies: HiggsfieldDependencies; wire: Wire; request: HttpRequest; operationId: string; argumentsDigest: string; schemaFingerprint: string;
}): Promise<Outcome<FederationResult>> {
  const d = required.dependencies;
  const result = await d.federation.invoke({ context: d.context, call: {
    operationId: required.operationId, connectionId: d.binding.connectionId,
    toolName: higgsfieldToolName({ connectionId: d.binding.connectionId, name: required.wire.name }), arguments: required.wire.arguments,
    argumentsDigest: required.argumentsDigest, pluginDigest: d.binding.pluginDigest, schemaFingerprint: required.schemaFingerprint,
  } }, { signal: required.request.signal });
  observeCall({ dependencies: d, toolName: required.wire.name, outcome: result.ok ? result.value.status : result.error.code });
  return result;
}
/** Non-authoritative observer failures cannot change a dispatched outcome. */
function observeCall(required: { dependencies: HiggsfieldDependencies; toolName: string; outcome: string }): void {
  const d = required.dependencies;
  try { d.observer.observe({ operation: "higgsfield." + required.toolName, outcome: required.outcome,
    correlationId: d.context.correlationId, traceId: d.context.traceId, ...(d.context.runId === undefined ? {} : { runId: d.context.runId }) }); }
  catch { /* Host durable audit is authoritative; diagnostics are best effort. */ }
}

/** Federation emits structuredContent as a JSON content block. Never scrape text for jobs or URLs.
 * Text-only JSON is supported for servers that omit structuredContent, with the same closed shape.
 * @returns Sanitized bounded vendor payload; credentials and unknown metadata are discarded.
 * @complexity O(b), b <=64KiB and content length <=16.
 */
function decodeFederatedResult(required: { result: FederationResult; operationId: string }): Outcome<z.infer<typeof mcpPayloadSchema>> {
  if (required.result.operationId !== required.operationId) return failure({ code: "conflict", message: "Higgsfield federation operation mismatch" });
  if (required.result.status === "unknown") return failure({ code: "unavailable", message: "Unknown Higgsfield outcome; do not resubmit" });
  const content = federatedContentSchema.safeParse(required.result.content);
  if (!content.success) return failure({ code: "protocol_mismatch", message: "Invalid Higgsfield federation content" });
  const structured = content.data.filter(item => item.type === "json");
  if (structured.length > 1) return failure({ code: "protocol_mismatch", message: "Ambiguous Higgsfield structured result" });
  if (structured.length === 1) return projectPayload({ input: { structuredContent: structured[0].data, isError: required.result.status === "failed" } });
  const texts = content.data.filter(item => item.type === "text");
  if (texts.length !== 1) return failure({ code: "protocol_mismatch", message: "Missing Higgsfield structured result" });
  const json = parseProviderJson({ text: texts[0].text });
  if (!json.ok) return json;
  return projectPayload({ input: { structuredContent: json.value, isError: required.result.status === "failed" } });
}
/** Whitelist only metadata the adapter uses; text/description/unknown fields are never persisted. */
function projectPayload(required: { input: unknown }): Outcome<z.infer<typeof mcpPayloadSchema>> {
  const projected = parseBoundary({ schema: mcpPayloadSchema, input: required.input });
  if (!projected.ok) return projected;
  if (Buffer.byteLength(JSON.stringify(projected.value), "utf8") > MAX_PROVIDER_BYTES) return failure({ code: "limit_exceeded", message: "Higgsfield projected result too large" });
  return projected;
}
