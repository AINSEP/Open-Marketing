/** Server-only Meta exchange; host owns state, admission, guarded transport and sealing.
 * https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow/
 * https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived/
 * https://developers.facebook.com/docs/graph-api/reference/debug_token/
 */
import { z } from "zod";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { failure } from "./boundary.js";

const clientSchema = z.object({ clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192), configId: z.string().regex(/^[1-9][0-9]{0,127}$/) });
const tokenSchema = z.object({ access_token: z.string().min(1).max(32768), token_type: z.string().regex(/^bearer$/i), expires_in: z.number().int().nonnegative().max(3155760000) });
const scopeSchema = z.string().min(1).max(128).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/);
const expirySchema = z.number().int().nonnegative().max(253402300799);
const debugSchema = z.object({ data: z.object({ app_id: z.string(), type: z.literal('USER'), is_valid: z.literal(true),
    expires_at: expirySchema, data_access_expires_at: expirySchema, scopes: z.array(scopeSchema).max(64),
    granular_scopes: z.array(z.object({ scope: scopeSchema, target_ids: z.array(z.union([z.string().regex(/^[0-9]{1,128}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])).max(1024).optional() })).max(64).optional() }) });

const tokensSchema = z.strictObject({ accessToken: z.string().min(1).max(32768), refreshToken: z.null(), tokenType: z.literal('Bearer'),
    scopes: z.array(scopeSchema).max(64), expiresAt: z.iso.datetime().nullable() });
type OAuthTokens = z.infer<typeof tokensSchema>;
type ExchangeInput = { client: unknown; code: string; redirectUri: string; requiredScopes: readonly string[] };
const tokenEndpoint = 'https://graph.facebook.com/v26.0/oauth/access_token';
const debugEndpoint = 'https://graph.facebook.com/v26.0/debug_token';

/** Create an inert, call-scoped exchange using the host's guarded fetch and injected clock.
 * @returns Normalized validated tokens or a fixed, secret-free boundary failure; no storage.
 * @example createOAuthExchange({ fetch: guardedFetch, clock }).exchange({ client, code, redirectUri, requiredScopes })
 * @complexity Three sequential GETs, no retry; O(b + s) time/space for bounded response bytes and <=64 scopes.
 */
export function createOAuthExchange(required: Pick<PluginCapabilityDependencies, 'fetch' | 'clock'>): {
    exchange(required: ExchangeInput, optional?: CallOptions): Promise<Outcome<OAuthTokens>>;
} {
    return { async exchange(input, optional) {
        try {
            optional?.signal?.throwIfAborted();
            const client = clientSchema.parse(input.client);
            const identity = { client_id: client.clientId, client_secret: client.clientSecret };
            const short = tokenSchema.parse(await getJson({ fetch: required.fetch, endpoint: tokenEndpoint,
                params: { ...identity, redirect_uri: input.redirectUri, code: input.code } }, optional));
            const exchangeStartedAt = required.clock.now({});
            const token = tokenSchema.parse(await getJson({ fetch: required.fetch, endpoint: tokenEndpoint,
                params: { ...identity, grant_type: 'fb_exchange_token', fb_exchange_token: short.access_token } }, optional));
            const inspected = debugSchema.parse(await getJson({ fetch: required.fetch, endpoint: debugEndpoint,
                params: { input_token: token.access_token, access_token: client.clientId + '|' + client.clientSecret } }, optional)).data;
            const tokens = tokensSchema.parse(validatedTokens({ token, inspected, clientId: client.clientId, requiredScopes: input.requiredScopes,
                exchangeStartedAt, now: required.clock.now({}) }));
            optional?.signal?.throwIfAborted();
            return { ok: true, value: tokens };
        } catch (error) {
            const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'protocol_mismatch' : 'unavailable';
            return failure({ code, message: 'OAuth token exchange unavailable' });
        }
    } };
}

/** Foreign fetch ABI stays in the injected host; never expose its error or a rejected response body.
 * @complexity One host-bounded GET and JSON parse, O(response bytes) time/space, no retry.
 */
async function getJson(required: { fetch: typeof fetch; endpoint: string; params: Record<string, string> }, optional?: CallOptions): Promise<unknown> {
    optional?.signal?.throwIfAborted();
    const url = new URL(required.endpoint);
    url.search = new URLSearchParams(required.params).toString();
    const response = await required.fetch(url, { method: 'GET', redirect: 'error', signal: optional?.signal });
    if (!response.ok) { await response.body?.cancel(); throw malformed({}); }
    return response.json();
}

/** Validate identity, actual grants and every reported positive expiry; zero means no time limit.
 * @complexity O(s + g) time/space for <=64 scopes/granular grants; no I/O or assumed lifetime.
 */
function validatedTokens(required: { token: z.infer<typeof tokenSchema>; inspected: z.infer<typeof debugSchema>['data']; clientId: string;
    requiredScopes: readonly string[]; exchangeStartedAt: number; now: number }) {
    const { token, inspected } = required;
    const granted = new Set(inspected.scopes);
    if (inspected.app_id !== required.clientId || required.requiredScopes.some(scope => !granted.has(scope))) throw malformed({});
    if (inspected.granular_scopes?.some(grant => !granted.has(grant.scope))) throw malformed({});
    const expiries = [token.expires_in === 0 ? 0 : required.exchangeStartedAt + token.expires_in * 1000, inspected.expires_at * 1000, inspected.data_access_expires_at * 1000].filter(expiry => expiry > 0);
    const expiresAt = expiries.length ? Math.min(...expiries) : null;
    if (expiresAt !== null && expiresAt <= required.now) throw malformed({});
    return { accessToken: token.access_token, refreshToken: null, tokenType: 'Bearer', scopes: [...granted],
        expiresAt: expiresAt === null ? null : new Date(expiresAt).toISOString() };
}

function malformed(_required: Record<string, never>): SyntaxError {
    return new SyntaxError('Invalid OAuth grant');
}
