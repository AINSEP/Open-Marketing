import type { CallContext, EffectEnvelope, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createPinterestAdsAdapter, createPinterestCapiBackend, deployCampaignPaused } from "../src/index.js";
import type { CampaignTranslationInput, PinterestCapiConfiguration, PinterestCapiRequest, PinterestConversionAuthorityPort, PinterestConfiguration, PinterestDependencies, PinterestGatewayPort, PinterestInvocation, PinterestPausedPlan } from "../src/index.js";

export const now = Date.parse("2026-10-24T00:00:00Z");
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: PinterestConfiguration = { scope: context.scope, connectionId: "connection", accountId: "123", currency: "GBP", apiVersion: "v5", bindingId: "binding", pluginDigest: "a".repeat(64) };
export const accountPage = { items: [{ id: "123", name: "Fixture", currency: "GBP", time_zone: "Europe/London", secret: "discard" }], bookmark: "next+/=" };
export const campaignPage = { items: [{ id: "456", ad_account_id: "123", name: "Fixture", status: "PAUSED" }] };
export const report = { kind: "report", level: "ACCOUNT", startDate: "2026-10-20", endDate: "2026-10-21" } as const;
export function invocation(required: { command?: PinterestInvocation["command"] } = {}): PinterestInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "list_accounts" } }; }
export function deny(): Outcome<never> { return { ok: false, error: { code: "forbidden", message: "Fixture refusal", retryable: false } }; }

