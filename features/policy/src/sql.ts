import type { CallContext, CallOptions, ObserverPort, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { PolicyRepoPort } from "./ports.js";
import type { PolicyEvidence } from "./types.js";
import { boundary, evidenceSchema, evidenceLimit, failure, sameScope, validateEvidence, validateRequest } from "./validation.js";
import { checkAppend, projectSnapshot } from "./projection.js";

/** The server owns transactions; a supplied session joins its current transaction. */
export type PolicySqlClient = SqlSession;
export type PolicySqlPool = UnitOfWork;
export type SqlPolicyOptions = { readonly pool: PolicySqlPool; readonly maxEvidence?: number; readonly observer?: ObserverPort };

type Session = { client: PolicySqlClient; context: CallContext; maxEvidence: number };

/** Durable append-only evidence adapter; all reads refresh current data.
 * Factories do not connect, create tables or apply migrations. SQLite is server-owned.
 * @example createSqlPolicyRepo({ pool, observer }).appendEvidence({ context, evidence })
 * @complexity O(n) for n scoped evidence records, bounded at maxEvidence; 1 bulk read per operation.
 */
export function createSqlPolicyRepo(required: SqlPolicyOptions): PolicyRepoPort {
  const maxEvidence = evidenceLimit({ value: required.maxEvidence });
  return {
    async snapshot(input, options) {
      const invalid = validateRequest({ ...input, options });
      if (invalid) return invalid;
      return transaction({ ...required, context: input.context, options, operation: "policy.sql.snapshot", work: async client => {
        const evidence = await readEvidence({ client, context: input.context, maxEvidence });
        if (!evidence.ok) return evidence;
        return projectSnapshot({ subjectId: input.subjectId, evidence: evidence.value });
      } });
    },
    async appendEvidence(input, options) {
      const invalid = validateEvidence({ ...input, options });
      if (invalid) return invalid;
      const evidence = evidenceSchema.parse(input.evidence);
      return transaction({ ...required, context: input.context, options, operation: "policy.sql.appendEvidence", work: async client => {
        const existing = await readEvidence({ client, context: input.context, maxEvidence });
        if (!existing.ok) return existing;
        const checked = checkAppend({ evidence, existing: existing.value, maxEvidence });
        if (!checked.ok) return checked;
      if (checked.value) return { ok: true, value: checked.value };
        await insertEvidence({ client, evidence });
        return { ok: true, value: evidence };
      } });
    },
  };
}

/** One bounded scoped read, never truncate authority/evidence on overflow. @complexity O(n) time/space. */
async function readEvidence(required: Session): Promise<Outcome<PolicyEvidence[]>> {
  const result = await required.client.query({ text: "SELECT payload, id, subject_id, kind, recorded_at, source_id FROM policy_evidence WHERE owner_id = $1 AND workspace_id = $2 ORDER BY id LIMIT $3", values: [required.context.scope.ownerId, required.context.scope.workspaceId, required.maxEvidence + 1] });
  if (result.rows.length > required.maxEvidence) return failure({ code: "limit_exceeded", message: "Policy evidence capacity exceeded" });
  const records: PolicyEvidence[] = [];
  for (const row of result.rows) {
    const record = decodeEvidence({ row, context: required.context });
    if (!record.ok) return record;
    records.push(record.value);
  }
  return { ok: true, value: records };
}
/** Persisted JSON is tainted; strict schemas and scope checks fail closed. @complexity O(1) bounded payload. */
function decodeEvidence(required: { row: Record<string, unknown>; context: CallContext }): Outcome<PolicyEvidence> {
  if (typeof required.row.payload !== "string" || required.row.payload.length > 8192) return failure({ code: "unavailable", message: "Invalid stored policy evidence" });
  const parsed = evidenceSchema.safeParse(JSON.parse(required.row.payload));
  if (!parsed.success || !sameScope({ left: parsed.data.scope, right: required.context.scope })) return failure({ code: "unavailable", message: "Invalid stored policy evidence" });
  if (!metadataMatches({ row: required.row, evidence: parsed.data })) return failure({ code: "unavailable", message: "Inconsistent stored policy evidence" });
  if (parsed.data.kind === "merge" && !sameScope({ left: parsed.data.scope, right: parsed.data.target.scope })) return failure({ code: "unavailable", message: "Invalid stored merge scope" });
  return { ok: true, value: parsed.data };
}
/** Parameterized append under writer serialization; scoped PK is a second duplicate barrier. @complexity O(log n). */
async function insertEvidence(required: { client: PolicySqlClient; evidence: PolicyEvidence }): Promise<void> {
  await required.client.query({ text: "INSERT INTO policy_evidence (owner_id, workspace_id, id, subject_id, kind, recorded_at, source_id, payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", values: [required.evidence.scope.ownerId, required.evidence.scope.workspaceId, required.evidence.id, required.evidence.subjectId, required.evidence.kind, required.evidence.recordedAt, required.evidence.sourceId, JSON.stringify(required.evidence)] });
}
type TransactionInput<T> = SqlPolicyOptions & { context: CallContext; options?: CallOptions; operation: string; work: (client: PolicySqlClient) => Promise<Outcome<T>> };
/** Delegate transaction ownership, checking cancellation before root work returns.
 * A joined call leaves the final commit/rollback decision with the outer caller.
 * @complexity Work-dependent; one transaction and a bounded bulk read.
 */
async function transaction<T>(required: TransactionInput<T>): Promise<Outcome<T>> {
  return boundary({ ...required, work: () => required.pool.transaction({ work: async ({ session }) => {
    const result = await required.work(session);
    if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Policy operation cancelled" });
    return result;
  } }) });
}

/** Reject JSON/column drift rather than trusting corrupted grant metadata. @complexity O(1). */
function metadataMatches(required: { row: Record<string, unknown>; evidence: PolicyEvidence }): boolean {
  return required.row.id === required.evidence.id && required.row.subject_id === required.evidence.subjectId
    && required.row.kind === required.evidence.kind && required.row.recorded_at === required.evidence.recordedAt
    && required.row.source_id === required.evidence.sourceId;
}
