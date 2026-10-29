import { createHash } from "node:crypto";
import { signSigV4 } from "@jini-ai/platform";
import type { AppError, CallOptions, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import { accountSchema, configurationSchema, identitySchema, invocationSchema, sesCredentialSchema } from "./commands.js";
import type { SesCommand, SesCredentials, SesData } from "./commands.js";
import type { AmazonSesAdapter, SesConfiguration, SesDependencies, SesInvocation, SesResult, SesWireRequest } from "./ports.js";

/** Inert factory. Validation precedes credentials and gateway; errors never expose secrets.
 * @param required - Server configuration and injected broker, gateway, fetch, clock, observer.
 * @returns Read adapter with typed failures; at most one signed GET per invocation.
 * @example createAmazonSesAdapter({ configuration, credentials, gateway, fetch: hostFetch, clock, observer })
 * @complexity O(b) time/space per invocation, b<=1MiB response, 10s timeout, zero retries.
 */
export function createAmazonSesAdapter(required: SesDependencies): AmazonSesAdapter {
  return { async invoke(input, options) {
    if (options?.signal?.aborted) return failure({ code: "cancelled" });
    const invocation = invocationSchema.safeParse(input);
    const config = configurationSchema.safeParse(required.configuration);
    if (!invocation.success || !config.success) return failure({ code: "invalid_input" });
    const scope = invocation.data.context.scope;
    if (scope.ownerId !== config.data.scope.ownerId || scope.workspaceId !== config.data.scope.workspaceId) return failure({ code: "forbidden" });
    return dispatch({ dependencies: required, configuration: config.data, input: invocation.data }, options);
  } };
}

/** Server authority sees the exact region/domain-bound request digest. Credentials resolve first.
 * @complexity O(1) work; one broker lookup, one host dispatch and at most one GET.
 */
async function dispatch(required: { dependencies: SesDependencies; configuration: SesConfiguration; input: SesInvocation }, optional?: CallOptions): Promise<Outcome<SesResult>> {
  const { dependencies, configuration, input } = required;
  const path = input.command.kind === "account_status" ? "/v2/email/account" : "/v2/email/identities/" + configuration.domainIdentity;
  const request: SesWireRequest = Object.freeze({ method: "GET", url: "https://email." + configuration.region + ".amazonaws.com" + path });
  const effect: EffectEnvelope = { operationId: input.operationId, connectionId: configuration.connectionId, accountId: null,
    effects: ["read"], argumentsDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"), moneyExposure: null, requiredLimit: null };
  let result: Outcome<SesResult>;
  try {
    const credential = await dependencies.credentials.access({ connectionId: configuration.connectionId }, optional);
    const parsed = sesCredentialSchema.safeParse(credential.ok ? credential.value : null);
    if (!parsed.success) result = failure({ code: "unauthenticated" });
    else if (parsed.data.region !== configuration.region) result = failure({ code: "forbidden" });
    else result = await authorize({ dependencies, configuration, input, request, effect, credential: parsed.data }, optional);
  } catch { result = failure({ code: "unavailable" }); }
  observe({ dependencies, input, result });
  return result;
}

/** The zero-argument execute callback is the host ABI; prevent repeated execution within a dispatch.
 * @complexity O(1); host owns current authority and durable audit, no local policy/registry.
 */
async function authorize(required: { dependencies: SesDependencies; configuration: SesConfiguration; input: SesInvocation;
  request: SesWireRequest; effect: EffectEnvelope; credential: SesCredentials }, optional?: CallOptions): Promise<Outcome<SesResult>> {
  let executed = false;
  return required.dependencies.gateway.dispatch({ context: structuredClone(required.input.context),
    configuration: structuredClone(required.configuration), operation: required.input.command.kind,
    request: required.request, effect: structuredClone(required.effect), execute: async () => {
      if (executed) return failure({ code: "conflict" });
      if (optional?.signal?.aborted) return failure({ code: "cancelled" });
      executed = true;
      return requestSes(required, optional);
    } }, optional);
}

/** Sign immediately before egress, always using injected time; fixed host, redirects rejected.
 * @complexity O(b) time/space, one 10s request, b<=1MiB; no internal retries.
 */
async function requestSes(required: { dependencies: SesDependencies; configuration: SesConfiguration; input: SesInvocation;
  request: SesWireRequest; credential: SesCredentials }, optional?: CallOptions): Promise<Outcome<SesResult>> {
  const now = required.dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) return failure({ code: "invalid_input" });
  const url = new URL(required.request.url);
  const headers: Record<string, string> = { host: url.host };
  signSigV4({ method: "GET", path: url.pathname, query: "", headers, body: Buffer.alloc(0),
    region: required.configuration.region, service: "ses", credentials: required.credential, now: new Date(now) });
  const deadline = AbortSignal.timeout(10000);
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  try {
    const response = await required.dependencies.fetch(url.href, { method: "GET", headers, redirect: "error", signal });
    if (response.status !== 200) {
      await response.body?.cancel();
      return failure({ code: responseCode({ status: response.status }) });
    }
    const body = await readBody({ response });
    // Body parsing catches stream errors; preserve caller cancellation and deadline classification.
    signal.throwIfAborted();
    if (!body.ok) return body;
    const data = decode({ kind: required.input.command.kind, configuration: required.configuration, body: body.value });
    if (!data.ok) return data;
    return { ok: true, value: { operationId: required.input.operationId, status: "succeeded", data: data.value } };
  } catch {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    return failure({ code: "unavailable" });
  }
}

/** Discard all provider error text. Read errors are explicit and never automatically retried. */
function responseCode(required: { status: number }): AppError["code"] {
  switch (required.status) {
    case 401: return "unauthenticated";
    case 403: return "forbidden";
    case 429: return "limit_exceeded";
    default: return "unavailable";
  }
}

/** Count streamed bytes before JSON decoding, ignoring untrusted Content-Length. @complexity O(b), b<=1MiB. */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.body) return failure({ code: "protocol_mismatch" });
  const reader = required.response.body.getReader();
  const buffer = Buffer.alloc(1048576);
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (part.value.byteLength > buffer.length - bytes) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      buffer.set(part.value, bytes);
      bytes += part.value.byteLength;
    }
    return { ok: true, value: JSON.parse(buffer.toString("utf8", 0, bytes)) as unknown };
  } catch { return failure({ code: "protocol_mismatch" }); }
  finally { reader.releaseLock(); }
}

