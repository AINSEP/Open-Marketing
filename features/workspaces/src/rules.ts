import type { AppError, CallContext, Outcome, Scope } from "@open-marketing/contracts";
import type { AccountBinding } from "./types.js";

/** Stable failures never contain adapter exceptions or session identifiers. @complexity O(1). */
export function failure<T>(required: { code: AppError["code"]; message: string }): Outcome<T> {
  return { ok: false, error: { ...required, retryable: required.code === "unavailable" } };
}
/** Compare both tenancy dimensions; vendor IDs alone never identify an account. @complexity O(1). */
export function sameScope(required: { left: Scope; right: Scope }): boolean {
  return required.left.ownerId === required.right.ownerId && required.left.workspaceId === required.right.workspaceId;
}
/** Only an authenticated owner context may bind accounts. @complexity O(1). */
export function ownsContext(required: { context: CallContext }): boolean {
  return required.context.principal.kind === "owner" && required.context.principal.ownerId === required.context.scope.ownerId;
}
/** Exact replay succeeds; a different binding on either unique key conflicts. @complexity O(1). */
export function sameBinding(required: { left: AccountBinding; right: AccountBinding }): boolean {
  return sameScope({ left: required.left.scope, right: required.right.scope }) && required.left.id === required.right.id && required.left.connectionId === required.right.connectionId && required.left.externalAccountId === required.right.externalAccountId;
}
/** Object identity alone is insufficient: reject post-resolution mutation as well. @complexity O(1). */
export function sameContext(required: { left: CallContext; right: CallContext }): boolean {
  return sameScope({ left: required.left.scope, right: required.right.scope }) && ownsContext({ context: required.left }) && ownsContext({ context: required.right }) && required.left.correlationId === required.right.correlationId && required.left.traceId === required.right.traceId && required.left.runId === required.right.runId;
}
