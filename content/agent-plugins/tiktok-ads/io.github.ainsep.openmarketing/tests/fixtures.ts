import { z } from "zod";
import { parseBoundary } from "@open-marketing/contracts";
import type { AppError, CallContext, ClockPort, EffectEnvelope, HaltStopPermit, MeasurementGrant, ObserverEvent, Outcome, ServiceContext } from "@open-marketing/contracts";
import { createTikTokAdsAdapter, createTikTokEventsBackend, createTikTokFetchEgress, decodeTikTokRead } from "../src/index.js";
import type { TikTokAccountMetadata, TikTokAdsAdapter, TikTokBinding, TikTokCall, TikTokCredentialPort, TikTokEgressPort, TikTokEgressRequest, TikTokEventsConfiguration, TikTokEventsPayload, TikTokEventsRequest, TikTokInvocation, TikTokReadCommand, TikTokReportQuery } from "../src/index.js";
import type { TikTokEgressCommand, TikTokGatewayPort } from "../src/ports.js";
import { decodeTikTokAcknowledgement, digestTikTokArguments, failure } from "../src/commands.js";
import { encodeTikTokEgress } from "../src/transport.js";

/** Entirely synthetic fixtures, not vendor recordings or admission evidence. */
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const now = 1791849600000;
export const clock: ClockPort = { now: () => now };
export const metadata: TikTokAccountMetadata = { accountId: "123", currency: "USD", timezone: "America/Los_Angeles", minorUnitExponent: 2 };
export const reportQuery: TikTokReportQuery = { kind: "report", startDate: "2026-10-01", endDate: "2026-10-13", page: 1, pageSize: 100 };
export const pageInfo = { page: 1, page_size: 100, total_page: 1, total_number: 1 };
export const advertiserResponse = { code: 0, message: "OK", data: { list: [{ advertiser_id: "123", advertiser_name: "Fixture advertiser", currency: "USD", timezone: "America/Los_Angeles" }] } };
export const campaignResponse = { code: 0, data: { list: [{ advertiser_id: "123", campaign_id: "456", campaign_name: "Fixture campaign", operation_status: "DISABLE" }], page_info: pageInfo } };
export const adgroupResponse = { code: 0, data: { list: [{ advertiser_id: "123", campaign_id: "456", adgroup_id: "457", adgroup_name: "Fixture group", operation_status: "DISABLE" }], page_info: pageInfo } };
export const adResponse = { code: 0, data: { list: [{ advertiser_id: "123", campaign_id: "456", adgroup_id: "457", ad_id: "458", ad_name: "Fixture ad", operation_status: "DISABLE" }], page_info: pageInfo } };
export const reportResponse = { code: 0, data: { list: [{ dimensions: { advertiser_id: "123" }, metrics: { spend: "12.34" } }], page_info: pageInfo } };

export interface EgressFixture {
  egress: TikTokEgressPort;
  state: { current: boolean; token: string; body: unknown; onAccess?: () => void; credentialError?: AppError };
  credentialCalls: { context: CallContext | ServiceContext; connectionId: string; accountId: string }[];
  sent: string[];
  fetchCalls: { url: string; init?: RequestInit }[];
  observations: ObserverEvent[];
}

/** Same typed egress request for both adapters; each fixture has isolated mutable state. */
export function request(required: { fixture: EgressFixture; command?: TikTokEgressCommand }): TikTokEgressRequest {
  return { context, connectionId: "connection", accountId: "123", operationId: "operation", request: required.command ?? { kind: "get-advertiser" }, isCurrent: () => required.fixture.state.current };
}

