import { z } from "zod";
import { callContextSchema, digestSchema, effectEnvelopeSchema, epochSchema, haltStopRequestSchema, idSchema, parseBoundary, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, EffectEnvelope, HaltStopPermit, Outcome } from "@open-marketing/contracts";
import { encodeLinkedInCommand, invocationSchema, linkedInDigest, vendorIdSchema } from "./commands.js";
import type { LinkedInCommand } from "./commands.js";
import type { LinkedInAdsAdapter, LinkedInConfiguration, LinkedInDependencies, LinkedInInvocation, LinkedInResult, LinkedInStopInput, LinkedInWireRequest } from "./ports.js";
import { decodeLinkedInReport } from "./reporting.js";

/** Internal binding parser shared by interactive calls and the backend conversion consumer. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), apiVersion: z.literal("202609"), pluginDigest: digestSchema, bindingId: idSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const permitSchema = z.strictObject({ kind: z.literal("halt-stop"), request: haltStopRequestSchema, expiresAt: epochSchema });
const stopSchema = z.strictObject({ context: callContextSchema, request: haltStopRequestSchema, permit: permitSchema });
const providerId = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const state = z.enum(["ACTIVE", "PAUSED", "DRAFT", "ARCHIVED", "CANCELED", "CANCELLED", "COMPLETED", "PENDING_DELETION", "REMOVED"]);
const urn = z.string().regex(/^urn:li:[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9_-]{1,128}$/);
const accountUrn = z.string().regex(/^urn:li:sponsoredAccount:[1-9][0-9]{0,18}$/);
const campaignUrn = z.string().regex(/^urn:li:sponsoredCampaign:[1-9][0-9]{0,18}$/);
const groupUrn = z.string().regex(/^urn:li:sponsoredCampaignGroup:[1-9][0-9]{0,18}$/);
const creativeUrn = z.string().regex(/^urn:li:sponsoredCreative:[1-9][0-9]{0,18}$/);
const budget = z.object({ amount: z.string().regex(/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,6})?$/), currencyCode: z.string().regex(/^[A-Z]{3}$/) });
const runSchedule = z.object({ start: epochSchema, end: epochSchema.optional() });
const text = z.string().max(1024);
// Strip unconsumed provider fields, including arbitrary secrets or URLs. No raw result escapes.
const accountItem = z.object({ id: providerId, name: text, status: state, currency: z.string().regex(/^[A-Z]{3}$/), test: z.boolean().optional() });
const groupItem = z.object({ id: providerId, account: accountUrn, name: text, status: state, totalBudget: budget.optional(), runSchedule: runSchedule.optional(), servingStatuses: z.array(text).max(32).optional() });
const campaignItem = z.object({ id: providerId, account: accountUrn, campaignGroup: groupUrn, name: text, status: state, dailyBudget: budget.optional(), runSchedule: runSchedule.optional(), servingStatuses: z.array(text).max(32).optional() });
const creativeItem = z.object({ id: creativeUrn, account: accountUrn, campaign: campaignUrn, intendedStatus: state, isServing: z.boolean(), servingHoldReasons: z.array(text).max(32).optional(), content: z.object({ reference: urn }).optional() });
const targetingItem = z.object({ urn, facetUrn: z.string().regex(/^urn:li:adTargetingFacet:[A-Za-z]+$/), name: text });
const pagination = z.object({ nextPageToken: z.string().min(1).max(2048).regex(/^[^\x00-\x1f\x7f]+$/).nullable().optional() });
const conversionItem = z.object({ id: providerId, account: accountUrn, name: text, type: text, conversionMethod: text, enabled: z.boolean(), ownershipType: z.enum(["OWNED", "SHARED"]).optional() });
const leadItem = z.object({ id: providerId, owner: z.object({ sponsoredAccount: accountUrn }), name: text, state: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]), versionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const offsetPaging = z.object({ start: z.number().int().min(0).max(1000000), count: z.number().int().min(1).max(100) });
interface Prepared { configuration: LinkedInConfiguration; invocation: LinkedInInvocation; request: LinkedInWireRequest; effect: EffectEnvelope; permit?: HaltStopPermit }
type Credential = z.infer<typeof credentialSchema>;

/** Inert adapter sharing bounded transport with the server-only conversion backend.
 * @param required - Server binding, policy/outbox gateway, token broker and injected fetch/clock/observer.
 * @returns Invoke and campaign-only halt stop; typed denials, ACKs or unknown writes; no retries.
 * @example createLinkedInAdsAdapter({ configuration, gateway, credentials, fetch: hostFetch, clock, observer })
 * @complexity O(b) time/space, 64KiB input, 1MiB response, at most one 15s vendor call per invocation.
 */
