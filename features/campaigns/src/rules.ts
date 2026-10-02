import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, digestSchema, effectEnvelopeSchema, epochSchema, idSchema, moneySchema, parseBoundary, scopeSchema, timeWindowSchema } from "@open-marketing/contracts";
import type { AppError, Outcome, Scope } from "@open-marketing/contracts";
import type { ApprovedLaunchRequest, CampaignJob, CampaignReadback, LaunchProposal } from "./types.js";

const ids = z.array(idSchema).min(1).max(100).refine(values => new Set(values).size === values.length);
export const draftSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, accountId: idSchema, name: z.string().trim().min(1).max(256), objective: idSchema, creativeIds: ids, creativeDigest: digestSchema, placements: ids });
export const flightSchema = z.strictObject({ window: timeWindowSchema, expectedExposure: moneySchema, timezone: idSchema }).refine(value => validTimezone({ timezone: value.timezone }));
export const requestSchema = z.strictObject({ campaignId: idSchema, operationId: idSchema, approvalId: idSchema, argumentsDigest: digestSchema, creativeDigest: digestSchema });
export const receiptSchema = z.strictObject({ campaignId: idSchema, desiredState: z.literal("paused"), observedState: z.enum(["paused", "unknown"]) });
export const launchReceiptSchema = z.strictObject({ operationId: idSchema, status: z.enum(["pending", "submitted", "unknown"]) });
export const observationSchema = z.strictObject({ campaignId: idSchema, state: z.enum(["paused", "active", "unknown"]), observedAt: epochSchema, providerReference: idSchema });
export const readbackSchema = z.strictObject({ state: observationSchema, hierarchy: z.array(z.strictObject({ entityId: idSchema, state: z.enum(["paused", "active", "unknown"]) })).max(500), complete: z.boolean(), operationId: idSchema.nullable() });
export const argumentsSchema = z.strictObject({ campaignId: idSchema, connectionId: idSchema, accountId: idSchema, creativeDigest: digestSchema, flight: flightSchema, action: z.literal("launch") });
export const proposalSchema = z.strictObject({ campaignId: idSchema, operations: z.array(effectEnvelopeSchema).length(1), creativeDigest: digestSchema, arguments: argumentsSchema, proposedAt: epochSchema });
export const recordSchema = z.strictObject({ scope: scopeSchema, draft: draftSchema, receipt: receiptSchema, observation: observationSchema.nullable() });
export const intentSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("create"), campaignId: idSchema, draft: draftSchema }), z.strictObject({ kind: z.literal("launch"), request: requestSchema, proposal: proposalSchema })]);
export const jobSchema = z.strictObject({ jobId: idSchema, scope: scopeSchema, operationId: idSchema, argumentsDigest: digestSchema, intent: intentSchema, status: z.enum(["queued", "dispatching", "submitted", "unknown"]) });
export const createInputSchema = z.strictObject({ context: callContextSchema, draft: draftSchema });
export const proposeInputSchema = z.strictObject({ context: callContextSchema, campaignId: idSchema, flight: flightSchema });
export const launchInputSchema = z.strictObject({ context: callContextSchema, request: requestSchema });
export const operationInputSchema = z.strictObject({ context: callContextSchema, operationId: idSchema });
export const assetResultSchema = z.strictObject({ creativeDigest: digestSchema });

/** Typed failures never expose untrusted payloads or driver messages. */
export function fail<T>(required: { code: AppError["code"]; message: string; retryable?: boolean }): Outcome<T> {
  return { ok: false, error: { code: required.code, message: required.message, retryable: required.retryable ?? false } };
}
export function success<T>(required: { value: T }): Outcome<T> { return { ok: true, value: required.value }; }
/** Hash schema-normalized DTOs; all callers parse before hashing. @complexity O(n) bounded DTO bytes. */
export function digest(required: { value: unknown }): string { return createHash("sha256").update(JSON.stringify(required.value)).digest("hex"); }
export function scopeKey(required: { scope: Scope }): string { return JSON.stringify([required.scope.ownerId, required.scope.workspaceId]); }
export function scopedKey(required: { scope: Scope; id: string }): string { return JSON.stringify([required.scope.ownerId, required.scope.workspaceId, required.id]); }
export function campaignId(required: { operationId: string }): string { return "campaign-" + digest({ value: required.operationId }).slice(0, 40); }
function validTimezone(required: { timezone: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: required.timezone }); return true; }
  catch { return false; }
}
/** Reject drift independently of safety, including a substituted immutable proposal. */
export function exactMatch(required: { request: ApprovedLaunchRequest; proposal: LaunchProposal }): boolean {
  const { request, proposal } = required;
  const operation = proposal.operations[0];
  if (!operation) return false;
  if (request.campaignId !== proposal.campaignId || request.operationId !== operation.operationId) return false;
  if (request.creativeDigest !== proposal.creativeDigest || request.argumentsDigest !== operation.argumentsDigest) return false;
  return request.argumentsDigest === digest({ value: proposal.arguments });
}
/** Full, nonempty, duplicate-free hierarchy evidence is necessary for a known state. */
export function verifiedState(required: { readback: CampaignReadback; expected: "paused" | "active" }): boolean {
  const { readback, expected } = required;
  if (!readback.complete || readback.hierarchy.length === 0) return false;
  if (readback.state.state !== expected) return false;
  if (new Set(readback.hierarchy.map(entity => entity.entityId)).size !== readback.hierarchy.length) return false;
  return readback.hierarchy.every(entity => entity.state === expected);
}
/** An uncertain worker state is never reported as a retryable pending operation. */
export function jobReceipt(required: { job: CampaignJob }): { operationId: string; status: "pending" | "submitted" | "unknown" } {
  if (required.job.status === "queued") return { operationId: required.job.operationId, status: "pending" };
  if (required.job.status === "submitted") return { operationId: required.job.operationId, status: "submitted" };
  return { operationId: required.job.operationId, status: "unknown" };
}
/** Boundary aliases keep validation consistent between SQL, memory and service. */
export { parseBoundary };
