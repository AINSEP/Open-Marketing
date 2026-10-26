import { z } from "zod";
import type { CallContext, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { CreativeRepoPort } from "./ports.js";
import type { GenerationStatus, GenerationCostObservation } from "./types.js";
import { costSchema, failure, success, validContext } from "./rules.js";
import { validateCostLink, validateReplacement, validateStatus } from "./repository-rules.js";

/** Canonical leased SQL session; no native driver belongs to this feature. */
export type CreativeSqlSession = SqlSession;
/** Server owns serialized transactions and rollback of failed Outcomes. */
export type CreativeSqlDatabase = UnitOfWork;
const statusRowSchema = z.strictObject({ status_json: z.string().max(24 * 1024 * 1024) });
const costRowSchema = z.strictObject({ cost_json: z.string().max(4096) });

/** SQL adapter with CAS, scope keys and append-only cost identities. Construction does no I/O.
 * @param required Server-owned database port; migration is a separate, unapplied artifact.
 * @returns Repository using only creative-owned tables.
 * @complexity O(k) rows for a bounded page, O(1) indexed get/save/claim/cost queries.
 */
export function createSqlCreativeRepo(required: { database: CreativeSqlDatabase }): CreativeRepoPort {
  return {
    async save(input) { return sqlBoundary({ database: required.database, context: input.context, work: args => saveSql({ ...args, ...input }) }); },
    async get(input) { return sqlBoundary({ database: required.database, context: input.context, work: args => getSql({ ...args, ...input }) }); },
    async claimDispatch(input) { return sqlBoundary({ database: required.database, context: input.context, work: args => claimSql({ ...args, ...input }) }); },
    async list(input) { return sqlBoundary({ database: required.database, context: input.context, work: args => listSql({ ...args, ...input }) }); },
    async appendCost(input) { return sqlBoundary({ database: required.database, context: input.context, work: args => appendSqlCost({ ...args, ...input }) }); },
  };
}
/** Driver/JSON failures are contained at this adapter edge; no SQL or stored payload leaks to callers. */
async function sqlBoundary<T>(required: { database: CreativeSqlDatabase; context: CallContext; work: (required: { session: CreativeSqlSession }) => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  if (!validContext({ context: required.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
  try { return await required.database.transaction({ work: required.work }); }
  catch { return failure({ code: "unavailable", message: "Creative persistence unavailable", retryable: true }); }
}
function scopeParameters(required: { context: CallContext }): readonly string[] { return [required.context.scope.ownerId, required.context.scope.workspaceId]; }
async function getSql(required: { session: CreativeSqlSession; context: CallContext; generationId: string }): Promise<Outcome<GenerationStatus>> {
  const { rows } = await required.session.query({ text: "SELECT status_json FROM creative_generation_request WHERE owner_id = $1 AND workspace_id = $2 AND generation_id = $3", values: [...scopeParameters(required), required.generationId] });
  if (rows.length === 0) return failure({ code: "unavailable", message: "Generation not found" });
  return decodeStatus({ row: rows[0] });
}
function decodeStatus(required: { row: unknown }): Outcome<GenerationStatus> {
  const row = statusRowSchema.safeParse(required.row);
  if (!row.success) return failure({ code: "protocol_mismatch", message: "Invalid stored creative row" });
  return validateStatus({ status: JSON.parse(row.data.status_json) as GenerationStatus });
}
async function saveSql(required: { session: CreativeSqlSession; context: CallContext; status: GenerationStatus; expectedRevision?: number }): Promise<Outcome<GenerationStatus>> {
  const parsed = validateStatus(required);
  if (!parsed.ok) return parsed;
  const existing = await getSql({ ...required, generationId: parsed.value.generationId });
  if (!existing.ok) return insertSql({ ...required, status: parsed.value, existing });
  const bound = validateReplacement({ previous: existing.value, next: parsed.value, expectedRevision: required.expectedRevision ?? parsed.value.revision });
  if (!bound.ok) return bound;
  const status = { ...parsed.value, revision: existing.value.revision + 1 };
  const updated = await required.session.query({ text: "UPDATE creative_generation_request SET status_json = $1, revision = $2 WHERE owner_id = $3 AND workspace_id = $4 AND generation_id = $5 AND revision = $6", values: [JSON.stringify(status), status.revision, ...scopeParameters(required), status.generationId, existing.value.revision] });
  if (updated.rowCount !== 1) return failure({ code: "conflict", message: "Generation revision changed" });
  return success({ value: status });
}
async function insertSql(required: { session: CreativeSqlSession; context: CallContext; status: GenerationStatus; expectedRevision?: number; existing: Outcome<GenerationStatus> }): Promise<Outcome<GenerationStatus>> {
  if (!required.existing.ok && required.existing.error.code !== "unavailable") return required.existing;
  if (required.expectedRevision !== undefined && required.expectedRevision !== -1) return failure({ code: "conflict", message: "Generation does not exist at expected revision" });
  const status = { ...required.status, revision: 0 };
  const inserted = await required.session.query({ text: "INSERT INTO creative_generation_request (owner_id, workspace_id, generation_id, revision, status_json) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id, workspace_id, generation_id) DO NOTHING", values: [...scopeParameters(required), status.generationId, status.revision, JSON.stringify(status)] });
  if (inserted.rowCount !== 1) return failure({ code: "conflict", message: "Generation already exists" });
  return success({ value: status });
}
async function claimSql(required: { session: CreativeSqlSession; context: CallContext; generationId: string }): Promise<Outcome<{ claimed: boolean; status: GenerationStatus }>> {
  const current = await getSql(required);
  if (!current.ok) return current;
  if (current.value.dispatchState !== "queued" || current.value.state === "cancelled") return success({ value: { claimed: false, status: current.value } });
  const saved = await saveSql({ ...required, status: { ...current.value, dispatchState: "dispatching" } });
  if (!saved.ok) return saved;
  return success({ value: { claimed: true, status: saved.value } });
}
async function listSql(required: { session: CreativeSqlSession; context: CallContext; limit: number; cursor?: string }): Promise<Outcome<{ items: readonly GenerationStatus[]; cursor: string | null }>> {
  if (!Number.isInteger(required.limit) || required.limit < 1 || required.limit > 100) return failure({ code: "invalid_input", message: "Invalid generation page limit" });
  const { rows } = await required.session.query({ text: "SELECT status_json FROM creative_generation_request WHERE owner_id = $1 AND workspace_id = $2 AND generation_id > $3 ORDER BY generation_id LIMIT $4", values: [...scopeParameters(required), required.cursor ?? "", required.limit + 1] });
  const items: GenerationStatus[] = [];
  for (const row of rows.slice(0, required.limit)) {
    const parsed = decodeStatus({ row });
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return success({ value: { items, cursor: rows.length > required.limit ? items[items.length - 1].generationId : null } });
}
async function readCost(required: { session: CreativeSqlSession; context: CallContext; observationId: string }): Promise<GenerationCostObservation | undefined> {
  const { rows } = await required.session.query({ text: "SELECT cost_json FROM creative_generation_cost_observation WHERE owner_id = $1 AND workspace_id = $2 AND observation_id = $3", values: [...scopeParameters(required), required.observationId] });
  if (rows.length === 0) return undefined;
  const row = costRowSchema.parse(rows[0]);
  return costSchema.parse(JSON.parse(row.cost_json));
}
async function appendSqlCost(required: { session: CreativeSqlSession; context: CallContext; cost: GenerationCostObservation }): Promise<Outcome<void>> {
  const parsed = costSchema.safeParse(required.cost);
  if (!parsed.success) return failure({ code: "invalid_input", message: "Invalid creative cost observation" });
  const status = await getSql({ ...required, generationId: parsed.data.generationId });
  if (!status.ok) return status;
  const previous = await readCost({ ...required, observationId: parsed.data.observationId });
  const correction = await readCost({ ...required, observationId: parsed.data.correctionOf ?? "" });
  const linked = validateCostLink({ cost: parsed.data, status: status.value, previous, correction });
  if (!linked.ok) return linked;
  if (previous !== undefined) return success({ value: undefined });
  await required.session.query({ text: "INSERT INTO creative_generation_cost_observation (owner_id, workspace_id, observation_id, generation_id, cost_json) VALUES ($1, $2, $3, $4, $5)", values: [...scopeParameters(required), parsed.data.observationId, parsed.data.generationId, JSON.stringify(parsed.data)] });
  return success({ value: undefined });
}
