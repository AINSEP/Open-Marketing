import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createCapabilities, createAmazonAdsAdapter, commandSchema } from "../src/index.js";
import type { AmazonAdsAdapter, AmazonCommand, AmazonDependencies, AmazonInvocation } from "../src/index.js";

/** Synthetic values only. Each fixture owns admission, time and intercepted requests. */
export const now = 1792800000000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const credential = { clientId: "fixture-client", accessToken: "fixture-token", expiresAt: now + 60000, region: "NA" };
export const profile = { profileId: 123, countryCode: "US", currencyCode: "USD", timezone: "America/Los_Angeles", accountInfo: { id: "ENTITY-fixture", type: "seller", name: "Fixture account", marketplaceStringId: "ATVPDKIKX0DER" } };
export const campaign = { campaignId: "456", name: "Fixture campaign", state: "PAUSED", startDate: "2026-10-01" };
export const requestReport = { kind: "request_report", preset: "spCampaigns", startDate: "2026-10-01", endDate: "2026-10-02" } as const;
export const reportId = "11111111-1111-4111-8111-111111111111";
export const report = { reportId, startDate: requestReport.startDate, endDate: requestReport.endDate, status: "PENDING", configuration: { adProduct: "SPONSORED_PRODUCTS", groupBy: ["campaign", "adGroup"], columns: ["adGroupId", "campaignId", "impressions", "clicks", "cost", "date"], reportTypeId: "spCampaigns", timeUnit: "DAILY", format: "GZIP_JSON", filters: null }, url: null, urlExpiresAt: null };
export const completedReport = { ...report, status: "COMPLETED", url: "https://offline-report-storage-us-east-1-prod.s3.amazonaws.com/fixture.json.gz?signature=fixture-location-secret", urlExpiresAt: new Date(now + 60000).toISOString() };
export const row = { campaignId: "456", adGroupId: "789", date: "2026-10-01", impressions: 12, clicks: 2, cost: 0.75 };
export function invocation(required: { command?: AmazonCommand } = {}): AmazonInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "list_accounts" } }; }
export function denial(): Outcome<never> { return { ok: false, error: { code: "forbidden", message: "Fixture denied", retryable: false } }; }

/** Actual adapter over synthetic fetch; host revocation is modeled at the final fetch boundary. */
export function fixture(required: { credential?: unknown; credentialHook?: () => void; response?: (required: { index: number }) => Response | Promise<Response>; accountId?: string | null } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const observations: ObserverEvent[] = [];
  const deadlines: { timeoutMs: number; controller: AbortController }[] = [];
  const state = { authority: true, credentialCalls: 0, time: now };
  const dependencies: AmazonDependencies = {
    configuration: { scope: context.scope, connectionId: "connection", accountId: required.accountId === undefined ? "123" : required.accountId, region: "NA" },
    credentials: { async access() { state.credentialCalls++; required.credentialHook?.(); return { ok: true, value: { accessToken: JSON.stringify(required.credential ?? credential) } }; } },
    createDeadlineSignal: ({ timeoutMs }) => { const controller = new AbortController(); deadlines.push({ timeoutMs, controller }); return controller.signal; },
    fetch: async (url, init) => {
      if (!state.authority) throw new Error("Fixture host revoked");
      calls.push({ url: String(url), init: init ?? {} });
      return required.response ? required.response({ index: calls.length }) : Response.json([profile]);
    },
    clock: { now: () => state.time }, observer: { observe(event) { observations.push(event); } },
  };
  return { capabilities: createCapabilities({ ...dependencies, configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [] } }), wait: async () => ({ ok: true as const, value: undefined }) }), adapter: createAmazonAdsAdapter(dependencies), dependencies, state, calls, observations, deadlines };
}

/** Independent memory double for the shared account-discovery contract; no HTTP or credentials. */
export function memoryFixture() {
  const state = {};
  const adapter: AmazonAdsAdapter = {
    async invoke(input) {
    if (!commandSchema.safeParse(input.command).success) return { ok: false, error: { code: "invalid_input", message: "Fixture input", retryable: false } };
    return { ok: true, value: { operationId: input.operationId, status: "succeeded", observedState: "unknown", data: { items: [{ ...profile, profileId: "123" }], nextToken: null } } };
  } };
  return { adapter, state };
}
