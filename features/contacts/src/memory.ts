import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, Outcome, Scope, ServiceContext } from "@open-marketing/contracts";
import type { ContactRepoPort } from "./ports.js";
import type { Identifier, Subject } from "./types.js";
import { boundary, canonicalPair, failure, findSchema, getSchema, mergeSchema, purgeSchema, scopeKey, stableKind, storedIdentifiersSchema, validateWrite } from "./rules.js";

type StoredIdentifier = { scope: string; identifier: Identifier };
type Store = { subjects: Map<string, Subject>; identifiers: Map<string, StoredIdentifier>; erased: Set<string>; order: number };
function key(required: { scope: Scope; id: string }): string { return JSON.stringify([scopeKey({ scope: required.scope }), required.id]); }

/** Instance-owned in-memory repository. Mutations are synchronous after all validation,
 * so failures/collisions never publish partial state. Inputs and outputs are copied.
 * @example createMemoryContactRepo({})
 * @complexity Scans O(n) stored records per lookup; writes O(20n), merges O(n). */
export function createMemoryContactRepo(_required: Record<string, never>): ContactRepoPort {
  const store: Store = { subjects: new Map(), identifiers: new Map(), erased: new Set(), order: 0 };
  return {
    async get(input, options) { return boundary({ work: async () => {
      const parsed = parseBoundary({ schema: getSchema, input });
      if (!parsed.ok) return parsed;
      return root({ store, ...parsed.value });
    } }, options); },
    async findByDigest(input, options) { return boundary({ work: async () => {
      const parsed = parseBoundary({ schema: findSchema, input });
      if (!parsed.ok) return parsed;
      if (!stableKind(parsed.value)) return { ok: true, value: null };
      const scope = scopeKey({ scope: parsed.value.context.scope });
      const found = [...store.identifiers.values()].find(item => item.scope === scope && item.identifier.kind === parsed.value.kind && item.identifier.identifierDigest === parsed.value.identifierDigest);
      if (!found) return { ok: true, value: null };
      return root({ store, context: input.context, subjectId: found.identifier.subjectId });
    } }, options); },
    async upsert(input, options) { return boundary({ work: async () => write({ store, input }), }, options); },
    async merge(input, options) { return boundary({ work: async () => merge({ store, input }), }, options); },
    async identifiersFor(input, options) { return boundary<readonly Identifier[]>({ work: async () => {
      const parsed = parseBoundary({ schema: getSchema, input });
      if (!parsed.ok) return parsed;
      const subject = root({ store, ...input });
      if (!subject.ok) return subject;
      if (!subject.value) return failure({ code: "unavailable", message: "Subject not found" });
      if (store.erased.has(key({ scope: input.context.scope, id: subject.value.subjectId }))) return failure({ code: "forbidden", message: "Subject erased" });
      const identifiers = storedIdentifiersSchema.safeParse(ownedIdentifiers({ store, scope: input.context.scope, subjectId: subject.value.subjectId }));
      if (!identifiers.success) return failure({ code: "unavailable", message: "Invalid stored identifiers" });
      return { ok: true, value: identifiers.data };
    } }, options); },
    async purgeIdentifiers(input, options) { return boundary({ work: async () => purge({ store, input }), }, options); },
  };
}

/** Resolve only within caller scope. Corrupt/cyclic/overlong pointers fail explicitly. */
function root(required: { store: Store; context: CallContext | ServiceContext; subjectId: string }): Outcome<Subject | null> {
  let current = required.store.subjects.get(key({ scope: required.context.scope, id: required.subjectId }));
  if (!current) return { ok: true, value: null };
  const seen = new Set<string>();
  while (current.mergedInto) {
    if (seen.has(current.subjectId) || seen.size >= 100) return failure({ code: "conflict", message: "Invalid merge chain" });
    seen.add(current.subjectId);
    current = required.store.subjects.get(key({ scope: required.context.scope, id: current.mergedInto }));
    if (!current) return failure({ code: "conflict", message: "Broken merge chain" });
  }
  if (seen.size >= 100) return failure({ code: "conflict", message: "Merge chain too long" });
  return { ok: true, value: structuredClone(current) };
}
function ownedIdentifiers(required: { store: Store; scope: Scope; subjectId: string }): Identifier[] {
  const scope = scopeKey({ scope: required.scope });
  return [...required.store.identifiers.values()].filter(item => item.scope === scope && item.identifier.subjectId === required.subjectId).map(item => item.identifier);
}

