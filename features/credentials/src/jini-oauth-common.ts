import { OAuthError } from "@jini-ai/oauth";
import type { OAuthClient, OAuthFetch, OAuthProviderDescriptor, OAuthTokenSet, OAuthUrlGuard } from "@jini-ai/oauth";
import { z } from "zod";
import { appErrorSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, Outcome, ObserverPort } from "@open-marketing/contracts";
import type { CredentialBrokerPort, CredentialRepoPort, SecretSealerPort } from "./ports.js";
import { readCredentialOAuthClient } from "./token.js";
import { failure } from "./rules.js";

/** Host-only plugin configuration. Never serialize clients into agent/UI configuration. */
export interface JiniOAuthProvider {
  readonly provider: OAuthProviderDescriptor;
  readonly client?: OAuthClient;
  readonly resource?: string;
  readonly extraAuthorizationParams?: { readonly access_type?: "offline"; readonly prompt?: "consent" };
}

/** Published HTTP/URL ports must enforce DNS/egress policy; native global fetch is insufficient. */
export interface JiniOAuthDependencies {
  readonly providers: ReadonlyMap<string, JiniOAuthProvider>;
  readonly fetchFn: OAuthFetch;
  readonly guard: OAuthUrlGuard;
  readonly clock: ClockPort;
  readonly sealer: SecretSealerPort;
  readonly timeoutMs?: number;
  readonly observer?: ObserverPort;
  readonly clientCredentials?: { readonly repo: CredentialRepoPort; readonly broker: CredentialBrokerPort };
}

const scopesSchema = z.array(z.string().min(1).max(128).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).max(64);
const authSchema = z.enum(["none", "client_secret_post", "client_secret_basic"]);
const providerSchema = z.strictObject({
  provider: z.strictObject({ providerId: z.string().min(1).max(128), label: z.string().min(1).max(256), supportedGrants: z.array(z.enum(["authorization_code", "device_code"])).max(2), authorizationEndpoint: z.string().url().max(2048).optional(), tokenEndpoint: z.string().url().max(2048), deviceAuthorizationEndpoint: z.string().url().max(2048).optional(), defaultScopes: scopesSchema, usesPkce: z.literal(true), clientAuth: authSchema }),
  client: z.strictObject({ clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192).optional(), authMethod: authSchema }),
  resource: z.string().url().max(2048).optional(),
  extraAuthorizationParams: z.strictObject({ access_type: z.literal("offline").optional(), prompt: z.literal("consent").optional() }).optional(),
});
const tokenSchema = z.strictObject({ accessToken: z.string().min(1).max(32768), refreshToken: z.string().min(1).max(32768).nullable(), tokenType: z.string().regex(/^Bearer$/i), scopes: scopesSchema, expiresAt: z.iso.datetime().nullable(), refreshExpiresAt: z.iso.datetime().optional() });
const upstreamTokenSchema = tokenSchema.extend({ idToken: z.string().min(1).max(32768).optional() });
export type StoredOAuthTokens = Omit<OAuthTokenSet, "idToken"> & { readonly refreshExpiresAt?: string };
export const oauthPayloadPrefix = "om.oauth.v1:";

/** Host-only decoder: untagged pasted secrets pass unchanged; malformed/version-unknown tags deny.
 * Returns only access token, expiry and scopes, never refresh material. @complexity O(payload bytes), cap 64 KiB.
 * @example readCredentialAccess({ plaintext: decrypted })
 */
export function readCredentialAccess(required: { plaintext: string }): Outcome<{ accessToken: string; expiresAt?: number; scopes?: readonly string[] }> {
  const parsed = readStoredTokens(required);
  if (!parsed.ok) return parsed;
  if (!parsed.value) return { ok: true, value: { accessToken: required.plaintext } };
  const tokens = parsed.value;
  return { ok: true, value: { accessToken: tokens.accessToken, scopes: tokens.scopes, ...(tokens.expiresAt === null ? {} : { expiresAt: Date.parse(tokens.expiresAt) }) } };
}

