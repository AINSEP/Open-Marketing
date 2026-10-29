import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies, CallContext, ObserverEvent } from "@open-marketing/contracts";
import { createCapabilities, createNaverAdsAdapter } from "../src/index.js";
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
    configuration: { scope: configuration.scope, connectionId: configuration.connectionId, accountId: configuration.accountId },
    credentials: { async access(input) { credentialCalls.push(input); required.credentialHook?.(); return { ok: true, value: { accessToken: required.credential ?? JSON.stringify({ apiKey: "fixture-license", secretKey: "fixture-secret", customerId: "111" }) } }; } },
    fetch: async (url, init) => { if (!configuration.admitted) throw new Error("Host guarded fetch denied"); calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response() : Response.json([campaign]); },
    createDeadline: () => new AbortController().signal,
    clock: { now: () => now },
    observer: { observe(event) { if (required.observerThrows) throw new Error("Fixture observer failure"); observations.push(event); } },
  };
  return { adapter: createNaverAdsAdapter(dependencies), dependencies, configuration, calls, credentialCalls, observations };
}

/** Independent daily and hierarchy fixtures follow the documented selected wire responses. */
export const dailyPage = { data: [{ dateStart: "2026-10-01", dateEnd: "2026-10-01", salesAmt: "9007199254740993", impCnt: "0", clkCnt: null, ccnt: "2" }],
  summary: { dateStart: "2026-10-01", dateEnd: "2026-10-02" }, cycleBaseTm: "202610030000" };
export const group = { nccAdgroupId: "grp-fixture-1", nccCampaignId: "cmp-fixture-1", customerId: 222, status: "ELIGIBLE" };
export const ad = { nccAdId: "nad-fixture-1", nccAdgroupId: "grp-fixture-1", customerId: 222, status: "PAUSED", inspectStatus: "DENIED", statusReason: "AD_DISAPPROVED" };

/** Canonical ABI over the same memory custody/HTTP seam. Expiry is manual; no timers/network. */
export function capabilityFixture(required: { response?: (input: { url: URL; requestIndex: number }) => Response | Promise<Response> } = {}) {
  const f = fixture();
  let expire!: () => void;
  const waits: number[] = [];
  const dependencies: PluginCapabilityDependencies = { ...f.dependencies,
    configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "222", pluginDigest: "a".repeat(64), settings: {} }),
    wait: (input, options) => new Promise(resolve => {
      waits.push(input.milliseconds);
      expire = () => resolve({ ok: true, value: undefined });
      options?.signal?.addEventListener("abort", () => resolve({ ok: false, error: { code: "cancelled", message: "Fixture cancelled", retryable: false } }), { once: true });
    }),
    fetch: async (url, init) => {
      f.calls.push({ url: String(url), init: init ?? {} });
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname === "/ad-accounts") return Response.json(accountPage);
      if (required.response) return required.response({ url: requestUrl, requestIndex: f.calls.length });
      const responses: Record<string, unknown> = { "/stats": dailyPage, "/ncc/adgroups": [group], "/ncc/ads": [ad], "/ncc/campaigns": [campaign] };
      return Response.json(responses[requestUrl.pathname] ?? campaign);
    },
  };
  return { ...f, dependencies, capabilities: createCapabilities(dependencies), waits, expire: () => expire() };
}
