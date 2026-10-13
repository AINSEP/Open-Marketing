import { z } from "zod";
import { epochSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, ServiceContext, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { ContactRepoPort } from "./ports.js";
import type { Identifier, Subject } from "./types.js";
import { boundary, canonicalPair, failure, findSchema, getSchema, identifierSchema, mergeSchema, purgeSchema, stableKind, storedIdentifiersSchema, subjectSchema, timezoneSchema, validateWrite } from "./rules.js";

type Context = CallContext | ServiceContext;
type Loaded = { subject: Subject; erased: boolean };
const rowSchema = z.strictObject({ subject_id: idSchema, created_at: epochSchema, creation_order: epochSchema, merged_into: idSchema.nullable(), timezone: timezoneSchema.nullable(), erased: z.union([z.literal(0), z.literal(1)]) });
const identifierColumns = "identifier_id AS identifierId, subject_id AS subjectId, kind, normalized_value AS normalizedValue, normalization_version AS normalizationVersion, identifier_digest AS identifierDigest, key_version AS keyVersion";
const treeSql = `WITH RECURSIVE members(subject_id) AS (
  SELECT subject_id FROM contact_subject WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3
  UNION SELECT child.subject_id FROM contact_subject child JOIN members ON child.merged_into=members.subject_id
  WHERE child.owner_id=$1 AND child.workspace_id=$2
)`;
function scopeValues(required: { context: Context }): unknown[] { return [required.context.scope.ownerId, required.context.scope.workspaceId]; }

/** Repository over the caller's transaction owner (or its leased SqlSession). No driver,
 * kernel, connection or transaction lifecycle is constructed here. Failed root Outcomes roll back.
 * @example createSqlContactRepo({ uow: session })
 * @complexity Indexed lookups; <=20 identifiers (two reads/one write each) per upsert.
 * Root chains <=100 hops; identifier/lineage reloads are bounded to 1000 records. */
export function createSqlContactRepo(required: { uow: UnitOfWork }): ContactRepoPort {
  return {
    async get(input, options) {
      const parsed = parseBoundary({ schema: getSchema, input });
      if (!parsed.ok) return parsed;
      return sqlCall({ uow: required.uow, work: async ({ session }) => {
        const loaded = await loadRoot({ session, ...parsed.value });
        if (!loaded.ok) return loaded;
        return { ok: true, value: loaded.value?.subject ?? null };
      } }, options);
    },
    async findByDigest(input, options) {
      const parsed = parseBoundary({ schema: findSchema, input });
      if (!parsed.ok) return parsed;
      return sqlCall({ uow: required.uow, work: async ({ session }) => find({ session, input: parsed.value }) }, options);
    },
    async upsert(input, options) {
      const parsed = validateWrite(input);
      if (!parsed.ok) return parsed;
      return sqlCall({ uow: required.uow, work: async ({ session }) => write({ session, input: parsed.value }) }, options);
    },
    async merge(input, options) {
      const parsed = parseBoundary({ schema: mergeSchema, input });
      if (!parsed.ok) return parsed;
      return sqlCall({ uow: required.uow, work: async ({ session }) => merge({ session, input: parsed.value }) }, options);
    },
    async identifiersFor(input, options) {
      const parsed = parseBoundary({ schema: getSchema, input });
      if (!parsed.ok) return parsed;
      return sqlCall({ uow: required.uow, work: async ({ session }) => readIdentifiers({ session, input: parsed.value }) }, options);
    },
    async purgeIdentifiers(input, options) {
      const parsed = parseBoundary({ schema: purgeSchema, input });
      if (!parsed.ok) return parsed;
      return sqlCall({ uow: required.uow, work: async ({ session }) => purge({ session, input: parsed.value }) }, options);
    },
  };
}

async function find(required: { session: SqlSession; input: Parameters<ContactRepoPort["findByDigest"]>[0] }): Promise<Outcome<Subject | null>> {
  const { session, input } = required;
  if (!stableKind(input)) return { ok: true, value: null };
  const found = await session.query({ text: "SELECT subject_id FROM contact_identifier WHERE owner_id=$1 AND workspace_id=$2 AND kind=$3 AND identifier_digest=$4 ORDER BY subject_id LIMIT 2", values: [...scopeValues(input), input.kind, input.identifierDigest] });
  const ids = z.array(z.strictObject({ subject_id: idSchema })).safeParse(found.rows);
  if (!ids.success) return failure({ code: "unavailable", message: "Invalid stored identifier owner" });
  if (!ids.data.length) return { ok: true, value: null };
  if (ids.data.some(row => row.subject_id !== ids.data[0].subject_id)) return failure({ code: "conflict", message: "Ambiguous identifier" });
  const loaded = await loadRoot({ session, context: input.context, subjectId: ids.data[0].subject_id });
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "conflict", message: "Orphaned identifier" });
  return { ok: true, value: loaded.value.subject };
}
async function readIdentifiers(required: { session: SqlSession; input: Parameters<ContactRepoPort["identifiersFor"]>[0] }): Promise<Outcome<readonly Identifier[]>> {
  const { session, input } = required;
  const loaded = await loadRoot({ session, ...input });
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "unavailable", message: "Subject not found" });
  if (loaded.value.erased) return failure({ code: "forbidden", message: "Subject erased" });
  const rows = await session.query({ text: `SELECT ${identifierColumns} FROM contact_identifier WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3 LIMIT 1001`, values: [...scopeValues(input), loaded.value.subject.subjectId] });
  const identifiers = storedIdentifiersSchema.safeParse(rows.rows);
  if (!identifiers.success) return failure({ code: "unavailable", message: "Invalid stored identifiers" });
  return { ok: true, value: identifiers.data };
}

