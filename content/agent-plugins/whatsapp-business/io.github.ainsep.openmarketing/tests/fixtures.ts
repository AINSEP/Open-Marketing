import type { CallContext, ObserverEvent } from "@open-marketing/contracts";
import { createWhatsAppBusinessAdapter } from "../src/index.js";
import type { WhatsAppConfiguration, WhatsAppDependencies, WhatsAppGatewayPort, WhatsAppInvocation } from "../src/index.js";

/** Synthetic credentials/assets only. Each fixture owns its mutable authority and clock. */
export const now = 1792886400000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: WhatsAppConfiguration = { scope: context.scope, connectionId: "meta-connection", wabaId: "123", phoneNumberId: "456", apiVersion: "v26.0", pluginDigest: "a".repeat(64), bindingId: "binding", admitted: true };
export const account = { id: "123", name: "Fixture", business_verification_status: "VERIFIED", account_review_status: "APPROVED", access_token: "synthetic-secret" };
export function invocation(required: { command?: WhatsAppInvocation["command"] } = {}): WhatsAppInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "get_account_status" } }; }

/** Actual HTTP adapter over fixture fetch; memory broker/gateway stand in for server custody. */
export function fixture(required: { configuration?: WhatsAppConfiguration; response?: (required: { signal: AbortSignal }) => Response | Promise<Response>; credential?: unknown; gateway?: WhatsAppGatewayPort; credentialHook?: () => void; observerThrows?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const credentials: unknown[] = [];
  const observations: ObserverEvent[] = [];
  const deadlines: { timeoutMs: number; controller: AbortController }[] = [];
  const state = { admitted: true, time: now };
  const dependencies: WhatsAppDependencies = {
    configuration: required.configuration ?? configuration,
    gateway: required.gateway ?? { async dispatch(input) {
      if (!state.admitted) return { ok: false, error: { code: "forbidden", message: "Fixture denial", retryable: false } };
      return input.execute();
    } },
    credentials: { async access(input) {
      credentials.push(input); required.credentialHook?.();
      return { ok: true, value: (required.credential ?? { accessToken: "synthetic-secret", expiresAt: now + 1000 }) as { accessToken: string } };
    } },
    fetch: async (url, init) => { calls.push({ url: String(url), init }); return required.response?.({ signal: init!.signal! }) ?? Response.json(account); },
    createDeadline: input => { const controller = new AbortController(); deadlines.push({ ...input, controller }); return controller.signal; },
    clock: { now: () => state.time },
    observer: { observe(event) { if (required.observerThrows) throw new Error("fixture"); observations.push(event); } },
  };
  return { adapter: createWhatsAppBusinessAdapter(dependencies), calls, credentials, observations, state, deadlines };
}

/** Pending fetch/body fixtures reject on the supplied signal. Stream pull waits for an actual
 * reader (zero prefetch); Promise/Streams callbacks follow the platform ABI. No real timers.
 */
export function pendingResponse(required: { signal: AbortSignal; phase: "fetch" | "body"; ready: () => void }): Promise<Response> | Response {
  if (required.phase === "fetch") return new Promise((_resolve, reject) => {
    required.signal.addEventListener("abort", () => reject(new Error("synthetic-secret")), { once: true });
    required.ready();
  });
  return new Response(new ReadableStream({ pull(controller) {
    required.signal.addEventListener("abort", () => controller.error(new Error("synthetic-secret")), { once: true });
    required.ready();
  } }, { highWaterMark: 0 }));
}
