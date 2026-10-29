import { z } from "zod";
import { callContextSchema, digestSchema, effectEnvelopeSchema, epochSchema, idSchema, parseBoundary, parseExactIntegerJson, pluginConfigurationSchema, scopeSchema } from "@open-marketing/contracts";
import type { AppError, CallOptions, EffectEnvelope, Outcome, PluginCapabilityDependencies, PluginToolsFactory } from "@open-marketing/contracts";
import { encodeLinkedInCommand, invocationSchema, linkedInDigest, parseTool, vendorIdSchema } from "./commands.js";
import type { LinkedInCommand } from "./commands.js";
import type { LinkedInAdsAdapter, LinkedInConfiguration, LinkedInDependencies, LinkedInInvocation, LinkedInResult, LinkedInWireRequest } from "./ports.js";
import { decodeLinkedInReport } from "./reporting.js";

/** Version owned by the plugin. */
export const linkedInApiVersion = "202610" as const;

/** Internal binding parser shared by interactive calls and the backend conversion consumer. */
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema, accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), apiVersion: z.literal("202610"), pluginDigest: digestSchema, bindingId: idSchema });
const credentialSchema = z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/), expiresAt: epochSchema.optional() });
const providerId = z.union([vendorIdSchema, z.number().int().positive().max(Number.MAX_SAFE_INTEGER).transform(String)]);
const state = z.enum(["ACTIVE", "PAUSED", "DRAFT", "ARCHIVED", "CANCELED", "CANCELLED", "COMPLETED", "PENDING_DELETION", "REMOVED"]);
const urn = z.string().regex(/^urn:li:[A-Za-z][A-Za-z0-9]*:[A-Za-z0-9_-]{1,128}$/);
const creativeContentInput = z.object({ reference: urn.optional(), standardUpdateAd: z.object({ reference: urn }).optional(), videoAd: z.object({ reference: urn }).optional() });
/** Internal read projection for legacy and 202610 enriched content; no I/O or input mutation.
 * @param required - Tainted content object from a bounded creative response.
 * @returns One reference, or protocol_mismatch for missing, malformed or conflicting references.
 * @complexity O(b) validation, b<=1MiB; compares at most three references.
 */
export function decodeLinkedInCreativeContent(required: { input: unknown }): Outcome<{ reference: string }> {
  const parsed = creativeContentInput.safeParse(required.input);
  if (!parsed.success) return failure({ code: "protocol_mismatch" });
  const content = parsed.data;
  const references = [content.reference, content.standardUpdateAd?.reference, content.videoAd?.reference].filter(reference => reference !== undefined);
  if (references.length === 0 || new Set(references).size !== 1) return failure({ code: "protocol_mismatch" });
  return { ok: true, value: { reference: references[0]! } };
}
// The same decoder serves entity pages and deployment readback; provider additions stay private.
const creativeContent = z.unknown().transform((input, context) => {
  const decoded = decodeLinkedInCreativeContent({ input });
  if (decoded.ok) return decoded.value;
  context.addIssue({ code: "custom", message: "Invalid creative content reference" });
  return z.NEVER;
});
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
const creativeItem = z.object({ id: creativeUrn, account: accountUrn, campaign: campaignUrn, intendedStatus: state, isServing: z.boolean(), servingHoldReasons: z.array(text).max(32).optional(), content: creativeContent });
const targetingItem = z.object({ urn, facetUrn: z.string().regex(/^urn:li:adTargetingFacet:[A-Za-z]+$/), name: text });
const pagination = z.object({ nextPageToken: z.string().min(1).max(2048).regex(/^[^\x00-\x1f\x7f]+$/).nullable().optional() });
const conversionItem = z.object({ id: providerId, account: accountUrn, name: text, type: text, conversionMethod: text, enabled: z.boolean(), ownershipType: z.enum(["OWNED", "SHARED"]).optional() });
const leadItem = z.object({ id: providerId, owner: z.object({ sponsoredAccount: accountUrn }), name: text, state: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]), versionId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
const offsetPaging = z.object({ start: z.number().int().min(0).max(1000000), count: z.number().int().min(1).max(100) });
interface Prepared { configuration: LinkedInConfiguration; invocation: LinkedInInvocation; request: LinkedInWireRequest; effect: EffectEnvelope }
type Credential = z.infer<typeof credentialSchema>;

/** Inert adapter sharing bounded transport with the server-only conversion backend.
 * @param required - Server binding, policy/outbox gateway, token broker and injected fetch/clock/observer.
 * @returns Invoke; typed denials, ACKs or unknown writes; no retries.
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

function sameScope(required: { first: LinkedInConfiguration["scope"]; second: LinkedInConfiguration["scope"] }): boolean { return required.first.ownerId === required.second.ownerId && required.first.workspaceId === required.second.workspaceId; }


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
      request: Object.freeze({ ...prepared.request }), effect: structuredClone(prepared.effect),
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

/** Recheck cancellation and token expiry at the actual fetch boundary. @complexity O(1). */
function checkBeforeEgress(required: { dependencies: LinkedInDependencies; prepared: Prepared; credential: Credential }, optional?: CallOptions): Outcome<void> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  const now = required.dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "invalid_input" });
  if (required.credential.expiresAt !== undefined && now >= required.credential.expiresAt) return failure({ code: "expired" });
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

/** Byte overflow identity for canonical date splitting; legacy callers still see unavailable. */
export const oversizedBody = Object.freeze(failure({ code: "unavailable" }));