/** Driver errors are redacted outside the transaction, so partial writes roll back first. */
async function sqlCall<T>(required: { uow: UnitOfWork; work: (required: { session: SqlSession }) => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  return boundary({ work: async () => {
    try { return await required.uow.transaction({ work: required.work }); }
    catch (error) {
      if (constraintError({ error })) return failure({ code: "conflict", message: "Contacts storage conflict" });
      return failure({ code: "unavailable", message: "Contacts storage unavailable" });
    }
  } }, optional);
}
function constraintError(required: { error: unknown }): boolean {
  if (typeof required.error !== "object" || required.error === null || !("code" in required.error)) return false;
  return String(required.error.code).startsWith("SQLITE_CONSTRAINT") || required.error.code === "23505";
}

/** Read roots without cross-scope joins; UNION deduplicates the lineage tree.
 * @complexity <=100 indexed pointer reads plus O(m) lineage rows for m merged members. */
async function loadRoot(required: { session: SqlSession; context: Context; subjectId: string }): Promise<Outcome<Loaded | null>> {
  let subjectId = required.subjectId;
  const seen = new Set<string>();
  while (seen.size < 100) {
    if (seen.has(subjectId)) return failure({ code: "conflict", message: "Invalid merge chain" });
    seen.add(subjectId);
    const result = await required.session.query({ text: "SELECT subject_id,created_at,creation_order,merged_into,timezone,erased FROM contact_subject WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3", values: [...scopeValues(required), subjectId] });
    if (!result.rows.length) return missingRoot({ hops: seen.size });
    const row = rowSchema.safeParse(result.rows[0]);
    if (!row.success) return failure({ code: "unavailable", message: "Invalid stored subject" });
    if (row.data.merged_into) { subjectId = row.data.merged_into; continue; }
    return hydrate({ ...required, row: row.data });
  }
  return failure({ code: "conflict", message: "Merge chain too long" });
}
function missingRoot(required: { hops: number }): Outcome<null> {
  if (required.hops > 1) return failure({ code: "conflict", message: "Broken merge chain" });
  return { ok: true, value: null };
}
async function hydrate(required: { session: SqlSession; context: Context; row: z.infer<typeof rowSchema> }): Promise<Outcome<Loaded>> {
  const { row } = required;
  const result = await required.session.query({ text: `${treeSql} SELECT source_subject_id AS sourceSubjectId,target_subject_id AS targetSubjectId,merged_at AS mergedAt FROM contact_merge WHERE owner_id=$1 AND workspace_id=$2 AND source_subject_id IN (SELECT subject_id FROM members) ORDER BY merged_at,source_subject_id LIMIT 1001`, values: [...scopeValues(required), row.subject_id] });
  const parsed = subjectSchema.safeParse({ scope: required.context.scope, subjectId: row.subject_id, createdAt: row.created_at, creationOrder: row.creation_order, mergedInto: null, ...(row.timezone === null ? {} : { timezone: row.timezone }), lineage: result.rows });
  if (!parsed.success) return failure({ code: "unavailable", message: "Invalid stored lineage" });
  return { ok: true, value: { subject: parsed.data, erased: row.erased === 1 } };
}

/** Each write joins the owning transaction. SQLite constraints are the concurrent collision guard. */
async function write(required: { session: SqlSession; input: Parameters<ContactRepoPort["upsert"]>[0] }): Promise<Outcome<Subject>> {
  const { input, session } = required;
  const previous = await loadRoot({ session, context: input.context, subjectId: input.subject.subjectId });
  if (!previous.ok) return previous;
  const writable = checkWritable({ loaded: previous.value, subject: input.subject });
  if (!writable.ok) return writable;
  const values = [...scopeValues(input), input.subject.subjectId];
  if (!previous.value) {
    await session.query({ text: "INSERT INTO contact_subject(owner_id,workspace_id,subject_id,created_at,timezone) VALUES($1,$2,$3,$4,$5)", values: [...values, input.subject.createdAt, input.subject.timezone ?? null] });
  } else {
    await session.query({ text: "UPDATE contact_subject SET timezone=$4 WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3", values: [...values, input.subject.timezone ?? previous.value.subject.timezone ?? null] });
  }
  const attached = await attach({ session, input });
  if (!attached.ok) return attached;
  const loaded = await loadRoot({ session, context: input.context, subjectId: input.subject.subjectId });
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "unavailable", message: "Subject write unavailable" });
  return { ok: true, value: loaded.value.subject };
}
function checkWritable(required: { loaded: Loaded | null; subject: Subject }): Outcome<void> {
  if (required.loaded?.erased) return failure({ code: "forbidden", message: "Subject erased" });
  if (required.loaded && required.loaded.subject.subjectId !== required.subject.subjectId) return failure({ code: "conflict", message: "Cannot update a merged subject" });
  if (!required.loaded && required.subject.lineage.length) return failure({ code: "conflict", message: "Merge metadata is repository-owned" });
  if (required.loaded && (required.loaded.subject.createdAt !== required.subject.createdAt || required.loaded.subject.creationOrder !== required.subject.creationOrder)) return failure({ code: "conflict", message: "Subject creation metadata conflict" });
  return { ok: true, value: undefined };
}
async function attach(required: { session: SqlSession; input: Parameters<ContactRepoPort["upsert"]>[0] }): Promise<Outcome<void>> {
  for (const identifier of required.input.identifiers) {
    const result = await attachOne({ ...required, identifier });
    if (!result.ok) return result;
  }
  return { ok: true, value: undefined };
}
async function attachOne(required: { session: SqlSession; input: Parameters<ContactRepoPort["upsert"]>[0]; identifier: Identifier }): Promise<Outcome<void>> {
  const { input, identifier, session } = required;
  const values = [...scopeValues(input), identifier.identifierId, identifier.subjectId, identifier.kind, identifier.normalizedValue, identifier.normalizationVersion, identifier.identifierDigest, identifier.keyVersion];
  const existing = await session.query({ text: `SELECT ${identifierColumns} FROM contact_identifier WHERE owner_id=$1 AND workspace_id=$2 AND identifier_id=$3`, values: values.slice(0, 3) });
  if (existing.rows.length) return compareStored({ stored: existing.rows[0], identifier });
  const duplicate = await session.query({ text: "SELECT identifier_id FROM contact_identifier WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3 AND kind=$4 AND identifier_digest=$5", values: [...scopeValues(input), identifier.subjectId, identifier.kind, identifier.identifierDigest] });
  if (duplicate.rows.length) return { ok: true, value: undefined };
  await session.query({ text: "INSERT INTO contact_identifier(owner_id,workspace_id,identifier_id,subject_id,kind,normalized_value,normalization_version,identifier_digest,key_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", values });
  return { ok: true, value: undefined };
}
function compareStored(required: { stored: unknown; identifier: Identifier }): Outcome<void> {
  const parsed = identifierSchema.safeParse(required.stored);
  if (!parsed.success) return failure({ code: "conflict", message: "Identifier ID collision" });
  const stored = parsed.data;
  const input = required.identifier;
  if (stored.subjectId !== input.subjectId || stored.kind !== input.kind || stored.identifierDigest !== input.identifierDigest || stored.keyVersion !== input.keyVersion || stored.normalizedValue !== input.normalizedValue) return failure({ code: "conflict", message: "Identifier ID collision" });
  return { ok: true, value: undefined };
}

