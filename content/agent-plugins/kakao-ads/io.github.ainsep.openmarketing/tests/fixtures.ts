import type { CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createKakaoAdsAdapter } from "../src/index.js";
import type { KakaoConfiguration, KakaoDependencies, KakaoInvocation } from "../src/index.js";

/** Synthetic IDs, token and time only. No test uses a vendor account or native fetch. */
export const now = Date.parse("2026-10-24T00:00:00Z");
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const accounts = { content: [{ id: 123, name: "Fixture", config: "ON", memberType: "MASTER" }], number: 0, page: 0, size: 10, totalElements: 11, totalPages: 2 };
export const campaigns = { content: [{ id: 456, name: "Fixture campaign", config: "OFF", systemConfig: "ON" }] };
export const report = { code: 200, message: "Success", data: [{ start: "2026-10-01", end: "2026-10-01", dimensions: { ad_account_id: "123" }, metrics: { imp: 4, click: 0, ctr: 0, cost: 0 } }] };
export const reportCommand = { kind: "report" as const, start: "20261001", end: "20261001" };
export function invocation(required: { command?: KakaoInvocation["command"] } = {}): KakaoInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "list_accounts" } }; }
export interface FixtureOptions { configuration?: Partial<KakaoConfiguration>; response?: (required: { signal: AbortSignal }) => Response | Promise<Response>; credential?: unknown; credentialHook?: () => void; observerThrows?: boolean }

/** Fetch stays pending until the propagated signal aborts; no native I/O or timers. @complexity O(1). */
export function pendingFetch() {
  const started = Promise.withResolvers<AbortSignal>();
  return {
    started: started.promise,
    response(required: { signal: AbortSignal }): Promise<Response> {
      return new Promise((_resolve, reject) => {
        required.signal.addEventListener("abort", () => reject(new Error("synthetic-secret")), { once: true });
        started.resolve(required.signal);
      });
    },
  };
}

/** Body read stays pending until fetch's signal aborts, matching native fetch body errors.
 * Zero buffering ensures started means reader.read() is pending. @complexity O(1).
 */
export function pendingBody() {
  const started = Promise.withResolvers<{ signal: AbortSignal; body: ReadableStream<Uint8Array> }>();
  return {
    started: started.promise,
    response(required: { signal: AbortSignal }): Response {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          required.signal.addEventListener("abort", () => controller.error(new Error("synthetic-secret")), { once: true });
        },
        pull() { started.resolve({ signal: required.signal, body }); },
      }, { highWaterMark: 0 });
      return new Response(body);
    },
  };
}

/** Real plugin over synthetic HTTP and credential seams; host guarded-fetch substitute fails closed.
 * Server consumer: apps/server/tests/agent-plugin-backends.test.ts (integrator-owned, pending).
 */
export function fixture(required: FixtureOptions = {}) {
  const configuration = { scope: context.scope, connectionId: "connection", accountId: "123" as string | null, admitted: true, ...required.configuration };
  const calls: { url: string; init: RequestInit }[] = [];
  const credentialCalls: { connectionId: string; accountId: string | null }[] = [];
  const observations: ObserverEvent[] = [];
  const deadlines: { timeoutMs: number; controller: AbortController }[] = [];
  const state = { now, egressAllowed: true };
  const dependencies: KakaoDependencies = {
    configuration, clock: { now: () => state.now },
    createDeadlineSignal(input) {
      const controller = new AbortController();
      deadlines.push({ ...input, controller });
      return controller.signal;
    },
    credentials: { async access(input) {
      credentialCalls.push(input); required.credentialHook?.();
      const value = Object.hasOwn(required, "credential") ? required.credential : { accessToken: "synthetic-secret" };
      return { ok: true, value } as Outcome<{ accessToken: string }>;
    } },
    fetch: async (url, init) => {
      if (!state.egressAllowed) throw new Error("synthetic-secret");
      calls.push({ url: String(url), init: init ?? {} });
      if (!init?.signal) throw new Error("Missing abort signal");
      if (required.response) return required.response({ signal: init.signal });
      return Response.json(accounts);
    },
    observer: { observe(event) { if (required.observerThrows) throw new Error("synthetic-secret"); observations.push(event); } },
  };
  return { adapter: createKakaoAdsAdapter(dependencies), dependencies, configuration, calls, credentialCalls, observations, deadlines, state };
}
export type Fixture = ReturnType<typeof fixture>;
