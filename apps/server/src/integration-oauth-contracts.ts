/** Server-only OAuth boundaries shared by HTTP, CLI and assistant; codes never enter tools. */
import { z } from 'zod';
import { idSchema, credentialPluginStatusSchema, oauthChallengeSchema, oauthStatusSchema as sharedOAuthStatusSchema, toolResultSchema, toolOperationSchema } from '@open-marketing/contracts';
import type { OAuthChallengeRules } from '@open-marketing/credentials';
export const oauthCallbackPath = '/api/addons/v1/integrations/oauth/callback';
export const oauthStartSchema = z.strictObject({ pluginId: idSchema });
export const oauthClientQuerySchema = z.strictObject({ pluginId: idSchema });
export const oauthStatusQuerySchema = z.union([z.strictObject({ transactionId: idSchema }), z.strictObject({ pluginId: idSchema })]);
const callbackFields = { state: z.string().min(1).max(512) };
// Provider-added display fields are discarded. Both/neither result and duplicate query keys deny.
export const oauthCallbackSchema = z.union([
    z.object({ ...callbackFields, code: z.string().min(1).max(4096), error: z.never().optional() }),
    z.object({ ...callbackFields, error: z.string().min(1).max(256), code: z.never().optional() }),
]);
export const oauthStatusSchema = z.union([sharedOAuthStatusSchema, credentialPluginStatusSchema]);
// Start returns the existing policy receipt; completed output contains the browser challenge.
export const oauthStartResultSchema = toolResultSchema.refine(value => value.status !== 'completed' || oauthChallengeSchema.safeParse(value.output).success);
export const oauthOperationSchema = toolOperationSchema.refine(value => value.status !== 'completed' || oauthChallengeSchema.safeParse(value.output).success);
export const oauthClientSetSchema = oauthClientQuerySchema.extend({ client: z.unknown().refine(value => value !== undefined) });
const standardProviderSchema = z.strictObject({ providerId: idSchema, label: z.string().min(1).max(256), supportedGrants: z.tuple([z.literal('authorization_code')]),
        authorizationEndpoint: z.url().max(2048), tokenEndpoint: z.url().max(2048), defaultScopes: z.array(z.string().min(1).max(128)).min(1).max(64),
        usesPkce: z.literal(true), clientAuth: z.literal('client_secret_post') });
const scope = z.string().min(1).max(128).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
export const oauthMetadataSchema = z.union([z.strictObject({
    provider: standardProviderSchema,
    extraAuthorizationParams: z.strictObject({ access_type: z.literal('offline'), prompt: z.literal('consent') }).optional(),
}), z.strictObject({
    provider: standardProviderSchema.extend({ usesPkce: z.literal(false), clientAuth: z.literal('none') }),
    exchange: z.strictObject({ authorizationScopes: z.array(scope).max(64),
        authorizationParams: z.partialRecord(z.enum(['app_id', 'config_id']), fieldName) }),
})]);
/** Installed declarative metadata; custom protocol code remains in the plugin. */
export type IntegrationOAuthProvider = z.infer<typeof oauthMetadataSchema>;

/** Derive the closed challenge exceptions from discovered custom exchanges.
 * @example oauthChallengeRules({ providers });
 * @complexity O(providers) time/space; metadata bounds each exchange to two parameters.
 */
export function oauthChallengeRules(required: { providers: ReadonlyMap<string, IntegrationOAuthProvider> }): Map<string, OAuthChallengeRules> {
    const rules = new Map<string, OAuthChallengeRules>();
    for (const [pluginId, metadata] of required.providers) {
        if ('exchange' in metadata) rules.set(pluginId, { usesPkce: false, responseType: 'code',
            additionalParameters: Object.keys(metadata.exchange.authorizationParams) as ('app_id' | 'config_id')[] });
    }
    return rules;
}
