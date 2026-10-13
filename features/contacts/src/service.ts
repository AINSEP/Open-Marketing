import { z } from "zod";
import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { ContactRepoPort, ContactSuppressionPort } from "./ports.js";
import type { ContactService, DestinationIdentifiers, Identifier, IdentifierInput, Subject } from "./types.js";
import { identifierDigest } from "./normalize.js";
import { boundary, checkedSubject, failure, inputSchema, normalizeInput, projectIdentifiers, projectionSchema, stableKind, storedIdentifiersSchema, upsertSchema } from "./rules.js";

type Dependencies = {
  repo: ContactRepoPort; suppression: ContactSuppressionPort; clock: ClockPort; ids: IdPort;
  digest: { activeKeyVersion: string; keys: Readonly<Record<string, Uint8Array>> };
};
type Normalized = { kind: IdentifierInput["kind"]; normalizedValue: string };
const digestConfigSchema = z.strictObject({ activeKeyVersion: idSchema, keys: z.record(idSchema, z.instanceof(Uint8Array).refine(key => key.length > 0 && key.length <= 4096)) }).refine(config => Object.hasOwn(config.keys, config.activeKeyVersion)).refine(config => Object.keys(config.keys).length > 0 && Object.keys(config.keys).length <= 20);

/** Sole identity/merge authority. Retained HMAC keys are required for historical/tombstone
 * lookup; configuration and key bytes are copied. No dependencies run at construction.
 * @example createContactService({ repo, suppression, clock, ids, digest: { activeKeyVersion: "v1", keys: { v1: key } } })
 * @complexity Upsert/resolve use <=20 inputs x <=20 key versions; repository cost is adapter-owned. */
export function createContactService(required: Dependencies): ContactService {
  const digest = digestConfigSchema.safeParse(required.digest);
  const dependencies = digest.success ? { ...required, digest: structuredClone(digest.data) } : required;
  function run<T>(input: { work: () => Promise<Outcome<T>> }, options?: CallOptions): Promise<Outcome<T>> {
    if (!digest.success) return Promise.resolve(failure({ code: "unavailable", message: "Invalid contacts digest configuration" }));
    return boundary(input, options);
  }
  return {
    async upsert(input, options) { return run({ work: async () => upsert({ dependencies, input, options }) }, options); },
    async resolve(input, options) { return run({ work: async () => resolve({ dependencies, input, options }) }, options); },
    async merge(input, options) { return run({ work: async () => {
      const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, sourceSubjectId: idSchema, targetSubjectId: idSchema }), input });
      if (!parsed.ok) return parsed;
      const result = await dependencies.repo.merge({ ...parsed.value, mergedAt: dependencies.clock.now({}) }, options);
      return requireSubject({ outcome: checkedSubject({ outcome: result, context: input.context }) });
    } }, options); },
    async identifiersFor(input, options) { return run({ work: async () => identifiersFor({ dependencies, input, options }) }, options); },
  };
}

/** Normalize the entire bounded batch before any repository read or write. */
function normalizeBatch(required: { identifiers: readonly IdentifierInput[] }): Outcome<readonly Normalized[]> {
  const normalized = new Map<string, Normalized>();
  for (const identifier of required.identifiers) {
    const value = normalizeInput({ identifier });
    if (!value.ok) return value;
    const item = { kind: identifier.kind, normalizedValue: value.value };
    normalized.set(JSON.stringify([item.kind, item.normalizedValue]), item);
  }
  if (![...normalized.values()].some(item => stableKind(item))) return failure({ code: "invalid_input", message: "A stable identity identifier is required" });
  return { ok: true, value: [...normalized.values()] };
}

/** Historical lookup never uses clicks to select an identity. Distinct roots conflict. */
async function matches(required: { dependencies: Dependencies; context: CallContext; identifiers: readonly Normalized[]; options?: CallOptions }): Promise<Outcome<Subject | null>> {
  let match: Subject | null = null;
  for (const identifier of required.identifiers.filter(stableKind)) {
    const found = await lookup({ ...required, identifier });
    if (!found.ok) return found;
    if (!found.value) continue;
    if (match && match.subjectId !== found.value.subjectId) return failure({ code: "conflict", message: "Identifiers match multiple subjects" });
    match = found.value;
  }
  return { ok: true, value: match };
}
async function lookup(required: { dependencies: Dependencies; context: CallContext; identifier: Normalized; options?: CallOptions }): Promise<Outcome<Subject | null>> {
  let match: Subject | null = null;
  for (const [keyVersion, key] of Object.entries(required.dependencies.digest.keys)) {
    const digest = identifierDigest({ ...required.identifier, key, keyVersion });
    if (!digest.ok) return digest;
    const result = await required.dependencies.repo.findByDigest({ context: required.context, kind: required.identifier.kind, identifierDigest: digest.value }, required.options);
    const found = checkedSubject({ outcome: result, context: required.context });
    if (!found.ok) return found;
    if (!found.value) continue;
    if (match && match.subjectId !== found.value.subjectId) return failure({ code: "conflict", message: "Identifier key versions disagree" });
    match = found.value;
  }
  return { ok: true, value: match };
}

