import type { CallContext, EffectEnvelope, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createYandexDirectAdapter } from "../src/index.js";
import type { YandexDirectConfiguration, YandexDirectDependencies, YandexDirectInvocation } from "../src/index.js";

/** Synthetic token/account and injected time only. Nothing contacts a vendor. */
export const now = 1792800000000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: YandexDirectConfiguration = { scope: context.scope, connectionId: "connection", accountId: "123", clientLogin: "fixture-login", currency: "RUB", apiVersion: "v501", pluginDigest: "a".repeat(64), bindingId: "binding" };
export const account = { ClientId: 123, Login: "fixture-login", Currency: "RUB", Type: "CLIENT" };
export const campaign = { Id: 456, Name: "Fixture", Type: "UNIFIED_CAMPAIGN", State: "OFF", Status: "DRAFT" };
export const report = { kind: "report" as const, view: "campaign" as const, dateFrom: "2026-10-01", dateTo: "2026-10-02", campaignIds: ["456"] };
export const tsv = "Date\tCampaignId\tImpressions\tClicks\tCost\n2026-10-01\t456\t9007199254740993\t2\t12345678901234567890\n";
export function invocation(required: { command?: YandexDirectInvocation["command"]; operationId?: string } = {}): YandexDirectInvocation { return { context, operationId: required.operationId ?? "operation", command: required.command ?? { kind: "list_campaigns" }, moneyExposure: null, requiredLimit: null }; }
export function denied(required: { code?: "forbidden" | "conflict" } = {}): Outcome<never> { return { ok: false, error: { code: required.code ?? "forbidden", message: "Fixture denial", retryable: false } }; }

/** Server integration must implement this same fixture seam for the shared dispatch suite. */
export type Fixture = ReturnType<typeof fixture>;
export function fixture(required: { response?: (required: RequestInit) => Response | Promise<Response>; credentialHook?: () => void; configuration?: YandexDirectConfiguration; credential?: unknown; repeatExecute?: boolean; observerThrows?: boolean } = {}) {
  const state = { admitted: true, authorized: true, time: now };
  const calls: { url: string; init: RequestInit }[] = [];
  const credentialCalls: { connectionId: string; accountId?: string }[] = [];
  const effects: EffectEnvelope[] = [];
  const observations: ObserverEvent[] = [];
  const deadlines: { milliseconds: number; controller: AbortController }[] = [];
  const dependencies: YandexDirectDependencies = {
    configuration: required.configuration ?? configuration, admitted: () => state.admitted,
    credentials: { async access(input) { credentialCalls.push(input); required.credentialHook?.(); return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret", expiresAt: now + 60000 }) as { accessToken: string } }; } },
    gateway: { async dispatch(input) {
      effects.push(input.effect);
      if (!state.authorized || !state.admitted) return denied();
      const first = await input.execute();
      return required.repeatExecute ? input.execute() : first;
    } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response(init ?? {}) : Response.json({ result: { Campaigns: [campaign] } }); },
    createDeadline(input) { const controller = new AbortController(); deadlines.push({ ...input, controller }); return controller.signal; },
    clock: { now: () => state.time }, observer: { observe(event) { if (required.observerThrows) throw new Error("fixture telemetry"); observations.push(event); } },
  };
  return { adapter: createYandexDirectAdapter(dependencies), state, calls, credentialCalls, effects, observations, dependencies, deadlines };
}
