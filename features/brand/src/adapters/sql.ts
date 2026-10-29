import { z } from "zod";
import type { CallContext, CallOptions, Outcome, SqlSession } from "@open-marketing/contracts";
import type { BrandRepoPort } from "../ports.js";
import { appendSchema, brandFailure, brandRevisionSchema, checkBrandAppend, contextSchema, parseBrandInput, readSchema, revisionNumberSchema } from "../schemas.js";
import type { BrandRevision } from "../schemas.js";

const projectionSchema = z.array(z.strictObject({ latest_revision: revisionNumberSchema, confirmed_revision: revisionNumberSchema.nullable() })
  .refine(row => row.confirmed_revision === null || row.confirmed_revision <= row.latest_revision)).max(1);
const rowsSchema = z.array(z.strictObject({ record_json: z.string().max(160 * 1024) })).max(1);

/** Inert injected SQL adapter; migrations and connection lifecycle belong to composition.
 * Writes use one transaction with CAS; storage exceptions return unavailable without retry.
 * @complexity O(log n + b) per operation, fixed indexed query count and bounded record bytes b.
 * @example const repo = createSqlBrandRepo({ db });
 */
export function createSqlBrandRepo(required: { db: SqlSession }): BrandRepoPort {
  return {
    async read(input, options) {
      const parsed = parseBrandInput({ schema: readSchema, input }, options);
      if (!parsed.ok) return parsed;
      try { return { ok: true, value: await loadRevision({ db: required.db, ...parsed.value, projection: "latest" }) }; }
      catch { return brandFailure({ code: "unavailable", message: "Brand storage unavailable" }); }
    },
    async readConfirmed(input, options) {
      const parsed = parseBrandInput({ schema: contextSchema, input }, options);
      if (!parsed.ok) return parsed;
      try { return { ok: true, value: await loadRevision({ db: required.db, ...parsed.value, projection: "confirmed" }) }; }
      catch { return brandFailure({ code: "unavailable", message: "Brand storage unavailable" }); }
    },
    async append(input, options) {
      const parsed = parseBrandInput({ schema: appendSchema, input }, options);
      if (!parsed.ok) return parsed;
      try { return await required.db.transaction({ work: ({ session }) => appendStored({ db: session, input: parsed.value }, options) }); }
      catch { return brandFailure({ code: "unavailable", message: "Brand storage unavailable; read current state before retry" }); }
    },
  };
}

/** Read one scoped pointer; malformed projections throw to the adapter boundary. O(log n). */
async function loadPointer(required: { db: SqlSession; context: CallContext; projection: "latest" | "confirmed" }): Promise<number | null> {
  const { context } = required;
  const result = await required.db.query({ text: "SELECT latest_revision, confirmed_revision FROM brand_current WHERE owner_id = $1 AND workspace_id = $2", values: [context.scope.ownerId, context.scope.workspaceId] });
  const projection = projectionSchema.parse(result.rows)[0];
  if (!projection) return null;
  return required.projection === "latest" ? projection.latest_revision : projection.confirmed_revision;
}

/** Resolve immutable history by full scope; validate persisted JSON before release.
 * Corruption throws to adapter's unavailable boundary. O(log n + b), at most two indexed reads.
 */
async function loadRevision(required: { db: SqlSession; context: CallContext; revision?: number; projection: "latest" | "confirmed" }): Promise<BrandRevision | null> {
  const { db, context } = required;
  const scopeValues = [context.scope.ownerId, context.scope.workspaceId];
  const revision = required.revision ?? await loadPointer(required);
  if (revision === null) return null;
  const result = await db.query({ text: "SELECT record_json FROM brand_revision WHERE owner_id = $1 AND workspace_id = $2 AND revision = $3", values: [...scopeValues, revision] });
  const row = rowsSchema.parse(result.rows)[0];
  if (!row && required.revision !== undefined) return null;
  if (!row) throw new Error("Missing brand projection target");
  const value = brandRevisionSchema.parse(JSON.parse(row.record_json));
  if (value.revision !== revision || value.scope.ownerId !== context.scope.ownerId || value.scope.workspaceId !== context.scope.workspaceId) throw new Error("Brand row identity mismatch");
  if (required.projection === "confirmed" && value.status !== "confirmed") throw new Error("Brand confirmation projection mismatch");
  return value;
}

/** Atomically validate against latest, append and move pointers. Failed Outcomes roll back via SqlSession.
 * Cancellation is rechecked after awaited reads and before commit. O(log n + b), fixed query count.
 */
async function appendStored(required: { db: SqlSession; input: z.infer<typeof appendSchema> }, optional?: CallOptions): Promise<Outcome<BrandRevision>> {
  const { db, input } = required;
  const current = await loadRevision({ db, context: input.context, projection: "latest" });
  const checked = checkBrandAppend({ input, current });
  if (!checked.ok) return checked;
  if (optional?.signal?.aborted) return brandFailure({ code: "cancelled", message: "Brand operation cancelled" });
  const revision = checked.value;
  const values = [revision.scope.ownerId, revision.scope.workspaceId, revision.revision];
  await db.query({ text: "INSERT INTO brand_revision (owner_id, workspace_id, revision, record_json) VALUES ($1, $2, $3, $4)", values: [...values, JSON.stringify(revision)] });
  const result = await db.query({
    text: `INSERT INTO brand_current (owner_id, workspace_id, latest_revision, confirmed_revision) VALUES ($1, $2, $3, $4)
      ON CONFLICT (owner_id, workspace_id) DO UPDATE SET latest_revision = excluded.latest_revision,
      confirmed_revision = COALESCE(excluded.confirmed_revision, brand_current.confirmed_revision)
      WHERE brand_current.latest_revision = $5`,
    values: [...values, revision.status === "confirmed" ? revision.revision : null, input.expectedRevision],
  });
  if (result.rowCount !== 1) return brandFailure({ code: "conflict", message: "Brand revision changed" });
  if (optional?.signal?.aborted) return brandFailure({ code: "cancelled", message: "Brand operation cancelled" });
  return { ok: true, value: revision };
}