export function createLinkedInAdsAdapter(required: LinkedInDependencies): LinkedInAdsAdapter {
  const dependencies = { ...required, configuration: structuredClone(required.configuration) };
  return {
    async invoke(input, options) {
      const prepared = prepareInvocation({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      return dispatch({ dependencies, prepared: prepared.value }, options);
    },
    async stop(input, options) {
      const prepared = prepareStop({ dependencies, input }, options);
      if (!prepared.ok) return prepared;
      return dispatch({ dependencies, prepared: prepared.value }, options);
    },
  };
}

/** Validate the entire request and binding before any I/O; serialize the reviewed bytes once. @complexity O(b). */
function prepareInvocation(required: { dependencies: LinkedInDependencies; input: LinkedInInvocation }, optional?: CallOptions): Outcome<Prepared> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const invocation = parseBoundary({ schema: invocationSchema, input: bounded.value });
  if (!invocation.ok) return invocation;
  const configuration = parseBoundary({ schema: configurationSchema, input: required.dependencies.configuration });
  if (!configuration.ok) return configuration;
  if (!sameScope({ first: invocation.value.context.scope, second: configuration.value.scope })) return failure({ code: "forbidden" });
  const encoded = encodeLinkedInCommand({ input: invocation.value.command, accountId: configuration.value.accountId, currency: configuration.value.currency });
  if (!encoded.ok) return encoded;
  const effect: EffectEnvelope = {
    operationId: invocation.value.operationId, connectionId: configuration.value.connectionId, accountId: configuration.value.accountId,
    effects: [encoded.value.effect], argumentsDigest: linkedInDigest({ value: { apiVersion: configuration.value.apiVersion, request: encoded.value.request } }),
    moneyExposure: invocation.value.moneyExposure, requiredLimit: invocation.value.requiredLimit,
  };
  const checked = checkSpendMetadata({ effect, currency: configuration.value.currency });
  if (!checked.ok) return checked;
  return { ok: true, value: { configuration: configuration.value, invocation: invocation.value, request: encoded.value.request, effect } };
}

/** Use the existing exact-card contract; never add another exposure-evidence approval gate. @complexity O(1). */
function checkSpendMetadata(required: { effect: EffectEnvelope; currency: string }): Outcome<void> {
  if (!required.effect.effects.includes("ad_spend")) return { ok: true, value: undefined };
  if (required.effect.moneyExposure === null || required.effect.requiredLimit === null) return failure({ code: "invalid_input" });
  if (required.effect.moneyExposure.amount.currency !== required.currency || required.effect.requiredLimit.amount.currency !== required.currency) return failure({ code: "invalid_input" });
  const parsed = parseBoundary({ schema: effectEnvelopeSchema, input: required.effect });
  if (!parsed.ok) return parsed;
  return { ok: true, value: undefined };
}

/** One safety-issued campaign stop, never a loop or generic updater. Request digest uses safety's
 * {adAccountId,entityIds,action} format; the gateway also sees the exact encoded vendor request.
 * @complexity O(b) bounded envelope validation; no effects.
 */
function prepareStop(required: { dependencies: LinkedInDependencies; input: LinkedInStopInput }, optional?: CallOptions): Outcome<Prepared> {
  const bounded = boundInput({ input: required.input });
  if (!bounded.ok) return bounded;
  const parsed = parseBoundary({ schema: stopSchema, input: bounded.value });
  if (!parsed.ok) return parsed;
  const { request, permit } = parsed.value;
  if (request.entityIds.length !== 1 || !vendorIdSchema.safeParse(request.entityIds[0]).success) return failure({ code: "invalid_input" });
  if (linkedInDigest({ value: request }) !== linkedInDigest({ value: permit.request })) return failure({ code: "conflict" });
  if (request.argumentsDigest !== linkedInDigest({ value: { adAccountId: request.adAccountId, entityIds: request.entityIds, action: request.action } })) return failure({ code: "conflict" });
  const prepared = prepareInvocation({ dependencies: required.dependencies, input: { context: parsed.value.context, operationId: request.operationId, command: { kind: "pause", campaignId: request.entityIds[0] }, moneyExposure: null, requiredLimit: null } }, optional);
  if (!prepared.ok) return prepared;
  if (!stopBindingMatches({ prepared: prepared.value, input: parsed.value })) return failure({ code: "forbidden" });
  if (!permitCurrent({ permit, now: required.dependencies.clock.now({}) })) return failure({ code: "expired" });
  return { ok: true, value: { ...prepared.value, permit, effect: { ...prepared.value.effect, effects: ["halt_stop"], argumentsDigest: request.argumentsDigest } } };
}

function stopBindingMatches(required: { prepared: Prepared; input: LinkedInStopInput }): boolean {
  const configuration = required.prepared.configuration;
  const request = required.input.request;
  return sameScope({ first: request.scope, second: configuration.scope }) && request.adAccountId === configuration.accountId && request.connectionId === configuration.connectionId && request.pluginDigest === configuration.pluginDigest && request.bindingId === configuration.bindingId;
}
function sameScope(required: { first: LinkedInConfiguration["scope"]; second: LinkedInConfiguration["scope"] }): boolean { return required.first.ownerId === required.second.ownerId && required.first.workspaceId === required.second.workspaceId; }
function permitCurrent(required: { permit: HaltStopPermit; now: number }): boolean { return Number.isSafeInteger(required.now) && required.now >= 0 && required.now < required.permit.expiresAt; }

/** Catch tainted JSON at the boundary, including cycles, before reaching schemas. @complexity O(b), <=64KiB. */
export function boundInput(required: { input: unknown }): Outcome<unknown> {
  try {
    const serialized = JSON.stringify(required.input);
    if (serialized === undefined || Buffer.byteLength(serialized) > 65536) return failure({ code: "limit_exceeded" });
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Resolve the token before final server checks. The callback is guarded against a second send
 * within one dispatch; durable repeated-call identity belongs to the host's ONE jobs outbox.
 * @complexity O(b), one credential lookup and one fenced request; no internal retry.
 */
async function dispatch(required: { dependencies: LinkedInDependencies; prepared: Prepared }, optional?: CallOptions): Promise<Outcome<LinkedInResult>> {
  const { dependencies, prepared } = required;
  let sent = false;
  let result: Outcome<LinkedInResult>;
  try {
    const credential = await resolveCredential({ credentials: dependencies.credentials, configuration: prepared.configuration }, optional);
    if (!credential.ok) result = credential;
    else result = await dependencies.gateway.dispatch({
      context: prepared.invocation.context, configuration: prepared.configuration, operation: prepared.invocation.command.kind,
      request: Object.freeze({ ...prepared.request }), effect: structuredClone(prepared.effect), permit: prepared.permit,
      execute: async () => {
        if (sent) return failure({ code: "conflict" });
        const checked = checkBeforeEgress({ dependencies, prepared, credential: credential.value }, optional);
        if (!checked.ok) return checked;
        sent = true;
        return sendRequest({ dependencies, prepared, credential: credential.value }, optional);
      },
    }, optional);
  } catch { result = uncertain({ prepared, sent }); }
  observe({ dependencies, prepared, result });
  return result;
}

/** No broker errors or token content leak. Missing expiry means host-managed expiry, not infinity. @complexity O(1). */
export async function resolveCredential(required: { credentials: LinkedInDependencies["credentials"]; configuration: Pick<LinkedInConfiguration, "connectionId" | "accountId"> }, optional?: CallOptions): Promise<Outcome<Credential>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const result = await required.credentials.access({ connectionId: required.configuration.connectionId, accountId: required.configuration.accountId }, optional);
  if (!result.ok) return failure({ code: result.error.code });
  return parseBoundary({ schema: credentialSchema, input: result.value });
}

/** Recheck cancellation, token expiry and stop expiry at the actual fetch boundary. @complexity O(1). */
function checkBeforeEgress(required: { dependencies: LinkedInDependencies; prepared: Prepared; credential: Credential }, optional?: CallOptions): Outcome<void> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = required.dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (required.credential.expiresAt !== undefined && now >= required.credential.expiresAt) return failure({ code: "expired" });
  if (required.prepared.permit && !permitCurrent({ permit: required.prepared.permit, now })) return failure({ code: "expired" });
  return { ok: true, value: undefined };
}

/** Fixed HTTPS origin, no redirect, 15s deadline, <=64KiB request and <=1MiB streamed response.
 * Failure after fetch begins is unknown for writes. Neither vendor errors nor secrets escape.
 * @complexity O(b) time/space, b<=1MiB, one fetch and zero retries.
 */
async function sendRequest(required: { dependencies: LinkedInDependencies; prepared: Prepared; credential: Credential }, optional?: CallOptions): Promise<Outcome<LinkedInResult>> {
  const { dependencies, prepared, credential } = required;
  const response = await requestLinkedIn({ fetch: dependencies.fetch, request: prepared.request, credential, apiVersion: prepared.configuration.apiVersion }, optional);
  if (!response.ok) return response.error.code === "unavailable" ? uncertain({ prepared, sent: true }) : response;
  return decodeResponse({ prepared, response: response.value.response, body: response.value.body, retrievedAt: dependencies.clock.now({}) });
}

/** Internal shared fetch edge for interactive calls and CAPI. Bounded streams and headers remain
 * vendor-owned; callers check current authority immediately before entering this synchronous preflight.
 * @complexity O(b) time/space, b<=1MiB; one request, no redirect or retry.
 */
export async function requestLinkedIn(required: { fetch: typeof fetch; request: LinkedInWireRequest; credential: Credential; apiVersion: "202609" }, optional?: CallOptions): Promise<Outcome<{ response: Response; body: unknown }>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (Buffer.byteLength(required.request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const deadline = AbortSignal.timeout(15000);
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  try {
    const response = await required.fetch(required.request.url, {
      method: required.request.method, body: required.request.body, redirect: "error", signal,
      headers: { Authorization: "Bearer " + required.credential.accessToken, "LinkedIn-Version": required.apiVersion,
        "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json",
        ...(required.request.method === "GET" && !required.request.url.includes("?") ? {} : { "X-RestLi-Method": required.request.restliMethod }) },
    });
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      return vendorRejection({ status: response.status });
    }
    const body = await readBody({ response });
    if (!body.ok) return failure({ code: "unavailable" });
    return { ok: true, value: { response, body: body.value } };
  } catch { return failure({ code: "unavailable" }); }
}

/** Documented client rejections remain typed failures; no retry, including 429. @complexity O(1). */
function vendorRejection(required: { status: number }): Outcome<never> {
  switch (required.status) {
    case 401: return failure({ code: "unauthenticated" });
    case 403: return failure({ code: "forbidden" });
    case 409: return failure({ code: "conflict" });
    case 429: return failure({ code: "limit_exceeded" });
    default: return failure({ code: "invalid_input" });
  }
}

/** Consume bytes before parsing; never trust Content-Length or provider links. @complexity O(b), b<=1MiB. */
async function readBody(required: { response: Response }): Promise<Outcome<unknown>> {
  if (!required.response.body) return { ok: true, value: null };
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1048576) { await reader.cancel(); return failure({ code: "limit_exceeded" }); }
      chunks.push(chunk.value);
    }
    if (bytes === 0) return { ok: true, value: null };
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } finally { reader.releaseLock(); }
}

