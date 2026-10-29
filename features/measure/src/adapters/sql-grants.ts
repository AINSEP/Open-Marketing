import { z } from "zod";
import { callContextSchema, epochSchema, idSchema, pageQuerySchema, parseBoundary, parseExactIntegerJson } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, Page, PageQuery, Scope } from "@open-marketing/contracts";
import type { MeasurementGrantPort, MeasureSqlDatabase, MeasureSqlQueryable } from "../ports.js";
import type { MeasureGrant } from "../types.js";
import { failure, grantInputSchema, measureGrantSchema, revokeInputSchema, sameScope, scopeKey, serviceContextSchema } from "../rules.js";
import { sqlBoundary, unwrap } from "./sql-boundary.js";

const storedGrantSchema = z.strictObject({ grant_json: z.string().max(65536), revoked_at: epochSchema.nullable() });

/** Scoped durable grants with immutable content and idempotent revocation.
 * The caller owns DB transactions/lifecycle and time. Missing authority is forbidden;
 * malformed stored data is invalid_input, driver failures are sanitized unavailable.
 * @example createSqlMeasurementGrant({ database, clock }, { observer }).grant({ context, grant })
 * @complexity O(log n) indexed queries and bounded grant parsing per call; O(1) bounded payload space.
 */
export function createSqlMeasurementGrant(required: { database: MeasureSqlDatabase; clock: ClockPort }, optional?: { observer?: ObserverPort }): MeasurementGrantPort & {
  list(input: { context: CallContext; query: PageQuery }, options?: CallOptions): Promise<Outcome<Page<MeasureGrant>>>;
} {
  return {
    /** Scoped keyset page includes revoked grants; at most 101 rows are decoded. */
    async list(input, options) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: callContextSchema, query: pageQuerySchema }), input });
      if (!parsed.ok) return parsed;
      const { context, query } = parsed.value;
      return sqlBoundary({ context, operation: "measure.sql.listGrants", observer: optional?.observer, work: async () => {
        const result = await required.database.query({ text: "SELECT grant_json,revoked_at FROM measure_grant WHERE scope_key=$1 AND ($2 IS NULL OR grant_id > $2) ORDER BY grant_id LIMIT $3", values: [scopeKey({ scope: context.scope }), query.cursor ?? null, query.limit + 1] });
        const rows = unwrap({ outcome: parseBoundary({ schema: z.array(storedGrantSchema).max(query.limit + 1), input: result.rows }) });
        const grants = rows.map(row => decodeGrant({ row, scope: context.scope }));
        const items = grants.slice(0, query.limit);
        return { items, cursor: grants.length > query.limit ? items.at(-1)!.grantId : null };
      } }, options);
    },
    async current(input, options) {
      const parsed = parseBoundary({ schema: z.strictObject({ context: serviceContextSchema, grantId: idSchema }), input });
      if (!parsed.ok) return parsed;
      const { context, grantId } = parsed.value;
      return sqlBoundary({ context: { scope: context.scope, principal: { kind: "service", serviceId: context.serviceId }, correlationId: context.correlationId, traceId: context.traceId }, operation: "measure.sql.currentGrant", observer: optional?.observer, work: async () => {
        const grant = await readGrant({ database: required.database, scope: context.scope, grantId });
        return grant ?? unwrap({ outcome: failure<MeasureGrant>({ code: "forbidden", message: "Measurement grant not found" }) });
      } }, options);
    },
    async grant(input, options) {
      const parsed = parseBoundary({ schema: grantInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, grant } = parsed.value;
      if (grant.revoked || !sameScope({ left: grant.scope, right: context.scope })) return failure({ code: "forbidden", message: "Measurement grant scope or state mismatch" });
      return sqlBoundary({ context, operation: "measure.sql.grant", observer: optional?.observer, work: () => required.database.transaction({ work: async ({ session }) => {
        await session.query({ text: "INSERT INTO measure_grant (scope_key,grant_id,grant_json,created_at) VALUES ($1,$2,$3,$4) ON CONFLICT (scope_key, grant_id) DO NOTHING", values: [scopeKey({ scope: context.scope }), grant.grantId, JSON.stringify(grant), required.clock.now({})] });
        const stored = await readGrant({ database: session, scope: context.scope, grantId: grant.grantId });
        if (!stored) throw new Error("Measurement grant insert missing");
        // Strict parsing gives canonical property order; retries never revive revoked rows.
        if (JSON.stringify({ ...stored, revoked: false }) !== JSON.stringify(grant)) return unwrap({ outcome: failure<MeasureGrant>({ code: "conflict", message: "Measurement grant ID already binds different content" }) });
        return stored;
      } }) }, options);
    },
    async revoke(input, options) {
      const parsed = parseBoundary({ schema: revokeInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, grantId } = parsed.value;
      return sqlBoundary({ context, operation: "measure.sql.revokeGrant", observer: optional?.observer, work: () => required.database.transaction({ work: async ({ session }) => {
        await session.query({ text: "UPDATE measure_grant SET revoked_at=$3 WHERE scope_key=$1 AND grant_id=$2 AND revoked_at IS NULL", values: [scopeKey({ scope: context.scope }), grantId, required.clock.now({})] });
        const grant = await readGrant({ database: session, scope: context.scope, grantId });
        return grant ?? unwrap({ outcome: failure<MeasureGrant>({ code: "forbidden", message: "Measurement grant not found" }) });
      } }) }, options);
    },
  };
}

/** Read one scoped row and validate persisted identity before returning authority.
 * @complexity One indexed lookup, O(log n); bounded JSON parsing time/space. */
async function readGrant(required: { database: MeasureSqlQueryable; scope: Scope; grantId: string }): Promise<MeasureGrant | null> {
  const result = await required.database.query({ text: "SELECT grant_json,revoked_at FROM measure_grant WHERE scope_key=$1 AND grant_id=$2", values: [scopeKey({ scope: required.scope }), required.grantId] });
  if (!result.rows[0]) return null;
  const grant = decodeGrant({ row: result.rows[0], scope: required.scope });
  if (grant.grantId !== required.grantId) return unwrap({ outcome: failure({ code: "forbidden", message: "Stored measurement grant binding mismatch" }) });
  return grant;
}

/** Both reads validate stored authority identically; bounded JSON, no I/O. */
function decodeGrant(required: { row: unknown; scope: Scope }): MeasureGrant {
  const row = unwrap({ outcome: parseBoundary({ schema: storedGrantSchema, input: required.row }) });
  const json = parseExactIntegerJson({ text: row.grant_json });
  if (!json.ok) return unwrap({ outcome: failure({ code: "invalid_input", message: "Invalid stored measurement grant JSON" }) });
  const grant = unwrap({ outcome: parseBoundary({ schema: measureGrantSchema, input: json.value }) });
  if (grant.revoked) return unwrap({ outcome: failure({ code: "invalid_input", message: "Invalid stored measurement grant state" }) });
  if (!sameScope({ left: grant.scope, right: required.scope })) return unwrap({ outcome: failure({ code: "forbidden", message: "Stored measurement grant binding mismatch" }) });
  return { ...grant, revoked: row.revoked_at !== null };
}