async function merge(required: { session: SqlSession; input: Parameters<ContactRepoPort["merge"]>[0] }): Promise<Outcome<Subject>> {
  const { session, input } = required;
  const source = await loadRoot({ session, context: input.context, subjectId: input.sourceSubjectId });
  const target = await loadRoot({ session, context: input.context, subjectId: input.targetSubjectId });
  if (!source.ok) return source;
  if (!target.ok) return target;
  if (!source.value || !target.value) return failure({ code: "unavailable", message: "Subject not found" });
  if (source.value.erased || target.value.erased) return failure({ code: "forbidden", message: "Subject erased" });
  const { winner, loser } = canonicalPair({ source: source.value.subject, target: target.value.subject });
  if (winner.subjectId === loser.subjectId) return { ok: true, value: winner };
  return commitMerge({ session, context: input.context, winner, loser, mergedAt: input.mergedAt });
}
async function commitMerge(required: { session: SqlSession; context: Context; winner: Subject; loser: Subject; mergedAt: number }): Promise<Outcome<Subject>> {
  if (required.winner.lineage.length + required.loser.lineage.length >= 1000) return failure({ code: "limit_exceeded", message: "Merge lineage limit reached" });
  const values = [...scopeValues(required), required.loser.subjectId, required.winner.subjectId];
  await required.session.query({ text: "UPDATE contact_identifier SET subject_id=$4 WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3", values });
  await required.session.query({ text: "UPDATE contact_subject SET merged_into=$4 WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3", values });
  await required.session.query({ text: "INSERT INTO contact_merge(owner_id,workspace_id,source_subject_id,target_subject_id,merged_at) VALUES($1,$2,$3,$4,$5)", values: [...values, required.mergedAt] });
  const loaded = await loadRoot({ session: required.session, context: required.context, subjectId: required.winner.subjectId });
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "unavailable", message: "Merged subject unavailable" });
  return { ok: true, value: loaded.value.subject };
}

