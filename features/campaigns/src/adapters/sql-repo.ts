import type { z } from "zod";
import type { CallContext, CallOptions, Outcome, ObserverPort } from "@open-marketing/contracts";
import type { CampaignRepoPort, CampaignSqlPort } from "../ports.js";
import type { CampaignRecord, LaunchProposal } from "../types.js";
import { campaignId, createInputSchema, fail, parseBoundary, recordSchema, proposalBinding, proposalSchema, success, digest, observationSchema } from "../rules.js";
import { boundRecord, checkCancelled, existingDraft, existingProposal, getInputSchema, listInputSchema, observeInputSchema, proposalInputSchema, proposalGetSchema, proposalForRecord, withObservation } from "../repo-rules.js";
import { neutralCampaignRecordSchema, saveNeutralCampaignSchema, type NeutralCampaignRecord } from "../neutral-launch.js";

interface Dependencies { db: CampaignSqlPort; observer?: ObserverPort }
const recordQuery = `SELECT c.campaign_id, c.operation_id, c.record_json, (SELECT r.observation_json FROM campaign_revision r
 WHERE r.owner_id=c.owner_id AND r.workspace_id=c.workspace_id AND r.campaign_id=c.campaign_id
 ORDER BY r.revision DESC LIMIT 1) AS observation_json FROM campaign c
 WHERE c.owner_id=$1 AND c.workspace_id=$2 AND c.campaign_id=$3`;

/** Inert portable SQL repository. Caller supplies the server-owned query port,
 * initializes the additive migration separately, and owns connection/lifecycle.
 * Never imports a driver or another feature's tables.
 * @example createSqlCampaignRepo({ db: serverQueryable }, { observer });
 * @complexity Indexed O(log n) lookup; at most three SQL calls per operation.
 */
