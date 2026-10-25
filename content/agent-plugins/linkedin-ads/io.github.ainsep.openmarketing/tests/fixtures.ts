import type { CallContext, EffectEnvelope, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createLinkedInAdsAdapter, createLinkedInCapiBackend, linkedInDigest } from "../src/index.js";
import type { LinkedInConfiguration, LinkedInDependencies, LinkedInGatewayPort, LinkedInInvocation, LinkedInResult } from "../src/index.js";
import type { LinkedInCapiConfiguration, LinkedInCapiRequest, LinkedInConversionAuthorityPort, LinkedInConversionOutcome } from "../src/index.js";

/** Entirely synthetic fixtures, including credentials, cards and account IDs. */
export const now = 1791849600000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: LinkedInConfiguration = { scope: context.scope, connectionId: "connection", accountId: "123", currency: "USD", apiVersion: "202610", pluginDigest: "a".repeat(64), bindingId: "binding" };
export const exposure = { amount: { currency: "USD", minorUnits: 4321 }, window: { start: now, end: now + 86400000 } };
export const limit = { amount: { currency: "USD", minorUnits: 4321 }, timezone: "UTC", semantics: "average_budget" as const, evidenceId: "existing-request-metadata" };
export const draft: LinkedInInvocation["command"] = { kind: "create_campaign_group_draft", name: "Fixture group", runSchedule: { start: now, end: now + 86400000 }, totalBudget: { amount: "43.21", currencyCode: "USD" } };
export const campaign: LinkedInInvocation["command"] = { kind: "create_campaign_paused", name: "Fixture campaign", campaignGroupId: "456", organizationId: "789", locale: { country: "US", language: "en" }, geoIds: ["103644278"], dailyBudget: { amount: "43.21", currencyCode: "USD" }, unitCost: { amount: "2.37", currencyCode: "USD" }, costType: "CPC", runSchedule: { start: now, end: now + 86400000 }, politicalIntent: "NOT_POLITICAL" };
export const groupPage = { elements: [{ id: 456, account: "urn:li:sponsoredAccount:123", name: "Fixture group", status: "DRAFT", totalBudget: { amount: "43.21", currencyCode: "USD" } }], metadata: { nextPageToken: "next_page-1" } };
export const campaignPage = { elements: [{ id: 567, account: "urn:li:sponsoredAccount:123", campaignGroup: "urn:li:sponsoredCampaignGroup:456", name: "Fixture campaign", status: "PAUSED", servingStatuses: ["STOPPED"] }] };
export const creativePage = { elements: [{ id: "urn:li:sponsoredCreative:678", account: "urn:li:sponsoredAccount:123", campaign: "urn:li:sponsoredCampaign:567", intendedStatus: "PAUSED", isServing: false, content: { reference: "urn:li:share:987" } }] };
export function invocation(required: { command?: LinkedInInvocation["command"]; operationId?: string } = {}): LinkedInInvocation { return { context, operationId: required.operationId ?? "operation", command: required.command ?? draft, moneyExposure: exposure, requiredLimit: limit }; }
export function rejection(required: { code?: "forbidden" | "conflict" } = {}): Outcome<never> { return { ok: false, error: { code: required.code ?? "forbidden", message: "Fixture denial", retryable: false } }; }

export interface Fixture {
  adapter: ReturnType<typeof createLinkedInAdsAdapter>;
  dependencies: LinkedInDependencies;
  calls: { url: string; init: RequestInit }[];
  effects: EffectEnvelope[];
  observations: ObserverEvent[];
  credentialCalls: { connectionId: string; accountId: string }[];
  state: { admitted: boolean; writeAllowed: boolean; halted: boolean; cards: Map<string, string>; time: number };
}

/** Fixture-only current authority; exact cards bind each operation's prepared digest. */
function fixtureAuthority(required: { state: Fixture["state"]; input: Parameters<LinkedInGatewayPort["dispatch"]>[0] }): Outcome<void> {
  const { state, input } = required;
  if (!state.admitted) return rejection();
  if (input.context.scope.workspaceId !== input.configuration.scope.workspaceId) return rejection();
  const category = input.effect.effects[0];
  if (state.halted && category !== "halt_stop") return rejection();
  if (category === "ad_spend" && state.cards.get(input.effect.operationId) !== input.effect.argumentsDigest) return rejection();
  if (category === "write" && !state.writeAllowed) return rejection();
  return { ok: true, value: undefined };
}

/** Real plugin fetch boundary over synthetic Response streams. The memory gateway models the
 * server's ONE operation journal and fresh exact-card checks. It is not the production host adapter.
 * @complexity Fixture-only bounded maps; each test owns/reset its state.
 */
export function fixture(required: { response?: () => Response | Promise<Response>; credentialHook?: () => void; credential?: unknown; gateway?: LinkedInGatewayPort; observerThrows?: boolean } = {}): Fixture {
  const calls: Fixture["calls"] = [];
  const credentialCalls: Fixture["credentialCalls"] = [];
  const effects: EffectEnvelope[] = [];
  const observations: ObserverEvent[] = [];
  const state: Fixture["state"] = { admitted: true, writeAllowed: true, halted: false, cards: new Map(), time: now };
  const claims = new Map<string, { digest: string; result: Outcome<LinkedInResult> }>();
  const gateway: LinkedInGatewayPort = required.gateway ?? { async dispatch(input) {
    effects.push(input.effect);
    const current = fixtureAuthority({ state, input });
    if (!current.ok) return current;
    const claim = claims.get(input.effect.operationId);
    if (claim && claim.digest !== input.effect.argumentsDigest) return rejection({ code: "conflict" });
    if (claim) return claim.result;
    const result = await input.execute();
    claims.set(input.effect.operationId, { digest: input.effect.argumentsDigest, result });
    return result;
  } };
  const dependencies: LinkedInDependencies = {
    configuration, gateway,
    credentials: { async access(input) {
      credentialCalls.push(input); required.credentialHook?.();
      const credential = Object.hasOwn(required, "credential") ? required.credential : { accessToken: "synthetic-secret", expiresAt: now + 60000 };
      return { ok: true, value: credential as { accessToken: string } };
    } },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      if (required.response) return required.response();
      return new Response(null, { status: 201, headers: { "x-restli-id": "456" } });
    },
    clock: { now: () => state.time },
    observer: { observe(event) { if (required.observerThrows) throw new Error("fixture telemetry"); observations.push(event); } },
  };
  return { adapter: createLinkedInAdsAdapter(dependencies), dependencies, calls, effects, observations, credentialCalls, state };
}