/** A reserved prefix separates OAuth records from arbitrary pasted strings/JSON. @complexity O(payload bytes), cap 64 KiB. */
export function readStoredTokens(required: { plaintext: string }): Outcome<StoredOAuthTokens | null> {
  if (!required.plaintext || Buffer.byteLength(required.plaintext) > 65536) return failure({ code: "protocol_mismatch" });
  if (required.plaintext.startsWith("om.developer-token.") || required.plaintext.startsWith("om.plugin-secret.")) return failure({ code: "protocol_mismatch" });
  if (!required.plaintext.startsWith("om.oauth.")) return { ok: true, value: null };
  if (!required.plaintext.startsWith(oauthPayloadPrefix)) return failure({ code: "protocol_mismatch" });
  try { return parseTokens({ value: JSON.parse(required.plaintext.slice(oauthPayloadPrefix.length)) }); }
  catch { return failure({ code: "protocol_mismatch" }); }
}

/** Validate plugin configuration before protocol effects. Unknown plugins fail closed.
 * @complexity Time/space O(config bytes), with bounded scopes and field lengths.
 */
export async function resolveProvider(required: { dependencies: JiniOAuthDependencies; context: CallContext; pluginId: string }, optional?: CallOptions): Promise<Outcome<z.infer<typeof providerSchema>>> {
  const { dependencies, pluginId } = required;
  const candidate = dependencies.providers.get(pluginId);
  if (!candidate) return failure({ code: "unavailable" });
  let client = candidate.client; let provider = candidate.provider;
  if (dependencies.clientCredentials) {
    const saved = await readCredentialOAuthClient({ ...dependencies.clientCredentials, sealer: dependencies.sealer, context: { ...required.context, principal: { kind: "service", serviceId: "oauth-client" } }, pluginId }, optional);
    if (!saved.ok) return saved;
    if (!saved.value) return failure({ code: "unavailable" });
    client = { ...saved.value, authMethod: saved.value.clientSecret ? candidate.provider.clientAuth : "none" };
    provider = { ...provider, clientAuth: client.authMethod };
  }
  return validateProvider({ candidate: { ...candidate, provider, client } });
}
/** Validate auth consistency after server-only client lookup. @complexity O(config bytes), bounded schemas. */
function validateProvider(required: { candidate: unknown }): Outcome<z.infer<typeof providerSchema>> {
  const parsed = providerSchema.safeParse(required.candidate);
  if (!parsed.success) return failure({ code: "invalid_input" });
  if (parsed.data.client.authMethod !== parsed.data.provider.clientAuth) return failure({ code: "invalid_input" });
  if (parsed.data.client.authMethod !== "none" && !parsed.data.client.clientSecret) return failure({ code: "invalid_input" });
  return { ok: true, value: parsed.data };
}

/** Brand expiry only after schema validation; no tainted provider fields cross the seam.
 * @complexity Time/space O(token bytes), capped again by the 64 KiB sealer boundary.
 */
export function parseTokens(required: { value: unknown }): Outcome<StoredOAuthTokens> {
  const parsed = tokenSchema.safeParse(required.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data as StoredOAuthTokens };
}

/** Validate Jini's opaque ID token, then discard it before the unchanged stored-token parser.
 * No identity is inferred and no ID token is sealed or returned to callers.
 * @complexity Time/space O(token bytes), bounded fields and a 64 KiB HTTP response cap.
 * @example parseUpstreamTokens({ value: normalizedTokens })
 */
