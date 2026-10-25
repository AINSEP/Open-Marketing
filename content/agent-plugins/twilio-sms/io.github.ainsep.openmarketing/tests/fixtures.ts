import { vi } from "vitest";
import type { CallContext, ObserverEvent, Outcome } from "@open-marketing/contracts";
import { createTwilioSmsAdapter } from "../src/index.js";
import type { TwilioConfiguration, TwilioCredentialPort, TwilioDependencies, TwilioGatewayPort, TwilioInvocation, TwilioResult } from "../src/index.js";

/** Fake SIDs, credentials and deterministic time only; no provider requests. */
export const binding: TwilioConfiguration = { scope: { ownerId: "owner", workspaceId: "workspace" }, connectionId: "twilio", accountSid: "AC" + "a".repeat(32), messagingServiceSid: "MG" + "a".repeat(32), phoneNumberSid: "PN" + "a".repeat(32), pluginDigest: "a".repeat(64), admitted: true, registration: { kind: "us_a2p", brandSid: "BN" + "a".repeat(32), campaignSid: "QE" + "a".repeat(32) } };
/** Canonical trusted-context fixture; no assistant principal establishes host authority. */
export const context: CallContext = { scope: binding.scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
/** One account read, overridable only by test inputs. */
export const invocation: TwilioInvocation = { context, operationId: "operation", command: { kind: "account_status", connectionId: binding.connectionId } };
/** Vendor fixture includes tainted extras to prove projection strips secrets. */
export const accountBody = { sid: binding.accountSid, status: "active", type: "Trial", auth_token: "must-not-leak" };
/** Synthetic fixture matching https://help.twilio.com/articles/50301225354651; not a captured account response. */
export const accountDeniedBody = { code: 20003, message: "Authentication Error - invalid username", more_info: "https://www.twilio.com/docs/errors/20003", status: 401 };

/** Memory broker and executing host-gateway doubles; the real host adapters must share the suite.
 * @returns Isolated adapter/dependencies and observable calls. No I/O or hidden time reads.
 */
export function fixture(required: { configuration?: TwilioConfiguration; response?: () => Response; gateway?: TwilioGatewayPort } = {}) {
  const events: ObserverEvent[] = [];
  const deadline = new AbortController();
  const deadlineSignal = vi.fn<TwilioDependencies["deadlineSignal"]>(() => deadline.signal);
  const fetch = vi.fn<TwilioDependencies["fetch"]>(async () => required.response?.() ?? Response.json(accountBody));
  const credentials = { access: vi.fn<TwilioCredentialPort["access"]>(async () => ({ ok: true, value: { accountSid: binding.accountSid, apiKeySid: "SK" + "a".repeat(32), apiKeySecret: "fixture-secret" } })) };
  const gateway = required.gateway ?? { dispatch: vi.fn<TwilioGatewayPort["dispatch"]>(async input => input.execute()) };
  const dependencies: TwilioDependencies = { configuration: required.configuration ?? binding, fetch, credentials, gateway, deadlineSignal, clock: { now: () => 1000 }, observer: { observe: event => { events.push(event); } } };
  return { adapter: createTwilioSmsAdapter(dependencies), dependencies, fetch, credentials, gateway, events, deadline, deadlineSignal };
}
/** Host-denial fixture: neither its sensitive text nor retry authority may escape the adapter. */
export function denied(): Outcome<TwilioResult> { return { ok: false, error: { code: "forbidden", message: "gateway-secret +15555550100 fixture-secret", retryable: true } }; }
