import type { TwilioMessageDependencies, TwilioDeliveryReceipt } from "../src/index.js";
import { vi } from "vitest";
import type { CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createTwilioSmsAdapter } from "../src/index.js";
import type { TwilioConfiguration, TwilioCredentialPort, TwilioDependencies, TwilioInvocation } from "../src/index.js";

/** Fake SIDs, credentials and deterministic time only; no provider requests. */
export const binding: TwilioConfiguration = { scope: { ownerId: "owner", workspaceId: "workspace" }, connectionId: "twilio", accountId: "AC" + "a".repeat(32), pluginDigest: "a".repeat(64), settings: {} };
export const resourceBinding = { scope: binding.scope, accountSid: binding.accountId, messagingServiceSid: "MG" + "a".repeat(32), phoneNumberSid: "PN" + "a".repeat(32), brandSid: "BN" + "a".repeat(32), campaignSid: "QE" + "a".repeat(32), tollfreeVerificationSid: "HH" + "a".repeat(32) };
export const credential = { accountSid: resourceBinding.accountSid, messagingServiceSid: resourceBinding.messagingServiceSid,
  phoneNumberSid: resourceBinding.phoneNumberSid, brandSid: resourceBinding.brandSid, campaignSid: resourceBinding.campaignSid,
  tollfreeVerificationSid: resourceBinding.tollfreeVerificationSid, apiKeySid: "SK" + "a".repeat(32), apiKeySecret: "fixture-secret" };
/** Canonical trusted-context fixture; no assistant principal establishes host authority. */
export const context: CallContext = { scope: binding.scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
/** One account read, overridable only by test inputs. */
export const invocation: TwilioInvocation = { context, operationId: "operation", command: { kind: "account_status" } };
/** Vendor fixture includes tainted extras to prove projection strips secrets. */
export const accountBody = { sid: binding.accountId, status: "active", type: "Trial", auth_token: "must-not-leak" };
/** Synthetic fixture matching https://help.twilio.com/articles/50301225354651; not a captured account response. */
export const accountDeniedBody = { code: 20003, message: "Authentication Error - invalid username", more_info: "https://www.twilio.com/docs/errors/20003", status: 401 };

/** Memory broker and fixture fetch; the real host adapters must share the suite.
 * @returns Isolated adapter/dependencies and observable calls. No I/O or hidden time reads.
 */
export function fixture(required: { configuration?: TwilioConfiguration; credential?: Record<string, unknown>; response?: () => Response } = {}) {
  const events: ObserverEvent[] = [];
  const deadline = new AbortController();
  const deadlineSignal = vi.fn<TwilioDependencies["deadlineSignal"]>(() => deadline.signal);
  const fetch = vi.fn<TwilioDependencies["fetch"]>(async () => required.response?.() ?? Response.json(accountBody));
  const credentials = { access: vi.fn<TwilioCredentialPort["access"]>(async () => ({ ok: true, value: { accessToken: JSON.stringify(required.credential ?? credential) } })) };
  const dependencies: TwilioDependencies = { configuration: required.configuration ?? binding, fetch, credentials, deadlineSignal, clock: { now: () => 1000 }, observer: { observe: event => { events.push(event); } } };
  return { adapter: createTwilioSmsAdapter(dependencies), dependencies, fetch, credentials, events, deadline, deadlineSignal };
}

/** R2 synthetic authority/inbox. The production subject-lane and durable adapters are host work. */
export function broadcastFixture(required: { transport?: "memory" | "http"; response?: () => Response | Promise<Response>;
  lookup?: unknown; pricing?: unknown; credentialHook?: () => void; repeatExecute?: boolean; throwAfterExecute?: boolean } = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const reads: { url: string; init?: RequestInit }[] = [];
  const quotes: Parameters<TwilioMessageDependencies["authority"]>[0]["quote"][] = [];
  const state = { consent: true, paid: true, grant: true, approvedTemplate: true, credentials: 0, authority: 0 };
  const suppression = new Set<string>();
  const ledger = new Map<string, { digest: string; outcome: Outcome<TwilioDeliveryReceipt> }>();
  const inbox = new Set<string>();
  const applied: { eventId: string; kind: string; recipient: string }[] = [];
  const observations: ObserverEvent[] = [];
  const denied: Outcome<never> = { ok: false, error: { code: "forbidden", message: "fixture denial", retryable: false } };
  const dependencies: TwilioMessageDependencies = { configuration: binding,
    clock: { now: () => 1792886400000 }, observer: { observe(event) { observations.push(event); } },
    deadlineSignal: () => new AbortController().signal,
    credentials: { async access() { state.credentials++; required.credentialHook?.(); return { ok: true, value: { accessToken: JSON.stringify(credential) } }; } },
    async authority(input, options) {
      state.authority++; quotes.push(input.quote);
      if (!state.consent || !state.paid || !state.grant || !state.approvedTemplate || suppression.size > 0) return denied;
      const prior = ledger.get(input.quote.quoteId);
      if (prior) return prior.digest === input.argumentsDigest ? prior.outcome : denied;
      const outcome = await input.execute();
      if (required.repeatExecute) await input.execute();
      ledger.set(input.quote.quoteId, { digest: input.argumentsDigest, outcome });
      if (required.throwAfterExecute) throw new Error("synthetic ack failure");
      return outcome;
    },
    fetch: async (url, init) => {
      if (init?.method === "GET") {
        reads.push({ url: String(url), init });
        return Response.json(String(url).includes("lookups.twilio.com")
          ? required.lookup ?? { valid: true, phone_number: "+15555550100", country_code: "US" }
          : required.pricing ?? { price_unit: "USD", outbound_sms_prices: [{ prices: [{ current_price: "0.0083" }] }] });
      }
      calls.push({ url: String(url), init });
      const response = await required.response?.() ?? Response.json({ sid: "SM" + "b".repeat(32), account_sid: binding.accountId, to: "+15555550100" }, { status: 201 });
      if (required.transport !== "http") return response;
      return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
    } };
  /** Commit replay marker and STOP together; no START event can erase suppression. */
  async function apply(input: { events: readonly { eventId: string; kind: string; recipient: string }[] }): Promise<Outcome<void>> {
    for (const event of input.events) {
      if (inbox.has(event.eventId)) continue;
      if (event.kind === "stop") suppression.add(event.recipient);
      applied.push(event); inbox.add(event.eventId);
    }
    return { ok: true, value: undefined };
  }
  return { dependencies, calls, reads, quotes, state, suppression, ledger, observations, inbox, applied, apply };
}