/** Documented create ACKs and 204 patches are acknowledged; group IDs stay candidates.
 * Nothing proves serving state. @complexity O(b). */
function decodeResponse(required: { prepared: Prepared; response: Response; body: unknown; retrievedAt: number }): Outcome<LinkedInResult> {
  const { prepared, response } = required;
  if (prepared.invocation.command.kind === "report") return decodeReportResponse({ ...required, command: prepared.invocation.command });
  if (prepared.effect.effects.includes("read")) return decodeList({ prepared, status: response.status, body: required.body });
  return decodeWriteResponse(required);
}
/** Analytics has a separate schema and source/time semantics from entity pages. @complexity O(n*m), n,m<=100. */
function decodeReportResponse(required: { prepared: Prepared; response: Response; body: unknown; retrievedAt: number; command: Extract<LinkedInCommand, { kind: "report" }> }): Outcome<LinkedInResult> {
  if (required.response.status !== 200) return failure({ code: "unavailable" });
  const report = decodeLinkedInReport({ input: required.body, command: required.command, ...required.prepared.configuration, retrievedAt: required.retrievedAt });
  return report.ok ? result({ prepared: required.prepared, status: "succeeded", data: report.value }) : report;
}
/** Only documented ACKs identify completed writes; no serving/attribution inference. @complexity O(1). */
function decodeWriteResponse(required: { prepared: Prepared; response: Response }): Outcome<LinkedInResult> {
  const { prepared, response } = required;
  if (["PARTIAL_UPDATE", "UPDATE"].includes(prepared.request.restliMethod) && response.status === 204) return result({ prepared, status: "acknowledged", data: null });
  if (prepared.request.restliMethod !== "CREATE" || response.status !== 201) return uncertain({ prepared, sent: true });
  const schema = ["create_creative_paused", "create_creative_draft"].includes(prepared.invocation.command.kind) ? creativeUrn : vendorIdSchema;
  const created = schema.safeParse(response.headers.get("x-restli-id"));
  if (!created.success) return uncertain({ prepared, sent: true });
  // The group endpoint does not document its ACK; retain the candidate for scoped readback.
  if (prepared.invocation.command.kind === "create_campaign_group_draft") return result({ prepared, status: "unknown", data: { id: created.data } });
  return result({ prepared, status: "acknowledged", data: { id: created.data } });
}

