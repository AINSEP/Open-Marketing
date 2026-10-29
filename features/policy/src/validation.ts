import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, ObserverPort, Outcome } from "@open-marketing/contracts";
import type { PolicyEvidence } from "./types.js";

const label = idSchema.refine(value => value.trim().length > 0);
const window = { start: epochSchema, end: epochSchema };
const orderedWindow = ({ start, end }: { start: number; end: number }) => start < end;
export const consentSchema = z.strictObject({ ...window, scope: z.enum(["channel", "destination"]), target: label, purpose: label,
  topic: label.optional(), wordingVersion: label.optional(), wordingDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: z.enum(["granted", "withdrawn"]) }).refine(orderedWindow);
export const suppressionSchema = z.strictObject({ ...window, channel: label }).refine(orderedWindow);
export const referenceSchema = z.strictObject({ scope: scopeSchema, subjectId: label });
const metadata = { id: label, scope: scopeSchema, subjectId: label, recordedAt: epochSchema, sourceId: label };
export const evidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ ...metadata, kind: z.literal("consent"), consent: consentSchema.refine(value => value.status === "granted") }),
  z.strictObject({ ...metadata, kind: z.literal("withdrawal"), consent: consentSchema.refine(value => value.status === "withdrawn") }),
  z.strictObject({ ...metadata, kind: z.literal("suppression"), suppression: suppressionSchema }),
  z.strictObject({ ...metadata, kind: z.literal("merge"), target: referenceSchema }),
]);

/** Stable sanitized boundary failure; never expose SQL or identifiers. @complexity O(1). */
export function failure(required: { code: AppError["code"]; message: string }): { ok: false; error: AppError } {
  return { ok: false, error: { ...required, retryable: required.code === "unavailable" } };
}
/** Validate scope and owner consistency; upstream still authenticates callers. @complexity O(1). */
export function validateRequest(required: { context: CallContext; subjectId: string; options?: CallOptions }) {
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Policy operation cancelled" });
  const parsed = callContextSchema.safeParse(required.context);
  if (!parsed.success || !label.safeParse(required.subjectId).success) return failure({ code: "invalid_input", message: "Invalid policy request" });
  const { scope, principal } = parsed.data;
  if (principal.kind === "owner" && principal.ownerId !== scope.ownerId) return failure({ code: "forbidden", message: "Principal scope mismatch" });
  return null;
}
/** Scope equality compares both owner and workspace. @complexity O(1). */
export function sameScope(required: { left: { ownerId: string; workspaceId: string }; right: { ownerId: string; workspaceId: string } }): boolean {
  return required.left.ownerId === required.right.ownerId && required.left.workspaceId === required.right.workspaceId;
}
/** Reject malformed payloads and scope escape before append. @complexity O(1). */
export function validateEvidence(required: { context: CallContext; evidence: PolicyEvidence; options?: CallOptions }) {
  const invalid = validateRequest({ ...required, subjectId: required.evidence?.subjectId });
  if (invalid) return invalid;
  if (!evidenceSchema.safeParse(required.evidence).success) return failure({ code: "invalid_input", message: "Invalid policy evidence" });
  if (!sameScope({ left: required.context.scope, right: required.evidence.scope })) return failure({ code: "forbidden", message: "Evidence scope mismatch" });
  if (required.evidence.kind === "merge" && !sameScope({ left: required.evidence.scope, right: required.evidence.target.scope })) return failure({ code: "forbidden", message: "Merge scope mismatch" });
  return null;
}

/** Map dependency throws to failures; observers cannot change storage outcomes.
 * Callback ABI is a deferred zero-argument operation. @complexity Work-dependent.
 */
export async function boundary<T>(required: { context: CallContext; operation: string; observer?: ObserverPort; work: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  let outcome: Outcome<T>;
  try { outcome = await required.work(); }
  catch { outcome = failure({ code: "unavailable", message: "Policy dependency unavailable" }); }
  observe({ ...required, outcome: outcome.ok ? "succeeded" : outcome.error.code });
  return outcome;
}
/** Metadata only; telemetry failure cannot invalidate a committed append. @complexity O(1). */
function observe(required: { context: CallContext; operation: string; observer?: ObserverPort; outcome: string }): void {
  if (!required.observer || !callContextSchema.safeParse(required.context).success) return;
  try { required.observer.observe({ operation: required.operation, outcome: required.outcome, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
  catch { /* Telemetry must not alter the decision. */ }
}

/** Hard evidence bound; configuration errors fail before exposing an adapter. @complexity O(1). */
export function evidenceLimit(required: { value?: number }): number {
  const value = required.value ?? 10_000;
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000) throw new PolicyConfigurationError({ message: "Invalid policy evidence limit" });
  return value;
}

/** Invalid factory configuration is distinct from runtime dependency failure.
 * Constructors cannot return Outcome under the preserved factory contracts.
 */
export class PolicyConfigurationError extends Error {
  readonly code = "invalid_input";
  constructor(required: { message: string }) {
    super(required.message);
    this.name = "PolicyConfigurationError";
  }
}
