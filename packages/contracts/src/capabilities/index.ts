import { z } from "zod";
import { digestSchema, epochSchema, idSchema, moneySchema, scopeSchema, timeWindowSchema } from "../values/index.js";
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
export type CostQuote = GenerationCostQuote;
export const generationAllowanceSettingsSchema = z.strictObject({ amount: moneySchema, dayTimezone: idSchema, revision: epochSchema });
export type GenerationAllowanceSettings = z.infer<typeof generationAllowanceSettingsSchema>;
export const DEFAULT_GENERATION_ALLOWANCE: GenerationAllowanceSettings = Object.freeze({ amount: Object.freeze({ minorUnits: 1000, currency: "USD" }), dayTimezone: "UTC", revision: 0 });
export const generationApprovalRequirementSchema = z.strictObject({ kind: z.enum(["normal_write", "exact_spend", "denied"]), reason: idSchema, quoteId: idSchema, allowanceRevision: epochSchema, dispatchDay: idSchema });
export type GenerationApprovalRequirement = z.infer<typeof generationApprovalRequirementSchema>;
/** Closed stop-only input: extra fields/budget/activation are rejected by the schema. */
export const haltStopRequestSchema = z.strictObject({ operationId: idSchema, scope: scopeSchema, connectionId: idSchema, adAccountId: idSchema, entityIds: z.array(idSchema).min(1).max(100), action: z.enum(["pause", "stop"]), haltId: idSchema, haltEpoch: epochSchema, pluginDigest: digestSchema, bindingId: idSchema, argumentsDigest: digestSchema });
export type HaltStopRequest = z.infer<typeof haltStopRequestSchema>;
export interface HaltStopPermit { readonly kind: "halt-stop"; readonly request: HaltStopRequest; readonly expiresAt: number }
export const measurementGrantSchema = z.strictObject({ kind: z.literal("measurement"), grantId: idSchema, scope: scopeSchema, connectionId: idSchema, accountId: idSchema, eventTypes: z.array(z.enum(["signup", "trial"])).min(1).max(2), destination: idSchema, purpose: idSchema, payloadSchema: idSchema, payloadVersion: z.literal(1), expiresAt: epochSchema, revoked: z.boolean() });
export type MeasurementGrant = z.infer<typeof measurementGrantSchema>;
export type MeasurementServiceGrant = MeasurementGrant;
