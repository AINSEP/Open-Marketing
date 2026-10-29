import { z } from "zod";
import { appErrorSchema, callContextSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome, Scope } from "@open-marketing/contracts";
import type { ErasurePhase, ErasureRequest, ParticipantProgress } from "./types.js";
import { phases, requestSchema, suppressionSchema } from "./types.js";

/** Participant success and failure envelopes are strict; unknown outcomes cannot permit purge. */
export const participantOutcomeSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.strictObject({ complete: z.boolean(), removedCount: epochSchema, retainedSuppression: suppressionSchema.array().max(1000).optional() }) }),
  z.strictObject({ ok: z.literal(false), error: appErrorSchema }),
]);
/** Acknowledgement alone is insufficient unless it has the processing-block success shape. */
export const blockOutcomeSchema = z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: z.undefined() }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);

/** Stable failures omit tainted data; availability/conflict can be retried explicitly. */
export function failure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: required.code === "unavailable" || required.code === "conflict" } };
}
/** Catch port/driver throws without leaking PII or turning uncertain effects into success. */
export async function boundary<T>(required: { work: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.work(); }
  catch { return failure({ code: "unavailable", message: "Privacy boundary failed" }); }
}
/** Validate scope/trace metadata and caller IDs before any I/O. @complexity O(1), bounded IDs. */
export function validateInput(required: { context: CallContext; id: string; options?: CallOptions }): Outcome<never> | undefined {
  if (!callContextSchema.safeParse(required.context).success || !idSchema.safeParse(required.id).success) return failure({ code: "invalid_input", message: "Invalid privacy context or identifier" });
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Privacy operation cancelled" });
  return undefined;
}
/** Unambiguous owner/workspace identity for local locks and memory storage. */
export function scopeKey(required: { scope: Scope; id: string }): string {
  return JSON.stringify([required.scope.ownerId, required.scope.workspaceId, required.id]);
}
/** Canonical record comparison is safe after schema parsing fixes field order. */
export function sameRecord(required: { left: unknown; right: unknown }): boolean {
  return JSON.stringify(required.left) === JSON.stringify(required.right);
}
/** Parse and bound UTF-8 persistence payloads before checking lifecycle consistency.
 * @complexity O(p+d), p<=400 checkpoints and d<=1000 digests; <=256 KiB JSON.
 */
export function parseRequest(required: { context: CallContext; request: unknown }): Outcome<ErasureRequest> {
  const parsed = requestSchema.safeParse(required.request);
  if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid erasure request" });
  const request = parsed.data;
  if (!sameRecord({ left: request.scope, right: scopeSchema.parse(required.context.scope) })) return failure({ code: "forbidden", message: "Erasure scope mismatch" });
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 256 * 1024) return failure({ code: "limit_exceeded", message: "Erasure request exceeds payload limit" });
  if (!validProgress({ request })) return failure({ code: "invalid_input", message: "Inconsistent erasure progress" });
  const digests = request.retainedSuppression.map(digest => JSON.stringify(digest));
  if (new Set(digests).size !== digests.length) return failure({ code: "invalid_input", message: "Duplicate suppression digests" });
  return { ok: true, value: request };
}
/** Phase batches preserve the initial participant order; prior phases must be complete. */
function validProgress(required: { request: ErasureRequest }): boolean {
  const { request } = required;
  const ids = request.participants.filter(progress => progress.phase === "plan").map(progress => progress.participantId);
  const phaseIndex = phases.indexOf(request.phase);
  if (ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length) return false;
  if (request.participants.length !== ids.length * (phaseIndex + 1)) return false;
  if (!validBatches({ request, ids, phaseIndex })) return false;
  return request.status === progressStatus(request);
}
/** Current checkpoint statuses determine request status; only attestation may be terminal. */
export function progressStatus(required: { phase: ErasurePhase; participants: readonly ParticipantProgress[] }): ErasureRequest["status"] {
  const current = required.participants.filter(progress => progress.phase === required.phase);
  if (current.some(progress => progress.status === "failed")) return "failed";
  if (required.phase === "attest" && current.every(progress => progress.status === "complete")) return "complete";
  return "pending";
}
/** One linear scan checks ordered, unique checkpoints without nested participant searches. */
function validBatches(required: { request: ErasureRequest; ids: string[]; phaseIndex: number }): boolean {
  return required.request.participants.every((progress, index) => {
    const batch = Math.floor(index / required.ids.length);
    return progress.participantId === required.ids[index % required.ids.length] && progress.phase === phases[batch]
      && (batch === required.phaseIndex || progress.status === "complete");
  });
}
/** Only new, pending planning requests may be created. */
export function checkCreate(required: { request: ErasureRequest }): Outcome<never> | undefined {
  const { request } = required;
  if (request.phase !== "plan" || request.status !== "pending" || request.retainedSuppression.length !== 0) return failure({ code: "invalid_input", message: "Erasure must begin with planning" });
  if (request.participants.some(progress => progress.status !== "pending" || progress.removedCount !== 0)) return failure({ code: "invalid_input", message: "Erasure must begin without completed work" });
  return undefined;
}
/** Preserve identity, completed checkpoints and tombstones; allow explicit retry of unfinished work.
 * @complexity O(p+d) using checkpoint order and digest membership sets, fixed bounds.
 */
export function checkTransition(required: { previous: ErasureRequest; next: ErasureRequest }): Outcome<never> | undefined {
  const { previous, next } = required;
  if (!sameRecord({ left: identity({ request: previous }), right: identity({ request: next }) })) return failure({ code: "conflict", message: "Erasure identity is immutable" });
  if (!validPhaseChange({ previous, next })) return failure({ code: "conflict", message: "Erasure phase cannot regress or skip" });
  if (!previous.participants.every((progress, index) => preservesProgress({ previous: progress, next: next.participants[index] }))) return failure({ code: "conflict", message: "Erasure progress cannot regress" });
  const digests = new Set(next.retainedSuppression.map(digest => JSON.stringify(digest)));
  if (!previous.retainedSuppression.every(digest => digests.has(JSON.stringify(digest)))) return failure({ code: "conflict", message: "Suppression digests cannot be removed" });
  if (previous.phase !== "plan" && next.retainedSuppression.length !== previous.retainedSuppression.length) return failure({ code: "conflict", message: "Suppression must be planned before removal" });
  return undefined;
}
function identity(required: { request: ErasureRequest }): unknown[] {
  const { request } = required;
  return [request.scope, request.requestId, request.subjectId, request.requestedAt, request.participants.filter(progress => progress.phase === "plan").map(progress => progress.participantId)];
}
/** A next-phase save cannot also claim new effects; all new checkpoints start pending. */
function validPhaseChange(required: { previous: ErasureRequest; next: ErasureRequest }): boolean {
  const delta = phases.indexOf(required.next.phase) - phases.indexOf(required.previous.phase);
  if (delta === 0) return true;
  return delta === 1 && required.previous.participants.every(progress => progress.status === "complete")
    && required.next.participants.filter(progress => progress.phase === required.next.phase).every(progress => progress.status === "pending" && progress.removedCount === 0);
}
/** Completed results are immutable; retries of unfinished work may only increase counts. */
function preservesProgress(required: { previous: ParticipantProgress; next?: ParticipantProgress }): boolean {
  if (!required.next) return false;
  if (required.previous.status === "complete") return sameRecord({ left: required.previous, right: required.next });
  return required.next.removedCount >= required.previous.removedCount;
}
