import type { z } from "zod";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignRepoPort, CampaignSqlPort, CampaignObserverPort } from "../ports.js";
import type { CampaignRecord, LaunchProposal } from "../types.js";
import { campaignId, createInputSchema, fail, parseBoundary, recordSchema, proposalSchema, success, digest, observationSchema, scopeKey } from "../rules.js";
import { checkCancelled, existingDraft, existingProposal, getInputSchema, observeInputSchema, proposalInputSchema, proposalGetSchema, proposalForRecord, withObservation } from "../repo-rules.js";

interface Dependencies { db: CampaignSqlPort; observer?: CampaignObserverPort }
const recordQuery = `SELECT c.record_json, (SELECT r.observation_json FROM campaign_revision r
 WHERE r.owner_id=c.owner_id AND r.workspace_id=c.workspace_id AND r.campaign_id=c.campaign_id
 ORDER BY r.revision DESC LIMIT 1) AS observation_json FROM campaign c
 WHERE c.owner_id=$1 AND c.workspace_id=$2 AND c.campaign_id=$3`;

/** Inert portable SQL repository. Caller supplies the documented db-shaped shim,
 * initializes the additive migration separately, and owns connection/lifecycle.
 * Never imports a driver or another feature's tables.
 * @example createSqlCampaignRepo({ db: serverQueryable }, { observer });
 * @complexity Indexed O(log n) lookup; at most three SQL calls per operation.
 */
export function createSqlCampaignRepo(required: { db: CampaignSqlPort }, optional: { observer?: CampaignObserverPort } = {}): CampaignRepoPort {
  const dependencies: Dependencies = { ...required, ...optional };
  return {
    save(input, options) { return sqlBoundary({ dependencies, context: input.context, operation: "campaigns.repo.save", execute: async () => {
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
    get(input, options) { return sqlBoundary({ dependencies, context: input.context, operation: "campaigns.repo.get", execute: async () => {
      const parsed = parseBoundary({ schema: getInputSchema, input });
      if (!parsed.ok) return parsed;
      return readRecord({ dependencies, ...parsed.value });
    } }, options); },
    observe(input, options) { return sqlBoundary({ dependencies, context: input.context, operation: "campaigns.repo.observe", execute: async () => {
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
    saveProposal(input, options) { return sqlBoundary({ dependencies, context: input.context, operation: "campaigns.repo.saveProposal", execute: async () => {
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
    getProposal(input, options) { return sqlBoundary({ dependencies, context: input.context, operation: "campaigns.repo.getProposal", execute: async () => {
      const parsed = parseBoundary({ schema: proposalGetSchema, input });
      if (!parsed.ok) return parsed;
      return readProposal({ dependencies, ...parsed.value });
    } }, options); },
  };
}
async function readRecord(required: { dependencies: Dependencies; context: CallContext; campaignId: string }): Promise<Outcome<CampaignRecord | null>> {
  const { context, campaignId, dependencies } = required;
  const result = await dependencies.db.query({ text: recordQuery, values: [context.scope.ownerId, context.scope.workspaceId, campaignId] });
  const row = result.rows[0];
  if (!row) return success({ value: null });
  const parsed = parseStored({ schema: recordSchema, value: row.record_json });
  if (!parsed.ok) return parsed;
  if (scopeKey({ scope: parsed.value.scope }) !== scopeKey({ scope: context.scope }) || parsed.value.receipt.campaignId !== campaignId) return fail({ code: "invalid_input", message: "Stored campaign scope mismatch" });
  if (row.observation_json === null) return parsed;
  const observation = parseStored({ schema: observationSchema, value: row.observation_json });
  if (!observation.ok) return observation;
  return success({ value: withObservation({ record: parsed.value, state: observation.value }) });
}
async function readProposal(required: { dependencies: Dependencies; context: CallContext; operationId: string }): Promise<Outcome<LaunchProposal | null>> {
  const { context, operationId, dependencies } = required;
  const result = await dependencies.db.query({ text: "SELECT proposal_json FROM campaign_launch_proposal WHERE owner_id=$1 AND workspace_id=$2 AND operation_id=$3", values: [context.scope.ownerId, context.scope.workspaceId, operationId] });
  if (!result.rows[0]) return success({ value: null });
  return parseStored({ schema: proposalSchema, value: result.rows[0].proposal_json });
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
