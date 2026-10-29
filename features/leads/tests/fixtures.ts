import { readFileSync } from "node:fs";
import { createSqliteFixture } from "@open-marketing/om-db/testing";
import type { CallContext, ClockPort, IdPort, Outcome } from "@open-marketing/contracts";
import type { Lead, LeadAttribution, LeadsRepoPort, LeadStage } from "../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const otherWorkspace: CallContext = { ...context, scope: { ...context.scope, workspaceId: "other-workspace" } };
export const otherOwner: CallContext = { ...context, scope: { ownerId: "other-owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "other-owner" } };
export const attribution: LeadAttribution = { campaign: { pluginId: "google-ads", accountId: "account", vendorCampaignId: "campaign" }, touchId: "touch", touchedAt: 100, modelVersion: "last_paid_touch_30d.v1" };
/** Only IDs and accepted attribution evidence enter repository fixtures. */
export function record(required: { lead?: Partial<Lead>; context?: CallContext } = {}): Parameters<LeadsRepoPort["capture"]>[0] {
  const ctx = required.context ?? context;
  const lead = structuredClone<Lead>({ scope: ctx.scope, leadId: "lead-1", subjectId: "subject", source: { kind: "form", ref: "submission" }, occurredAt: 200, createdAt: 1000, attribution, stage: "new", revision: 1, lastEventId: "initial", erased: false, ...required.lead });
  return { context: ctx, lead, event: { scope: ctx.scope, leadId: lead.leadId, eventId: lead.lastEventId, revision: 1, from: null, to: "new", retractsEventId: null, at: lead.createdAt, actor: ctx.principal, correlationId: ctx.correlationId, traceId: ctx.traceId, runId: ctx.runId } };
}
export function stage(required: { lead: Lead; to?: LeadStage; changeId?: string }): Parameters<LeadsRepoPort["appendStage"]>[0] {
  const { lead } = required;
  const to = required.to ?? "qualified";
  return { context, leadId: lead.leadId, expectedRevision: lead.revision, event: { ...record().event, leadId: lead.leadId, eventId: required.changeId ?? "change", from: lead.stage, to, revision: lead.revision + 1, at: 2000, retractsEventId: to === "spam" ? lead.lastEventId : null } };
}
export function value<T>(result: Outcome<T>): T { if (!result.ok) throw new Error(result.error.code); return result.value; }
export function runtime() {
  let sequence = 0;
  const time = { now: 1000 };
  const clock: ClockPort = { now: () => time.now };
  const ids: IdPort = { next: () => "generated-" + ++sequence };
  return { clock, ids, time };
}
/** Reopen with migrations:false; fixture-only SQLite, never a product migration. */
export function sqliteFixture(required: { filename?: string; migrations?: boolean; beforeQuery?: (input: { text: string; values?: unknown[] }) => void } = {}) {
  return createSqliteFixture({ migrations: required.migrations === false ? [] : [readFileSync(new URL("../migrations/0001_leads.sql", import.meta.url), "utf8")] }, { filename: required.filename, beforeQuery: required.beforeQuery });
}
