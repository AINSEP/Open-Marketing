import type { WhatsAppMessageDependencies, WhatsAppDeliveryReceipt } from "../src/index.js";
import type { CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createWhatsAppBusinessAdapter } from "../src/index.js";
import type { WhatsAppConfiguration, WhatsAppDependencies, WhatsAppInvocation } from "../src/index.js";
import type { Rates } from "../src/rates.js";

/** Deliberately synthetic prices, never production Meta rates. */
export const fixtureRates: Rates = {
  "North America": { marketing: "0.010001", utility: "0.020000", authentication: "0.010000", authenticationInternational: "0.030001" },
  "Rest of Latin America": { marketing: "0.040001", utility: "0.050000", authentication: "0.060000" },
};

/** Synthetic credentials/assets only. Each fixture owns its mutable authority and clock. */
export const now = 1792886400000;
export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const configuration: WhatsAppConfiguration = { scope: context.scope, connectionId: "meta-connection", accountId: "123", pluginDigest: "a".repeat(64), settings: {} };
export const resourceBinding = { scope: context.scope, wabaId: "123", phoneNumberId: "456" };
export const account = { id: "123", name: "Fixture", business_verification_status: "VERIFIED", account_review_status: "APPROVED", access_token: "synthetic-secret" };
export function invocation(required: { command?: WhatsAppInvocation["command"] } = {}): WhatsAppInvocation { return { context, operationId: "operation", command: required.command ?? { kind: "get_account_status" } }; }

/** Actual HTTP adapter over fixture fetch; memory broker stands in for server custody. */
export function fixture(required: { configuration?: WhatsAppConfiguration; response?: (required: { signal: AbortSignal }) => Response | Promise<Response>; credential?: unknown; credentialHook?: () => void; observerThrows?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const credentials: unknown[] = [];
  const observations: ObserverEvent[] = [];
  const deadlines: { timeoutMs: number; controller: AbortController }[] = [];
  const state = { credentialsAllowed: true, time: now };
  const dependencies: WhatsAppDependencies = {
    configuration: required.configuration ?? configuration,
    credentials: { async access(input) {
      credentials.push(input); required.credentialHook?.();
      if (!state.credentialsAllowed) return { ok: false, error: { code: "forbidden", message: "gateway-secret +15555550100 fixture-secret", retryable: true } };
      return { ok: true, value: (required.credential ?? { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: resourceBinding.wabaId, phoneNumberId: resourceBinding.phoneNumberId, appSecret: "app-secret" }), expiresAt: now + 1000 }) as { accessToken: string } };
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

/** Approved text-body template and USD account evidence; no vendor credentials or rates. */
export const approvedTemplate = { id: "789", name: "fixture", language: "en_US", status: "APPROVED", category: "MARKETING" };
/** Synthetic host authority/dedup around the real plugin; reads and submissions are separate. */
export function broadcastFixture(required: { transport?: "memory" | "http"; response?: () => Response | Promise<Response>;
  account?: unknown; templates?: unknown; readResponse?: (input: { url: string; signal: AbortSignal }) => Response | Promise<Response>;
  credential?: { accessToken: string; expiresAt?: number }; credentialHook?: () => void; authorityHook?: () => void;
  repeatExecute?: boolean; throwAfterExecute?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const reads: { url: string; init?: RequestInit }[] = [];
  const state = { consent: true, paid: true, grant: true, credentials: 0, authority: 0, time: now };
  const suppression = new Set<string>();
  const ledger = new Map<string, { digest: string; outcome: Outcome<WhatsAppDeliveryReceipt> }>();
  const observations: ObserverEvent[] = [];
  const authorityInputs: Parameters<WhatsAppMessageDependencies["authority"]>[0][] = [];
  const repeatOutcomes: Outcome<WhatsAppDeliveryReceipt>[] = [];
  const deadlines: { timeoutMs: number; controller: AbortController }[] = [];
  const denied: Outcome<never> = { ok: false, error: { code: "forbidden", message: "fixture denial", retryable: false } };
  const dependencies: WhatsAppMessageDependencies = { configuration,
    clock: { now: () => state.time }, observer: { observe(event) { observations.push(event); } },
    deadlineSignal: input => { const controller = new AbortController(); deadlines.push({ ...input, controller }); return controller.signal; },
    credentials: { async access() {
      state.credentials++; required.credentialHook?.();
      return { ok: true, value: required.credential ?? { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: resourceBinding.wabaId,
        phoneNumberId: resourceBinding.phoneNumberId, appSecret: "app-secret" }) } };
    } },
    async authority(input) {
      state.authority++; authorityInputs.push(input); required.authorityHook?.();
      if (!state.consent || !state.paid || !state.grant || suppression.has("+15555550100")) return denied;
      const prior = ledger.get(input.quote.quoteId);
      if (prior) return prior.digest === input.argumentsDigest ? prior.outcome : denied;
      const outcome = await input.execute();
      if (required.repeatExecute) repeatOutcomes.push(await input.execute());
      ledger.set(input.quote.quoteId, { digest: input.argumentsDigest, outcome });
      if (required.throwAfterExecute) throw new Error("synthetic ack failure");
      return outcome;
    },
    fetch: async (url, init) => {
      if (init?.method === "GET") {
        reads.push({ url: String(url), init });
        if (required.readResponse) return required.readResponse({ url: String(url), signal: init.signal! });
        return Response.json(String(url).includes("/message_templates?") ? required.templates ?? { data: [approvedTemplate] } : required.account ?? { currency: "USD" });
      }
      calls.push({ url: String(url), init });
      const response = await required.response?.() ?? Response.json({ messaging_product: "whatsapp", contacts: [{ input: "15555550100", wa_id: "15555550100" }], messages: [{ id: "wamid.fixture" }] }, { status: 201 });
      if (required.transport !== "http") return response;
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } };
  return { dependencies, calls, reads, state, suppression, ledger, observations, authorityInputs, repeatOutcomes, deadlines };
}
