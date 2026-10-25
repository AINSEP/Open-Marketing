import type { ObserverEvent } from "@open-marketing/contracts";
import { createAmazonSesAdapter } from "../src/index.js";
import type { SesConfiguration, SesDependencies, SesInvocation } from "../src/index.js";

export const now = 1791849600000;
export const context: SesInvocation["context"] = { scope: { ownerId: "owner", workspaceId: "workspace" },
  principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: SesConfiguration = { scope: context.scope, connectionId: "ses-connection", region: "us-east-1",
  domainIdentity: "example.com", pluginDigest: "a".repeat(64), bindingId: "binding" };
export const invocation: SesInvocation = { context, operationId: "operation", command: { kind: "account_status" } };
export const credential = { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", region: "us-east-1" };
export const account = { SendingEnabled: true, ProductionAccessEnabled: false,
  SendQuota: { Max24HourSend: 200, MaxSendRate: 1, SentLast24Hours: 12 }, PricingAttributes: { CurrentPlan: "ESSENTIALS" } };
/** Synthetic AWS-documented unlimited daily quota sentinel. */
export const unlimitedAccount = { ...account, SendQuota: { ...account.SendQuota, Max24HourSend: -1 } };
export const identity = { IdentityType: "DOMAIN", VerifiedForSendingStatus: true, VerificationStatus: "SUCCESS",
  DkimAttributes: { SigningEnabled: true, Status: "SUCCESS", Tokens: ["synthetictoken"] } };
/** Per-test synthetic ports. Integrator supplies the same harness over real host adapters. */
export function fixture(required: { response?: () => Response | Promise<Response> } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const observations: ObserverEvent[] = [];
  const dispatches: Parameters<SesDependencies["gateway"]["dispatch"]>[0][] = [];
  const state = { admitted: true, credentialsAllowed: true, credentialCalls: 0, time: now };
  const denied = { ok: false as const, error: { code: "forbidden" as const, message: "Denied", retryable: false } };
  const dependencies: SesDependencies = { configuration, clock: { now: () => state.time },
    observer: { observe: event => { observations.push(event); } },
    credentials: { async access() { state.credentialCalls++; if (!state.credentialsAllowed) return denied; return { ok: true, value: credential }; } },
    gateway: { async dispatch(input) { dispatches.push(input); if (!state.admitted) return denied; return input.execute(); } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} });
      if (required.response) return required.response(); return Response.json(account); },
  };
  return { dependencies, adapter: createAmazonSesAdapter(dependencies), calls, observations, dispatches, state,
    denyAdmission() { state.admitted = false; }, denyCredentials() { state.credentialsAllowed = false; } };
}
