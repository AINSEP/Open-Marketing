import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, parseBoundary, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome, Scope, ServiceContext } from "@open-marketing/contracts";
import type { DestinationIdentifiers, Identifier, IdentifierInput, IdentifierKind, Subject } from "./types.js";
import { destinationIdentifierHash, normalizeEmail, normalizePhoneE164 } from "./normalize.js";

/** Fixed boundary bounds; all schemas are pure and strip no authority fields. */
export const kindSchema = z.enum(["email", "phone", "external_customer_id", "fbclid", "fbc", "fbp", "gclid", "gbraid", "wbraid"]);
export const contextSchema = z.union([callContextSchema, z.strictObject({ scope: scopeSchema, serviceId: idSchema, correlationId: idSchema, traceId: idSchema })]);
export const timezoneSchema = z.string().min(1).max(100).refine(value => validTimezone({ value }));
export const inputSchema = z.strictObject({ kind: kindSchema, raw: z.string().min(1).max(2048) });
export const subjectSchema = z.strictObject({ scope: scopeSchema, subjectId: idSchema, createdAt: epochSchema, creationOrder: epochSchema, mergedInto: idSchema.nullable(), timezone: timezoneSchema.optional(), lineage: z.array(z.strictObject({ sourceSubjectId: idSchema, targetSubjectId: idSchema, mergedAt: epochSchema })).max(1000) });
export const identifierSchema = z.strictObject({ identifierId: idSchema, subjectId: idSchema, kind: kindSchema, normalizedValue: z.string().min(1).max(2048), normalizationVersion: z.literal("v1"), identifierDigest: digestSchema, keyVersion: idSchema });
export const storedIdentifiersSchema = z.array(identifierSchema).max(1000);
export const upsertSchema = z.strictObject({ context: callContextSchema, identifiers: z.array(inputSchema).min(1).max(20), timezone: timezoneSchema.optional() });
export const repoUpsertSchema = z.strictObject({ context: callContextSchema, subject: subjectSchema, identifiers: z.array(identifierSchema).min(1).max(20) });
export const getSchema = z.strictObject({ context: contextSchema, subjectId: idSchema });
export const purgeSchema = getSchema.extend({ context: callContextSchema });
export const mergeSchema = z.strictObject({ context: callContextSchema, sourceSubjectId: idSchema, targetSubjectId: idSchema, mergedAt: epochSchema });
export const findSchema = z.strictObject({ context: callContextSchema, kind: kindSchema, identifierDigest: digestSchema });
export const projectionSchema = z.strictObject({ context: contextSchema, subjectId: idSchema, destination: idSchema, purpose: idSchema });

