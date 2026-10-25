import { z } from "zod";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { mcpPayloadSchema } from "./schemas.js";
import { failure } from "./results.js";
import type { ImportReference } from "./types.js";

/** Safe vendor projection; neither prompts, auth metadata nor vendor errors escape it. */
export type PendingJob = { readonly jobId: string; readonly retryAfterMs: number };
/** Terminal failure is separate from unknown transport outcomes; neither implies no charge. */
export type ProviderStatus =
  | { readonly kind: "pending"; readonly jobId: string; readonly retryAfterMs: number; readonly credits: number | null; readonly chargeEvidenceId: string | null }
  | { readonly kind: "failed"; readonly reason: "failed" | "cancelled" | "expired"; readonly jobId: string; readonly credits: number | null; readonly chargeEvidenceId: string | null }
  | { readonly kind: "complete"; readonly reference: ImportReference; readonly credits: number | null; readonly chargeEvidenceId: string | null };

/** Bounded JSON parser used for federation text content. Never retries or echoes malformed payloads.
 * @example parseProviderJson({ text: '{"structuredContent":{"status":"pending"}}' })
 * @complexity O(b) time/space for b <=65536 UTF-8 bytes.
 */
export function parseProviderJson(required: { text: string }): Outcome<unknown> {
  if (Buffer.byteLength(required.text, "utf8") > 65536) return failure({ code: "limit_exceeded", message: "Higgsfield response too large" });
  try { return { ok: true, value: JSON.parse(required.text) as unknown }; }
  catch { return failure({ code: "protocol_mismatch", message: "Higgsfield response is not JSON" }); }
}

/** Honor vendor polling guidance, clamped to 1–60 seconds. No sync:true or busy polling.
 * @returns A bounded delay. @complexity O(1).
 */
export function pollDelay(required: { seconds?: number }): number {
  const seconds = required.seconds ?? 5;
  if (!Number.isFinite(seconds)) return 5000;
  return Math.min(60000, Math.max(1000, seconds * 1000));
}

/** Parse one async image submission. Multiple jobs are rejected; requests are capped to one image.
 * @example parseVendorSubmission({ input: { structuredContent: { results: [{ id: "job", type: "image", status: "pending" }] } } })
 * @returns Job handle or sanitized plan/protocol failure. No success claim or asset at submit.
 * @complexity O(b) for bounded provider metadata.
 */
export function parseVendorSubmission(required: { input: unknown }): Outcome<PendingJob> {
  const parsed = parseBoundary({ schema: mcpPayloadSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const payload = parsed.value;
  if (payload.structuredContent?.monetization_intent === "upgrade") return failure({ code: "forbidden", message: "Higgsfield account plan does not allow this model" });
  if (payload.isError) return failure({ code: "unavailable", message: "Higgsfield generation was refused; reconcile possible charge" });
  const jobs = payload.structuredContent?.results;
  if (jobs?.length !== 1) return failure({ code: "protocol_mismatch", message: "Expected exactly one Higgsfield job" });
  return { ok: true, value: { jobId: jobs[0].id, retryAfterMs: pollDelay({ seconds: payload.structuredContent?.poll_after_seconds }) } };
}

/** URL syntax is checked here; DNS, redirect, MIME and byte checks remain in guarded server media.
 * Signed URL query data stays server-side. No credentials/userinfo/fragments or local literal hosts.
 * @returns The validated URL or typed refusal. @complexity O(u), u <=4096.
 */
export function validateImportUrl(required: { url: string }): Outcome<string> {
  if (required.url.length > 4096) return failure({ code: "limit_exceeded", message: "Higgsfield output URL too long" });
  let url: URL;
  try { url = new URL(required.url); }
  catch { return failure({ code: "invalid_input", message: "Invalid Higgsfield output URL" }); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== "") return failure({ code: "forbidden", message: "Unsafe Higgsfield output URL" });
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(url.hostname)) {
    return failure({ code: "forbidden", message: "Higgsfield output requires a public DNS host" });
  }
  return { ok: true, value: url.href };
}

/** Validate a job-bound status and produce a media import reference, never an agent-facing CDN link.
 * A completed status MUST include one image link; another job's result is rejected.
 * @example parseVendorStatus({ input, jobId: "job", operationId: "op" })
 * @returns Pending/terminal reason/reference or protocol refusal; terminal status never implies a refund.
 * @complexity O(b), one bounded 16-item metadata scan.
 */
export function parseVendorStatus(required: { input: unknown; jobId: string; operationId: string }): Outcome<ProviderStatus> {
  const identity = z.strictObject({ jobId: idSchema, operationId: idSchema }).safeParse({ jobId: required.jobId, operationId: required.operationId });
  if (!identity.success) return failure({ code: "invalid_input", message: "Invalid Higgsfield job identity" });
  const parsed = parseBoundary({ schema: mcpPayloadSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const data = parsed.value.structuredContent;
  if (data?.jobId !== undefined && data.jobId !== required.jobId) return failure({ code: "conflict", message: "Higgsfield status returned another job" });
  if (parsed.value.isError) return failure({ code: "unavailable", message: "Higgsfield status unavailable; reconcile possible charge" });
  const credits = data?.charge?.credits_exact ?? null;
  const chargeEvidenceId = data?.charge?.evidence_id ?? null;
  const status = data?.status;
  switch (status) {
    case "pending": case "in_progress":
      return { ok: true, value: { kind: "pending", jobId: required.jobId, retryAfterMs: pollDelay({ seconds: data?.poll_after_seconds }), credits, chargeEvidenceId } };
    case "failed": case "cancelled": case "expired":
      return { ok: true, value: { kind: "failed", reason: status, jobId: required.jobId, credits, chargeEvidenceId } };
    case "completed": return completedReference({ ...required, payload: parsed.value, credits, chargeEvidenceId });
    case undefined: return failure({ code: "protocol_mismatch", message: "Higgsfield job status is missing" });
    default: { const impossible: never = status; throw new Error("Unsupported status: " + impossible); }
  }
}

/** Ignore descriptive text; accept one structured image resource, never scrape prose for a URL. */
function completedReference(required: { payload: z.infer<typeof mcpPayloadSchema>; jobId: string; operationId: string; credits: number | null; chargeEvidenceId: string | null }): Outcome<ProviderStatus> {
  const links = required.payload.structuredContent?.resources ?? required.payload.content?.filter(item => item.type === "resource_link") ?? [];
  if (links.length !== 1) return failure({ code: "protocol_mismatch", message: "Completed Higgsfield job requires one image resource" });
  const link = links[0];
  const url = validateImportUrl({ url: link.uri });
  if (!url.ok) return url;
  return { ok: true, value: { kind: "complete", credits: required.credits, chargeEvidenceId: required.chargeEvidenceId, reference: {
    provider: "higgsfield", providerJobId: required.jobId, operationId: required.operationId,
    sourceUrl: url.value, mimeType: link.mimeType,
  } } };
}
