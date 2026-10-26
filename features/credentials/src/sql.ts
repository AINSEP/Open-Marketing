import type { SqlSession } from "@open-marketing/contracts";
import { z } from "zod";
import { callContextSchema, idSchema, pageQuerySchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, IdPort, Outcome, Page, PageQuery } from "@open-marketing/contracts";
import type { CredentialAuditPort, CredentialRepoPort } from "./ports.js";
import type { ConnectionSummary, CredentialRecord } from "./types.js";
import { boundary, failure, lookupSchema, recordSchema, sameScope, storeSchema, summarySchema } from "./rules.js";

/** Structural @jini-ai/db-shaped seam. Server supplies its leased/scheduled query adapter.
 * Feature code never constructs or imports a driver. Query failures are redacted.
 */
export type CredentialSqlPort = Pick<SqlSession, "query">;
const identityWhere = "owner_id = $1 AND workspace_id = $2 AND connection_id = $3";
const summaryColumns = "owner_id, workspace_id, connection_id, plugin_id, status";
const dbSummarySchema = z.object({ owner_id: z.string(), workspace_id: z.string(), connection_id: z.string(), plugin_id: z.string(), status: z.enum(["connected", "revoked", "reconnect_required"]) });
const dbRecordSchema = dbSummarySchema.extend({ version: z.union([z.number(), z.bigint()]), ciphertext: z.string(), aad_digest: z.string() });
const listQuerySchema = pageQuerySchema.extend({ pluginId: idSchema.optional(), status: summarySchema.shape.status.optional() });

/** Bounded keyset list containing only connection summaries. Owner and trusted server callers
 * may list their scope; agent principals are denied. Optional filters support host key lookup.
 * @example await listCredentialConnections({ context, query: { limit: 25 }, db });
 * @complexity One indexed scope query; O(n) result time/space, n <=101 including lookahead.
 */
export async function listCredentialConnections(required: {
  context: CallContext; query: PageQuery & { pluginId?: string; status?: ConnectionSummary["status"] }; db: CredentialSqlPort;
}, optional?: CallOptions): Promise<Outcome<Page<ConnectionSummary>>> {
  return boundary({ run: async () => {
    const parsed = z.strictObject({ context: callContextSchema, query: listQuerySchema }).safeParse({ context: required.context, query: required.query });
    if (!parsed.success) return failure({ code: "invalid_input" });
    const { context, query } = parsed.data;
    if (context.principal.kind === "agent") return failure({ code: "forbidden" });
    if (context.principal.kind === "owner" && context.principal.ownerId !== context.scope.ownerId) return failure({ code: "forbidden" });
    const result = await required.db.query({ text: `SELECT ${summaryColumns} FROM om_credential_connection
      WHERE owner_id = $1 AND workspace_id = $2 AND ($3 IS NULL OR connection_id > $3)
      AND connection_id NOT LIKE 'oauth-client.%'
      AND connection_id NOT LIKE 'developer-token.%'
      AND ($4 IS NULL OR plugin_id = $4) AND ($5 IS NULL OR status = $5)
      ORDER BY connection_id LIMIT $6`,
      values: [context.scope.ownerId, context.scope.workspaceId, query.cursor ?? null, query.pluginId ?? null, query.status ?? null, query.limit + 1] });
    return connectionPage({ rows: result.rows, context, limit: query.limit });
  } }, optional);
}

/** Fail the entire page on malformed/foreign-scope rows; never return partial storage results. @complexity O(n), n <=101. */
function connectionPage(required: { rows: unknown[]; context: CallContext; limit: number }): Outcome<Page<ConnectionSummary>> {
  if (required.rows.length > required.limit + 1) return failure({ code: "protocol_mismatch" });
  const items: ConnectionSummary[] = [];
  for (const row of required.rows) {
    const parsed = parseSummary({ row });
    if (!parsed.ok) return parsed;
    if (!sameScope({ left: parsed.value.scope, right: required.context.scope })) return failure({ code: "protocol_mismatch" });
    items.push(parsed.value);
  }
  const more = items.length > required.limit;
  return { ok: true, value: { items: items.slice(0, required.limit), cursor: more ? items[required.limit - 1].connectionId : null } };
}

/** Persistent repo with atomic version CAS and terminal local revocation. SQL is portable
 * between SQLite and PostgreSQL. No schema changes/queries happen during construction.
 * @complexity Indexed O(log records) queries, one row per operation; storage O(records).
 */
