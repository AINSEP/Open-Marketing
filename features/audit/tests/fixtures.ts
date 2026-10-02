import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { AuditEntry } from "../index.js";

/** Deterministic, independently scoped fixtures; no real time/randomness. */
export function context(required: Partial<CallContext> = {}): CallContext {
  return {
    scope: { ownerId: "owner-1", workspaceId: "workspace-1" },
    principal: { kind: "owner", ownerId: "owner-1" },
    correlationId: "correlation-1", traceId: "trace-1", runId: "run-1", ...required,
  };
}
export function entry(required: Partial<AuditEntry> = {}): AuditEntry {
  return { operationId: "operation-1", kind: "intent", argumentsDigest: "a".repeat(64), references: ["evidence-1"], ...required };
}
export function dependencies(required: Record<string, never> = {}): { clock: ClockPort; ids: IdPort } {
  let next = 0;
  return { clock: { now() { return 1234; } }, ids: { next() { next += 1; return `audit-${next}`; } } };
}
/** Tests assert exact errors at their own callsite instead of accepting any failure. */
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(`Expected success: ${required.outcome.error.code}`);
  return required.outcome.value;
}
