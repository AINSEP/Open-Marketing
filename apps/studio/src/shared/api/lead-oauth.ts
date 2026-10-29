import { campaignKeySchema, credentialPluginStatusSchema, epochSchema, idSchema, oauthClientStatusSchema, oauthStatusSchema } from '@open-marketing/contracts';
import { z } from "zod";
export const displayId = z.string().min(1).max(256);
/** Studio reads only the inbox presentation fields; backend lifecycle types stay on the server. */
export const leadDisplaySchema = z.object({
  leadId: displayId, source: z.object({ kind: z.enum(['form', 'call', 'booking', 'manual']), ref: displayId }),
  stage: z.enum(['new', 'qualified', 'won', 'disqualified', 'spam']), revision: epochSchema.min(1), erased: z.boolean(),
  attribution: z.object({ campaign: campaignKeySchema.nullable() }),
});
export const leadStageRequestSchema = leadDisplaySchema.pick({ leadId: true }).strict().extend({
  to: leadDisplaySchema.shape.stage, expectedRevision: leadDisplaySchema.shape.revision.max(Number.MAX_SAFE_INTEGER - 1), changeId: displayId,
});
export type LeadDisplay = z.infer<typeof leadDisplaySchema>;
export type LeadStageRequest = z.infer<typeof leadStageRequestSchema>;
export const oauthClientSetSchema = z.strictObject({ pluginId: idSchema, client: z.object({
  clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192).optional(),
}).catchall(z.string().min(1).max(2048)).nullable() });
export const pluginOAuthStatusSchema = z.union([oauthStatusSchema, credentialPluginStatusSchema]);
export type OAuthClientRequest = z.infer<typeof oauthClientSetSchema>;
export type OAuthClientStatus = z.infer<typeof oauthClientStatusSchema>;
export type OAuthStatus = z.infer<typeof pluginOAuthStatusSchema>;