export function createSqlCredentialRepo(required: { db: CredentialSqlPort; clock: ClockPort }): CredentialRepoPort {
  return {
    async get(input, options) {
      return boundary<ConnectionSummary | null>({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const result = await required.db.query({ text: `SELECT ${summaryColumns} FROM om_credential_connection WHERE ${identityWhere}`, values: identityValues(input) });
        if (!result.rows.length) return { ok: true, value: null };
        return parseSummary({ row: result.rows[0] });
      } }, options);
    },
    async getSecret(input, options) {
      return boundary<CredentialRecord | null>({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (input.context.principal.kind !== "service") return failure({ code: "forbidden" });
        const result = await required.db.query({ text: `SELECT ${summaryColumns}, version, ciphertext, aad_digest FROM om_credential_connection WHERE ${identityWhere} AND status = 'connected'`, values: identityValues(input) });
        if (!result.rows.length) return { ok: true, value: null };
        return parseRecord({ row: result.rows[0] });
      } }, options);
    },
    async store(input, options) {
      return boundary({ run: async () => {
        if (!storeSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        if (!sameScope({ left: input.context.scope, right: input.reference.scope })) return failure({ code: "forbidden" });
        if (input.secret.version !== input.reference.version) return failure({ code: "invalid_input" });
        const values = [input.reference.scope.ownerId, input.reference.scope.workspaceId, input.reference.connectionId, input.pluginId, input.secret.ciphertext, input.reference.version, input.secret.aadDigest];
        const result = await required.db.query({ text: storeSql, values });
        if (result.rows.length) return parseSummary({ row: result.rows[0] });
        return storeDenied({ db: required.db, input });
      } }, options);
    },
    async revoke(input, options) {
      return boundary({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const result = await required.db.query({ text: `UPDATE om_credential_connection SET status = 'revoked', ciphertext = NULL, revoked_at = COALESCE(revoked_at, $4) WHERE ${identityWhere} RETURNING revoked_at`, values: [...identityValues(input), required.clock.now({})] });
        if (!result.rows.length) return failure({ code: "forbidden" });
        const revokedAt = Number(result.rows[0].revoked_at);
        if (!z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).safeParse(revokedAt).success) return failure({ code: "protocol_mismatch" });
        return { ok: true, value: { connectionId: input.connectionId, revokedAt } };
      } }, options);
    },
    async requireReconnect(input, options) {
      return boundary({ run: async () => {
        if (!lookupSchema.safeParse(input).success) return failure({ code: "invalid_input" });
        const result = await required.db.query({ text: `UPDATE om_credential_connection SET status = 'reconnect_required' WHERE ${identityWhere} AND status <> 'revoked' RETURNING ${summaryColumns}`, values: identityValues(input) });
        if (!result.rows.length) return failure({ code: "forbidden" });
        return parseSummary({ row: result.rows[0] });
      } }, options);
    },
  };
}
const storeSql = `INSERT INTO om_credential_connection
  (owner_id, workspace_id, connection_id, plugin_id, status, ciphertext, version, aad_digest)
  SELECT $1, $2, $3, $4, 'connected', $5, $6, $7
  WHERE $6 = 1 OR EXISTS (SELECT 1 FROM om_credential_connection WHERE ${identityWhere} AND version = $6 - 1 AND status = 'connected')
  ON CONFLICT (owner_id, workspace_id, connection_id) DO UPDATE SET ciphertext = excluded.ciphertext, version = excluded.version, aad_digest = excluded.aad_digest
  WHERE om_credential_connection.status = 'connected' AND om_credential_connection.version = excluded.version - 1 AND om_credential_connection.plugin_id = excluded.plugin_id
  RETURNING ${summaryColumns}`;

/** Parameterized identity values contain no SQL fragments. @complexity O(1). */
function identityValues(required: Parameters<CredentialRepoPort["get"]>[0]): unknown[] {
  return [required.context.scope.ownerId, required.context.scope.workspaceId, required.connectionId];
}
/** Driver row validation before public DTO construction. @complexity O(row size). */
function parseSummary(required: { row: unknown }): Outcome<ConnectionSummary> {
  const parsed = dbSummarySchema.safeParse(required.row);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const row = parsed.data;
  const value = { connectionId: row.connection_id, scope: { ownerId: row.owner_id, workspaceId: row.workspace_id }, pluginId: row.plugin_id, status: row.status };
  if (!summarySchema.safeParse(value).success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value };
}
/** Driver bigints normalize only after bounded record validation. @complexity O(record size). */
function parseRecord(required: { row: unknown }): Outcome<CredentialRecord> {
  const parsed = dbRecordSchema.safeParse(required.row);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const summary = parseSummary(required);
  if (!summary.ok) return summary;
  const reference = { scope: summary.value.scope, connectionId: summary.value.connectionId, version: Number(parsed.data.version) };
  const value = { summary: summary.value, reference, secret: { ciphertext: parsed.data.ciphertext, version: reference.version, aadDigest: parsed.data.aad_digest } };
  if (!recordSchema.safeParse(value).success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value };
}
/** Distinguish revoked authority from stale CAS without returning secret data. @complexity One indexed lookup. */
async function storeDenied(required: { db: CredentialSqlPort; input: Parameters<CredentialRepoPort["store"]>[0] }): Promise<Outcome<never>> {
  const result = await required.db.query({ text: `SELECT status FROM om_credential_connection WHERE ${identityWhere}`, values: identityValues({ context: required.input.context, connectionId: required.input.reference.connectionId }) });
  const status = result.rows[0]?.status;
  if (status && status !== "connected") return failure({ code: "forbidden" });
  return failure({ code: "conflict" });
}

/** Durable append-only audit adapter. Metadata only; IDs/time are injected. @complexity O(log events) insertion. */
export function createSqlCredentialAudit(required: { db: CredentialSqlPort; ids: IdPort; clock: ClockPort }): CredentialAuditPort {
  return {
    async record(input, options) {
      return boundary({ run: async () => {
        if (!lookupSchema.safeParse({ context: input.context, connectionId: input.connectionId }).success) return failure({ code: "invalid_input" });
        if (!["credentials.connect", "credentials.revoked", "credentials.use"].includes(input.operation)) return failure({ code: "invalid_input" });
        await required.db.query({ text: "INSERT INTO om_credential_audit (event_id, owner_id, workspace_id, connection_id, operation, correlation_id, trace_id, run_id, recorded_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)", values: [required.ids.next({}), input.context.scope.ownerId, input.context.scope.workspaceId, input.connectionId, input.operation, input.context.correlationId, input.context.traceId, input.context.runId ?? null, required.clock.now({})] });
        return { ok: true, value: undefined };
      } }, options);
    },
  };
}
