import type { CallContext } from "@open-marketing/contracts";
import type { Consent, PolicyEvidence, PolicyObserverPort, SubjectReference } from "../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const subject: SubjectReference = { scope: context.scope, subjectId: "subject" };
export const consent: Consent = { purpose: "signup", scope: "destination", target: "meta", status: "granted", start: 10, end: 100 };
export const grant: Extract<PolicyEvidence, { kind: "consent" | "withdrawal" }> = { id: "grant", scope: context.scope, subjectId: subject.subjectId, kind: "consent", recordedAt: 10, sourceId: "authenticated-ingress", consent };
export const withdrawal: Extract<PolicyEvidence, { kind: "consent" | "withdrawal" }> = { ...grant, id: "withdrawal", kind: "withdrawal", consent: { ...consent, status: "withdrawn", start: 20, end: 30 } };
export const merge: Extract<PolicyEvidence, { kind: "merge" }> = { id: "merge", scope: context.scope, subjectId: "subject", kind: "merge", recordedAt: 20, sourceId: "authenticated-ingress", target: { scope: context.scope, subjectId: "survivor" } };
export const otherWorkspace: CallContext = { ...context, scope: { ...context.scope, workspaceId: "other-workspace" } };
export const otherOwner: CallContext = { ...context, scope: { ...context.scope, ownerId: "other-owner" }, principal: { kind: "owner", ownerId: "other-owner" } };

/** Isolated observer double records metadata, clones caller values and never collects payloads. */
export function memoryObserver(): PolicyObserverPort & { events: Parameters<PolicyObserverPort["observe"]>[0][] } {
  const events: Parameters<PolicyObserverPort["observe"]>[0][] = [];
  return { events, observe(input) { events.push(structuredClone(input)); } };
}
