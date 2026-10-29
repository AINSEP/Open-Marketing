import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import { createCapabilities, createRedditAdsAdapter } from "../src/index.js";
import type { RedditConfiguration, RedditDependencies, RedditInvocation } from "../src/index.js";

/** Synthetic state only; never resolves real credentials or native network. */
export const now = Date.UTC(2026, 9, 24);
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const businessId = "34e0ed2c-b15d-4945-bf3f-1428eaddbf11";
export const reportCommand = { kind: "report" as const, pivot: "ACCOUNT" as const, window: { start: now - 86400000, end: now } };
export const businessPage = { data: [{ id: businessId, name: "Fixture business", unused: "synthetic-secret" }], pagination: { next_url: null } };
export const metric = { account_id: "a2_fixture", currency: "USD", spend: 123456789, impressions: 100, clicks: 3 };
export function reportPage(required: { metrics?: unknown[]; next?: string | null } = {}) { return { data: { metrics: required.metrics ?? [metric], metrics_updated_at: "2026-10-24T00:00:00Z" }, pagination: { next_url: required.next ?? null } }; }
export function invocation(required: { command?: RedditInvocation["command"] } = {}): RedditInvocation { return { context: structuredClone(context), operationId: "operation", command: required.command ?? { kind: "list_businesses" }, moneyExposure: null, requiredLimit: null }; }
export interface Fixture {
  capabilities: ReturnType<typeof createCapabilities>; adapter: ReturnType<typeof createRedditAdsAdapter>; dependencies: RedditDependencies;
  calls: { url: string; init: RequestInit }[]; credentialCalls: { connectionId: string; accountId: string | null }[]; observations: ObserverEvent[];
  deadline: AbortController; deadlineCalls: { timeoutMs: number }[];
  state: { admitted: boolean; time: number; body: unknown };
}
/** Memory credential broker/host fence plus real Response streams; reusable by the host suite.
 * Factory is inert. Each test owns its mutable fixture controls; no global runtime registry.
 */
export function fixture(required: { configuration?: Partial<RedditConfiguration>; response?: () => Response | Promise<Response>; credential?: unknown; credentialHook?: (required: { state: Fixture["state"] }) => void; observerThrows?: boolean } = {}): Fixture {
  const calls: Fixture["calls"] = [], credentialCalls: Fixture["credentialCalls"] = [], observations: ObserverEvent[] = [];
  const state: Fixture["state"] = { admitted: true, time: now, body: businessPage };
  const deadline = new AbortController(), deadlineCalls: Fixture["deadlineCalls"] = [];
  const dependencies: RedditDependencies = {
    configuration: { scope: context.scope, connectionId: "connection", accountId: "a2_fixture", currency: "USD", ...required.configuration },
    credentials: { async access(input) {
      credentialCalls.push(input); required.credentialHook?.({ state });
      return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret", expiresAt: now + 60000 }) as { accessToken: string } };
    } },
    fetch: async (url, init) => { if (!state.admitted) throw new Error("Host fence revoked"); calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response() : Response.json(state.body); },
    createDeadline: input => { deadlineCalls.push(input); return deadline.signal; },
    clock: { now: () => state.time }, observer: { observe(event) { if (required.observerThrows) throw new Error("synthetic-secret"); observations.push(event); } },
  };
  return { capabilities: createCapabilities({ ...dependencies, configuration: pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "a2_fixture", pluginDigest: "a".repeat(64), settings: { version: 1, enabled: false, capabilities: [] } }), wait: async () => ({ ok: true as const, value: undefined }) }), adapter: createRedditAdsAdapter(dependencies), dependencies, calls, credentialCalls, observations, state, deadline, deadlineCalls };
}

export const accountResponse = { data: { id: "a2_fixture", currency: "KRW", name: "Fixture account" } };
export const dailyMetric = { account_id: "a2_fixture", date: "2026-10-20T00:00:00Z", spend: "9007199254740993", impressions: "0", clicks: null };
/** Independent account and daily response fixtures; exact integers travel as JSON numbers. */
export function dailyFixture(required: { rows?: unknown[]; next?: string | null; account?: unknown; pages?: { rows: unknown[]; next?: string | null }[] } = {}) {
  let reads = 0;
  return fixture({ response: () => {
    if (++reads === 1) return Response.json(required.account ?? accountResponse);
    const page = required.pages?.[reads - 2];
    return new Response(JSON.stringify({ data: { metrics: page?.rows ?? required.rows ?? [dailyMetric] }, pagination: { next_url: page ? page.next ?? null : required.next ?? null } }).replaceAll('"9007199254740993"', "9007199254740993"), { headers: { "Content-Type": "application/json" } });
  } });
}
