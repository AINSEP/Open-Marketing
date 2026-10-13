import { z } from "zod";
import { callContextSchema, dailyLimitRequirementSchema, idSchema, moneyExposureSchema } from "@open-marketing/contracts";
import type { EffectCategory, Outcome } from "@open-marketing/contracts";
import { parse } from "./boundary.js";

/** Adapter-owned commands, NOT a claim about the hosted Meta tools/list schema. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/);
const name = z.string().trim().min(1).max(256);
const minor = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const entityType = z.enum(["campaign", "adset", "ad"]);
const targeting = z.strictObject({ countries: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(25), age_min: z.number().int().min(18).max(65), age_max: z.number().int().min(18).max(65) }).refine(value => value.age_min <= value.age_max);

/** Closed commands prevent generic updater, arbitrary HTTP, account-cap unit guesses and payload inflation. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("create-campaign"), name, objective: z.enum(["OUTCOME_TRAFFIC", "OUTCOME_LEADS", "OUTCOME_SALES", "OUTCOME_AWARENESS"]), specialAdCategories: z.array(z.enum(["CREDIT", "EMPLOYMENT", "HOUSING", "ISSUES_ELECTIONS_POLITICS"])).max(4) }),
  z.strictObject({ kind: z.literal("create-adset"), name, campaignId: vendorIdSchema, targeting, billingEvent: z.literal("IMPRESSIONS"), optimizationGoal: z.enum(["LINK_CLICKS", "LANDING_PAGE_VIEWS", "OFFSITE_CONVERSIONS"]), dailyBudgetMinor: minor }),
  z.strictObject({ kind: z.literal("create-ad"), name, adsetId: vendorIdSchema, creativeId: vendorIdSchema }),
  z.strictObject({ kind: z.literal("activate"), entityId: vendorIdSchema, entityType }),
  z.strictObject({ kind: z.literal("pause"), entityId: vendorIdSchema, entityType }),
  z.strictObject({ kind: z.literal("set-campaign-cap"), campaignId: vendorIdSchema, amountMinor: minor }),
  z.strictObject({ kind: z.literal("set-daily-budget"), entityId: vendorIdSchema, entityType: z.enum(["campaign", "adset"]), amountMinor: minor }),
  z.strictObject({ kind: z.literal("read-entities"), entityIds: z.array(vendorIdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length) }),
  z.strictObject({ kind: z.literal("report"), since: z.iso.date(), until: z.iso.date(), attributionWindow: z.enum(["1d_click", "7d_click", "1d_view"]) }).refine(value => value.since <= value.until),
]);
export type MetaCommand = z.infer<typeof commandSchema>;

/** Every money mutation carries this single call's declared exposure for the server gate. */
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, connectionId: idSchema, accountId: vendorIdSchema, command: commandSchema, moneyExposure: moneyExposureSchema.nullable(), requiredLimit: dailyLimitRequirementSchema.nullable() });
export type MetaInvocation = z.infer<typeof invocationSchema>;
export interface EncodedCommand { readonly operation: MetaCommand["kind"]; readonly arguments: Readonly<Record<string, unknown>>; readonly effects: readonly EffectCategory[]; readonly claim: string }

/** Produce a narrow proposed wire payload; actual input-schema validation is mandatory before egress.
 * @example encodeCommand({ input: { kind: "activate", entityId: "123", entityType: "campaign" }, accountId: "456" })
 * @complexity O(n) time/space for <=100 entity IDs. No effects.
 */
export function encodeCommand(required: { input: unknown; accountId: string }): Outcome<EncodedCommand> {
  const parsed = parse({ schema: commandSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const command = parsed.value;
  const account = parse({ schema: vendorIdSchema, input: required.accountId });
  if (!account.ok) return account;
  const base = { ad_account_id: account.value };
  switch (command.kind) {
    case "create-campaign": return encoded({ command, args: { ...base, name: command.name, objective: command.objective, special_ad_categories: command.specialAdCategories, status: "PAUSED" }, effects: ["write"], claim: "paused-creation" });
    case "create-adset": return encoded({ command, args: { ...base, name: command.name, campaign_id: command.campaignId, targeting: command.targeting, billing_event: command.billingEvent, optimization_goal: command.optimizationGoal, daily_budget: String(command.dailyBudgetMinor), status: "PAUSED" }, effects: ["ad_spend"], claim: "paused-creation-budget-minor" });
    case "create-ad": return encoded({ command, args: { ...base, name: command.name, adset_id: command.adsetId, creative_id: command.creativeId, status: "PAUSED" }, effects: ["write"], claim: "paused-creation" });
    case "activate": return encoded({ command, args: { ...base, entity_id: command.entityId, entity_type: command.entityType, status: "ACTIVE" }, effects: ["ad_spend"], claim: "exact-activation" });
    case "pause": return encoded({ command, args: { ...base, entity_id: command.entityId, entity_type: command.entityType, status: "PAUSED" }, effects: ["write"], claim: "pause-only" });
    case "set-campaign-cap": return encoded({ command, args: { ...base, entity_id: command.campaignId, entity_type: "campaign", spend_cap: String(command.amountMinor) }, effects: ["ad_spend"], claim: "campaign-cap-minor" });
    case "set-daily-budget": return encoded({ command, args: { ...base, entity_id: command.entityId, entity_type: command.entityType, daily_budget: String(command.amountMinor) }, effects: ["ad_spend"], claim: "daily-average-budget-minor" });
    case "read-entities": return encoded({ command, args: { ...base, entity_ids: command.entityIds, fields: ["id", "account_id", "configured_status", "effective_status", "daily_budget", "spend_cap"] }, effects: ["read"], claim: "status-cap-readback" });
    case "report": return encoded({ command, args: { ...base, time_range: { since: command.since, until: command.until }, attribution_windows: [command.attributionWindow], fields: ["account_id", "spend", "account_currency", "date_start", "date_stop"], level: "account" }, effects: ["read"], claim: "account-spend-report" });
    default: { const exhaustive: never = command; return exhaustive; }
  }
}

function encoded(required: { command: MetaCommand; args: Record<string, unknown>; effects: EffectCategory[]; claim: string }): Outcome<EncodedCommand> {
  return { ok: true, value: { operation: required.command.kind, arguments: required.args, effects: required.effects, claim: required.claim } };
}
