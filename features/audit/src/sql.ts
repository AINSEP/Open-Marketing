import { z } from "zod";
import type { AppError, CallContext, CallOptions, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import { callContextSchema, epochSchema, idSchema } from "@open-marketing/contracts";
import type { AuditObserverPort, AuditRepoPort, AuditSqlDatabase, AuditSqlSession } from "./ports.js";
import type { AuditEntry, AuditPage, AuditQuery, AuditReceipt } from "./types.js";
import { allocateReceipt, correctionAllowed, scopeKey } from "./repository-rules.js";
import { auditEntrySchema, auditReceiptSchema, failure, validateAppend, validateList } from "./validation.js";
import { observe } from "./observation.js";

const storedRowSchema = z.strictObject({
  entry_id: auditReceiptSchema.shape.entryId, recorded_at: epochSchema, sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  owner_id: idSchema, workspace_id: idSchema, operation_id: idSchema,
  kind: auditEntrySchema.shape.kind, arguments_digest: auditEntrySchema.shape.argumentsDigest, correction_of: idSchema.nullable(),
  payload: z.string().max(32768), context_json: z.string().max(8192),
});
const queryResultSchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())).max(101) });
type StoredRow = { entry: AuditEntry; receipt: AuditReceipt; sequence: number; context: CallContext };
type SqlDependencies = { db: AuditSqlDatabase; clock: ClockPort; ids: IdPort; observer: AuditObserverPort };
const columns = "entry_id, recorded_at, sequence, owner_id, workspace_id, operation_id, kind, arguments_digest, correction_of, payload, context_json";

/** Internal validation exception rolls the injected transaction back, then becomes a typed outcome. */
class AuditStorageError extends Error {
  readonly code: AppError["code"];
  constructor(required: { code: AppError["code"] }) {
    super("Audit storage validation failed");
    this.code = required.code;
  }
}

/** Durable append-only adapter over a server-owned canonical transaction port. Construction does no I/O.
 * Native lock/query deadlines and serialized transactions are composition responsibilities.
 * @example createSqlAuditRepo({ db, clock, ids, observer });
 * @returns Success only after commit; failed/uncertain commits are unavailable and never retried here.
 * @complexity Indexed append O(log n + r); indexed page O(log n + p*r), p <=100, r <=64.
 */
export function createSqlAuditRepo(required: SqlDependencies): AuditRepoPort {
  return {
    async append(input, optional) {
      const parsed = validateAppend({ input }, optional);
      if (!parsed.ok) return parsed;
      return transaction({ ...required, context: parsed.value.context, operation: "audit.sql.append",
        execute: ({ session }) => appendSql({ ...required, ...parsed.value, session }, optional),
      }, optional);
    },
    async list(input, optional) {
      const parsed = validateList({ input }, optional);
      if (!parsed.ok) return parsed;
      return transaction({ ...required, context: parsed.value.context, operation: "audit.sql.list",
        execute: ({ session }) => listSql({ ...parsed.value, session }, optional),
      }, optional);
    },
  };
}

/** Observe the final result and check cancellation after acquisition, before SQL.
 * Only successfully rolled-back body failures restore typed validation errors; cleanup failures remain unavailable.
 * @complexity One injected transaction; body bounded by adapter operations.
 */
async function transaction<T>(required: {
  db: AuditSqlDatabase; observer: AuditObserverPort; context: CallContext; operation: string;
  execute(required: { session: AuditSqlSession }): Promise<Outcome<T>>;
}, optional?: CallOptions): Promise<Outcome<T>> {
  let result: Outcome<T>;
  try {
    result = await required.db.transaction({ work: input => {
      if (optional?.signal?.aborted) return Promise.resolve(failure<T>({ code: "cancelled" }));
      return required.execute(input);
    } });
  } catch (cause) {
    const body = cause instanceof Error && "code" in cause && cause.code === "transaction_failed" ? cause.cause : cause;
    result = failure({ code: body instanceof AuditStorageError ? body.code : "unavailable" });
  }
  observe({ ...required, outcome: result });
  return result;
}

/** Check the tainted DB container before inspecting rows; all queries return at most 101 rows.
 * @returns Validated rows; malformed output rolls back via AuditStorageError. Driver errors
 * propagate to the transaction boundary, which maps them without exposing driver messages.
 * @complexity One injected query and O(p*k) container parsing, p <=101, k returned columns.
 */
async function query(required: {
  session: AuditSqlSession; text: string; values: unknown[];
}): Promise<{ rows: readonly Readonly<Record<string, unknown>>[] }> {
  const result = await required.session.query({ text: required.text, values: required.values });
  const parsed = queryResultSchema.safeParse(result);
  if (!parsed.success) throw new AuditStorageError({ code: "protocol_mismatch" });
  return parsed.data;
}