/** Validate every collision before committing the subject or identifier batch. */
function write(required: { store: Store; input: Parameters<ContactRepoPort["upsert"]>[0] }): Outcome<Subject> {
  const valid = validateWrite(required.input);
  if (!valid.ok) return valid;
  const input = valid.value;
  const subjectKey = key({ scope: input.context.scope, id: input.subject.subjectId });
  const previous = required.store.subjects.get(subjectKey);
  const writable = checkWritable({ previous, erased: required.store.erased.has(subjectKey), subject: input.subject });
  if (!writable.ok) return writable;
  const collisions = checkIdentifiers({ store: required.store, input });
  if (!collisions.ok) return collisions;
  const subject = previous ? { ...previous, timezone: input.subject.timezone ?? previous.timezone } : { ...input.subject, creationOrder: ++required.store.order };
  required.store.subjects.set(subjectKey, subject);
  const scope = scopeKey({ scope: input.context.scope });
  const retained = ownedIdentifiers({ store: required.store, scope: input.context.scope, subjectId: subject.subjectId });
  for (const identifier of input.identifiers) {
    if (retained.some(item => item.kind === identifier.kind && item.identifierDigest === identifier.identifierDigest)) continue;
    required.store.identifiers.set(key({ scope: input.context.scope, id: identifier.identifierId }), { scope, identifier });
    retained.push(identifier);
  }
  return { ok: true, value: structuredClone(subject) };
}
function checkWritable(required: { previous?: Subject; erased: boolean; subject: Subject }): Outcome<void> {
  if (required.erased) return failure({ code: "forbidden", message: "Subject erased" });
  if (required.previous?.mergedInto) return failure({ code: "conflict", message: "Cannot update a merged subject" });
  if (!required.previous && required.subject.lineage.length) return failure({ code: "conflict", message: "Merge metadata is repository-owned" });
  if (required.previous && (required.previous.createdAt !== required.subject.createdAt || required.previous.creationOrder !== required.subject.creationOrder)) return failure({ code: "conflict", message: "Subject creation metadata conflict" });
  return { ok: true, value: undefined };
}
function checkIdentifiers(required: { store: Store; input: Parameters<ContactRepoPort["upsert"]>[0] }): Outcome<void> {
  const { input } = required;
  const scoped = [...required.store.identifiers.values()].filter(item => item.scope === scopeKey({ scope: input.context.scope })).map(item => item.identifier);
  const ids = new Map<string, string>();
  for (const identifier of input.identifiers) {
    const identity = identifierIdentity({ identifier });
    const existing = required.store.identifiers.get(key({ scope: input.context.scope, id: identifier.identifierId }));
    if (existing && identifierIdentity({ identifier: existing.identifier }) !== identity) return failure({ code: "conflict", message: "Identifier ID collision" });
    if (ids.has(identifier.identifierId) && ids.get(identifier.identifierId) !== identity) return failure({ code: "conflict", message: "Identifier batch collision" });
    ids.set(identifier.identifierId, identity);
    if (ownershipCollision({ scoped, identifier })) return failure({ code: "conflict", message: "Identifier already belongs to another subject" });
  }
  return { ok: true, value: undefined };
}
function identifierIdentity(required: { identifier: Identifier }): string {
  const item = required.identifier;
  return JSON.stringify([item.subjectId, item.kind, item.identifierDigest, item.keyVersion, item.normalizedValue]);
}
function ownershipCollision(required: { scoped: readonly Identifier[]; identifier: Identifier }): boolean {
  if (!stableKind(required.identifier)) return false;
  return required.scoped.some(item => item.kind === required.identifier.kind && item.identifierDigest === required.identifier.identifierDigest && item.subjectId !== required.identifier.subjectId);
}