export function createSqlCampaignRepo(required: { db: CampaignSqlPort }, optional: { observer?: ObserverPort } = {}): CampaignRepoPort {
  const dependencies: Dependencies = { ...required, ...optional };
  return {
    saveNeutral(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.saveNeutral", execute: async () => {
      const parsed = parseBoundary({ schema: saveNeutralCampaignSchema, input });
      if (!parsed.ok) return parsed;
      const { context, campaign } = parsed.value;
      const id = "neutral-" + campaignId({ operationId: campaign.operationId });
      const record: NeutralCampaignRecord = { scope: context.scope, campaignId: id, campaign };
      await dependencies.db.query({ text: "INSERT INTO campaign (owner_id,workspace_id,campaign_id,operation_id,record_json) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING", values: [context.scope.ownerId, context.scope.workspaceId, id, "neutral:" + campaign.operationId, JSON.stringify(record)] });
      const saved = await readNeutral({ dependencies, context, campaignId: id });
      if (!saved.ok) return saved;
      if (!saved.value || digest({ value: saved.value.campaign }) !== digest({ value: campaign })) return fail({ code: "conflict", message: "Neutral operation reused with changed intent" });
      return success({ value: saved.value });
    } }, options); },
    getNeutral(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.getNeutral", execute: async () => {
      const parsed = parseBoundary({ schema: getInputSchema, input });
      return parsed.ok ? readNeutral({ dependencies, ...parsed.value }) : parsed;
    } }, options); },
    /** One scoped keyset query, <=101 rows; correlated latest-observation read uses its index. */
    list(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.list", execute: async () => {
      const parsed = parseBoundary({ schema: listInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, query } = parsed.value;
      const result = await dependencies.db.query({ text: recordQuery.replace("c.campaign_id=$3", "c.campaign_id>$3 AND c.campaign_id NOT LIKE 'neutral-campaign-%' ORDER BY c.campaign_id LIMIT $4"),
        values: [context.scope.ownerId, context.scope.workspaceId, query.cursor ?? "", query.limit + 1] });
      const items: CampaignRecord[] = [];
      for (const row of result.rows.slice(0, query.limit)) {
        const record = decodeRecord({ context, campaignId: row.campaign_id, row });
        if (!record.ok) return record;
        items.push(record.value);
      }
      return success({ value: { items, cursor: result.rows.length > query.limit ? items.at(-1)!.receipt.campaignId : null } });
    } }, options); },
    save(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.save", execute: async () => {
      const parsed = parseBoundary({ schema: createInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, draft } = parsed.value;
      const id = campaignId({ operationId: draft.operationId });
      const record: CampaignRecord = { scope: context.scope, draft, receipt: { campaignId: id, desiredState: "paused", observedState: "unknown" }, observation: null };
      await dependencies.db.query({ text: "INSERT INTO campaign (owner_id,workspace_id,campaign_id,operation_id,record_json) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id,workspace_id,campaign_id) DO NOTHING", values: [context.scope.ownerId, context.scope.workspaceId, id, draft.operationId, JSON.stringify(record)] });
      const saved = await readRecord({ dependencies, context, campaignId: id });
      if (!saved.ok) return saved;
      if (!saved.value) return fail({ code: "unavailable", message: "Saved SQL campaign missing" });
      return existingDraft({ record: saved.value, draftDigest: digest({ value: draft }) });
    } }, options); },
    get(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.get", execute: async () => {
      const parsed = parseBoundary({ schema: getInputSchema, input });
      if (!parsed.ok) return parsed;
      return readRecord({ dependencies, ...parsed.value });
    } }, options); },
    observe(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.observe", execute: async () => {
      const parsed = parseBoundary({ schema: observeInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, state } = parsed.value;
      const record = await readRecord({ dependencies, context, campaignId: state.campaignId });
      if (!record.ok) return record;
      if (!record.value) return fail({ code: "forbidden", message: "Campaign unavailable in scope" });
      // One INSERT computes sequence and rejects stale observations in the same statement.
      const appended = await dependencies.db.query({ text: `INSERT INTO campaign_revision (owner_id,workspace_id,campaign_id,revision,observed_at,observation_json)
 SELECT $1,$2,$3,COALESCE(MAX(revision),0)+1,$4,$5 FROM campaign_revision
 WHERE owner_id=$1 AND workspace_id=$2 AND campaign_id=$3
 HAVING $4 >= COALESCE(MAX(observed_at),0)`, values: [context.scope.ownerId, context.scope.workspaceId, state.campaignId, state.observedAt, JSON.stringify(state)] });
      if (appended.rowCount !== 1) return fail({ code: "conflict", message: "Stale observation" });
      return success({ value: state });
    } }, options); },
    saveProposal(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.saveProposal", execute: async () => {
      const parsed = parseBoundary({ schema: proposalInputSchema, input });
      if (!parsed.ok) return parsed;
      const { context, proposal } = parsed.value;
      const record = await readRecord({ dependencies, context, campaignId: proposal.campaignId });
      if (!record.ok) return record;
      const valid = proposalForRecord({ record: record.value, proposal });
      if (!valid.ok) return valid;
      const operationId = proposal.operations[0].operationId;
      await dependencies.db.query({ text: "INSERT INTO campaign_launch_proposal (owner_id,workspace_id,operation_id,campaign_id,proposal_json) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (owner_id,workspace_id,operation_id) DO NOTHING", values: [context.scope.ownerId, context.scope.workspaceId, operationId, proposal.campaignId, JSON.stringify(proposal)] });
      const saved = await readProposal({ dependencies, context, operationId });
      if (!saved.ok) return saved;
      if (!saved.value) return fail({ code: "unavailable", message: "SQL proposal missing" });
      return existingProposal({ existing: saved.value, proposal });
    } }, options); },
    getProposal(input, options) { return sqlBoundary({ dependencies, context: input?.context, operation: "campaigns.repo.getProposal", execute: async () => {
      const parsed = parseBoundary({ schema: proposalGetSchema, input });
      if (!parsed.ok) return parsed;
      return readProposal({ dependencies, ...parsed.value });
    } }, options); },
  };
}
/** Reuse the campaign JSON row for local neutral data; validate scope and both stored identities.
 * @complexity One indexed query and O(b) parsing, b<=64KiB neutral input; no remote effects. */
async function readNeutral(required: { dependencies: Dependencies; context: CallContext; campaignId: string }): Promise<Outcome<NeutralCampaignRecord | null>> {
  const { context, campaignId: id, dependencies } = required;
  const result = await dependencies.db.query({ text: "SELECT operation_id,record_json FROM campaign WHERE owner_id=$1 AND workspace_id=$2 AND campaign_id=$3", values: [context.scope.ownerId, context.scope.workspaceId, id] });
  if (!result.rows[0]) return success({ value: null });
  const parsed = parseStored({ schema: neutralCampaignRecordSchema, value: result.rows[0].record_json });
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  if (record.scope.ownerId !== context.scope.ownerId || record.scope.workspaceId !== context.scope.workspaceId) return fail({ code: "forbidden", message: "Neutral scope mismatch" });
  const expected = "neutral-" + campaignId({ operationId: record.campaign.operationId });
  if (record.campaignId !== id || id !== expected || result.rows[0].operation_id !== "neutral:" + record.campaign.operationId) return fail({ code: "conflict", message: "Neutral identity mismatch" });
  return parsed;
}
/** Read the latest append-only observation and bind every nested identity to its row key.
 * @complexity One indexed SQL query plus O(n) bounded JSON/schema validation.
 */