/** Private NULL values are tombstones, never returned as destination identifiers. */
async function purge(required: { session: SqlSession; input: Parameters<ContactRepoPort["purgeIdentifiers"]>[0] }): Promise<Outcome<{ purged: number }>> {
  const { session, input } = required;
  const loaded = await loadRoot({ session, ...input });
  if (!loaded.ok) return loaded;
  if (!loaded.value) return failure({ code: "unavailable", message: "Subject not found" });
  const values = [...scopeValues(input), loaded.value.subject.subjectId];
  const count = await session.query({ text: "SELECT COUNT(*) AS purged FROM contact_identifier WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3 AND normalized_value IS NOT NULL", values });
  const parsedCount = z.strictObject({ purged: epochSchema }).safeParse(count.rows[0]);
  if (!parsedCount.success) return failure({ code: "unavailable", message: "Invalid purge count" });
  await session.query({ text: "DELETE FROM contact_identifier WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3 AND kind NOT IN ('email','phone','external_customer_id')", values });
  await session.query({ text: "UPDATE contact_identifier SET normalized_value=NULL WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3", values });
  await session.query({ text: `${treeSql} UPDATE contact_subject SET timezone=NULL,erased=1 WHERE owner_id=$1 AND workspace_id=$2 AND subject_id IN (SELECT subject_id FROM members)`, values });
  return { ok: true, value: parsedCount.data };
}
