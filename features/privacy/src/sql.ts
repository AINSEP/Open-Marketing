import { z } from "zod";
import { epochSchema, idSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { PrivacyRepoPort } from "./ports.js";
import type { ErasureRequest } from "./types.js";
import { boundary, checkCreate, checkTransition, failure, parseRequest, sameRecord, validateInput } from "./validation.js";

type Stored = { request: ErasureRequest; version: number };
type Input = { context: CallContext; request: ErasureRequest };
const rowSchema = z.strictObject({ subject_id: idSchema, requested_at: epochSchema, version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), payload: z.string().max(256 * 1024) });

/** Inert SQL adapter over the server's transaction/session; never opens a driver or migrates.
 * Updates use a scoped optimistic version, while shared rules reject stale regressions.
 * @example createSqlPrivacyRepo({ unitOfWork }).save({ context, request });
 * @complexity O(p+d) bounded parsing plus 1 indexed read and at most 1 write per transaction.
 */
export function createSqlPrivacyRepo(required: { unitOfWork: UnitOfWork }): PrivacyRepoPort {
  return {
    async create(input, options) {
      const parsed = validateWrite({ ...input, options });
      if (!parsed.ok) return parsed;
      const denied = checkCreate({ request: parsed.value });
      if (denied) return denied;
      return boundary({ work: () => required.unitOfWork.transaction({ work: ({ session }) => insertRequest({ session, context: input.context, request: parsed.value, options }) }) });
    },
    async get(input, options) {
      const invalid = validateInput({ context: input.context, id: input.requestId, options });
      if (invalid) return invalid;
      return boundary<ErasureRequest | null>({ work: () => required.unitOfWork.transaction({ work: async ({ session }) => {
        const stored = await readRequest({ session, ...input });
        if (!stored.ok) return stored;
        if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Privacy operation cancelled" });
        return { ok: true, value: stored.value?.request ?? null };
      } }) });
    },
    async save(input, options) {
      const parsed = validateWrite({ ...input, options });
      if (!parsed.ok) return parsed;
      return boundary({ work: () => required.unitOfWork.transaction({ work: ({ session }) => updateRequest({ session, context: input.context, request: parsed.value, options }) }) });
    },
  };
}
function validateWrite(required: Input & { options?: CallOptions }): Outcome<ErasureRequest> {
  return validateInput({ context: required.context, id: required.request?.requestId, options: required.options }) ?? parseRequest(required);
}
function keyValues(required: { context: CallContext; requestId: string }): unknown[] {
  return [required.context.scope.ownerId, required.context.scope.workspaceId, required.requestId];
}
/** One scoped PK lookup. Invalid JSON or column/payload drift is an explicit storage failure. */
async function readRequest(required: { session: SqlSession; context: CallContext; requestId: string }): Promise<Outcome<Stored | null>> {
  const result = await required.session.query({ text: "SELECT subject_id, requested_at, version, payload FROM privacy_request WHERE owner_id=$1 AND workspace_id=$2 AND request_id=$3", values: keyValues(required) });
  if (result.rows.length === 0) return { ok: true, value: null };
  if (result.rows.length !== 1) return failure({ code: "unavailable", message: "Ambiguous stored erasure request" });
  const row = rowSchema.safeParse(result.rows[0]);
  if (!row.success) return failure({ code: "unavailable", message: "Invalid stored erasure row" });
  const parsed = parseRequest({ context: required.context, request: JSON.parse(row.data.payload) });
  if (!parsed.ok) return failure({ code: "unavailable", message: "Invalid stored erasure request" });
  if (parsed.value.requestId !== required.requestId || parsed.value.subjectId !== row.data.subject_id || parsed.value.requestedAt !== row.data.requested_at) return failure({ code: "unavailable", message: "Erasure column/payload mismatch" });
  return { ok: true, value: { request: parsed.value, version: row.data.version } };
}
/** Conflict-safe insert: an identical request is idempotent and creates no second row. */
async function insertRequest(required: Input & { session: SqlSession; options?: CallOptions }): Promise<Outcome<ErasureRequest>> {
  const { request, session, context } = required;
  const result = await session.query({ text: "INSERT INTO privacy_request (owner_id, workspace_id, request_id, subject_id, requested_at, version, payload) VALUES ($1,$2,$3,$4,$5,1,$6) ON CONFLICT (owner_id, workspace_id, request_id) DO NOTHING", values: [...keyValues({ context, requestId: request.requestId }), request.subjectId, request.requestedAt, JSON.stringify(request)] });
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Privacy operation cancelled" });
  if (result.rowCount === 1) return { ok: true, value: request };
  const previous = await readRequest({ session, context, requestId: request.requestId });
  if (!previous.ok) return previous;
  if (previous.value && sameRecord({ left: previous.value.request, right: request })) return { ok: true, value: previous.value.request };
  return failure({ code: "conflict", message: "Erasure request already exists" });
}
/** The transaction protects the read/check/write; the version also detects a racing writer. */
async function updateRequest(required: Input & { session: SqlSession; options?: CallOptions }): Promise<Outcome<ErasureRequest>> {
  const { session, context, request } = required;
  const previous = await readRequest({ session, context, requestId: request.requestId });
  if (!previous.ok) return previous;
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Privacy operation cancelled" });
  if (!previous.value) return failure({ code: "unavailable", message: "Erasure request missing" });
  const denied = checkTransition({ previous: previous.value.request, next: request });
  if (denied) return denied;
  if (sameRecord({ left: previous.value.request, right: request })) return { ok: true, value: request };
  return writeVersion({ ...required, version: previous.value.version });
}
/** One compare-and-swap update; cancellation returns failure so the transaction owner rolls back. */
async function writeVersion(required: Input & { session: SqlSession; options?: CallOptions; version: number }): Promise<Outcome<ErasureRequest>> {
  if (required.version === Number.MAX_SAFE_INTEGER) return failure({ code: "limit_exceeded", message: "Erasure version exhausted" });
  const result = await required.session.query({ text: "UPDATE privacy_request SET payload=$1, version=version+1 WHERE owner_id=$2 AND workspace_id=$3 AND request_id=$4 AND version=$5", values: [JSON.stringify(required.request), ...keyValues({ context: required.context, requestId: required.request.requestId }), required.version] });
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Privacy operation cancelled" });
  if (result.rowCount !== 1) return failure({ code: "conflict", message: "Concurrent erasure update" });
  return { ok: true, value: required.request };
}
