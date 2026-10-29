import { z } from "zod";
import type { CallContext, CallOptions, Outcome, SqlSession, UnitOfWork } from "@open-marketing/contracts";
import type { LeadsRepoPort } from "./ports.js";
import { appendSchema, checkAppend, checkCapture, failure, getSchema, historySchema, leadSchema, leadStageEventSchema, listSchema, parseInput, purgeSchema, repoCaptureSchema } from "./schemas.js";
import type { Lead, LeadStageEvent } from "./schemas.js";

const leadColumns = "lead_id,subject_id,source_kind,source_ref,occurred_at,created_at,attribution,stage,revision,last_event_id,erased";
const eventColumns = "event_id,lead_id,revision,payload";
const storedJsonSchema = z.string().max(8192);

/** Transactional adapter; a borrowed SqlSession joins the caller's acceptance/erasure transaction.
 * Driver faults are redacted after rollback. Indexed writes and reads return <=101 rows per page.
 * The injected database owns lifecycle telemetry; no new observer plumbing.
 * @example createSqlLeadsRepo({ unitOfWork: session }) */
export function createSqlLeadsRepo(required: { unitOfWork: UnitOfWork }): LeadsRepoPort {
  /** Snapshot before yielding; cancellation inside the transaction returns a failed Outcome.
   * O(b + q) bounded parse plus query work; root failures roll back both tables. */
  async function run<I extends { context: CallContext }, T>(input: { schema: z.ZodType<I>; value: I; work: (required: { session: SqlSession; input: I }) => Promise<Outcome<T>> }, options?: CallOptions): Promise<Outcome<T>> {
    const parsed = parseInput({ schema: input.schema, input: input.value }, options);
    if (!parsed.ok) return parsed;
    try {
      return await required.unitOfWork.transaction({ work: async ({ session }) => {
        if (options?.signal?.aborted) return failure({ code: "cancelled" });
        const result = await input.work({ session, input: parsed.value });
        return options?.signal?.aborted ? failure({ code: "cancelled" }) : result;
      } });
    } catch (error) {
      return failure({ code: isConstraint({ error }) ? "conflict" : "unavailable" });
    }
  }
  return {
    capture: (input, options) => run({ schema: repoCaptureSchema, value: input, work: capture }, options),
    appendStage: (input, options) => run({ schema: appendSchema, value: input, work: appendStage }, options),
    get: (input, options) => run({ schema: getSchema, value: input, work: async ({ session, input: value }) => ({ ok: true, value: await loadLead({ session, context: value.context, where: "lead_id=$3", values: [value.leadId] }) }) }, options),
    list: (input, options) => run({ schema: listSchema, value: input, work: async ({ session, input: value }) => {
      const { query, context } = value;
      const result = await session.query({ text: `SELECT ${leadColumns} FROM lead WHERE owner_id=$1 AND workspace_id=$2 AND lead_id>$3 AND ($4 IS NULL OR stage=$4) ORDER BY lead_id LIMIT $5`, values: [...scope({ context }), query.page.cursor ?? "", query.stage ?? null, query.page.limit + 1] });
      const rows = result.rows.map(row => decodeLead({ context, row }));
      return { ok: true, value: { items: rows.slice(0, query.page.limit), cursor: rows.length > query.page.limit ? rows[query.page.limit - 1].leadId : null } };
    } }, options),
    history: (input, options) => run({ schema: historySchema, value: input, work: async ({ session, input: value }) => {
      const result = await session.query({ text: `SELECT ${eventColumns} FROM lead_stage_event WHERE owner_id=$1 AND workspace_id=$2 AND lead_id=$3 AND revision>$4 ORDER BY revision LIMIT $5`, values: [...scope(value), value.leadId, Number(value.page.cursor ?? 0), value.page.limit + 1] });
      const rows = result.rows.map(row => decodeEvent({ context: value.context, row }));
      return { ok: true, value: { items: rows.slice(0, value.page.limit), cursor: rows.length > value.page.limit ? String(rows[value.page.limit - 1].revision) : null } };
    } }, options),
    purgeSubject: (input, options) => run({ schema: purgeSchema, value: input, work: async ({ session, input: value }) => {
      await session.query({ text: "UPDATE lead SET subject_id=NULL,erased=1 WHERE owner_id=$1 AND workspace_id=$2 AND subject_id=$3", values: [...scope(value), value.subjectId] });
      return { ok: true, value: undefined };
    } }, options),
  };
}

/** Scoped source receipt lookup precedes insertion; original attribution wins on replay.
 * O(1) indexed reads/writes; both projection and initial event share one transaction. */
