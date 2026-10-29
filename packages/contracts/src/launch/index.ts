import { z } from "zod";
import { callContextSchema, digestSchema, idSchema, moneySchema, scopeSchema, timeWindowSchema } from "../values/index.js";
import type { CallContext, Outcome } from "../values/index.js";
import type { PluginCapabilityDependencies } from "../capabilities/index.js";

/** Paused/draft deployment evidence; plugin checkpoint extensions remain opaque to core. */
export const campaignDeploymentReceiptSchema = z.looseObject({
  status: z.enum(["acknowledged", "unknown"]), state: z.enum(["paused", "draft"]), entityIds: z.array(idSchema).max(500),
  references: z.union([z.array(idSchema).max(500), z.record(idSchema, idSchema)]).optional(),
});
export type CampaignDeploymentReceipt = z.infer<typeof campaignDeploymentReceiptSchema>;
/** Shared input for deployCampaignPaused and readCampaignDeployment; the host owns persistence.
 * saved.record is the latest opaque checkpoint, or null before one exists.
 */
export type CampaignDeploymentRequired = {
  context: CallContext; operationId: string; plan: unknown; connectionId: string; accountId: string;
  dependencies: PluginCapabilityDependencies;
  checkpoint(required: { step: string; phase: string; references?: unknown; record?: unknown }): Promise<Outcome<void>>;
  saved: { references: Record<string, string>; record: unknown | null };
};

const positiveMoney = moneySchema.refine(value => value.minorUnits > 0);
const countries = z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(20)
  .refine(values => new Set(values).size === values.length);
const localTargeting = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("postal"), codes: z.array(z.string().trim().min(1).max(20)).min(1).max(200)
    .refine(values => new Set(values).size === values.length) }),
  z.strictObject({ kind: z.literal("radius"), latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180), radiusKm: z.number().positive().max(20040) }),
]);
const target = z.strictObject({
  pluginId: idSchema, connectionId: idSchema, accountId: idSchema, dailyBudget: positiveMoney, expectedExposure: positiveMoney,
}).refine(value => value.dailyBudget.currency === value.expectedExposure.currency);
/** V2 intent, never deployment authority. Per-account exposure is not a hard cap or FX conversion.
 * Strict JSON <=64 KiB; each ad carries its explicit HTTP(S) destination. No v1 decoder.
 * @example neutralCampaignLaunchSchema.safeParse({ schemaVersion: 2, ...intent })
 */
export const neutralCampaignLaunchSchema = z.preprocess((value, context) => boundLaunchJson({ value, context }), z.strictObject({
  schemaVersion: z.literal(2), operationId: idSchema, name: z.string().trim().min(1).max(200),
  objective: z.enum(["traffic", "leads", "sales"]),
  schedule: z.strictObject({ window: timeWindowSchema.refine(value => value.end <= 8640000000000000),
    timezone: z.string().min(1).max(100).refine(value => validTimezone({ value })) }),
  audience: z.strictObject({ countries, localTargeting: localTargeting.optional(),
    searchTerms: z.array(z.string().trim().min(1).max(80)).min(1).max(50)
      .refine(values => new Set(values.map(value => value.toLowerCase())).size === values.length).optional(),
  }).refine(value => value.localTargeting?.kind !== "postal" || value.countries.length === 1),
  ads: z.array(z.strictObject({ creativeId: idSchema, destinationUrl: z.url({ protocol: /^https?$/ }).max(2048) })).min(1).max(20)
    .refine(values => new Set(values.map(value => value.creativeId)).size === values.length),
  creativeDigest: digestSchema,
  targets: z.array(target).min(1).max(4)
    .refine(values => new Set(values.map(value => JSON.stringify([value.pluginId, value.connectionId, value.accountId]))).size === values.length),
}));
export type NeutralCampaignLaunch = z.infer<typeof neutralCampaignLaunchSchema>;
/** A saved intent is not evidence of a remotely created campaign. */
export const neutralCampaignRecordSchema = z.strictObject({ scope: scopeSchema, campaignId: idSchema, campaign: neutralCampaignLaunchSchema });
export type NeutralCampaignRecord = z.infer<typeof neutralCampaignRecordSchema>;
export const saveNeutralCampaignSchema = z.strictObject({ context: callContextSchema, campaign: neutralCampaignLaunchSchema });
/** Zod callback adapter bounds JSON before traversal; cycles/oversize reject. O(b) time/space in bytes. */
function boundLaunchJson(required: { value: unknown; context: z.RefinementCtx }): unknown {
  try {
    const json = JSON.stringify(required.value);
    if (json !== undefined && new TextEncoder().encode(json).byteLength <= 65536) return required.value;
  } catch { /* Cycles and non-JSON values are invalid boundary input. */ }
  required.context.addIssue({ code: "custom", message: "Launch must be JSON of at most 64 KiB" });
  return z.NEVER;
}
/** Pure timezone validity check; constant bounded work, no clock reads. */
function validTimezone({ value }: { value: string }): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; }
  catch { return false; }
}