/** Card identity is obtained from the prepared request in codec tests; no blanket spend grant. */
export function approve(required: { fixture: Fixture; request: LinkedInInvocation; wire: object }): void { required.fixture.state.cards.set(required.request.operationId, linkedInDigest({ value: { apiVersion: "202610", request: required.wire } })); }

/** R2 fixtures: UTC half-open day, precision-preserving spend and contacts-produced hashes. */
export const reportCommand = { kind: "report" as const, pivot: "ACCOUNT" as const, window: { start: now, end: now + 86400000 } };
export const analyticsPage = { elements: [{ dateRange: { start: { year: 2026, month: 10, day: 13 }, end: { year: 2026, month: 10, day: 13 } }, pivotValues: ["urn:li:sponsoredAccount:123"], costInLocalCurrency: "123456789.123456789", impressions: 123, clicks: 4 }] };
export const conversionRule = { kind: "create_conversion_rule" as const, name: "Fixture signup", type: "SIGN_UP" as const, postClickAttributionWindowSize: 30 as const, viewThroughAttributionWindowSize: 7 as const, attributionType: "LAST_TOUCH_BY_CAMPAIGN" as const };
export const conversionPage = { elements: [{ id: 789, account: "urn:li:sponsoredAccount:123", name: "Fixture signup", type: "SIGN_UP", conversionMethod: "CONVERSIONS_API", enabled: true, ownershipType: "OWNED" }] };
export const leadPage = { elements: [{ id: "6755260984438374400", owner: { sponsoredAccount: "urn:li:sponsoredAccount:123" }, name: "Fixture form", state: "PUBLISHED", versionId: 1 }], paging: { start: 0, count: 1, links: [{ href: "https://untrusted.example/next" }] } };
export const capiConfiguration: LinkedInCapiConfiguration = { ...configuration, destination: "linkedin", purpose: "measurement", payloadSchema: "om.conversion.v1", mode: "production-server", conversionRules: { signup: "urn:lla:llaPartnerConversion:789" } };
export function conversionInput(): LinkedInCapiRequest {
  return { context: { scope: context.scope, serviceId: "measure-worker", correlationId: "correlation", traceId: "trace" }, deliveryId: "delivery", event: { eventId: "om-event", definitionId: "signup", subjectId: "subject", occurredAt: now, destination: "linkedin", purpose: "measurement", identifiers: { email: "a".repeat(64) }, identifierDigests: { email: "b".repeat(64) } }, grant: { kind: "measurement", grantId: "grant", scope: context.scope, connectionId: "connection", accountId: "123", definitionIds: ["signup"], destination: "linkedin", purpose: "measurement", payloadSchema: "om.conversion.v1", payloadVersion: 1, expiresAt: now + 60000, revoked: false } };
}
export interface CapiFixture extends Fixture {
  backend: ReturnType<typeof createLinkedInCapiBackend>;
  capiState: { consent: boolean; grant: boolean; connection: boolean; production: boolean; admitted: boolean };
  dispatches: Parameters<LinkedInConversionAuthorityPort["dispatch"]>[0][];
}
/** Per-test memory host models live consent and durable pre-send claims. Addons runs the same
 * acceptance suite with its production authority; no store is added to the plugin itself.
 */
export function capiFixture(required: Parameters<typeof fixture>[0] & { authority?: LinkedInConversionAuthorityPort; authorityHook?: () => void; configuration?: LinkedInCapiConfiguration } = {}): CapiFixture {
  const f = fixture(required);
  const capiState = { consent: true, grant: true, connection: true, production: true, admitted: true };
  const dispatches: CapiFixture["dispatches"] = [];
  const claims = new Map<string, { digest: string; result: Outcome<LinkedInConversionOutcome> }>();
  const authority: LinkedInConversionAuthorityPort = required.authority ?? { async dispatch(input) {
    dispatches.push(input);
    if (!current()) return rejection();
    const digest = linkedInDigest({ value: { event: input.event, payload: input.payload, apiVersion: input.configuration.apiVersion } });
    const previous = claims.get(input.deliveryId);
    if (previous && previous.digest !== digest) return rejection({ code: "conflict" });
    if (previous) return previous.result;
    const claim: { digest: string; result: Outcome<LinkedInConversionOutcome> } = { digest, result: { ok: true, value: { status: "unknown" } } };
    claims.set(input.deliveryId, claim);
    required.authorityHook?.();
    claim.result = await input.execute({ isCurrent: current });
    return claim.result;
  } };
  function current(): boolean { return capiState.consent && capiState.grant && capiState.connection && capiState.production && capiState.admitted; }
  const backend = createLinkedInCapiBackend({ ...f.dependencies, configuration: required.configuration ?? capiConfiguration, authority });
  return { ...f, backend, capiState, dispatches };
}
