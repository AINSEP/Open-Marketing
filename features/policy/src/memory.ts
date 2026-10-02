import type { Scope } from "@open-marketing/contracts";
import type { CanonicalIdentityPort, PolicyRepoPort } from "./ports.js";
import type { IdentifierBinding, PolicyEvidence } from "./types.js";
import { bindingSchema, evidenceSchema, evidenceLimit, PolicyConfigurationError, failure, sameScope, validateEvidence, validateRequest } from "./validation.js";
import { checkAppend, projectSnapshot, rootsFor } from "./projection.js";

export type MemoryPolicyOptions = { readonly bindings?: readonly IdentifierBinding[]; readonly evidence?: readonly PolicyEvidence[]; readonly maxEvidence?: number };

/** Isolated append-only double with shared canonical identity view; no global state.
 * Invalid seed/config throws before exposure; operations return typed failures.
 * @example const repo = createMemoryPolicyRepo({}); createPolicyService({ repo, clock, ids })
 * @complexity O(n) reads/append checks; bounded per-scope evidence, O(n) retained state.
 */
export function createMemoryPolicyRepo(required: MemoryPolicyOptions): PolicyRepoPort & CanonicalIdentityPort {
  const maxEvidence = evidenceLimit({ value: required.maxEvidence });
  const { records, bindings } = parseSeeds(required);
  validateSeeds({ records, maxEvidence });
  return {
    async snapshot(input, options) {
      const invalid = validateRequest({ ...input, options });
      if (invalid) return invalid;
      return projectSnapshot({ subjectId: input.subjectId, evidence: scopedRecords({ records, scope: input.context.scope }) });
    },
    async appendEvidence(input, options) {
      const invalid = validateEvidence({ ...input, options });
      if (invalid) return invalid;
      const evidence = evidenceSchema.parse(input.evidence);
      const checked = checkAppend({ evidence, existing: scopedRecords({ records, scope: input.context.scope }), maxEvidence });
      if (!checked.ok) return checked;
      if (checked.value) return { ok: true, value: checked.value };
      records.push(evidence);
      return { ok: true, value: structuredClone(evidence) };
    },
    async resolve(input, options) {
      const invalid = validateRequest({ context: input.context, subjectId: input.identifier, options });
      if (invalid) return invalid;
      const matches = bindings.filter(binding => binding.identifier === input.identifier && sameScope({ left: binding.subject.scope, right: input.context.scope }));
      if (matches.length !== 1) return failure({ code: "unavailable", message: "Canonical identifier missing or ambiguous" });
      const roots = rootsFor({ evidence: scopedRecords({ records, scope: input.context.scope }) });
      if (!roots.ok) return roots;
      return { ok: true, value: { scope: structuredClone(input.context.scope), subjectId: roots.value.get(matches[0].subject.subjectId) ?? matches[0].subject.subjectId } };
    },
  };
}
/** Resolve prebound identifiers without manufacturing identities or merging workspaces.
 * @example createMemoryCanonicalIdentity({ bindings: [{ identifier, subject }] })
 * @complexity O(n) bounded evidence and identifier scan.
 */
export function createMemoryCanonicalIdentity(required: MemoryPolicyOptions): CanonicalIdentityPort {
  return createMemoryPolicyRepo(required);
}
/** Tenant filter before all projection and retry lookup. @complexity O(n). */
function scopedRecords(required: { records: readonly PolicyEvidence[]; scope: Scope }): PolicyEvidence[] {
  return required.records.filter(record => sameScope({ left: record.scope, right: required.scope }));
}
/** Seed validation groups scopes once and detects invalid merge graphs without quadratic replay.
 * @complexity O(n) expected time/space for n seed records.
 */
function validateSeeds(required: { records: readonly PolicyEvidence[]; maxEvidence: number }): void {
  const scopes = new Map<string, PolicyEvidence[]>();
  const ids = new Set<string>();
  for (const evidence of required.records) {
    validateSeedScope({ evidence });
    const scopeKey = JSON.stringify([evidence.scope.ownerId, evidence.scope.workspaceId]);
    const idKey = JSON.stringify([scopeKey, evidence.id]);
    if (ids.has(idKey)) throw new PolicyConfigurationError({ message: "Duplicate seed evidence" });
    ids.add(idKey);
    const records = scopes.get(scopeKey) ?? [];
    records.push(evidence);
    scopes.set(scopeKey, records);
  }
  for (const evidence of scopes.values()) {
    if (evidence.length > required.maxEvidence || !rootsFor({ evidence }).ok) throw new PolicyConfigurationError({ message: "Invalid seed evidence graph or capacity" });
  }
}
/** Validate cross-scope seed merges before grouping. @complexity O(1). */
function validateSeedScope(required: { evidence: PolicyEvidence }): void {
  if (required.evidence.kind === "merge" && !sameScope({ left: required.evidence.scope, right: required.evidence.target.scope })) throw new PolicyConfigurationError({ message: "Invalid seed merge scope" });
}

/** Bound and validate external fixture data before exposing mutable state. @complexity O(n). */
function parseSeeds(required: MemoryPolicyOptions): { records: PolicyEvidence[]; bindings: IdentifierBinding[] } {
  const evidence = evidenceSchema.array().max(100_000).safeParse(required.evidence ?? []);
  const identifiers = bindingSchema.array().max(100_000).safeParse(required.bindings ?? []);
  if (!evidence.success || !identifiers.success) throw new PolicyConfigurationError({ message: "Invalid policy seed data" });
  return { records: evidence.data, bindings: identifiers.data };
}