/** Validate a page atomically. A foreign account or unrequested ID rejects the whole result.
 * Only cursor tokens are returned; provider URLs are stripped and never followed.
 * @complexity O(n*m) time for requested-ID membership, n,m<=100, O(n) space.
 */
function decodeList(required: { prepared: Prepared; status: number; body: unknown }): Outcome<LinkedInResult> {
  if (required.status !== 200) return failure({ code: "unavailable" });
  const command = required.prepared.invocation.command;
  if (command.kind === "list_lead_forms") return decodeLeadForms({ ...required, command });
  const schema = listSchema({ kind: command.kind });
  const parsed = schema.safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const checked = checkListBindings({ items: parsed.data.elements, command, accountId: required.prepared.configuration.accountId });
  if (!checked.ok) return checked;
  const nextPageToken = parsed.data.metadata?.nextPageToken ?? null;
  return result({ prepared: required.prepared, status: "succeeded", data: { items: parsed.data.elements, nextPageToken } });
}

/** Separate schemas strip provider additions while enforcing consumed field shapes. @complexity O(1) selection. */
function listSchema(required: { kind: LinkedInCommand["kind"] }): z.ZodType<{ elements: Record<string, unknown>[]; metadata?: { nextPageToken?: string | null } }> {
  switch (required.kind) {
    case "list_accounts": return z.object({ elements: z.array(accountItem).max(100), metadata: pagination.optional() });
    case "list_campaign_groups": return z.object({ elements: z.array(groupItem).max(100), metadata: pagination.optional() });
    case "list_campaigns": return z.object({ elements: z.array(campaignItem).max(100), metadata: pagination.optional() });
    case "list_creatives": return z.object({ elements: z.array(creativeItem).max(100), metadata: pagination.optional() });
    case "list_conversion_rules": return z.object({ elements: z.array(conversionItem).max(100) });
    default: return z.object({ elements: z.array(targetingItem).max(100), metadata: pagination.optional() });
  }
}