/** Validate persisted evidence before returning it. JSON never repairs or silently replaces history.
 * @complexity O(r), payload <=32,768 characters, context <=8,192 characters.
 */
function decodeRow(required: { row: Readonly<Record<string, unknown>> }): StoredRow {
  const parsed = storedRowSchema.safeParse(required.row);
  if (!parsed.success) throw new AuditStorageError({ code: "protocol_mismatch" });
  const entry = auditEntrySchema.safeParse(parseStoredJson({ text: parsed.data.payload }));
  const context = callContextSchema.safeParse(parseStoredJson({ text: parsed.data.context_json }));
  if (!entry.success || !context.success) throw new AuditStorageError({ code: "protocol_mismatch" });
  if (!metadataMatches({ row: parsed.data, entry: entry.data, context: context.data })) throw new AuditStorageError({ code: "protocol_mismatch" });
  return {
    entry: entry.data, context: context.data, sequence: parsed.data.sequence,
    receipt: { entryId: parsed.data.entry_id, recordedAt: parsed.data.recorded_at },
  };
}

/** Indexed scope/filter/lineage columns must describe the same immutable JSON evidence.
 * @complexity O(1) comparisons of bounded identifiers and digests; no I/O or mutation.
 */
function metadataMatches(required: {
  row: z.infer<typeof storedRowSchema>; entry: AuditEntry; context: CallContext;
}): boolean {
  return required.row.owner_id === required.context.scope.ownerId
    && required.row.workspace_id === required.context.scope.workspaceId
    && required.row.operation_id === required.entry.operationId
    && required.row.kind === required.entry.kind
    && required.row.arguments_digest === required.entry.argumentsDigest
    && required.row.correction_of === (required.entry.correctionOf ?? null);
}

function parseStoredJson(required: { text: string }): unknown {
  try { return JSON.parse(required.text); }
  catch { throw new AuditStorageError({ code: "protocol_mismatch" }); }
}

/** Verify tainted DB metadata agrees with the requested scope. @complexity O(1), bounded IDs. */
function scopedRow(required: { row: Readonly<Record<string, unknown>>; context: CallContext }): StoredRow {
  const row = decodeRow(required);
  if (scopeKey({ context: row.context }) !== scopeKey(required)) throw new AuditStorageError({ code: "protocol_mismatch" });
  return row;
}

/** Scoped lookup used for both correction lineage and cursor ownership. @complexity Indexed O(log n). */
async function findRow(required: { session: AuditSqlSession; context: CallContext; entryId: string }): Promise<StoredRow | undefined> {
  const rows = await query({ session: required.session,
    text: `SELECT ${columns} FROM audit_entry WHERE owner_id = $1 AND workspace_id = $2 AND entry_id = $3 LIMIT 1`,
    values: [required.context.scope.ownerId, required.context.scope.workspaceId, required.entryId],
  });
  if (rows.rows.length === 0) return undefined;
  if (rows.rows.length !== 1) throw new AuditStorageError({ code: "protocol_mismatch" });
  const row = scopedRow({ row: rows.rows[0], context: required.context });
  if (row.receipt.entryId !== required.entryId) throw new AuditStorageError({ code: "protocol_mismatch" });
  return row;
}

/** Append under serialized transaction; no overwrite/upsert. No guard failure mutates evidence.
 * @complexity Up to three indexed reads and one insert; O(r) serialization.
 */
async function appendSql(required: {
  session: AuditSqlSession; context: CallContext; entry: AuditEntry; clock: ClockPort; ids: IdPort;
}, optional?: CallOptions): Promise<Outcome<AuditReceipt>> {
  const target = await correctionTarget(required);
  if (!correctionAllowed({ entry: required.entry, target: target?.entry })) return failure({ code: "invalid_input" });
  const receipt = allocateReceipt(required);
  if (!receipt.ok) return receipt;
  const sequence = await nextSequence(required);
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const rows = await query({ session: required.session,
    text: "INSERT INTO audit_entry (entry_id, owner_id, workspace_id, sequence, operation_id, kind, arguments_digest, correction_of, recorded_at, payload, context_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (entry_id) DO NOTHING RETURNING entry_id, recorded_at",
    values: [receipt.value.entryId, required.context.scope.ownerId, required.context.scope.workspaceId, sequence,
      required.entry.operationId, required.entry.kind, required.entry.argumentsDigest, required.entry.correctionOf ?? null,
      receipt.value.recordedAt, JSON.stringify(required.entry), JSON.stringify(required.context)],
  });
  if (rows.rows.length === 0) return failure({ code: "conflict" });
  if (rows.rows.length !== 1) throw new AuditStorageError({ code: "protocol_mismatch" });
  const returned = auditReceiptSchema.safeParse({ entryId: rows.rows[0].entry_id, recordedAt: rows.rows[0].recorded_at });
  if (!returned.success) throw new AuditStorageError({ code: "protocol_mismatch" });
  if (returned.data.entryId !== receipt.value.entryId || returned.data.recordedAt !== receipt.value.recordedAt) throw new AuditStorageError({ code: "protocol_mismatch" });
  return receipt;
}