async function capture(required: { session: SqlSession; input: z.infer<typeof repoCaptureSchema> }): Promise<Outcome<Lead>> {
  const { session, input } = required;
  const existing = await loadLead({ session, context: input.context, where: "source_kind=$3 AND source_ref=$4", values: [input.lead.source.kind, input.lead.source.ref] });
  const checked = checkCapture({ input, existing });
  if (!checked.ok || existing) return checked;
  const lead = checked.value;
  await session.query({ text: `INSERT INTO lead(owner_id,workspace_id,${leadColumns}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, values: [...scope(input), lead.leadId, lead.subjectId, lead.source.kind, lead.source.ref, lead.occurredAt, lead.createdAt, JSON.stringify(lead.attribution), lead.stage, lead.revision, lead.lastEventId, 0] });
  await insertEvent({ session, context: input.context, event: input.event });
  return checked;
}
/** CAS projection update plus immutable event insert; stale writes cannot append evidence.
 * O(1) indexed reads/writes; a failed insert rolls the projection back. */
async function appendStage(required: { session: SqlSession; input: z.infer<typeof appendSchema> }): Promise<Outcome<Lead>> {
  const { session, input } = required;
  const current = await loadLead({ session, context: input.context, where: "lead_id=$3", values: [input.leadId] });
  const found = await session.query({ text: `SELECT ${eventColumns} FROM lead_stage_event WHERE owner_id=$1 AND workspace_id=$2 AND event_id=$3`, values: [...scope(input), input.event.eventId] });
  const previous = found.rows.length ? decodeEvent({ context: input.context, row: found.rows[0] }) : null;
  const checked = checkAppend({ input, current, previous });
  if (!checked.ok || previous) return checked;
  const lead = checked.value;
  const updated = await session.query({ text: "UPDATE lead SET stage=$4,revision=$5,last_event_id=$6 WHERE owner_id=$1 AND workspace_id=$2 AND lead_id=$3 AND revision=$7 AND erased=0", values: [...scope(input), input.leadId, lead.stage, lead.revision, lead.lastEventId, input.expectedRevision] });
  if (updated.rowCount !== 1) return failure({ code: "conflict" });
  await insertEvent({ session, context: input.context, event: input.event });
  return checked;
}
/** SQL identifiers/predicates are private constants; all caller data is parameterized. */
async function loadLead(required: { session: SqlSession; context: CallContext; where: string; values: unknown[] }): Promise<Lead | null> {
  const result = await required.session.query({ text: `SELECT ${leadColumns} FROM lead WHERE owner_id=$1 AND workspace_id=$2 AND ${required.where} LIMIT 1`, values: [...scope(required), ...required.values] });
  return result.rows.length ? decodeLead({ context: required.context, row: result.rows[0] }) : null;
}
/** Parse stored scalars and attribution before exposing a projection; faults are caught by run. */
function decodeLead(required: { context: CallContext; row: Record<string, unknown> }): Lead {
  const row = required.row;
  const erased = z.union([z.literal(0), z.literal(1)]).parse(row.erased);
  return leadSchema.parse({ scope: required.context.scope, leadId: row.lead_id, subjectId: row.subject_id, source: { kind: row.source_kind, ref: row.source_ref }, occurredAt: row.occurred_at, createdAt: row.created_at, attribution: JSON.parse(storedJsonSchema.parse(row.attribution)), stage: row.stage, revision: row.revision, lastEventId: row.last_event_id, erased: erased === 1 });
}
/** Validate event JSON and its indexed identity together; drift fails the storage boundary. */
function decodeEvent(required: { context: CallContext; row: Record<string, unknown> }): LeadStageEvent {
  const event = leadStageEventSchema.parse(JSON.parse(storedJsonSchema.parse(required.row.payload)));
  z.literal(required.row.event_id as string).parse(event.eventId);
  z.literal(required.row.lead_id as string).parse(event.leadId);
  z.literal(required.row.revision as number).parse(event.revision);
  scopeSchemaForRead.parse({ stored: event.scope, expected: required.context.scope });
  return event;
}
const scopeSchemaForRead = z.strictObject({ stored: leadSchema.shape.scope, expected: leadSchema.shape.scope }).refine(value => value.stored.ownerId === value.expected.ownerId && value.stored.workspaceId === value.expected.workspaceId);
/** Append ID-only evidence. Unique scope/event and scope/lead/revision enforce ledger identity. */
async function insertEvent(required: { session: SqlSession; context: CallContext; event: LeadStageEvent }): Promise<void> {
  const event = required.event;
  await required.session.query({ text: "INSERT INTO lead_stage_event(owner_id,workspace_id,event_id,lead_id,revision,payload) VALUES($1,$2,$3,$4,$5,$6)", values: [...scope(required), event.eventId, event.leadId, event.revision, JSON.stringify(event)] });
}
function scope(required: { context: CallContext }): unknown[] { return [required.context.scope.ownerId, required.context.scope.workspaceId]; }
/** Only definitive constraint faults become conflicts; cleanup uncertainty stays unavailable. */
function isConstraint({ error }: { error: unknown }): boolean {
  for (const code of ["transaction_failed", "query_failed"]) {
    if (error instanceof Error && "code" in error && error.code === code) error = error.cause;
  }
  return typeof error === "object" && error !== null && "code" in error && (String(error.code).startsWith("SQLITE_CONSTRAINT") || error.code === "23505");
}