/** Concrete memory substitute for the credentialed REST boundary. No HTTP or global mocking. */
function createMemoryEgress(required: { fixture: Omit<EgressFixture, "egress">; credentials: TikTokCredentialPort; responseFor?: ResponseFor }): TikTokEgressPort {
  return { send: async (input, options): Promise<Outcome<unknown>> => {
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Fixture cancelled" });
    if (!input.isCurrent()) return failure({ code: "forbidden", message: "Fixture authority revoked" });
    const encoded = encodeTikTokEgress({ input: input.request, accountId: input.accountId });
    if (!encoded.ok) return encoded;
    const credential = await required.credentials.access({ context: input.context, connectionId: input.connectionId, accountId: input.accountId }, options);
    if (!credential.ok) return credential;
    const parsed = parseBoundary({ schema: z.strictObject({ accessToken: z.string().min(1).max(4096).regex(/^[\x21-\x7E]+$/) }), input: credential.value });
    if (!parsed.ok) return parsed;
    if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Fixture cancelled" });
    if (!input.isCurrent()) return failure({ code: "forbidden", message: "Fixture authority revoked" });
    required.fixture.sent.push(encoded.value.path);
    return memoryResponse({ input, encoded: encoded.value, fixture: required.fixture, responseFor: required.responseFor });
  } };
}

/** Memory receives the same bounded wire shapes as fetch; uncertainty matches the real adapter. */
function memoryResponse(required: { input: TikTokEgressRequest; encoded: Extract<ReturnType<typeof encodeTikTokEgress>, { ok: true }>["value"]; fixture: Omit<EgressFixture, "egress">; responseFor?: ResponseFor }): Outcome<unknown> {
  const body = required.responseFor ? required.responseFor({ path: required.encoded.path, body: required.encoded.method === "POST" ? required.encoded.body : undefined }) : required.fixture.state.body;
  if (required.encoded.method === "GET") return decodeTikTokRead({ input: body, command: required.input.request as TikTokReadCommand, accountId: required.input.accountId });
  const ack = decodeTikTokAcknowledgement({ input: body });
  return ack.ok ? ack : failure({ code: "unavailable", message: "Fixture write receipt unknown" });
}

/** Injected fetch adapter uses real Response streams; memory implements the same shared suite. */
type ResponseFor = (required: { path: string; body?: Readonly<Record<string, unknown>> }) => unknown;
export function fixture(required: { kind: "memory" | "fetch"; body?: unknown; fetch?: typeof fetch; responseFor?: ResponseFor }): EgressFixture {
  const state: EgressFixture["state"] = { current: true, token: "fixture-token", body: required.body ?? structuredClone(advertiserResponse) };
  const credentialCalls: EgressFixture["credentialCalls"] = [];
  const sent: EgressFixture["sent"] = [];
  const fetchCalls: EgressFixture["fetchCalls"] = [];
  const observations: ObserverEvent[] = [];
  const credentials: TikTokCredentialPort = { access: async (input): Promise<Outcome<{ accessToken: string }>> => {
    credentialCalls.push(input);
    state.onAccess?.();
    if (state.credentialError) return { ok: false, error: state.credentialError };
    if (input.accountId !== "123" || input.connectionId !== "connection" || input.context.scope.ownerId !== context.scope.ownerId || input.context.scope.workspaceId !== context.scope.workspaceId) return failure({ code: "forbidden", message: "Fixture credential account binding mismatch" });
    return { ok: true, value: { accessToken: state.token } };
  } };
  // Narrow wrapper for fetch's foreign positional ABI; records exact outbound URL/options.
  const fetchPort: typeof fetch = async (input, init) => {
    fetchCalls.push({ url: String(input), init });
    sent.push(String(input));
    if (required.fetch) return required.fetch(input, init);
    return Response.json(required.responseFor ? required.responseFor({ path: new URL(String(input)).pathname.replace("/open_api/v1.3/", ""), body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined }) : state.body);
  };
  const shared = { state, credentialCalls, sent, fetchCalls, observations };
  const egress = required.kind === "memory" ? createMemoryEgress({ fixture: shared, credentials, responseFor: required.responseFor }) : createTikTokFetchEgress({ fetch: fetchPort, credentials, observer: { observe: input => { observations.push(input); } } });
  return { ...shared, egress };
}

