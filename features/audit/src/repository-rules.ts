import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { AuditEntry, AuditReceipt } from "./types.js";
import { auditReceiptSchema, failure } from "./validation.js";

/** Unambiguous scope key even when identifiers contain delimiters. @complexity O(1), bounded IDs. */
export function scopeKey(required: { context: CallContext }): string {
  return JSON.stringify([required.context.scope.ownerId, required.context.scope.workspaceId]);
}

/** Allocate through injected dependencies only. Invalid clock/ID cannot become durable evidence.
 * @complexity O(1). Exceptions are mapped by the owning repository boundary.
 */
export function allocateReceipt(required: { clock: ClockPort; ids: IdPort }): Outcome<AuditReceipt> {
  const parsed = auditReceiptSchema.safeParse({ entryId: required.ids.next({}), recordedAt: required.clock.now({}) });
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data };
}

/** Corrections append within one operation and scope; absence and cross-scope targets look identical.
 * @complexity O(1). The caller supplies a target looked up strictly within the current scope.
 */
export function correctionAllowed(required: { entry: AuditEntry; target?: AuditEntry }): boolean {
  if (required.entry.kind !== "correction") return true;
  return required.target?.operationId === required.entry.operationId;
}
