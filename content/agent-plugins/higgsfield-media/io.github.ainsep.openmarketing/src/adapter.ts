import { z } from "zod";
import { idSchema } from "@open-marketing/contracts";
import type { PollingVendorAdapter, PollOutcome, SubmitOutcome, UnsignedVendorRequest } from "@jini-ai/integrations/media-providers";
import type { HiggsfieldDependencies, HiggsfieldRenderContext as RenderContext, HiggsfieldRenderResult as RenderResult } from "./types.js";
import { HiggsfieldBoundaryError } from "./types.js";
import { mcpPayloadSchema } from "./schemas.js";
import { parseProviderJson, parseVendorStatus, parseVendorSubmission } from "./provider-results.js";
import { portBoundary, unwrap } from "./results.js";
import { recordCharges } from "./observations.js";

/** Routing marker only. The injected bridge invokes FederationHost; this is never raw vendor HTTP. */
export const HIGGSFIELD_MCP_URL = "https://mcp.higgsfield.ai/mcp";
/** Bridge/media body ceilings. Media uses the creative contract's 16 MiB result limit. */
export const MAX_PROVIDER_BYTES = 65536;
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const CALL_TIMEOUT_MS = 15000;

/** Closed wire arguments from immutable reviewed intent, always one asynchronous image.
 * @example imageArguments({ dependencies })
 * @complexity O(p), prompt length <=32768; no effects.
 */
export function imageArguments(required: { dependencies: Pick<HiggsfieldDependencies, "intent"> }): Readonly<Record<string, unknown>> {
  const i = required.dependencies.intent;
  return { params: { model: i.model, prompt: i.prompt, count: 1,
    ...(i.parameters.aspect_ratio === undefined ? {} : { aspect_ratio: i.parameters.aspect_ratio }),
    ...(i.seed === null ? {} : { seed: i.seed }) } };
}

/** Jini handles durable persistence, leases, attempts, deadlines and recovery; this adapter only
 * knows Higgsfield payloads. The vendor's submit has no verified idempotency, so NEVER resubmit.
 * @example createHiggsfieldAdapter({ dependencies })
 * @returns Inert adapter; foreign parser ABI throws sanitized HiggsfieldBoundaryError.
 * @complexity O(b) bounded metadata; one guarded media read on completion.
 */
export function createHiggsfieldAdapter(required: { dependencies: HiggsfieldDependencies }): PollingVendorAdapter {
  const d = required.dependencies;
  return {
    expectedLatencyClass: "slow", submitIsIdempotent: false,
    buildSubmitRequest(input) {
      assertRenderContext({ ctx: input.ctx, dependencies: d });
      return wireRequest({ name: "generate_image", arguments: imageArguments({ dependencies: d }) });
    },
    async parseSubmitResponse(input) {
      return unwrap({ outcome: await portBoundary<SubmitOutcome>({ execute: async () => {
        const payload = await boundedResponse({ response: input.resp });
        const job = parseVendorSubmission({ input: payload });
        if (!job.ok) return job;
        return { ok: true, value: { kind: "pending", state: { jobId: job.value.jobId }, retryAfterMs: job.value.retryAfterMs } };
      } }) });
    },
    buildPollRequest(input) {
      const state = z.strictObject({ jobId: idSchema }).safeParse(input.state);
      if (!state.success) throw new HiggsfieldBoundaryError({ code: "invalid_input", message: "Invalid persisted Higgsfield job handle" });
      return wireRequest({ name: "job_status", arguments: { jobId: state.data.jobId } });
    },
    async parsePollResponse(input) {
      return unwrap({ outcome: await portBoundary<PollOutcome>({ execute: async () => ({ ok: true, value: await pollResponse({ dependencies: d, response: input.resp, state: input.state }) }) }) });
    },
  };
}

/** Parse and record charges before reading a completed asset; any opaque port error is sanitized
 * by the surrounding foreign parser boundary. @complexity O(b), bounded result plus <=2 appends.
 */
async function pollResponse(required: { dependencies: HiggsfieldDependencies; response: Response; state: Readonly<Record<string, unknown>> }): Promise<PollOutcome> {
  const d = required.dependencies;
  const jobId = unwrap({ outcome: parseJobId({ input: required.state }) });
  const payload = await boundedResponse({ response: required.response });
  const status = unwrap({ outcome: parseVendorStatus({ input: payload, jobId, operationId: d.intent.operationId }) });
  unwrap({ outcome: await recordCharges({ dependencies: d, jobId, status }) });
  switch (status.kind) {
    case "pending": return { kind: "pending", retryAfterMs: status.retryAfterMs };
    case "failed": return { kind: "failed", code: "HIGGSFIELD_JOB_FAILED", message: "Higgsfield job failed; charge may remain" };
    case "complete": return readImage({ dependencies: d, reference: status.reference });
    default: { const impossible: never = status; throw new Error("Unsupported provider outcome: " + impossible); }
  }
}

