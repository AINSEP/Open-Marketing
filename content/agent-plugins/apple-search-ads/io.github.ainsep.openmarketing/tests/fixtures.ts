import type { CallContext, CallOptions, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { invokeAppleSearchAds } from "../src/index.js";
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
