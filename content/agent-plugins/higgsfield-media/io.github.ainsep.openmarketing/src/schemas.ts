import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, moneySchema, scopeSchema } from "@open-marketing/contracts";

/** Closed vendor parameter subset. No sync, get_cost, use_unlim, credentials or prompt/model override. */
export const intentSchema = z.strictObject({
  operationId: idSchema, argumentsDigest: digestSchema, configurationDigest: digestSchema,
  model: idSchema, prompt: z.string().min(1).max(32768), seed: z.number().int().min(0).max(4294967295).nullable(),
  parameters: z.strictObject({ count: z.literal(1).optional(), aspect_ratio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]).optional() }),
});
/** Host snapshot pins all security-relevant vendor identities. */
export const bindingSchema = z.strictObject({
  pluginId: z.literal("higgsfield-media"), pluginDigest: digestSchema, configurationDigest: digestSchema,
  connectionId: idSchema, accountId: idSchema, scope: scopeSchema,
  generationSchemaFingerprint: digestSchema, statusSchemaFingerprint: digestSchema,
  evidenceId: idSchema, expiresAt: epochSchema,
});
/** Evidence is bounded and cannot claim a conversion rate of zero or credits from another account. */
export const pricingSchema = z.strictObject({
  evidenceId: idSchema, source: z.string().min(1).max(4096), observedAt: epochSchema, expiresAt: epochSchema,
  pluginDigest: digestSchema, configurationDigest: digestSchema, generationSchemaFingerprint: digestSchema,
  accountId: idSchema, model: idSchema, argumentsDigest: digestSchema, unitUpperBound: moneySchema,
  creditRate: z.strictObject({ minorUnits: z.number().int().positive().max(1_000_000), creditUnits: z.number().int().positive().max(1_000_000) }).nullable(),
});
/** Public context schema is shared, including the trace/run identifiers. */
export { callContextSchema };

const resourceLink = z.object({
  type: z.literal("resource_link"), uri: z.string().min(1).max(4096),
  mimeType: z.enum(["image/png", "image/jpeg", "image/webp", "image/avif"]),
});
const textContent = z.object({ type: z.literal("text"), text: z.string().max(65536) });
/** Supported historical MCP shape; unknown metadata is discarded, not persisted or logged. */
export const mcpPayloadSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.union([textContent, resourceLink])).max(16).optional(),
  structuredContent: z.object({
    results: z.array(z.object({ id: idSchema, type: z.literal("image"), status: z.enum(["pending", "in_progress"]) })).max(4).optional(),
    jobId: idSchema.optional(),
    status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]).optional(),
    poll_after_seconds: z.number().finite().min(0).max(3600).optional(),
    resources: z.array(resourceLink).max(4).optional(),
    cost: z.object({ credits_exact: z.number().finite().nonnegative().max(1_000_000) }).optional(),
    charge: z.object({ status: z.literal("charged"), credits_exact: z.number().finite().nonnegative().max(1_000_000), evidence_id: idSchema }).optional(),
    monetization_intent: z.literal("upgrade").optional(),
  }).optional(),
});
/** Local bridge protocol carries only a closed vendor tool call, with no secrets or HTTP options. */
export const wireSchema = z.strictObject({
  name: z.enum(["generate_image", "job_status"]),
  arguments: z.union([
    z.strictObject({ params: z.strictObject({ model: idSchema, prompt: z.string().min(1).max(32768), count: z.literal(1), aspect_ratio: z.string().max(8).optional(), seed: z.number().int().nonnegative().max(4294967295).optional() }) }),
    z.strictObject({ jobId: idSchema }),
  ]),
});