/** Return metadata only and a bounded explicit offset hint, never lead responses or provider URLs.
 * @complexity O(n) time/space, n<=100. Partial invalid/foreign/duplicate pages reject atomically.
 */
function decodeLeadForms(required: { prepared: Prepared; body: unknown; command: Extract<LinkedInCommand, { kind: "list_lead_forms" }> }): Outcome<LinkedInResult> {
  const parsed = z.object({ elements: z.array(leadItem).max(required.command.count ?? 100), paging: offsetPaging }).safeParse(required.body);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  if (parsed.data.paging.start !== (required.command.start ?? 0) || parsed.data.paging.count !== (required.command.count ?? 100)) return failure({ code: "protocol_mismatch" });
  if (parsed.data.elements.some(item => item.owner.sponsoredAccount !== "urn:li:sponsoredAccount:" + required.prepared.configuration.accountId)) return failure({ code: "forbidden" });
  const keys = parsed.data.elements.map(item => item.id);
  if (new Set(keys).size !== keys.length) return failure({ code: "protocol_mismatch" });
  const next = parsed.data.paging.start + parsed.data.paging.count;
  return result({ prepared: required.prepared, status: "succeeded", data: { items: parsed.data.elements, nextStart: keys.length === parsed.data.paging.count && next <= 1000000 ? next : null } });
}

