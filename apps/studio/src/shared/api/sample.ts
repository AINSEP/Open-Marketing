import { approvalResponseSchema, cancelRunSchema, chatMessageSchema, navigationResultSchema, navigationTargetSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome, RunEvent, NavigationResult, ConfirmationCard, ApprovalResponse } from "@open-marketing/contracts";
import type { StudioApiPort, StudioRun, StudioPayload } from "./types.js";
import type { StudioRuntime } from "./types.js";
import { parseStudioSnapshot } from "./validation.js";
import { sampleSnapshot } from "./sample-data.js";

interface SampleRun { readonly receipt: StudioRun; readonly prompt: string; cancelled: boolean }
function unavailable<T>(): Outcome<T> { return { ok: false, error: { code: "unavailable", message: "Sample run unavailable", retryable: false } }; }
function fixturePayloads(required: { run: SampleRun }): readonly StudioPayload[] {
  const target = navigationTargetSchema.safeParse(required.run.prompt.trim().replace(/^open\s+/i, ""));
  const payloads: StudioPayload[] = [{ type: "status", text: "Sample response · no external tools" }, { type: "message", message: { id: required.run.receipt.runId + "-reply", role: "assistant", text: "Let's start with the audience, the promise, and one clear next step. You can review the sample approvals below, or ask me to open campaigns. No vendor call will run in this preview." } }];
  if (target.success) payloads.push({ type: "navigation", action: { kind: "navigate", actionId: required.run.receipt.runId + "-nav", target: target.data } });
  payloads.push({ type: "status", text: "Sample reply complete" });
  return payloads;
}
function fixtureEvent(required: { runId: string; sequence: number; payload: StudioPayload; last: boolean }): RunEvent {
  return { protocolVersion: 1, eventId: required.runId + "-" + required.sequence, runId: required.runId, sequence: required.sequence, correlationId: required.runId + "-correlation", traceId: required.runId + "-trace", kind: required.last ? "ended" : "delta", payload: JSON.parse(JSON.stringify(required.payload)) };
}
/** In-memory sample adapter, bounded to 100 runs, with no vendor or network effects.
 * Approval means recorded in this preview, never dispatched. Replace at composition only.
 * @example createSampleStudioApi({ runtime })
 * @complexity O(1) lookup; event count and retained runs are bounded.
 */
export function createSampleStudioApi(required: { runtime: StudioRuntime }): StudioApiPort {
  const snapshot = sampleSnapshot({ clock: required.runtime.clock });
  const decisions = new Map<string, string>();
  const runs = new Map<string, SampleRun>();
  const acknowledgements: NavigationResult[] = [];
  return {
    async snapshot() { return parseStudioSnapshot({ input: snapshot }); },
    async start(input) {
      const message = parseBoundary({ schema: chatMessageSchema, input: input.message });
      if (!message.ok) return message;
      if (message.value.role !== "user" || input.signal.aborted || runs.size >= 100) return unavailable();
      const runId = required.runtime.ids.next({});
      const receipt: StudioRun = { runId, status: "pending", expiresAt: required.runtime.clock.now({}) + 60000 };
      runs.set(runId, { receipt, prompt: message.value.text, cancelled: false });
      return { ok: true, value: receipt };
    },
    async *events(input) {
      const run = runs.get(input.runId);
      if (!run) { yield unavailable(); return; }
      const payloads = fixturePayloads({ run });
      for (let index = input.after; index < payloads.length; index += 1) {
        await required.runtime.timers.wait({ delayMs: 450, signal: input.signal });
        if (input.signal.aborted || run.cancelled) return;
        yield { ok: true, value: fixtureEvent({ runId: input.runId, sequence: index + 1, payload: payloads[index], last: index === payloads.length - 1 }) };
      }
    },
    async cancel(input) {
      const parsed = parseBoundary({ schema: cancelRunSchema, input: { protocolVersion: 1, ...input } });
      if (!parsed.ok) return parsed;
      const run = runs.get(input.runId);
      if (!run) return unavailable();
      run.cancelled = true;
      return { ok: true, value: { runId: input.runId, status: "cancelled" } };
    },
    async approve(input) {
      const parsed = parseBoundary({ schema: approvalResponseSchema, input: input.response });
      if (!parsed.ok) return parsed;
      const card = snapshot.cards.find(card => card.cardId === parsed.value.cardId);
      if (!card || !matchesCard({ card, response: parsed.value, now: required.runtime.clock.now({}) })) return { ok: false, error: { code: "forbidden", message: "Sample card no longer permits this response", retryable: false } };
      const previous = decisions.get(card.cardId);
      if (previous !== undefined && previous !== parsed.value.choice) return { ok: false, error: { code: "conflict", message: "Sample card already has a different choice", retryable: false } };
      decisions.set(card.cardId, parsed.value.choice);
      return { ok: true, value: { status: "recorded" } };
    },
    async acknowledgeNavigation(input) {
      const parsed = parseBoundary({ schema: navigationResultSchema, input: input.result });
      if (!parsed.ok) return parsed;
      if (acknowledgements.length === 100) acknowledgements.shift();
      acknowledgements.push(parsed.value);
      return { ok: true, value: { status: "recorded" } };
    },
  };
}

/** Fixture-side acknowledgement checks identity, digest, expiry and the offered choices. */
function matchesCard(required: { card: ConfirmationCard; response: ApprovalResponse; now: number }): boolean {
  return required.card.operationId === required.response.operationId && required.card.argumentsDigest === required.response.argumentsDigest && required.card.expiresAt > required.now && required.card.allowedChoices.includes(required.response.choice);
}
