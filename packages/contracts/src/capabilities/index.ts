import { z } from "zod";
import { campaignKeySchema, digestSchema, epochSchema, idSchema, moneySchema, parseBoundary, scopeSchema, timeWindowSchema } from "../values/index.js";
import type { CallContext, CallOptions, ClockPort, ObserverPort, Outcome, ServiceContext } from "../values/index.js";
import { metricBatchSchema, metricDaysSchema, metricGrainSchema, metricValuesSchema } from "../metrics/index.js";
export const effectCategorySchema = z.enum(["read", "write", "destructive", "ad_spend", "generation", "halt_stop", "conversion"]);
export type EffectCategory = z.infer<typeof effectCategorySchema>;
export const moneyExposureSchema = z.strictObject({ amount: moneySchema, window: timeWindowSchema });
export type MoneyExposure = z.infer<typeof moneyExposureSchema>;
export const dailyLimitRequirementSchema = z.strictObject({ amount: moneySchema, timezone: idSchema, semantics: z.enum(["hard_limit", "average_budget", "maximum_billed"]), evidenceId: idSchema });
export type DailyLimitRequirement = z.infer<typeof dailyLimitRequirementSchema>;
export const effectEnvelopeSchema = z.strictObject({ operationId: idSchema, connectionId: idSchema, accountId: idSchema.nullable(), effects: z.array(effectCategorySchema).min(1).max(10), argumentsDigest: digestSchema, moneyExposure: moneyExposureSchema.nullable(), requiredLimit: dailyLimitRequirementSchema.nullable() });
export type EffectEnvelope = z.infer<typeof effectEnvelopeSchema>;
export const capabilityEnvelopeSchema = z.strictObject({ capabilityId: idSchema, version: z.literal(1), pluginId: idSchema, pluginDigest: digestSchema, schemaFingerprint: digestSchema, admitted: z.boolean(), effects: z.array(effectCategorySchema).max(10) });
export type CapabilityEnvelope = z.infer<typeof capabilityEnvelopeSchema>;
export const generationCostQuoteSchema = z.strictObject({ quoteId: idSchema, pluginId: idSchema, pluginDigest: digestSchema, modelConfigurationDigest: digestSchema, argumentsDigest: digestSchema, estimated: moneySchema.nullable(), upperBound: moneySchema.nullable(), pricingEvidenceId: idSchema, expiresAt: epochSchema, status: z.enum(["known", "unknown", "expired"]) });
export type GenerationCostQuote = z.infer<typeof generationCostQuoteSchema>;
export const generationAllowanceSettingsSchema = z.strictObject({ amount: moneySchema, dayTimezone: idSchema, revision: epochSchema });
export type GenerationAllowanceSettings = z.infer<typeof generationAllowanceSettingsSchema>;
export const DEFAULT_GENERATION_ALLOWANCE: GenerationAllowanceSettings = Object.freeze({ amount: Object.freeze({ minorUnits: 1000, currency: "USD" }), dayTimezone: "UTC", revision: 0 });
export const generationApprovalRequirementSchema = z.strictObject({ kind: z.enum(["normal_write", "exact_spend", "denied"]), reason: idSchema, quoteId: idSchema, allowanceRevision: epochSchema, dispatchDay: idSchema });
export type GenerationApprovalRequirement = z.infer<typeof generationApprovalRequirementSchema>;
/** Closed stop-only input: extra fields/budget/activation are rejected by the schema. */
export const haltStopRequestSchema = z.strictObject({ operationId: idSchema, scope: scopeSchema, connectionId: idSchema, adAccountId: idSchema, entityIds: z.array(idSchema).min(1).max(100), action: z.enum(["pause", "stop"]), haltId: idSchema, haltEpoch: epochSchema, pluginDigest: digestSchema, bindingId: idSchema, argumentsDigest: digestSchema });
export type HaltStopRequest = z.infer<typeof haltStopRequestSchema>;
export interface HaltStopPermit { readonly kind: "halt-stop"; readonly request: HaltStopRequest; readonly expiresAt: number }
export const measurementGrantSchema = z.strictObject({ kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema, connectionId: idSchema, accountId: idSchema, definitionIds: z.array(idSchema).min(1).max(16), destination: idSchema, purpose: idSchema, payloadSchema: idSchema, payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean() });
export type MeasurementGrant = z.infer<typeof measurementGrantSchema>;