/** Project only validated fields. Domain readiness is verification/DKIM only, never send authority.
 * @complexity O(b) schema traversal, b<=1MiB; token list bounded to ten.
 */
function decode(required: { kind: SesCommand["kind"]; configuration: SesConfiguration; body: unknown }): Outcome<SesData> {
  switch (required.kind) {
    case "account_status": {
      const parsed = accountSchema.safeParse(required.body);
      if (!parsed.success) return failure({ code: "protocol_mismatch" });
      const data = parsed.data;
      return { ok: true, value: { kind: required.kind, sendingEnabled: data.SendingEnabled, productionAccessEnabled: data.ProductionAccessEnabled,
        quota: { max24HourSend: data.SendQuota.Max24HourSend, maxSendRate: data.SendQuota.MaxSendRate,
          sentLast24Hours: data.SendQuota.SentLast24Hours, remaining24HourSend: data.SendQuota.Max24HourSend === -1
            ? "unlimited" : Math.max(0, data.SendQuota.Max24HourSend - data.SendQuota.SentLast24Hours) },
        currentPlan: data.PricingAttributes?.CurrentPlan ?? null, nextPlan: data.PricingAttributes?.NextPlan ?? null } };
    }
    case "domain_identity_status": {
      const parsed = identitySchema.safeParse(required.body);
      if (!parsed.success) return failure({ code: "protocol_mismatch" });
      const data = parsed.data;
      return { ok: true, value: { kind: required.kind, domainIdentity: required.configuration.domainIdentity,
        verifiedForSending: data.VerifiedForSendingStatus, verificationStatus: data.VerificationStatus ?? "UNKNOWN",
        dkimStatus: data.DkimAttributes?.Status ?? "UNKNOWN", dkimSigningEnabled: data.DkimAttributes?.SigningEnabled ?? false,
        dkimTokens: data.DkimAttributes?.Tokens ?? [], domainReady: domainReady({ data }) } };
    }
    default: { const exhaustive: never = required.kind; return exhaustive; }
  }
}
/** Fail closed for incomplete/unknown status evidence; does not evaluate marketing consent. */
export function domainReady(required: { data: ReturnType<typeof identitySchema.parse> }): boolean {
  const data = required.data;
  return data.IdentityType === "DOMAIN" && data.VerifiedForSendingStatus && data.VerificationStatus === "SUCCESS"
    && data.DkimAttributes?.SigningEnabled === true && data.DkimAttributes.Status === "SUCCESS";
}
/** Stable redacted failures, never raw broker/provider messages. */
function failure(required: { code: AppError["code"] }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Amazon SES request " + required.code, retryable: false } };
}
/** Correlation/outcome only. Telemetry failure must not replace a completed read result. */
function observe(required: { dependencies: SesDependencies; input: SesInvocation; result: Outcome<SesResult> }): void {
  const context = required.input.context;
  try { required.dependencies.observer.observe({ operation: "amazon-ses." + required.input.command.kind,
    outcome: required.result.ok ? "succeeded" : required.result.error.code,
    correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Host egress audit is authoritative. */ }
}
