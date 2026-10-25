import type { ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createResendEmailAdapter } from "../src/index.js";
import type { ResendEmailDependencies, ResendEmailGatewayPort, ResendEmailInvocation } from "../src/index.js";

/** Synthetic fixture values; real host adapters must run the same dispatch suite. */
export const domainId = "d91cd9bd-1176-453e-8fc1-35364d380206";
export const domain = { id: domainId, name: "example.com", status: "verified", open_tracking: false, click_tracking: false, capabilities: { sending: "enabled" }, records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "fixture", status: "verified", ttl: "Auto" }] };
export function invocation(required: { command?: ResendEmailInvocation["command"] } = {}): ResendEmailInvocation {
  return { context: { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" }, operationId: "operation",
    command: required.command ?? { kind: "domain_status", limit: 100 } };
}
export type FixtureOptions = { response?: (required: { signal: AbortSignal }) => Response | Promise<Response>; deadline?: ResendEmailDependencies["deadline"]; credentialHook?: () => void; credential?: unknown; gateway?: ResendEmailGatewayPort };
export function denial(): Outcome<never> { return { ok: false, error: { code: "forbidden", message: "Fixture denied", retryable: false } }; }
/** Synthetic admission/connection fence only; never a production authorization implementation. */
export function fixture(required: FixtureOptions = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const observations: ObserverEvent[] = [];
  const effects: Parameters<ResendEmailGatewayPort["dispatch"]>[0][] = [];
  const state = { admitted: true, connection: true, credentialCalls: 0 };
  const gateway: ResendEmailGatewayPort = required.gateway ?? { async dispatch(input) {
    effects.push(input);
    if (!state.admitted || !state.connection) return denial();
    return input.execute();
  } };
  const dependencies: ResendEmailDependencies = {
    configuration: { scope: invocation().context.scope, connectionId: "connection", pluginDigest: "a".repeat(64), bindingId: "binding" }, gateway,
    credentials: { async access() { state.credentialCalls++; required.credentialHook?.(); return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret" }) as { accessToken: string } }; } },
    fetch: async (url, init) => { calls.push({ url: String(url), init: init ?? {} }); return required.response ? required.response({ signal: init!.signal! }) : Response.json({ data: [domain], has_more: false }); },
    deadline: required.deadline ?? (() => new AbortController().signal),
    observer: { observe(event) { observations.push(event); } },
  };
  return { adapter: createResendEmailAdapter(dependencies), dependencies, calls, effects, state, observations };
}
export type Fixture = ReturnType<typeof fixture>;