export const binding: TikTokBinding = { scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64) };
export const campaign: TikTokInvocation["command"] = { kind: "create-campaign-paused", name: "Fixture campaign", budget: 20 };
export const adgroup: TikTokInvocation["command"] = { kind: "create-adgroup-paused", name: "Fixture group", campaignId: "456", budget: 20, locationIds: ["6252001"], scheduleStart: "2026-10-13 00:00:00" };
export const ad: TikTokInvocation["command"] = { kind: "create-ad-paused", name: "Fixture ad", adgroupId: "457", text: "Fixture creative", videoId: "fixture-video", identityId: "fixture-identity", landingPageUrl: "https://example.com/signup" };
export const exposure = { amount: { currency: "USD", minorUnits: 2000 }, window: { start: now, end: now + 86400000 } };
export const limit = { amount: { currency: "USD", minorUnits: 2000 }, timezone: "America/Los_Angeles", semantics: "average_budget" as const, evidenceId: "fixture-limit" };
export function invocation(required: { command?: TikTokInvocation["command"]; operationId?: string } = {}): TikTokInvocation { return { context, operationId: required.operationId ?? "operation", command: required.command ?? campaign, moneyExposure: null, requiredLimit: null }; }
export function haltPermit(required: { entityIds?: string[] } = {}): HaltStopPermit {
  const entityIds = required.entityIds ?? ["456"];
  return { kind: "halt-stop", expiresAt: now + 30000, request: { operationId: "halt-operation", scope: context.scope, connectionId: "connection", adAccountId: "123", entityIds, action: "pause", haltId: "halt", haltEpoch: 1, pluginDigest: binding.pluginDigest, bindingId: "tiktok-ads.stop.v1", argumentsDigest: digestTikTokArguments({ arguments: { adAccountId: "123", entityIds, action: "pause" } }) } };
}
/** Synthetic routes; no production response is claimed verified by these fixtures. */
export function vendorResponse(required: { path: string }): unknown {
  switch (required.path) {
    case "campaign/create/": return { code: 0, data: { campaign_id: "456" } };
    case "adgroup/create/": return { code: 0, data: { adgroup_id: "457" } };
    case "ad/create/": return { code: 0, data: { ad_ids: ["458"] } };
    case "campaign/get/": return campaignResponse;
    case "adgroup/get/": return adgroupResponse;
    case "ad/get/": return adResponse;
    case "advertiser/info/": return advertiserResponse;
    case "report/integrated/get/": return reportResponse;
    default: return { code: 0, data: {} };
  }
}
export interface GatewayFixture {
  adapter: TikTokAdsAdapter; egress: EgressFixture;
  state: { admitted: boolean; current: boolean; haltCurrent: boolean; exactApprovals: Set<string>; responseFor: ResponseFor; gatewayError?: AppError; throwGateway?: boolean };
  calls: { context: CallContext; call: TikTokCall; effect: EffectEnvelope }[];
  claims: Map<string, string>; observations: ObserverEvent[];
}
/** Host policy/outbox DOUBLE, not the pending real server gateway. Both egress implementations
 * run the same tests; the exported gateway suite must also run against the addons host adapter.
 */
export function gatewayFixture(required: { kind: "memory" | "fetch" }): GatewayFixture {
  const state: GatewayFixture["state"] = { admitted: true, current: true, haltCurrent: true, exactApprovals: new Set(), responseFor: vendorResponse };
  const calls: GatewayFixture["calls"] = [];
  const claims = new Map<string, string>();
  const observations: ObserverEvent[] = [];
  const egress = fixture({ kind: required.kind, responseFor: input => state.responseFor(input) });
  const gateway: TikTokGatewayPort = { invoke: async (input, options) => {
    calls.push(input);
    if (state.gatewayError) return { ok: false, error: state.gatewayError };
    if (state.throwGateway) throw new Error("fixture-token gateway lost receipt");
    const authority = fixtureAuthority({ state, input });
    if (!authority.ok) return authority;
    if (!input.effect.effects.includes("read")) {
      if (claims.has(input.call.operationId)) return failure({ code: "conflict", message: "Fixture outbox claim already consumed" });
      claims.set(input.call.operationId, input.call.argumentsDigest);
    }
    return egress.egress.send({ context: input.context, connectionId: input.call.connectionId, accountId: input.call.accountId, operationId: input.call.operationId, request: input.call.request, isCurrent: () => state.current && state.admitted && (input.effect.effects[0] !== "halt_stop" || state.haltCurrent) }, options);
  } };
  const adapter = createTikTokAdsAdapter({ binding, gateway, clock, observer: { observe: event => { observations.push(event); } } });
  return { adapter, state, calls, claims, egress, observations };
}