/** Internal shared fetch edge for interactive calls and CAPI. Bounded streams and headers remain
 * vendor-owned; callers check current authority immediately before entering this synchronous preflight.
 * @complexity O(b) time/space, b<=1MiB; one request, no redirect or retry.
 */
export async function requestLinkedIn(required: { fetch: typeof fetch; request: LinkedInWireRequest; credential: Credential; apiVersion: "202610"; numericText?: true; missingAsNull?: boolean }, optional?: CallOptions): Promise<Outcome<{ response: Response; body: unknown }>> {
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  if (Buffer.byteLength(required.request.body ?? "") > 65536) return failure({ code: "limit_exceeded" });
  const deadline = AbortSignal.timeout(15000);
  const signal = AbortSignal.any([deadline, optional?.signal ?? deadline]);
  try {
    const response = await required.fetch(required.request.url, {
      method: required.request.method, body: required.request.body, redirect: "error", signal,
      headers: { Authorization: "Bearer " + required.credential.accessToken, "LinkedIn-Version": required.apiVersion,
        "X-Restli-Protocol-Version": "2.0.0", "Content-Type": "application/json",
        ...(required.request.method !== "GET" || required.request.url.includes("?") ? { "X-RestLi-Method": required.request.restliMethod } : {}) },
    });
    // Canonical status reads distinguish an absent requested entity from a bad request.
    if (required.missingAsNull === true && response.status === 404) {
      await response.body?.cancel();
      return { ok: true, value: { response, body: null } };
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel();
      return vendorRejection({ status: response.status });
    }
    const body = await readBody({ response, numericText: required.numericText });
    if (body.ok) return { ok: true, value: { response, body: body.value } };
    return body.error.code === "limit_exceeded" ? oversizedBody : failure({ code: "unavailable" });
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
async function readBody(required: { response: Response; numericText?: true }): Promise<Outcome<unknown>> {
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
    const text = Buffer.concat(chunks).toString("utf8");
    return required.numericText ? parseExactIntegerJson({ text }, { numericTextKeys: ["id", "costInLocalCurrency", "conversionValueInLocalCurrency", "externalWebsiteConversions", "impressions", "clicks"] }) : { ok: true, value: JSON.parse(text) as unknown };
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

/** Read authenticated account currency; one bounded GET, no cache/retries, O(b<=1MiB).
 * Foreign IDs and malformed metadata fail closed; credential failures remain static.
 * @example readAccountCurrency({ credentials, fetch, clock, connectionId: "c1", accountId: "123" }) */
export async function readAccountCurrency(required: Pick<LinkedInDependencies, "credentials" | "fetch" | "clock"> & { connectionId: string; accountId: string }, optional?: CallOptions): Promise<Outcome<string>> {
  const credential = await resolveCredential({ credentials: required.credentials, configuration: required }, optional);
  if (!credential.ok) return credential;
  const now = required.clock.now({});
  if (!epochSchema.safeParse(now).success) return failure({ code: "invalid_input" });
  if (credential.value.expiresAt !== undefined && credential.value.expiresAt <= now) return failure({ code: "expired" });
  const response = await requestLinkedIn({ fetch: required.fetch, request: { url: `https://api.linkedin.com/rest/adAccounts/${required.accountId}`, method: "GET", restliMethod: "FINDER" }, credential: credential.value, apiVersion: linkedInApiVersion, numericText: true }, optional);
  if (!response.ok) return response;
  const metadata = z.object({ id: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/) }).safeParse(response.value.body);
  if (!metadata.success) return failure({ code: "protocol_mismatch" });
  if (metadata.data.id !== required.accountId) return failure({ code: "forbidden" });
  return { ok: true, value: metadata.data.currency };
}

/** Inert fixed tool ABI; the host owns approval and guarded fetch. Each call resolves currency
 * and credentials afresh. O(b<=1MiB), one metadata GET plus one bounded vendor call, no retries.
 * @example createTools({ configuration, credentials, fetch, clock, observer, wait }).invoke(call) */
export function createTools(required: PluginCapabilityDependencies): ReturnType<PluginToolsFactory> {
  return { async invoke(call, optional) {
    try {
      const command = parseTool({ name: call.name, input: call.input });
      if (!command.ok) return command;
      const configuration = pluginConfigurationSchema.extend({ accountId: vendorIdSchema }).safeParse(required.configuration);
      const context = callContextSchema.safeParse(call.context);
      if (!configuration.success || !context.success) return failure({ code: "invalid_input" });
      const binding = configuration.data;
      if (call.connection.accountId !== binding.accountId || call.connection.connectionId !== binding.connectionId || !sameScope({ first: context.data.scope, second: binding.scope })) return failure({ code: "forbidden" });
      const currency = await readAccountCurrency({ ...required, connectionId: binding.connectionId, accountId: binding.accountId }, optional);
      if (!currency.ok) return currency;
      return createLinkedInAdsAdapter({ ...required, configuration: { scope: binding.scope, connectionId: binding.connectionId, accountId: binding.accountId, pluginDigest: binding.pluginDigest, currency: currency.value, apiVersion: linkedInApiVersion, bindingId: "linkedin-ads.stop.v1" }, gateway: { dispatch: call => call.execute() } }).invoke({ context: context.data, operationId: call.operationId, command: command.value as LinkedInCommand, moneyExposure: call.moneyExposure, requiredLimit: call.requiredLimit }, optional);
    } catch { return failure({ code: optional?.signal?.aborted ? "cancelled" : "unavailable" }); }
  } };
}