/** Reject inconsistent pages without partially exposing another account's records. @complexity O(n*m), n,m<=100. */
function checkListBindings(required: { items: Record<string, unknown>[]; command: LinkedInCommand; accountId: string }): Outcome<void> {
  const { command, items } = required;
  if ("pageSize" in command && items.length > (command.pageSize ?? 100)) return failure({ code: "protocol_mismatch" });
  const keys = items.map(item => String(item.id ?? item.urn));
  if (new Set(keys).size !== keys.length) return failure({ code: "protocol_mismatch" });
  if (items.some(item => item.account !== undefined && item.account !== "urn:li:sponsoredAccount:" + required.accountId)) return failure({ code: "forbidden" });
  if ("ids" in command && command.ids && keys.some(key => !command.ids?.includes(key.split(":").at(-1) ?? ""))) return failure({ code: "protocol_mismatch" });
  if (command.kind === "search_targeting" && items.some(item => item.facetUrn !== "urn:li:adTargetingFacet:" + command.facet)) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: undefined };
}

function result(required: { prepared: Prepared; status: LinkedInResult["status"]; data: unknown }): Outcome<LinkedInResult> { return { ok: true, value: { operationId: required.prepared.invocation.operationId, status: required.status, data: required.data, observedState: "unknown" } }; }
function uncertain(required: { prepared: Prepared; sent: boolean }): Outcome<LinkedInResult> {
  if (!required.sent || required.prepared.effect.effects.includes("read")) return failure({ code: "unavailable" });
  return result({ prepared: required.prepared, status: "unknown", data: null });
}
export function failure(required: { code: AppError["code"] }): Outcome<never> { return { ok: false, error: { code: required.code, message: "LinkedIn request " + required.code, retryable: false } }; }

/** Correlation IDs/outcomes only; the server gateway owns durable pre-egress audit. @complexity O(1). */
function observe(required: { dependencies: LinkedInDependencies; prepared: Prepared; result: Outcome<LinkedInResult> }): void {
  const context = required.prepared.invocation.context;
  try {
    required.dependencies.observer.observe({ operation: "linkedin-ads." + required.prepared.invocation.command.kind,
      outcome: required.result.ok ? required.result.value.status : required.result.error.code,
      correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
  } catch { /* Telemetry failure cannot rewrite a vendor receipt; host audit is authoritative. */ }
}