/** Fixture policy only; replace with the ONE server policy in production/shared host contract runs. */
function fixtureAuthority(required: { state: GatewayFixture["state"]; input: GatewayFixture["calls"][number] }): Outcome<void> {
  const { state, input } = required;
  if (!state.admitted || !state.current) return failure({ code: "forbidden", message: "Fixture host admission/authority denied" });
  if (input.effect.effects.includes("ad_spend") && !state.exactApprovals.delete(input.call.operationId)) return failure({ code: "forbidden", message: "Fixture exact spend card missing" });
  if (input.effect.effects.includes("halt_stop") && (!state.haltCurrent || !input.call.haltStopPermit)) return failure({ code: "forbidden", message: "Fixture current halt permit missing" });
  return { ok: true, value: undefined };
}

export const serviceContext: ServiceContext = { scope: context.scope, serviceId: "measurement-service", correlationId: "correlation", traceId: "trace" };
export const eventsConfiguration: TikTokEventsConfiguration = { connectionId: "connection", accountId: "123", pixelId: "fixture-pixel", pluginDigest: binding.pluginDigest, destination: "tiktok", purpose: "measurement", payloadSchema: "tiktok-ads.events.v1", mode: "production-server" };
export const grant: MeasurementGrant = { kind: "measurement", grantId: "grant", scope: context.scope, connectionId: "connection", accountId: "123", eventTypes: ["signup", "trial"], destination: "tiktok", purpose: "measurement", payloadSchema: "tiktok-ads.events.v1", payloadVersion: 1, expiresAt: now + 60000, revoked: false };
export const conversion: TikTokEventsRequest = { context: serviceContext, deliveryId: "delivery", grant, event: { eventId: "shared-event", eventType: "signup", subjectId: "subject", occurredAt: now - 1234, destination: "tiktok", purpose: "measurement", identifiers: { email: "b".repeat(64), phone: "c".repeat(64), external_id: "d".repeat(64), event_source_url: "https://example.com/signup" } } };
/** Durable claim/current consent are host doubles; plugin has no persistence or consent cache. */
export function eventsFixture(required: { kind: "memory" | "fetch"; configuration?: TikTokEventsConfiguration }): {
  backend: ReturnType<typeof createTikTokEventsBackend>; egress: EgressFixture; payloads: TikTokEventsPayload[];
  state: { consent: boolean; current: boolean; throwAfterSend: boolean; throwBeforeSend: boolean }; claims: Set<string>; observations: ObserverEvent[];
} {
  const state = { consent: true, current: true, throwAfterSend: false, throwBeforeSend: false };
  const egress = fixture({ kind: required.kind, body: { code: 0, data: {} } });
  const payloads: TikTokEventsPayload[] = [];
  const claims = new Set<string>();
  const observations: ObserverEvent[] = [];
  const backend = createTikTokEventsBackend({ configuration: required.configuration ?? eventsConfiguration, clock, egress: egress.egress, observer: { observe: event => { observations.push(event); } }, authority: { dispatch: async input => {
    if (state.throwBeforeSend) throw new Error("fixture-token authority unavailable");
    if (!state.consent || !state.current) return failure({ code: "forbidden", message: "Fixture consent withdrawn" });
    if (claims.has(input.deliveryId) || claims.has(input.event.eventId)) return failure({ code: "conflict", message: "Fixture duplicate delivery/event claim" });
    claims.add(input.deliveryId); claims.add(input.event.eventId); payloads.push(input.payload);
    const result = await input.execute({ isCurrent: () => state.consent && state.current });
    if (state.throwAfterSend) throw new Error("fixture-token lost receipt");
    return result;
  } } });
  return { backend, egress, payloads, state, claims, observations };
}
