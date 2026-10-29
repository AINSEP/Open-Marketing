import { z } from "zod";
import { array, bool, currency, date, epoch, id, micros, numericId, object, status, text } from "./schema.ts";
import type { Schema } from "./schema.ts";
import type { ToolName } from "./types.ts";

const headlines = z.array(z.string().min(1).max(30)).min(3).max(15);
const descriptions = z.array(z.string().min(1).max(90)).min(2).max(4);
const finalUrl = z.string().min(8).max(2048).regex(/^https:\/\//);

/** Immutable exact Search plan; root RSA plus up to two additional ads. Singletons omit additionalAds. */
export const campaignDeploymentPlanSchema = z.strictObject({
  name: z.string().min(1).max(256), currency: z.string().max(3).regex(/^[A-Z]{3}$/),
  averageDailyBudgetMicros: z.string().min(1).max(18).regex(/^[1-9][0-9]*$/),
  objective: z.enum(["leads", "sales"]).optional(),
  cpcBidMicros: z.string().min(1).max(18).regex(/^[1-9][0-9]*$/).optional(),
  startsAt: z.int().min(0).max(4102444800000), endsAt: z.int().min(0).max(4102444800000),
  geoTargetIds: z.array(z.string().min(1).max(19).regex(/^[1-9][0-9]*$/)).min(0).max(200),
  proximity: z.strictObject({
    latitudeMicroDegrees: z.int().min(-90000000).max(90000000),
    longitudeMicroDegrees: z.int().min(-180000000).max(180000000),
    radiusKm: z.number().positive().max(20040),
  }).optional(),
  keywords: z.array(z.strictObject({ text: z.string().min(1).max(80), matchType: z.enum(["EXACT", "PHRASE"]) })).min(1).max(50),
  headlines, descriptions, finalUrl,
  additionalAds: z.array(z.strictObject({ headlines, descriptions, finalUrl })).min(1).max(2).optional(),
  euPoliticalAdvertising: z.enum(["CONTAINS_EU_POLITICAL_ADVERTISING", "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"]),
});
/** Input JSON projection uses only the existing local matcher's validation keywords.
 * $schema is an annotation; no unions, formats, refs or executable refinements.
 */
export const planSchema = z.toJSONSchema(campaignDeploymentPlanSchema, { io: "input" }) as Schema;
const campaignInput = z.strictObject({ campaignId: z.string().min(1).max(19).regex(/^[1-9][0-9]*$/) });
const reportDate = z.string().max(10).regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
/** Closed fixed-ABI inputs; the host supplies operationId outside model input.
 * Conversion upload and halt permits remain backend-only. */
export const toolInputSchemas = {
  list_accounts: z.strictObject({}), read_campaign: campaignInput, read_budget: campaignInput,
  report: z.strictObject({ startDate: reportDate, endDate: reportDate }),
  create_paused: z.strictObject({ plan: campaignDeploymentPlanSchema }),
  activate: campaignInput,
  set_budget: campaignInput.extend({ averageDailyBudgetMicros: z.string().min(1).max(18).regex(/^[1-9][0-9]*$/) }),
  pause: campaignInput, reconcile: z.strictObject({}),
} satisfies Record<ToolName, z.ZodObject>;
/** Legacy invocation keeps operationId in arguments until vendor-neutral A3. */
export const toolSchemas = Object.fromEntries(Object.entries(toolInputSchemas).map(([name, schema]) =>
  [name, z.toJSONSchema(schema.extend({ operationId: z.string().min(1).max(256) }), { io: "input" }) as Schema],
)) as Record<ToolName, Schema>;
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
/** Transport consumes only selected identity, never write authority or fabricated account facts. */
export const transportBindingSchema = object({ properties: {
  scope: bindingSchema.properties!.scope, connectionId: id, customerId: bindingSchema.properties!.customerId,
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