/** Synthetic transport and a replaceable host gateway. Real composition must run the same suite. */
export function fixture(required: { admitted?: boolean; configuration?: PinterestConfiguration; response?: () => Response | Promise<Response>; credentialHook?: () => void; credential?: unknown; gateway?: PinterestGatewayPort; deadline?: PinterestDependencies["deadline"]; observerThrows?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [], observations: ObserverEvent[] = [], effects: EffectEnvelope[] = [];
  const credentialCalls: { connectionId: string; accountId: string | null }[] = [];
  const state = { current: true, time: now };
  const gateway: PinterestGatewayPort = required.gateway ?? { async dispatch(input) { effects.push(input.effect); if (!state.current) return deny(); return input.execute(); } };
  const dependencies: PinterestDependencies = {
    admitted: required.admitted ?? true, configuration: required.configuration ?? configuration, gateway,
    credentials: { async access(input) { credentialCalls.push(input); required.credentialHook?.(); return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret", expiresAt: now + 60000 }) as { accessToken: string } }; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); if (required.response) return required.response(); return Response.json(accountPage); },
    deadline: required.deadline ?? (input => AbortSignal.timeout(input.timeoutMs)),
    clock: { now: () => state.time }, observer: { observe(event) { if (required.observerThrows) throw new Error("fixture"); observations.push(event); } },
  };
  return { adapter: createPinterestAdsAdapter(dependencies), calls, observations, credentialCalls, effects, state };
}
export type Fixture = ReturnType<typeof fixture>;

export const launchInput: CampaignTranslationInput = {
  campaign: { name: "Traffic", objective: "traffic", schedule: { window: { start: now, end: now + 86400000 }, timezone: "Europe/London" }, audience: { countries: ["GB"] }, creativeIds: ["creative"], creativeDigest: "b".repeat(64) },
  target: { accountId: "123", dailyBudget: { minorUnits: 1000, currency: "GBP" } },
  resolved: { accountId: "123", currency: "GBP", currencyExponent: 2, timezone: "Europe/London", creativeId: "creative", creativeDigest: "b".repeat(64), pinId: "789", unitCost: { minorUnits: 25, currency: "GBP" } },
};
export const pausedPlan: PinterestPausedPlan = {
  accountId: "123", currency: "GBP", timezone: "Europe/London",
  campaign: { name: "Traffic", status: "PAUSED", objective_type: "CONSIDERATION", daily_spend_cap: 10000000, start_time: now / 1000, end_time: (now + 86400000) / 1000, is_campaign_budget_optimization: true, is_flexible_daily_budgets: false, is_automated_campaign: false, is_performance_plus: false },
  adGroup: { name: "Traffic", status: "PAUSED", campaign_id: { from: "campaign" }, billable_event: "CLICKTHROUGH", bid_strategy_type: "MAX_BID", bid_in_micro_currency: 250000, auto_targeting_enabled: false, is_creative_optimization: false, targeting_spec: { LOCATION: ["GB"] } },
  ad: { name: "Traffic", status: "PAUSED", ad_group_id: { from: "adGroup" }, creative_type: "REGULAR", pin_id: "789" },
};
/** Independent wire fixtures, not generated from encoder output or captured requests. */
export const deploymentRows = {
  campaigns: { id: "456", ad_account_id: "123", name: "Traffic", status: "PAUSED", objective_type: "CONSIDERATION", daily_spend_cap: 10000000, start_time: 1792800000, end_time: 1792886400, is_campaign_budget_optimization: true, is_flexible_daily_budgets: false, is_automated_campaign: false, is_performance_plus: false },
  ad_groups: { id: "567", ad_account_id: "123", campaign_id: "456", name: "Traffic", status: "PAUSED", billable_event: "CLICKTHROUGH", bid_strategy_type: "MAX_BID", bid_in_micro_currency: 250000, auto_targeting_enabled: false, is_creative_optimization: false, targeting_spec: { LOCATION: ["GB"] } },
  ads: { id: "678", ad_account_id: "123", ad_group_id: "567", name: "Traffic", status: "PAUSED", creative_type: "REGULAR", pin_id: "789" },
};
type WireCall = { url: string; init: RequestInit };
/** Memory host claims dispatch once and fences fetch after token lookup; all responses are synthetic. */
export function deploymentFixture(required: { admitted?: boolean; response?: (input: { call: WireCall; index: number }) => Response | Promise<Response>; credentialHook?: () => void; checkpointHook?: (input: { step: string; phase: string }) => void; credential?: unknown } = {}) {
  const calls: WireCall[] = [], journal: unknown[] = [], observations: ObserverEvent[] = [];
  const state = { current: true, credentials: 0 }, dispatched = new Set<string>();
  const dependencies: Omit<PinterestDependencies, "gateway"> = {
    configuration, admitted: required.admitted ?? true,
    credentials: { async access() { state.credentials++; required.credentialHook?.(); return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret", expiresAt: now + 60000 }) as { accessToken: string } }; } },
    fetch: async (url, init) => {
      if (!state.current) throw new Error("Host fence revoked");
      const call = { url: String(url), init: init ?? {} }; calls.push(call);
      if (required.response) return required.response({ call, index: calls.length });
      const key = call.url.split("/")[6] as keyof typeof deploymentRows;
      return Response.json(call.init.method === "POST" ? { items: [{ data: deploymentRows[key] }] } : deploymentRows[key]);
    },
    deadline: input => AbortSignal.timeout(input.timeoutMs), clock: { now: () => now }, observer: { observe: event => { observations.push(event); } },
  };
  const checkpoint: Parameters<typeof deployCampaignPaused>[0]["checkpoint"] = async input => {
    journal.push(structuredClone(input)); required.checkpointHook?.(input);
    if (input.phase === "dispatch" && dispatched.has(input.step)) return deny();
    if (input.phase === "dispatch") dispatched.add(input.step);
    return { ok: true, value: undefined };
  };
  return { dependencies, checkpoint, calls, journal, state, observations };
}

export const capiConfiguration: PinterestCapiConfiguration = { ...configuration, accountId: "123", mode: "production-server", destination: "pinterest", purpose: "measurement", payloadSchema: "pinterest-web-v1", conversionRules: { definition: { eventName: "signup", sourceUrl: "https://example.test/signup" } } };
export const conversionRequest: PinterestCapiRequest = {
  context: { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" }, deliveryId: "delivery",
  event: { eventId: "event", definitionId: "definition", subjectId: "subject", occurredAt: now - 1000, destination: "pinterest", purpose: "measurement", identifiers: { email: "a".repeat(64) }, identifierDigests: { email: "b".repeat(64) } },
  grant: { kind: "measurement", grantId: "grant", scope: context.scope, connectionId: "connection", accountId: "123", definitionIds: ["definition"], destination: "pinterest", purpose: "measurement", payloadSchema: "pinterest-web-v1", payloadVersion: 1, expiresAt: now + 60000, revoked: false },
};
/** The same authority suite is registered by the integrator against its real host adapter. */
export function capiFixture(required: { admitted?: boolean; configuration?: PinterestCapiConfiguration; response?: () => Response | Promise<Response>; credentialHook?: () => void; authority?: PinterestConversionAuthorityPort } = {}) {
  const f = deploymentFixture({ ...required, response: required.response ?? (() => Response.json({ num_events_received: 1, num_events_processed: 1, events: [{ status: "processed" }] })) });
  const claims = new Set<string>();
  const dispatches: Omit<Parameters<PinterestConversionAuthorityPort["dispatch"]>[0], "execute">[] = [];
  const authority: PinterestConversionAuthorityPort = required.authority ?? { async dispatch(input) {
    const { execute, ...audit } = input; dispatches.push(structuredClone(audit));
    if (!f.state.current || claims.has(input.deliveryId)) return deny();
    claims.add(input.deliveryId);
    return execute({ isCurrent: () => f.state.current });
  } };
  return { ...f, dispatches, backend: createPinterestCapiBackend({ ...f.dependencies, configuration: required.configuration ?? capiConfiguration, authority }) };
}
export type CapiFixture = ReturnType<typeof capiFixture>;
