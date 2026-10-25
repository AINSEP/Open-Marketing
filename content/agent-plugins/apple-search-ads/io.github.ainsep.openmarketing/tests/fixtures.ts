import type { CallContext, CallOptions, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { deployCampaignPaused, invokeAppleSearchAds, readCampaignDeployment } from "../src/index.js";
import type { AppleSearchAdsDependencies } from "../src/index.js";
export const now = Date.UTC(2026, 9, 24);
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const account = { orgId: 123, orgName: "Fixture org", currency: "USD", timeZone: "America/Los_Angeles", roleNames: ["API Account Read Only"] };
export const campaign = { id: 456, orgId: 123, name: "Fixture campaign", status: "PAUSED", dailyBudgetAmount: { amount: "37.0123", currency: "USD" } };
export const pagination = { totalResults: 3, startIndex: 0, itemsPerPage: 100 };
export const reportCommand = { kind: "report", startDate: "2026-10-22", endDate: "2026-10-23" };
export const reportRow = { metadata: { campaignId: 456, orgId: 123 }, granularity: [{ date: "2026-10-22", localSpend: { amount: "123456789.123456789", currency: "USD" }, impressions: 103, taps: 17, tapInstalls: 4, totalInstalls: 9 }] };
export const reportPage = { data: { reportingDataResponse: { row: [reportRow] } }, pagination, error: null };

/** Synthetic broker and actual Response streams around the public plugin entry. The integrator
 * binds the same dispatch suite to its real host adapter; no production authority is faked here.
 */
export function fixture() {
  const calls: { url: string; init: RequestInit }[] = [];
  const credentialCalls: { connectionId: string; accountId: string | null }[] = [];
  const observations: ObserverEvent[] = [];
  const state = { admitted: true, credentialHook: () => {}, time: now, response: () => Response.json({ data: [account], pagination: null, error: null }), credential: { ok: true, value: { accessToken: "synthetic-secret", expiresAt: now + 60000 } } as Outcome<{ accessToken: string; expiresAt?: number }> };
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
  campaign: { name: "Fixture install", orgId: 123, adamId: 987, countriesOrRegions: ["US", "CA"], dailyBudgetAmount: { amount: "37.01", currency: "USD" }, startTime: "2026-10-25T00:00:00.000Z", endTime: "2026-10-26T00:00:00.000Z", status: "PAUSED", adChannelType: "SEARCH", supplySources: ["APPSTORE_SEARCH_RESULTS"], billingEvent: "TAPS", biddingStrategy: "MANUAL_CPT" },
  adgroup: { name: "Fixture install", orgId: 123, startTime: "2026-10-25T00:00:00.000Z", endTime: "2026-10-26T00:00:00.000Z", status: "PAUSED", automatedKeywordsOptIn: true, pricingModel: "CPC", defaultBidAmount: { amount: "1.01", currency: "USD" }, campaignId: { from: "campaign" } },
  ad: { name: "Fixture install", creativeId: 789, status: "PAUSED", adgroupId: { from: "adgroup" } },
};
export const savedReferences = { campaign: "456", adgroup: "567", ad: "678" };

/** Fixed recorded-shape fixture responses; never derive a vendor response from outbound request bytes. */
export function deploymentFixture() {
  const f = fixture();
  const plan = structuredClone(pausedPlan);
  const { campaignId: _campaignSlot, ...group } = pausedPlan.adgroup;
  const { adgroupId: _groupSlot, ...ad } = pausedPlan.ad;
  const rows: Record<string, unknown>[] = [
    { ...pausedPlan.campaign, id: 456, servingStatus: "NOT_RUNNING", deleted: false },
    { ...group, id: 567, campaignId: 456, servingStatus: "NOT_RUNNING", deleted: false },
    { ...ad, id: 678, orgId: 123, campaignId: 456, adGroupId: 567, servingStatus: "NOT_RUNNING", deleted: false },
  ];
  const responses: unknown[] = [{ id: 789, orgId: 123, adamId: 987, state: "VALID" }, { data: { id: 456 }, error: null }, { data: rows[0], error: null }, { id: 567 }, rows[1], { id: 678 }, rows[2]];
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
