import { z } from "zod";
import { callContextSchema, digestSchema, idSchema, moneySchema, scopeSchema, timeWindowSchema } from "@open-marketing/contracts";

const positiveMoney = moneySchema.refine(value => value.minorUnits > 0);
const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20).refine(values => new Set(values).size === values.length);
const creativeIds = z.array(idSchema).min(1).max(20).refine(values => new Set(values).size === values.length);
const target = z.strictObject({
  pluginId: idSchema, connectionId: idSchema, accountId: idSchema,
  dailyBudget: positiveMoney, expectedExposure: positiveMoney,
}).refine(value => value.dailyBudget.currency === value.expectedExposure.currency);

/** Neutral website-traffic intent, not deployment or spend authority. Budgets are per account;
 * expectedExposure is a declared flight exposure, never a hard daily cap or an FX conversion.
 * Unknown fields, duplicate destinations and JSON payloads above 64 KiB reject.
 */
export const neutralCampaignLaunchSchema = z.preprocess((value, context) => boundLaunchJson({ value, context }), z.strictObject({
  operationId: idSchema, name: z.string().trim().min(1).max(200), objective: z.literal("traffic"),
  schedule: z.strictObject({ window: timeWindowSchema.refine(value => value.end <= 8640000000000000), timezone: z.string().min(1).max(100).refine(timezone => validTimezone({ timezone })) }),
  audience: z.strictObject({ countries, searchTerms: z.array(z.string().trim().min(1).max(80)).min(1).max(50).refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length).optional() }),
  creativeIds, creativeDigest: digestSchema,
  targets: z.array(target).min(1).max(4).refine(values => new Set(values.map(value => JSON.stringify([value.pluginId, value.connectionId, value.accountId]))).size === values.length),
}));

/** Canonical input for plugin-owned translations. Existing activation contracts are unchanged. */
export type NeutralCampaignLaunch = z.infer<typeof neutralCampaignLaunchSchema>;

/** A local intent is never evidence of a remotely created or serving campaign. */
export const neutralCampaignRecordSchema = z.strictObject({ scope: scopeSchema, campaignId: idSchema, campaign: neutralCampaignLaunchSchema });
export type NeutralCampaignRecord = z.infer<typeof neutralCampaignRecordSchema>;
export const saveNeutralCampaignSchema = z.strictObject({ context: callContextSchema, campaign: neutralCampaignLaunchSchema });

/** Bound JSON before schema traversal; Zod's contextual callback forwards its ABI as an object.
 * Invalid JSON or oversized input adds a validation issue and returns z.NEVER.
 * @complexity O(b) time/space in serialized input bytes; accepted payloads are <=64 KiB.
 */
function boundLaunchJson(required: { value: unknown; context: z.RefinementCtx }): unknown {
  try {
    const json = JSON.stringify(required.value);
    if (json !== undefined && new TextEncoder().encode(json).byteLength <= 65536) return required.value;
  } catch { /* Cycles and non-JSON values are invalid boundary input. */ }
  required.context.addIssue({ code: "custom", message: "Launch must be JSON of at most 64 KiB" });
  return z.NEVER;
}

function validTimezone(required: { timezone: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: required.timezone }); return true; }
  catch { return false; }
}
