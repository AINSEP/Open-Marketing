import { array, bool, currency, date, epoch, id, micros, numericId, object, status, text } from "./schema.ts";
import type { Schema } from "./schema.ts";
import type { ToolName } from "./types.ts";

/** Immutable exact Search plan; manual language criteria are intentionally absent. */
export const planSchema = object({ properties: {
  name: text, currency, averageDailyBudgetMicros: micros, cpcBidMicros: micros, startsAt: epoch, endsAt: epoch,
  geoTargetIds: array({ items: numericId, min: 1, max: 20 }),
  keywords: array({ items: object({ properties: {
    text: { ...text, maxLength: 80 }, matchType: { type: "string", enum: ["EXACT", "PHRASE"] },
  } }), min: 1, max: 50 }),
  headlines: array({ items: { ...text, maxLength: 30 }, min: 3, max: 15 }),
  descriptions: array({ items: { ...text, maxLength: 90 }, min: 2, max: 4 }),
  finalUrl: { type: "string", minLength: 8, maxLength: 2048, pattern: "^https://" },
  euPoliticalAdvertising: { type: "string", enum: ["CONTAINS_EU_POLITICAL_ADVERTISING", "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"] },
} });
const operation = object({ properties: { operationId: id } });
const campaign = object({ properties: { operationId: id, campaignId: numericId } });
/** Closed agent tool schemas: conversion upload and halt permits are backend-only. */
export const toolSchemas: Record<ToolName, Schema> = {
  list_accounts: operation, read_campaign: campaign, read_budget: campaign,
  report: object({ properties: { operationId: id, startDate: date, endDate: date } }),
  create_paused: object({ properties: { operationId: id, plan: planSchema } }),
  activate: campaign, set_budget: object({ properties: { operationId: id, campaignId: numericId, averageDailyBudgetMicros: micros } }),
  pause: campaign, reconcile: operation,
};
/** Sanitized hierarchy projection; provider taint is discarded before this parse. */
export const hierarchySchema = object({ properties: {
  customerId: numericId, campaignId: numericId, budgetId: numericId, name: text,
  currency, timezone: text, testAccount: bool, status, channel: { type: "string", enum: ["SEARCH"] },
  searchPartners: bool, displayNetwork: bool, averageDailyBudgetMicros: micros, sharedBudget: bool,
  period: { type: "string", enum: ["DAILY"] }, startsAt: epoch, endsAt: epoch,
  childIds: array({ items: { ...id, pattern: "^(group|ad|keyword):[1-9][0-9]*(~[1-9][0-9]*)?$" }, min: 3, max: 100 }),
  childStatuses: array({ items: status, min: 3, max: 100 }), observedAt: epoch,
  planDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
} });
export const bindingSchema = object({ properties: {
  scope: object({ properties: { ownerId: id, workspaceId: id } }), connectionId: id, customerId: { ...numericId, minLength: 10, maxLength: 10 },
  currency, timezone: text, mode: { type: "string", enum: ["sandbox", "read_only", "production"] },
  pluginDigest: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
  schemaFingerprint: { type: "string", pattern: "^[a-f0-9]{64}$", maxLength: 64 },
} });
export const contextSchema = object({ properties: {
  scope: object({ properties: { ownerId: id, workspaceId: id } }),
  principal: object({ properties: { kind: { type: "string", enum: ["service"] }, serviceId: id } }),
  correlationId: id, traceId: id, runId: id,
}, optional: ["runId"] });
export const billingSchema = object({ properties: {
  evidenceId: id, observedAt: epoch, localDate: date, historyComplete: bool,
  highestBudgetTodayMicros: micros, monthToDateBilledMicros: { ...micros, pattern: "^[0-9]+$" },
  remainingDaysIncludingToday: { type: "integer", minimum: 1, maximum: 31 }, productionVerified: bool,
} });
const receiptSchema = object({ properties: {
  operationId: id, status: { type: "string", enum: ["acknowledged", "unknown"] }, campaignId: numericId, hierarchy: hierarchySchema, requestId: id,
  references: array({ items: { type: "string", maxLength: 256, pattern: "^customers/[0-9]{10}/(campaignBudgets|campaigns|adGroups|campaignCriteria|adGroupCriteria|adGroupAds)/[1-9][0-9]*(~[1-9][0-9]*)?$" }, min: 0, max: 256 }),
}, optional: ["campaignId", "hierarchy", "requestId", "references"] });
/** Local MCP results are parsed again; plugin replies remain tainted at the host edge. */
export const resultSchemas: Record<ToolName, Schema> = {
  list_accounts: object({ properties: { customerId: { ...numericId, minLength: 10, maxLength: 10 }, currency, timezone: text, testAccount: bool } }),
  read_campaign: hierarchySchema, read_budget: hierarchySchema,
  create_paused: receiptSchema, activate: receiptSchema, set_budget: receiptSchema, pause: receiptSchema, reconcile: receiptSchema,
  report: object({ properties: {
    accountId: numericId, currency, timezone: text, retrievedAt: epoch,
    costSemantics: { type: "string", enum: ["served_cost_not_billed_cost"] },
    items: array({ items: object({ properties: {
      date, costMicros: { type: "string", pattern: "^[0-9]{1,18}$", maxLength: 18 },
      clicks: { type: "string", pattern: "^[0-9]{1,18}$", maxLength: 18 },
      impressions: { type: "string", pattern: "^[0-9]{1,18}$", maxLength: 18 },
    } }), min: 0, max: 100 }),
  } }),
};