async function readRecord(required: { dependencies: Dependencies; context: CallContext; campaignId: string }): Promise<Outcome<CampaignRecord | null>> {
  const { context, campaignId, dependencies } = required;
  const result = await dependencies.db.query({ text: recordQuery, values: [context.scope.ownerId, context.scope.workspaceId, campaignId] });
  const row = result.rows[0];
  if (!row) return success({ value: null });
  return decodeRecord({ context, campaignId, row });
}
/** Validate each page row without query fan-out; latest observation comes from the same SQL read.
 * @complexity O(record bytes), <=256 KiB; identities and scope must agree with the storage key.
 */
function decodeRecord(required: { context: CallContext; campaignId: unknown; row: Record<string, unknown> }): Outcome<CampaignRecord> {
  const { context, row } = required;
  if (typeof required.campaignId !== "string") return fail({ code: "invalid_input", message: "Stored campaign key invalid" });
  const campaignId = required.campaignId;
  const parsed = parseStored({ schema: recordSchema, value: row.record_json });
  if (!parsed.ok) return parsed;
  if (parsed.value.draft.operationId !== row.operation_id) return fail({ code: "conflict", message: "Stored creation operation mismatch" });
  if (row.observation_json === null) return boundRecord({ context, campaignId, value: parsed.value });
  const observation = parseStored({ schema: observationSchema, value: row.observation_json });
  if (!observation.ok) return observation;
  return boundRecord({ context, campaignId, value: withObservation({ record: parsed.value, state: observation.value }) });
}
/** A schema-valid card must still match its storage key and entire spend envelope.
 * @complexity One indexed SQL query plus O(n) bounded proposal bytes.
 */
async function readProposal(required: { dependencies: Dependencies; context: CallContext; operationId: string }): Promise<Outcome<LaunchProposal | null>> {
  const { context, operationId, dependencies } = required;
  const result = await dependencies.db.query({ text: "SELECT campaign_id, proposal_json FROM campaign_launch_proposal WHERE owner_id=$1 AND workspace_id=$2 AND operation_id=$3", values: [context.scope.ownerId, context.scope.workspaceId, operationId] });
  if (!result.rows[0]) return success({ value: null });
  const parsed = parseStored({ schema: proposalSchema, value: result.rows[0].proposal_json });
  if (!parsed.ok) return parsed;
  const proposal = parsed.value;
  if (proposal.operations[0].operationId !== operationId || proposal.campaignId !== result.rows[0].campaign_id) return fail({ code: "conflict", message: "Stored proposal identity mismatch" });
  const bound = proposalBinding({ proposal });
  if (!bound.ok) return bound;
  return parsed;
}
/** Stored rows are tainted too; bound JSON before parsing and map corrupt data explicitly. */
function parseStored<T>(required: { schema: z.ZodType<T>; value: unknown }): Outcome<T> {
  if (typeof required.value !== "string" || required.value.length > 262144) return fail({ code: "invalid_input", message: "Stored campaign payload invalid" });
  try { return parseBoundary({ schema: required.schema, input: JSON.parse(required.value) }); }
  catch { return fail({ code: "invalid_input", message: "Stored campaign JSON invalid" }); }
}
async function sqlBoundary<T>(required: { dependencies: Dependencies; context: CallContext; operation: string; execute: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  const cancelled = checkCancelled({ options: optional });
  if (!cancelled.ok) return cancelled;
  let outcome: Outcome<T>;
  try { outcome = await required.execute(); }
  catch { outcome = fail({ code: "unavailable", message: "Campaign SQL unavailable" }); }
  try { required.dependencies.observer?.observe({ operation: required.operation, outcome: outcome.ok ? "succeeded" : outcome.error.code, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
  catch { /* Telemetry never changes persistence semantics. */ }
  return outcome;
}