async function upsert(required: { dependencies: Dependencies; input: Parameters<ContactService["upsert"]>[0]; options?: CallOptions }): Promise<Outcome<Subject>> {
  const parsed = parseBoundary({ schema: upsertSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const normalized = normalizeBatch({ identifiers: parsed.value.identifiers });
  if (!normalized.ok) return normalized;
  const found = await matches({ ...required, context: parsed.value.context, identifiers: normalized.value });
  if (!found.ok) return found;
  if (found.value) {
    const retained = await required.dependencies.repo.identifiersFor({ context: parsed.value.context, subjectId: found.value.subjectId }, required.options);
    const checked = checkIdentifiers({ outcome: retained, subjectId: found.value.subjectId, keys: required.dependencies.digest.keys });
    if (!checked.ok) return checked;
  }
  const subject = found.value ?? { scope: parsed.value.context.scope, subjectId: required.dependencies.ids.next({}), createdAt: required.dependencies.clock.now({}), creationOrder: 0, mergedInto: null, lineage: [] };
  const identifiers = prepareIdentifiers({ dependencies: required.dependencies, subjectId: subject.subjectId, identifiers: normalized.value });
  if (!identifiers.ok) return identifiers;
  const result = await required.dependencies.repo.upsert({ context: parsed.value.context, subject: { ...subject, timezone: parsed.value.timezone ?? subject.timezone }, identifiers: identifiers.value }, required.options);
  const checked = requireSubject({ outcome: checkedSubject({ outcome: result, context: parsed.value.context }) });
  if (checked.ok && checked.value.subjectId !== subject.subjectId) return failure({ code: "conflict", message: "Repository identity changed during upsert" });
  return checked;
}
function prepareIdentifiers(required: { dependencies: Dependencies; subjectId: string; identifiers: readonly Normalized[] }): Outcome<readonly Identifier[]> {
  const identifiers: Identifier[] = [];
  const { activeKeyVersion, keys } = required.dependencies.digest;
  for (const identifier of required.identifiers) {
    const digest = identifierDigest({ ...identifier, key: keys[activeKeyVersion], keyVersion: activeKeyVersion });
    if (!digest.ok) return digest;
    identifiers.push({ ...identifier, subjectId: required.subjectId, identifierId: required.dependencies.ids.next({}), identifierDigest: digest.value, keyVersion: activeKeyVersion, normalizationVersion: "v1" });
  }
  return { ok: true, value: identifiers };
}
async function resolve(required: { dependencies: Dependencies; input: Parameters<ContactService["resolve"]>[0]; options?: CallOptions }): Promise<Outcome<Subject>> {
  const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, identifier: inputSchema }), input: required.input });
  if (!parsed.ok) return parsed;
  if (!stableKind(parsed.value.identifier)) return failure({ code: "invalid_input", message: "Click identifiers cannot resolve a subject" });
  const normalized = normalizeInput({ identifier: parsed.value.identifier });
  if (!normalized.ok) return normalized;
  const outcome = await lookup({ ...required, context: parsed.value.context, identifier: { kind: parsed.value.identifier.kind, normalizedValue: normalized.value } });
  return requireSubject({ outcome });
}
function requireSubject(required: { outcome: Outcome<Subject | null> }): Outcome<Subject> {
  if (!required.outcome.ok) return required.outcome;
  if (!required.outcome.value) return failure({ code: "unavailable", message: "Subject not found" });
  return { ok: true, value: required.outcome.value };
}

/** Canonical reload -> current policy assessment -> transient projection. No permission is cached.
 * Concurrent erasure/withdrawal serialization belongs to the server dispatch barrier. */
async function identifiersFor(required: { dependencies: Dependencies; input: Parameters<ContactService["identifiersFor"]>[0]; options?: CallOptions }): Promise<Outcome<DestinationIdentifiers>> {
  const parsed = parseBoundary({ schema: projectionSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const subject = requireSubject({ outcome: checkedSubject({ outcome: await required.dependencies.repo.get({ context: parsed.value.context, subjectId: parsed.value.subjectId }, required.options), context: parsed.value.context }) });
  if (!subject.ok) return subject;
  const loaded = await required.dependencies.repo.identifiersFor({ context: parsed.value.context, subjectId: subject.value.subjectId }, required.options);
  const identifiers = checkIdentifiers({ outcome: loaded, subjectId: subject.value.subjectId, keys: required.dependencies.digest.keys });
  if (!identifiers.ok) return identifiers;
  const assessment = await required.dependencies.suppression.assess({ ...parsed.value, subjectId: subject.value.subjectId, identifierDigests: identifiers.value.map(item => item.identifierDigest) }, required.options);
  if (!assessment.ok) return assessment;
  const allowed = z.strictObject({ allowed: z.boolean() }).safeParse(assessment.value);
  if (!allowed.success || !allowed.data.allowed) return failure({ code: "forbidden", message: "Identifier sharing denied" });
  return projectIdentifiers({ subjectId: subject.value.subjectId, identifiers: identifiers.value });
}
function checkIdentifiers(required: { outcome: Outcome<readonly Identifier[]>; subjectId: string; keys: Readonly<Record<string, Uint8Array>> }): Outcome<readonly Identifier[]> {
  if (!required.outcome.ok) return required.outcome;
  const parsed = storedIdentifiersSchema.safeParse(required.outcome.value);
  if (!parsed.success) return failure({ code: "unavailable", message: "Invalid stored identifiers" });
  if (parsed.data.some(item => item.subjectId !== required.subjectId)) return failure({ code: "forbidden", message: "Identifier subject mismatch" });
  if (parsed.data.some(item => !Object.hasOwn(required.keys, item.keyVersion))) return failure({ code: "unavailable", message: "Retained identifier key unavailable" });
  return { ok: true, value: parsed.data };
}