/** ICU validates zone names without reading a clock; Zod wraps its scalar callback. */
function validTimezone({ value }: { value: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}

/** Redacted typed errors shared by service and repository boundaries. */
export function failure(required: { code: AppError["code"]; message: string }): Outcome<never> {
  return { ok: false, error: { ...required, retryable: false } };
}
/** Caller-owned scopes are encoded without separator collisions. */
export function scopeKey(required: { scope: Scope }): string { return JSON.stringify([required.scope.ownerId, required.scope.workspaceId]); }
/** Only persistent identity kinds can select or merge a subject. */
export function stableKind(required: { kind: IdentifierKind }): boolean {
  return required.kind === "email" || required.kind === "phone" || required.kind === "external_customer_id";
}

/** Normalize one validated boundary input; opaque IDs preserve case.
 * @complexity O(n) time/space, n <= 2048. */
export function normalizeInput(required: { identifier: IdentifierInput }): Outcome<string> {
  const { kind, raw } = required.identifier;
  switch (kind) {
    case "email": return normalizeEmail({ raw });
    case "phone": return normalizePhoneE164({ raw });
    case "external_customer_id": return opaque({ raw });
    case "fbc": return click({ raw, pattern: /^fb\.\d+\.\d+\.[A-Za-z0-9_-]+$/ });
    case "fbp": return click({ raw, pattern: /^fb\.\d+\.\d+\.\d+$/ });
    case "fbclid": case "gclid": case "gbraid": case "wbraid": return click({ raw, pattern: /^[A-Za-z0-9_-]+$/ });
    default: { const exhaustive: never = kind; return exhaustive; }
  }
}
function opaque(required: { raw: string }): Outcome<string> {
  const value = required.raw.trim();
  if (!value || /[\x00-\x1f\x7f]/.test(value)) return failure({ code: "invalid_input", message: "Invalid identifier" });
  return { ok: true, value };
}
function click(required: { raw: string; pattern: RegExp }): Outcome<string> {
  if (required.raw.length > 256 || !required.pattern.test(required.raw)) return failure({ code: "invalid_input", message: "Invalid click identifier" });
  return { ok: true, value: required.raw };
}

/** Immutable insertion order beats argument direction and caller-supplied creationOrder. */
export function canonicalPair(required: { source: Subject; target: Subject }): { winner: Subject; loser: Subject } {
  const { source, target } = required;
  const earlier = source.creationOrder < target.creationOrder || (source.creationOrder === target.creationOrder && source.subjectId < target.subjectId);
  return earlier ? { winner: source, loser: target } : { winner: target, loser: source };
}

/** Validate atomic writes before effects, including scope and immutable merge metadata.
 * @complexity O(n), n <= 20. No effects. */
export function validateWrite(required: { context: CallContext; subject: Subject; identifiers: readonly Identifier[] }): Outcome<{ context: CallContext; subject: Subject; identifiers: readonly Identifier[] }> {
  const parsed = parseBoundary({ schema: repoUpsertSchema, input: required });
  if (!parsed.ok) return parsed;
  if (scopeKey({ scope: required.context.scope }) !== scopeKey({ scope: required.subject.scope })) return failure({ code: "forbidden", message: "Subject scope mismatch" });
  if (required.subject.mergedInto) return failure({ code: "conflict", message: "Merge metadata is repository-owned" });
  if (required.identifiers.some(item => item.subjectId !== required.subject.subjectId)) return failure({ code: "invalid_input", message: "Identifier subject mismatch" });
  return { ok: true, value: parsed.value };
}

/** Boundary wrappers redact thrown dependency failures and honor cancellation.
 * @complexity Work-dependent; no retries or dependency construction. */
export async function boundary<T>(required: { work: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled", message: "Contacts call cancelled" });
  try { return await required.work(); }
  catch { return failure({ code: "unavailable", message: "Contacts dependency unavailable" }); }
}

/** Validate untrusted repository subjects, including their caller scope and canonical shape. */
export function checkedSubject(required: { outcome: Outcome<Subject | null>; context: CallContext | ServiceContext }): Outcome<Subject | null> {
  if (!required.outcome.ok) return required.outcome;
  const parsed = subjectSchema.nullable().safeParse(required.outcome.value);
  if (!parsed.success) return failure({ code: "unavailable", message: "Invalid stored subject" });
  if (parsed.data && scopeKey({ scope: parsed.data.scope }) !== scopeKey({ scope: required.context.scope })) return failure({ code: "forbidden", message: "Stored subject scope mismatch" });
  if (parsed.data?.mergedInto) return failure({ code: "unavailable", message: "Repository returned noncanonical subject" });
  return { ok: true, value: parsed.data };
}

/** Deterministic first value per kind for the frozen scalar map. Stable IDs are SHA-256;
 * captured click cookies pass through; fbclid alone cannot supply fbc. Local HMAC stays separate.
 * @complexity O(n log n) time/O(n) space for a subject's retained identifiers. No I/O. */
export function projectIdentifiers(required: { subjectId: string; identifiers: readonly Identifier[] }): Outcome<DestinationIdentifiers> {
  const identifiers: Record<string, string> = {};
  const identifierDigests: Record<string, string> = {};
  const ordered = [...required.identifiers].sort(compareIdentifiers);
  for (const item of ordered) {
    if (item.kind === "fbclid") continue;
    const field = item.kind === "external_customer_id" ? "external_id" : item.kind;
    if (identifiers[field] !== undefined) continue;
    const value = destinationValue({ identifier: item });
    if (!value.ok) return value;
    identifiers[field] = value.value;
    identifierDigests[field] = item.identifierDigest;
  }
  if (!Object.keys(identifiers).length) return failure({ code: "unavailable", message: "No supported destination identifiers" });
  return { ok: true, value: { subjectId: required.subjectId, identifiers, identifierDigests } };
}
/** Array.sort comparator ABI; code-unit ordering is independent of machine locale. */
function compareIdentifiers(left: Identifier, right: Identifier): number {
  const a = JSON.stringify([left.kind, left.normalizedValue, left.keyVersion, left.identifierDigest]);
  const b = JSON.stringify([right.kind, right.normalizedValue, right.keyVersion, right.identifierDigest]);
  return a < b ? -1 : Number(a > b);
}
function destinationValue(required: { identifier: Identifier }): Outcome<string> {
  if (stableKind({ kind: required.identifier.kind })) return destinationIdentifierHash({ normalizedValue: required.identifier.normalizedValue });
  return { ok: true, value: required.identifier.normalizedValue };
}