async function correctionTarget(required: {
  session: AuditSqlSession; context: CallContext; entry: AuditEntry;
}): Promise<StoredRow | undefined> {
  if (required.entry.correctionOf === undefined) return undefined;
  return findRow({ ...required, entryId: required.entry.correctionOf });
}

/** Scope sequence orders equal timestamps and IDs; unique constraint detects deficient serialization.
 * @complexity Indexed O(log n), one bounded read.
 */
async function nextSequence(required: { session: AuditSqlSession; context: CallContext }): Promise<number> {
  const result = await query({ session: required.session,
    text: "SELECT sequence FROM audit_entry WHERE owner_id = $1 AND workspace_id = $2 ORDER BY sequence DESC LIMIT 1",
    values: [required.context.scope.ownerId, required.context.scope.workspaceId],
  });
  if (result.rows.length === 0) return 1;
  if (result.rows.length !== 1) throw new AuditStorageError({ code: "protocol_mismatch" });
  const sequence = result.rows[0].sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) throw new AuditStorageError({ code: "protocol_mismatch" });
  if ((sequence as number) >= Number.MAX_SAFE_INTEGER) throw new AuditStorageError({ code: "limit_exceeded" });
  return (sequence as number) + 1;
}

/** A cursor cannot be reused in another scope/filter; no silent first-page fallback.
 * @complexity One indexed lookup, O(log n).
 */
async function cursorSequence(required: { session: AuditSqlSession; context: CallContext; query: AuditQuery }): Promise<Outcome<number>> {
  if (required.query.cursor === undefined) return { ok: true, value: 0 };
  const row = await findRow({ ...required, entryId: required.query.cursor });
  if (!row) return failure({ code: "invalid_input" });
  if (required.query.operationId !== undefined && row.entry.operationId !== required.query.operationId) return failure({ code: "invalid_input" });
  return { ok: true, value: row.sequence };
}

/** Fetch one extra row for continuation; never load the full audit history. @complexity O(log n + p*r). */
async function listSql(required: { session: AuditSqlSession; context: CallContext; query: AuditQuery }, optional?: CallOptions): Promise<Outcome<AuditPage>> {
  const cursor = await cursorSequence(required);
  if (!cursor.ok) return cursor;
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const values: unknown[] = [required.context.scope.ownerId, required.context.scope.workspaceId, cursor.value];
  let filter = "";
  if (required.query.operationId !== undefined) {
    filter = " AND operation_id = $4";
    values.push(required.query.operationId);
  }
  values.push(required.query.limit + 1);
  const result = await query({ session: required.session,
    text: `SELECT ${columns} FROM audit_entry WHERE owner_id = $1 AND workspace_id = $2 AND sequence > $3${filter} ORDER BY sequence ASC LIMIT $${values.length}`,
    values,
  });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (result.rows.length > required.query.limit + 1) throw new AuditStorageError({ code: "protocol_mismatch" });
  const rows = result.rows.map(row => scopedRow({ row, context: required.context }));
  if (!validPageRows({ rows, query: required.query, after: cursor.value })) throw new AuditStorageError({ code: "protocol_mismatch" });
  const selected = rows.slice(0, required.query.limit);
  return { ok: true, value: {
    items: selected.map(row => row.entry),
    cursor: rows.length > selected.length ? selected[selected.length - 1].receipt.entryId : null,
  } };
}

/** Validate query shape on tainted results, including unique receipts, ordering and operation filters.
 * @complexity O(p) time and O(p) identity-set space, p <=101; no I/O or mutation of rows.
 */
function validPageRows(required: { rows: readonly StoredRow[]; query: AuditQuery; after: number }): boolean {
  let previous = required.after;
  const seen = new Set<string>();
  for (const row of required.rows) {
    if (row.sequence <= previous) return false;
    if (seen.has(row.receipt.entryId)) return false;
    if (required.query.operationId !== undefined && row.entry.operationId !== required.query.operationId) return false;
    seen.add(row.receipt.entryId);
    previous = row.sequence;
  }
  return true;
}