/** Move ownership and append one lineage entry; replay resolves the same root without writes. */
function merge(required: { store: Store; input: Parameters<ContactRepoPort["merge"]>[0] }): Outcome<Subject> {
  const parsed = parseBoundary({ schema: mergeSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { input, store } = required;
  const source = root({ store, context: input.context, subjectId: input.sourceSubjectId });
  const target = root({ store, context: input.context, subjectId: input.targetSubjectId });
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (!source.value || !target.value) return failure({ code: "unavailable", message: "Subject not found" });
  const pair = canonicalPair({ source: source.value, target: target.value });
  return commitMerge({ store, input, ...pair });
}
function commitMerge(required: { store: Store; input: Parameters<ContactRepoPort["merge"]>[0]; winner: Subject; loser: Subject }): Outcome<Subject> {
  const { store, input, winner, loser } = required;
  const winnerKey = key({ scope: input.context.scope, id: winner.subjectId });
  const loserKey = key({ scope: input.context.scope, id: loser.subjectId });
  if (store.erased.has(winnerKey) || store.erased.has(loserKey)) return failure({ code: "forbidden", message: "Subject erased" });
  if (winner.subjectId === loser.subjectId) return { ok: true, value: winner };
  const lineage = [...winner.lineage, ...loser.lineage, { sourceSubjectId: loser.subjectId, targetSubjectId: winner.subjectId, mergedAt: input.mergedAt }].sort((left, right) => left.mergedAt - right.mergedAt || (left.sourceSubjectId < right.sourceSubjectId ? -1 : Number(left.sourceSubjectId > right.sourceSubjectId)));
  const merged = { ...winner, lineage };
  if (lineage.length > 1000) return failure({ code: "limit_exceeded", message: "Merge lineage limit reached" });
  store.subjects.set(winnerKey, merged);
  store.subjects.set(loserKey, { ...loser, mergedInto: winner.subjectId });
  for (const identifier of ownedIdentifiers({ store, scope: input.context.scope, subjectId: loser.subjectId })) {
    store.identifiers.set(key({ scope: input.context.scope, id: identifier.identifierId }), { scope: scopeKey({ scope: input.context.scope }), identifier: { ...identifier, subjectId: winner.subjectId } });
  }
  return { ok: true, value: structuredClone(merged) };
}

/** Purge all members of a canonical identity; stable digest records retain empty values privately. */
function purge(required: { store: Store; input: Parameters<ContactRepoPort["purgeIdentifiers"]>[0] }): Outcome<{ purged: number }> {
  const parsed = parseBoundary({ schema: purgeSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const { input, store } = required;
  const subject = root({ store, ...input });
  if (!subject.ok) return subject;
  if (!subject.value) return failure({ code: "unavailable", message: "Subject not found" });
  const subjectId = subject.value.subjectId;
  let purged = 0;
  for (const identifier of ownedIdentifiers({ store, scope: input.context.scope, subjectId })) {
    if (identifier.normalizedValue) purged++;
    const identifierKey = key({ scope: input.context.scope, id: identifier.identifierId });
    if (!stableKind({ kind: identifier.kind })) { store.identifiers.delete(identifierKey); continue; }
    store.identifiers.set(identifierKey, { scope: scopeKey({ scope: input.context.scope }), identifier: { ...identifier, normalizedValue: "" } });
  }
  markErased({ store, input, subject: subject.value });
  return { ok: true, value: { purged } };
}
function markErased(required: { store: Store; input: Parameters<ContactRepoPort["purgeIdentifiers"]>[0]; subject: Subject }): void {
  const { store, input } = required;
  const members = [required.subject.subjectId, ...required.subject.lineage.map(item => item.sourceSubjectId)];
  for (const member of members) {
    const subjectKey = key({ scope: input.context.scope, id: member });
    const previous = store.subjects.get(subjectKey);
    if (!previous) continue;
    const { timezone: _timezone, ...retained } = previous;
    store.subjects.set(subjectKey, retained);
    store.erased.add(subjectKey);
  }
}
