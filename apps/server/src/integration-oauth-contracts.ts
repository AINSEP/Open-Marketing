/** Server-only OAuth boundaries shared by HTTP, CLI and assistant; codes never enter tools. */
import { z } from 'zod';
import { epochSchema, idSchema, integrationSummarySchema, toolResultSchema, toolOperationSchema } from '@open-marketing/contracts';
export const oauthCallbackPath = '/api/addons/v1/integrations/oauth/callback';
export const oauthStartSchema = z.strictObject({ pluginId: idSchema });
export const oauthClientQuerySchema = z.strictObject({ pluginId: z.enum(['google-ads', 'linkedin-ads']) });
export const oauthStatusQuerySchema = z.union([z.strictObject({ transactionId: idSchema }), oauthClientQuerySchema]);
const callbackFields = { state: z.string().min(1).max(512) };
// Provider-added display fields are discarded. Both/neither result and duplicate query keys deny.
export const oauthCallbackSchema = z.union([
    z.object({ ...callbackFields, code: z.string().min(1).max(4096), error: z.never().optional() }),
    z.object({ ...callbackFields, error: z.string().min(1).max(256), code: z.never().optional() }),
]);
export const oauthChallengeSchema = z.strictObject({ transactionId: idSchema, authorizationUrl: z.url().max(4096), expiresAt: epochSchema });
export const oauthClientStatusSchema = z.union([z.strictObject({ configured: z.literal(false) }), z.strictObject({ configured: z.literal(true), clientId: z.string().min(1).max(2048) })]);
export const oauthStatusSchema = z.union([z.strictObject({ status: z.enum(['pending', 'complete', 'expired']), connection: integrationSummarySchema.optional() }), oauthClientStatusSchema]);
// Start returns the existing policy receipt; completed output contains the browser challenge.
export const oauthStartResultSchema = toolResultSchema.refine(value => value.status !== 'completed' || oauthChallengeSchema.safeParse(value.output).success);
export const oauthOperationSchema = toolOperationSchema.refine(value => value.status !== 'completed' || oauthChallengeSchema.safeParse(value.output).success);
export const oauthClientSetSchema = oauthClientQuerySchema.extend({ client: z.unknown().refine(value => value !== undefined) });
/** Google-only compatibility secret. These ingress schemas are never assistant tool arguments. */
export const developerTokenQuerySchema = z.strictObject({ pluginId: z.literal('google-ads') });
export const developerTokenSetSchema = developerTokenQuerySchema.extend({ token: z.string().regex(/^[A-Za-z0-9]{22}$/).nullable() });
export const developerTokenStatusSchema = z.strictObject({ configured: z.boolean() });
export const oauthMetadataSchema = z.strictObject({
    provider: z.strictObject({ providerId: idSchema, label: z.string().min(1).max(256), supportedGrants: z.tuple([z.literal('authorization_code')]),
        authorizationEndpoint: z.url().max(2048), tokenEndpoint: z.url().max(2048), defaultScopes: z.array(z.string().min(1).max(128)).min(1).max(64),
        usesPkce: z.literal(true), clientAuth: z.literal('client_secret_post') }),
    extraAuthorizationParams: z.strictObject({ access_type: z.literal('offline'), prompt: z.literal('consent') }).optional(),
});