export const reportMetricsInputSchema = z.strictObject({ grain: metricGrainSchema, days: metricDaysSchema });
export type ReportMetricsInput = z.infer<typeof reportMetricsInputSchema>;
export const campaignStatusInputSchema = z.strictObject({
  vendorCampaignIds: z.array(idSchema).min(1).max(100).refine(values => new Set(values).size === values.length),
});
export type CampaignStatusInput = z.infer<typeof campaignStatusInputSchema>;
export const campaignStatusOutputSchema = z.strictObject({
  observedAt: epochSchema, complete: z.boolean(),
  campaigns: z.array(z.strictObject({
    vendorCampaignId: idSchema, status: z.enum(["active", "paused", "ended", "pending", "disapproved", "unknown"]),
    disapprovalDescriptions: z.array(z.string().min(1).max(1000)).max(20),
    /** Count of child ads observed as rejected; absent = not checked/unknown.
     * Reasons stay in disapprovalDescriptions; never changes status. */
    rejectedChildAds: z.number().int().nonnegative().optional(),
    /** Current, campaign-attributable budget as of observedAt; shared/unallocatable budgets are omitted.
     * Omit unknown budgets; this is not historical allocation and never authorizes month-to-date pacing alone. */
    currentBudget: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("daily"), amountMicros: metricValuesSchema.shape.spend.unwrap().unwrap(), currency: moneySchema.shape.currency }),
      z.strictObject({ kind: z.literal("lifetime"), amountMicros: metricValuesSchema.shape.spend.unwrap().unwrap(), currency: moneySchema.shape.currency, flight: timeWindowSchema }),
    ]).optional(),
  })).max(100).refine(values => new Set(values.map(value => value.vendorCampaignId)).size === values.length),
});
export type CampaignStatusOutput = z.infer<typeof campaignStatusOutputSchema>;
export const trackingTagInputSchema = z.strictObject({ campaignKey: campaignKeySchema, destinationUrl: z.url({ protocol: /^https?$/ }).max(2048) });
export type TrackingTagInput = z.infer<typeof trackingTagInputSchema>;
/** Inert text only; parsing does not execute or authorize installation of a snippet. */
export const trackingTagOutputSchema = z.strictObject({ snippet: z.string().max(32768), campaignUrlTemplate: z.string().min(1).max(4096) });
export type TrackingTagOutput = z.infer<typeof trackingTagOutputSchema>;
/** Vendor dry run of one exact deployment plan; the plugin owns the plan schema. */
export const campaignValidateInputSchema = z.strictObject({ operationId: idSchema, plan: z.record(z.string(), z.unknown()) });
export type CampaignValidateInput = z.infer<typeof campaignValidateInputSchema>;
/** Vendor rejection/uncertainty is a failed Outcome, never a status. */
export const campaignValidateOutputSchema = z.strictObject({ status: z.literal("validated") });
export type CampaignValidateOutput = z.infer<typeof campaignValidateOutputSchema>;
/** Card evidence; argumentsDigest equals the constituent envelope.argumentsDigest that dispatch rechecks. */
export const campaignValidationEvidenceSchema = z.strictObject({ pluginDigest: digestSchema, schemaFingerprint: digestSchema,
  argumentsDigest: digestSchema, status: z.enum(["validated", "unsupported"]), evidenceDigest: digestSchema });
