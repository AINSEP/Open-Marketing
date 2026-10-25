import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import { createNaverAdsAdapter } from "../src/index.js";
import type { NaverCommand, NaverDependencies, NaverInvocation } from "../src/index.js";

/** Synthetic identity: key owner 111, selected delegated customer 222, advertiser account 999. */
export const now = 1791849600000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const campaign = { nccCampaignId: "cmp-fixture-1", customerId: 222, name: "Fixture", campaignTp: "WEB_SITE", status: "PAUSED", userLock: true };
export const accountPage = { content: [{ adAccountNo: 999, roleName: "MASTER", adAccount: { no: 999, masterCustomerId: 222, name: "Fixture", currency: "KRW" } }], number: 0, size: 100, last: true };
export const reportCommand = { kind: "report" as const, campaignId: campaign.nccCampaignId, since: "2026-10-01", until: "2026-10-24" };
export const reportPage = { data: [{ id: campaign.nccCampaignId, impCnt: 120, clkCnt: 4, salesAmt: 3300 }] };
export function invocation(required: { command?: NaverCommand } = {}): NaverInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "list_campaigns" } }; }

/** Real adapter over a memory credential broker and recorded-request fetch, never global networking. */
export function fixture(required: { response?: () => Response | Promise<Response>; credential?: string; credentialHook?: () => void; observerThrows?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const credentialCalls: { connectionId: string; accountId: string }[] = [];
  const observations: ObserverEvent[] = [];
  const configuration = { scope: context.scope, connectionId: "connection", accountId: "222", credentialCustomerId: "111", admitted: true };
  const dependencies: NaverDependencies = {
    configuration,
    credentials: { async access(input) { credentialCalls.push(input); required.credentialHook?.(); return { ok: true, value: { accessToken: required.credential ?? JSON.stringify({ apiKey: "fixture-license", secretKey: "fixture-secret", customerId: "111" }) } }; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response() : Response.json([campaign]); },
    createDeadline: () => new AbortController().signal,
    clock: { now: () => now },
    observer: { observe(event) { if (required.observerThrows) throw new Error("Fixture observer failure"); observations.push(event); } },
  };
  return { adapter: createNaverAdsAdapter(dependencies), dependencies, configuration, calls, credentialCalls, observations };
}