/** Render context drift fails before dispatch; the adapter cannot substitute a model or prompt. */
function assertRenderContext(required: { ctx: RenderContext; dependencies: HiggsfieldDependencies }): void {
  const i = required.dependencies.intent;
  if (required.ctx.surface !== "image" || required.ctx.model !== i.model || required.ctx.wireModel !== i.model || required.ctx.prompt !== i.prompt) {
    throw new HiggsfieldBoundaryError({ code: "conflict", message: "Higgsfield render context changed reviewed intent" });
  }
}
/** Vendor resumption state contains ONLY the validated job ID. */
function parseJobId(required: { input: unknown }): import("@open-marketing/contracts").Outcome<string> {
  const parsed = z.strictObject({ jobId: idSchema }).safeParse(required.input);
  if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Invalid Higgsfield job handle", retryable: false } };
  return { ok: true, value: parsed.data.jobId };
}
function wireRequest(required: { name: "generate_image" | "job_status"; arguments: Readonly<Record<string, unknown>> }): UnsignedVendorRequest {
  return { url: HIGGSFIELD_MCP_URL, init: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(required) }, meta: undefined };
}

/** Stream bound before JSON allocation. Any clipping/HTTP failure is ambiguous, never retryable.
 * @complexity O(b) time/space, b <=64KiB; cancels oversized bodies.
 */
async function boundedResponse(required: { response: Response }): Promise<z.infer<typeof mcpPayloadSchema>> {
  if (!required.response.ok) throw new HiggsfieldBoundaryError({ code: "unavailable", message: "Higgsfield federation call failed; reconcile possible charge" });
  const reader = required.response.body?.getReader();
  if (reader === undefined) throw new HiggsfieldBoundaryError({ code: "protocol_mismatch", message: "Missing Higgsfield response body" });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > MAX_PROVIDER_BYTES) { await reader.cancel(); throw new HiggsfieldBoundaryError({ code: "limit_exceeded", message: "Higgsfield response too large" }); }
    chunks.push(chunk.value);
  }
  const value = unwrap({ outcome: parseProviderJson({ text: Buffer.concat(chunks).toString("utf8") }) });
  const parsed = mcpPayloadSchema.safeParse(value);
  if (!parsed.success) throw new HiggsfieldBoundaryError({ code: "protocol_mismatch", message: "Invalid Higgsfield result schema" });
  return parsed.data;
}

/** Retrieve real bytes via server media policy, preserving the provider URL/job/operation reference.
 * No OAuth token, download implementation or library table exists in this plugin.
 * @complexity O(b) memory/time, b <=16MiB; one bounded, server-guarded read.
 */
async function readImage(required: { dependencies: HiggsfieldDependencies; reference: import("./types.js").ImportReference }): Promise<PollOutcome> {
  const d = required.dependencies;
  const read = await d.deadlines.run({ timeoutMs: CALL_TIMEOUT_MS, execute: input => portBoundary({ execute: () => d.media.read({ context: d.context, reference: required.reference, maxBytes: MAX_IMAGE_BYTES, timeoutMs: CALL_TIMEOUT_MS }, input) }) });
  const result = unwrap({ outcome: read });
  assertImageBytes({ result });
  return { kind: "complete", result: { bytes: Buffer.from(result.bytes), providerNote: "Generated with Higgsfield", suggestedExt: extensionFor({ mimeType: required.reference.mimeType }) } };
}
/** The media port owns content sniffing; recheck runtime byte shape/size before Jini persistence. */
function assertImageBytes(required: { result: RenderResult }): void {
  if (!Buffer.isBuffer(required.result.bytes) || required.result.bytes.byteLength < 1 || required.result.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new HiggsfieldBoundaryError({ code: "limit_exceeded", message: "Higgsfield media bytes missing or oversized" });
  }
}
function extensionFor(required: { mimeType: import("./types.js").ImportReference["mimeType"] }): string {
  switch (required.mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
    case "image/avif": return "avif";
    default: { const impossible: never = required.mimeType; throw new Error("Unsupported MIME: " + impossible); }
  }
}