export type CampaignValidationEvidence = z.infer<typeof campaignValidationEvidenceSchema>;
export const capabilityIdSchema = z.enum(["report.metrics.v1", "campaign.status.v1", "tracking.tag.v1", "campaign.validate.v1", "campaign.deploy", "campaign.halt-stop.v1", "brand.extract.v1", "organic.publish.v1", "audience.member.add.v1"]);
export type CapabilityId = z.infer<typeof capabilityIdSchema>;
const readFloor = Object.freeze(["read"] as const);
/** Discovery declares effect floors, never admission or authority. Null schemas reserve an ID only. */
export const capabilityCatalog = Object.freeze({
  "report.metrics.v1": Object.freeze({ requiredEffects: readFloor, input: reportMetricsInputSchema, output: metricBatchSchema }),
  "campaign.status.v1": Object.freeze({ requiredEffects: readFloor, input: campaignStatusInputSchema, output: campaignStatusOutputSchema }),
  "tracking.tag.v1": Object.freeze({ requiredEffects: readFloor, input: trackingTagInputSchema, output: trackingTagOutputSchema }),
  "campaign.validate.v1": Object.freeze({ requiredEffects: readFloor, input: campaignValidateInputSchema, output: campaignValidateOutputSchema }),
  "campaign.deploy": Object.freeze({ requiredEffects: Object.freeze(["write", "ad_spend"] as const), input: null, output: null }),
  "campaign.halt-stop.v1": Object.freeze({ requiredEffects: Object.freeze(["halt_stop"] as const), input: haltStopRequestSchema,
    output: z.strictObject({ status: z.enum(["acknowledged", "unknown"]), entityIds: z.array(idSchema).max(100) }) }),
  "brand.extract.v1": Object.freeze({ requiredEffects: Object.freeze(["read", "generation"] as const), input: null, output: null }),
  "organic.publish.v1": Object.freeze({ requiredEffects: Object.freeze(["write"] as const),
    input: z.strictObject({ text: z.string().max(10000).refine(v => v.trim().length > 0), languageCode: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).optional() }),
    output: z.strictObject({ status: z.enum(["published", "processing", "rejected", "unknown"]), postId: idSchema.optional(), url: z.url({ protocol: /^https$/ }).max(2048).optional() }) }),
  "audience.member.add.v1": Object.freeze({ requiredEffects: Object.freeze(["write"] as const),
    input: z.strictObject({ audienceId: idSchema, emailSha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    output: z.strictObject({ audienceId: idSchema, status: z.enum(["accepted", "unknown"]) }) }),
});
type SchemaCapabilityId = { [K in CapabilityId]: (typeof capabilityCatalog)[K]["input"] extends z.ZodType ? K : never }[CapabilityId];
/** Read-only callable IDs; stop handlers remain restricted to the host's halt worker. */
export type CallableCapabilityId = { [K in SchemaCapabilityId]: (typeof capabilityCatalog)[K]["requiredEffects"] extends typeof readFloor ? K : never }[SchemaCapabilityId];
export type CapabilityInput<K extends SchemaCapabilityId> = z.infer<(typeof capabilityCatalog)[K]["input"]>;
export type CapabilityOutput<K extends SchemaCapabilityId> = z.infer<(typeof capabilityCatalog)[K]["output"]>;
/** Plugins bind their own dependencies. The server supplies context and account, never authority via discovery. */
export type PluginCapability<K extends SchemaCapabilityId = CallableCapabilityId> = (required: {
  context: CallContext | ServiceContext; connection: { connectionId: string; accountId: string }; input: CapabilityInput<K>;
}, optional?: CallOptions) => Promise<Outcome<CapabilityOutput<K>>>;
/** Exactly what the server passes as `configuration`; plugins parse it with this schema.
 * Account facts (currency, timezone, country) come from the vendor API, connection identity
 * fields (customer IDs, client logins) from the credential, install-level options from `settings`.
 * @example pluginConfigurationSchema.parse({ scope, connectionId: "c1", accountId: "123", pluginDigest, settings: {} })
 */
export const pluginConfigurationSchema = z.strictObject({
  scope: scopeSchema, connectionId: idSchema, accountId: idSchema, pluginDigest: digestSchema,
  settings: z.record(idSchema, z.unknown()),
});
export type PluginConfiguration = z.infer<typeof pluginConfigurationSchema>;
/** Account-discovery (connectionOnly) tools only; account-bound calls use pluginConfigurationSchema. */
export const pluginConnectionConfigurationSchema = pluginConfigurationSchema.extend({ accountId: z.null() });
export type PluginConnectionConfiguration = z.infer<typeof pluginConnectionConfigurationSchema>;
/** Call-scoped host effects. Settings values are tainted until the plugin validates them.
 * Cancellation/deadlines arrive through each handler's CallOptions; no authority is delegated.
 */
export interface PluginCapabilityDependencies<C extends PluginConfiguration | PluginConnectionConfiguration = PluginConfiguration> {
  readonly fetch: typeof fetch;
  readonly credentials: { access(required: { connectionId: string; accountId: C["accountId"] }, optional?: CallOptions): Promise<Outcome<{ accessToken: string; expiresAt?: number; secrets?: Readonly<Record<string, string>> }>> };
  readonly clock: ClockPort;
  readonly observer: ObserverPort;
  readonly wait: (required: { milliseconds: number }, optional?: CallOptions) => Promise<Outcome<void>>;
  readonly configuration: C;
}
/** Only callable catalog IDs may name handlers; reserved IDs have no executable ABI. */
export type PluginCapabilities = Partial<{ [K in SchemaCapabilityId]: PluginCapability<K> }>;
/** An inert bundle exports createCapabilities with this signature; handlers own vendor codecs.
 * @example const createCapabilities: PluginCapabilitiesFactory = required => ({ "campaign.status.v1": handler });
 */
export type PluginCapabilitiesFactory = (required: PluginCapabilityDependencies) => PluginCapabilities;
const effectRequest = z.strictObject({ capabilityId: capabilityIdSchema, declaredEffects: z.array(effectCategorySchema).max(10) });
/** Fresh union with catalog-owned floors; invalid IDs/effects return invalid_input, no effects.
 * @complexity O(e) time/space, at most ten declared effects.
 * @example effectiveCapabilityEffects({ capabilityId: "campaign.deploy", declaredEffects: ["read"] })
 */
export function effectiveCapabilityEffects(required: { capabilityId: CapabilityId; declaredEffects: readonly EffectCategory[] }): Outcome<readonly EffectCategory[]> {
  const parsed = parseBoundary({ schema: effectRequest, input: required });
  if (!parsed.ok) return parsed;
  return { ok: true, value: [...new Set<EffectCategory>([...capabilityCatalog[parsed.value.capabilityId].requiredEffects, ...parsed.value.declaredEffects])] };
}
