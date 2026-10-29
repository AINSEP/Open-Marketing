import type { CallContext, CallOptions, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { deployCampaignPaused, invokeAppleSearchAds, readCampaignDeployment } from "../src/index.js";
import type { AppleSearchAdsDependencies } from "../src/index.js";
export const now = Date.UTC(2026, 9, 24);
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const account = { adAccount: { id: 123, name: "Fixture account", orgId: 900 }, roles: ["Admin"] };
export const campaign = { id: 456, adAccountId: 123, name: "Fixture campaign", status: "PAUSED", dailyBudget: { value: { amount: "37.0123", currency: "USD" } } };
export const pagination = { totalCount: 3, offset: 0, pageSize: 100 };

/** Synthetic broker and actual Response streams around the public plugin entry. The integrator
 * binds the same dispatch suite to its real host adapter; no production authority is faked here.
 */
export function fixture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const credentialCalls: { connectionId: string; accountId: string | null }[] = [];
  const observations: ObserverEvent[] = [];
  const state = { admitted: true, credentialHook: () => {}, time: now, response: () => Response.json({ result: { acls: [account] } }), credential: { ok: true, value: { accessToken: "synthetic-secret", expiresAt: now + 60000 } } as Outcome<{ accessToken: string; expiresAt?: number }> };
  const dependencies: AppleSearchAdsDependencies = {
    configuration: { scope: context.scope, connectionId: "connection", accountId: "123", currency: "USD" },
    get admitted() { return state.admitted; },
    credentials: { async access(input) { credentialCalls.push(input); state.credentialHook(); return state.credential; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return state.response(); },
    clock: { now: () => state.time }, observer: { observe(event) { observations.push(event); } },
  };
  /** Invoke the public boundary with an object-wrapped command; omission defaults to discovery. */
  const invoke = ({ command = { kind: "list_accounts" } }: { command?: unknown } = {}, optional?: CallOptions) => invokeAppleSearchAds({ context, operationId: "operation", command, dependencies }, optional);
  return { dependencies, state, calls, credentialCalls, observations, invoke };
}
export type Fixture = ReturnType<typeof fixture>;

export const installCampaign = { name: "Fixture install", objective: "app_install", schedule: { window: { start: now + 86400000, end: now + 172800000 }, timezone: "UTC" }, audience: { countries: ["US", "CA"] }, creativeIds: ["om-creative"], creativeDigest: "a".repeat(64) };
export const installTarget = { pluginId: "apple-search-ads" as const, accountId: "123", dailyBudget: { minorUnits: 3701, currency: "USD" } };
export const installResolved = { accountId: "123", adamId: "987", appleCreativeId: "789", creativeId: "om-creative", creativeDigest: "a".repeat(64), currency: "USD", currencyExponent: 2, timezone: "UTC", bid: { minorUnits: 101, currency: "USD" } };
export const pausedPlan = {
  creative: { id: "om-creative", digest: "a".repeat(64) },
  campaign: { name: "Fixture install", adAccountId: 123, promotedObjectType: "APPSTORE_APP", promotedObjectId: "987", dailyBudget: { value: { amount: "37.01", currency: "USD" } }, startTime: "2026-10-25T00:00:00.000Z", endTime: "2026-10-26T00:00:00.000Z", status: "PAUSED", billingEvent: "TAPS",
    targeting: { countryOrRegion: { include: ["US", "CA"] }, supplySource: { include: ["APPSTORE"] }, supplyPlacement: { include: ["APPSTORE_SEARCH_RESULTS"] } }, bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP" } },
  adgroup: { name: "Fixture install", startTime: "2026-10-25T00:00:00.000Z", endTime: "2026-10-26T00:00:00.000Z", status: "PAUSED", automatedKeywordsOptIn: true, pricingModel: "CPT", bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP", bid: { amount: "1.01", currency: "USD" } }, campaignId: { from: "campaign" } },
  ad: { name: "Fixture install", creativeId: 789, status: "PAUSED", adgroupId: { from: "adgroup" } },
};
export const savedReferences = { campaign: "456", adgroup: "567", ad: "678" };

/** Fixed recorded-shape fixture responses; never derive a vendor response from outbound request bytes. */
export function deploymentFixture() {
  const f = fixture();
  const plan = structuredClone(pausedPlan);
  const rows: Record<string, unknown>[] = [
    { id: 456, adAccountId: 123, name: "Fixture install", promotedObjectType: "APPSTORE_APP", promotedObjectId: "987", dailyBudget: { value: { amount: "37.01", currency: "USD" } }, startTime: "2026-10-25T00:00:00.000", endTime: "2026-10-26T00:00:00.000", status: "PAUSED", billingEvent: "TAPS", systemStatus: "NOT_RUNNING", deleted: false,
      targeting: { countryOrRegion: { include: ["CA", "US"] }, supplySource: { include: ["APPSTORE"] }, supplyPlacement: { include: ["APPSTORE_SEARCH_RESULTS"] } }, bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP" } },
    { id: 567, adAccountId: 123, campaignId: 456, name: "Fixture install", startTime: "2026-10-25T00:00:00.000", endTime: "2026-10-26T00:00:00.000", status: "PAUSED", automatedKeywordsOptIn: true, pricingModel: "CPT", bidStrategy: { bidStrategyType: "MANUAL_CPT", bidStrategyGoal: "TAP", bid: { amount: "1.0100", currency: "USD" } }, systemStatus: "NOT_RUNNING", deleted: false },
    { id: 678, adAccountId: 123, campaignId: 456, adGroupId: 567, name: "Fixture install", creativeId: 789, status: "PAUSED", systemStatus: "NOT_RUNNING", deleted: false },
  ];
  const responses: unknown[] = [{ result: { id: 789, adAccountId: 123, destination: { destinationType: "APP_STORE_PRODUCT_PAGE", parameters: { adamId: 987 } }, systemStatus: "VALID", deleted: false } },
    { result: { id: 456 } }, { result: rows[0] }, { result: { id: 567 } }, { result: rows[1] }, { result: { id: 678 } }, { result: rows[2] }];
  f.state.response = () => Response.json(responses[f.calls.length - 1]);
  type Event = { step: string; phase: "dispatch" | "acknowledged"; references: Record<string, string | undefined> };
  const events: Event[] = [];
  const state = { reject: "", throwCheckpoint: false };
  const dispatched = new Set<string>();
  const checkpoint = async (event: Event): Promise<Outcome<void>> => {
    events.push(structuredClone(event));
    if (state.throwCheckpoint) throw new Error("synthetic checkpoint failure");
    if (state.reject === event.step + ":" + event.phase) return { ok: false, error: { code: "unavailable", message: "fixture", retryable: false } };
    if (event.phase === "dispatch" && dispatched.has(event.step)) return { ok: false, error: { code: "conflict", message: "duplicate intent", retryable: false } };
    if (event.phase === "dispatch") dispatched.add(event.step);
    return { ok: true, value: undefined };
  };
  const deploy = (optional?: CallOptions) => deployCampaignPaused({ context, operationId: "deployment", plan, dependencies: f.dependencies, checkpoint }, optional);
  const reconcile = (required: { references: unknown } = { references: savedReferences }) => readCampaignDeployment({ context, operationId: "deployment", plan, dependencies: f.dependencies, references: required.references });
  return { ...f, plan, rows, responses, events, checkpoint, checkpointState: state, deploy, reconcile };
}
