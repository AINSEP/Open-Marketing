import { OAuthError } from "@jini-ai/oauth";
import type { OAuthClient, OAuthFetch, OAuthProviderDescriptor, OAuthTokenSet, OAuthUrlGuard } from "@jini-ai/oauth";
import { z } from "zod";
import { appErrorSchema } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import type { CredentialObserverPort, SecretSealerPort } from "./ports.js";
import { failure } from "./rules.js";

/** Host-only plugin configuration. Never serialize clients into agent/UI configuration. */
export interface JiniOAuthProvider {
  readonly provider: OAuthProviderDescriptor;
  readonly client: OAuthClient;
  readonly resource?: string;
}

/** Published HTTP/URL ports must enforce DNS/egress policy; native global fetch is insufficient. */
export interface JiniOAuthDependencies {
  readonly providers: ReadonlyMap<string, JiniOAuthProvider>;
  readonly fetchFn: OAuthFetch;
  readonly guard: OAuthUrlGuard;
  readonly clock: ClockPort;
  readonly sealer: SecretSealerPort;
  readonly timeoutMs?: number;
  readonly observer?: CredentialObserverPort;
}

const scopesSchema = z.array(z.string().min(1).max(128).regex(/^[\x21\x23-\x5b\x5d-\x7e]+$/)).max(64);
const authSchema = z.enum(["none", "client_secret_post", "client_secret_basic"]);
const providerSchema = z.strictObject({
  provider: z.strictObject({ providerId: z.string().min(1).max(128), label: z.string().min(1).max(256), supportedGrants: z.array(z.enum(["authorization_code", "device_code"])).max(2), authorizationEndpoint: z.string().url().max(2048).optional(), tokenEndpoint: z.string().url().max(2048), deviceAuthorizationEndpoint: z.string().url().max(2048).optional(), defaultScopes: scopesSchema, usesPkce: z.literal(true), clientAuth: authSchema }),
  client: z.strictObject({ clientId: z.string().min(1).max(2048), clientSecret: z.string().min(1).max(8192).optional(), authMethod: authSchema }),
  resource: z.string().url().max(2048).optional(),
});
const tokenSchema = z.strictObject({ accessToken: z.string().min(1).max(32768), refreshToken: z.string().min(1).max(32768).nullable(), tokenType: z.string().regex(/^Bearer$/i), scopes: scopesSchema, expiresAt: z.iso.datetime().nullable() });

/** Validate plugin configuration before protocol effects. Unknown plugins fail closed.
 * @complexity Time/space O(config bytes), with bounded scopes and field lengths.
 */
export function resolveProvider(required: { providers: ReadonlyMap<string, JiniOAuthProvider>; pluginId: string }): Outcome<JiniOAuthProvider> {
  const candidate = required.providers.get(required.pluginId);
  if (!candidate) return failure({ code: "unavailable" });
  const parsed = providerSchema.safeParse(candidate);
  if (!parsed.success) return failure({ code: "invalid_input" });
  if (parsed.data.client.authMethod !== parsed.data.provider.clientAuth) return failure({ code: "invalid_input" });
  if (parsed.data.client.authMethod !== "none" && !parsed.data.client.clientSecret) return failure({ code: "invalid_input" });
  return { ok: true, value: parsed.data };
}

/** Brand expiry only after schema validation; no tainted provider fields cross the seam.
 * @complexity Time/space O(token bytes), capped again by the 64 KiB sealer boundary.
 */
export function parseTokens(required: { value: unknown }): Outcome<OAuthTokenSet> {
  const parsed = tokenSchema.safeParse(required.value);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: parsed.data as OAuthTokenSet };
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
export function correlatedFetch(required: { dependencies: JiniOAuthDependencies; context: CallContext }, optional?: CallOptions): OAuthFetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("x-om-correlation-id", required.context.correlationId);
    headers.set("x-om-trace-id", required.context.traceId);
    if (required.context.runId) headers.set("x-om-run-id", required.context.runId);
    const signals = [init?.signal, optional?.signal].filter((signal): signal is AbortSignal => !!signal);
    try {
      const response = await required.dependencies.fetchFn(input, { ...init, headers, signal: AbortSignal.any(signals) });
      observeOAuth({ dependencies: required.dependencies, context: required.context, succeeded: response.ok });
      return response;
    } catch (error) {
      observeOAuth({ dependencies: required.dependencies, context: required.context, succeeded: false });
      throw error;
    }
  };
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
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 60000) return failure({ code: "invalid_input" });
  return { ok: true, value: configured };
}
