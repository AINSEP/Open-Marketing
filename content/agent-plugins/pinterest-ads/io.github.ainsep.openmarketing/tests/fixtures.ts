import type { CallContext, EffectEnvelope, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createPinterestAdsAdapter } from "../src/index.js";
import type { PinterestConfiguration, PinterestDependencies, PinterestGatewayPort, PinterestInvocation } from "../src/index.js";

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