export function parseUpstreamTokens(required: { value: unknown }): Outcome<StoredOAuthTokens> {
  const parsed = upstreamTokenSchema.safeParse(required.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const { idToken: _idToken, ...stored } = parsed.data;
  return parseTokens({ value: stored });
}

/** Convert thrown Jini errors to safe OM values without exposing message, URL or cause.
 * @complexity O(1) plus injected protocol work; no automatic retry.
 */
export async function jiniBoundary<T>(required: { run: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  try {
    const outcome = await required.run();
    if (outcome.ok) return outcome;
    const parsed = appErrorSchema.shape.code.safeParse(outcome.error.code);
    return failure({ code: parsed.success ? parsed.data : "unavailable" });
  }
  catch (error) {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    if (!(error instanceof OAuthError)) return failure({ code: "unavailable" });
    return failure({ code: mappedOAuthError({ code: error.code }) });
  }
}

/** Terminal grant errors request reconnect; transient transport errors retain stored status.
 * @complexity O(1) time/space.
 */
function mappedOAuthError(required: { code: OAuthError["code"] }): import("@open-marketing/contracts").AppError["code"] {
  switch (required.code) {
    case "OAUTH_INVALID_GRANT": case "OAUTH_ACCESS_DENIED": case "OAUTH_EXPIRED_TOKEN": return "unauthenticated";
    case "OAUTH_INVALID_STATE": return "expired";
    case "OAUTH_UNSAFE_ENDPOINT": return "forbidden";
    case "OAUTH_INVALID_REQUEST": case "OAUTH_UNSUPPORTED_GRANT": return "invalid_input";
    case "OAUTH_MALFORMED_RESPONSE": return "protocol_mismatch";
    default: return "unavailable";
  }
}

/** Narrow foreign HTTP callback: propagate cancellation and correlated metadata only.
 * The injected fetch must enforce the guard's connection-time DNS policy and timeout.
 * @complexity O(headers) time/space; one request, zero retries, no body logging.
 */
export function correlatedFetch(required: { dependencies: JiniOAuthDependencies; context: CallContext; expiry: { refreshExpiresAt?: string } }, optional?: CallOptions): OAuthFetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-om-correlation-id", required.context.correlationId);
    headers.set("x-om-trace-id", required.context.traceId);
    if (required.context.runId) headers.set("x-om-run-id", required.context.runId);
    const signals = [init?.signal, optional?.signal].filter((signal): signal is AbortSignal => !!signal);
    try {
      const response = await required.dependencies.fetchFn(input, { ...init, headers, signal: AbortSignal.any(signals) });
      observeOAuth({ dependencies: required.dependencies, context: required.context, succeeded: response.ok });
      if (!response.ok) return response;
      return captureTokenExpiry({ response, expiry: required.expiry, now: required.dependencies.clock.now({}) });
    } catch (error) {
      observeOAuth({ dependencies: required.dependencies, context: required.context, succeeded: false });
      throw error;
    }
  };
}

/** Jini drops refresh lifetime fields. Inspect a bounded request-local stream before normalization.
 * Foreign stream callbacks are the TransformStream ABI; no token data leaves this request.
 * @complexity O(response bytes) time/space, cap 64 KiB; overflow/malformed lifetime throws a redacted OAuth error.
 */
function captureTokenExpiry(required: { response: Response; expiry: { refreshExpiresAt?: string }; now: number }): Response {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const body = required.response.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > 65536) throw new OAuthError({ code: "OAUTH_MALFORMED_RESPONSE", message: "Invalid token response", operatorAction: "Reconnect the account" });
      chunks.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      try {
        const parsed = z.object({ refresh_token_expires_in: z.number().int().nonnegative().max(3155760000).optional() }).parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        if (parsed.refresh_token_expires_in !== undefined) required.expiry.refreshExpiresAt = new Date(required.now + parsed.refresh_token_expires_in * 1000).toISOString();
      } catch { throw new OAuthError({ code: "OAUTH_MALFORMED_RESPONSE", message: "Invalid token lifetime", operatorAction: "Reconnect the account" }); }
    },
  }));
  return new Response(body, { status: required.response.status, headers: required.response.headers });
}

/** Metadata-only telemetry cannot alter authorization or leak exceptions/payloads.
 * @complexity O(1) time/space.
 */
function observeOAuth(required: { dependencies: JiniOAuthDependencies; context: CallContext; succeeded: boolean }): void {
  try {
    required.dependencies.observer?.observe({ operation: "credentials.oauth.http", outcome: required.succeeded ? "succeeded" : "failed", correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId });
  } catch { /* Observer is non-authoritative. */ }
}

/** Bound configured HTTP timeout. Caller cancellation propagates separately through fetch.
 * @complexity O(1) time/space.
 */
export function oauthTimeout(required: { dependencies: JiniOAuthDependencies }): Outcome<number> {
  const configured = required.dependencies.timeoutMs ?? 15000;
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 15000) return failure({ code: "invalid_input" });
  return { ok: true, value: configured };
}
