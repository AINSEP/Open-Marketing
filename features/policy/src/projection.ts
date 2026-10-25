import type { Outcome } from "@open-marketing/contracts";
import type { PolicyEvidence, SubjectPolicy } from "./types.js";
import { failure } from "./validation.js";

/** Build canonical roots with memoized paths; invalid cycles/conflicting merges fail closed.
 * @complexity O(n) amortized time/space for n scoped evidence records.
 */
export function rootsFor(required: { evidence: readonly PolicyEvidence[] }): Outcome<Map<string, string>> {
  const links = new Map<string, string>();
  for (const record of required.evidence) {
    if (record.kind !== "merge") continue;
    if (links.has(record.subjectId)) return failure({ code: "conflict", message: "Identity already merged" });
    links.set(record.subjectId, record.target.subjectId);
  }
  const roots = new Map<string, string>();
  for (const subjectId of links.keys()) {
    const root = resolveRoot({ subjectId, links, roots });
    if (!root.ok) return root;
  }
  return { ok: true, value: roots };
}
/** Resolve one chain; compression makes repeated resolution linear overall. @complexity O(chain length). */
function resolveRoot(required: { subjectId: string; links: Map<string, string>; roots: Map<string, string> }): Outcome<string> {
  const path = new Set<string>();
  let current = required.subjectId;
  while (required.links.has(current) && !required.roots.has(current)) {
    if (path.has(current)) return failure({ code: "conflict", message: "Identity merge cycle" });
    path.add(current);
    current = required.links.get(current)!;
  }
  const root = required.roots.get(current) ?? current;
  for (const subjectId of path) required.roots.set(subjectId, root);
  return { ok: true, value: root };
}
/** Preserve every applicable withdrawal/suppression across merged identities.
 * No last-write-wins grant can erase withdrawal. @complexity O(n) time/space.
 */
export function projectSnapshot(required: { subjectId: string; evidence: readonly PolicyEvidence[] }): Outcome<SubjectPolicy> {
  const roots = rootsFor(required);
  if (!roots.ok) return roots;
  const root = roots.value.get(required.subjectId) ?? required.subjectId;
  const consents: SubjectPolicy["consents"][number][] = [];
  const suppressions: SubjectPolicy["suppressions"][number][] = [];
  for (const record of required.evidence) {
    if ((roots.value.get(record.subjectId) ?? record.subjectId) !== root) continue;
    if (record.kind === "consent" || record.kind === "withdrawal") consents.push(structuredClone(record.consent));
    if (record.kind === "suppression") suppressions.push(structuredClone(record.suppression));
  }
  return { ok: true, value: { consents, suppressions, holdout: false } };
}
/** Validate append against immutable prior evidence; the caller commits atomically.
 * Records are schema-normalized by repository boundaries, independent of caller property order.
 * Returns the existing row for exact retry; null means append. @complexity O(n).
 */
export function checkAppend(required: { evidence: PolicyEvidence; existing: readonly PolicyEvidence[]; maxEvidence: number }): Outcome<PolicyEvidence | null> {
  const previous = required.existing.find(record => record.id === required.evidence.id);
  if (previous) return JSON.stringify(previous) === JSON.stringify(required.evidence)
    ? { ok: true, value: structuredClone(previous) }
    : failure({ code: "conflict", message: "Evidence ID already has different content" });
  if (required.existing.length >= required.maxEvidence) return failure({ code: "limit_exceeded", message: "Policy evidence capacity reached" });
  if (required.evidence.kind === "merge") {
    const roots = rootsFor({ evidence: [...required.existing, required.evidence] });
    if (!roots.ok) return roots;
  }
  return { ok: true, value: null };
}
