/** Exact-card presentation only; current authorization and all effects remain server-owned. */
import { confirmationCardSchema, parseBoundary } from "@open-marketing/contracts";
import type { ApprovalResponse, ConfirmationCard, Outcome } from "@open-marketing/contracts";
import { failure, requestOm, routes, terminalText } from "./http.js";
import type { HttpSession } from "./http.js";

/** Launcher and fixture confirmation seams; only an explicit true records the offered choice. */
export interface ApprovalRuntime {
  readonly clock: { now(required: Record<string, never>): number };
  readonly stderr: { write(required: { text: string }): void };
  readonly confirm: (required: { card: ConfirmationCard; choice: ApprovalResponse["choice"] }) => Promise<boolean>;
}

const secretKey = /^(authorization|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|bearer|credentials?)$/i;
const secretText = /\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY-----/;

/** Same bounded rejection pattern as studio: reject intact instead of redacting exact arguments.
 * @complexity O(n) time, O(depth) stack for <=32 KiB and <=16 object levels.
 */
function safeValue(required: { value: unknown; depth: number }): boolean {
  if (required.depth > 16) return false;
  if (typeof required.value === "string") return !secretText.test(required.value);
  if (typeof required.value !== "object" || required.value === null) return true;
  return Object.entries(required.value).every(([key, value]) =>
    !secretKey.test(key) && safeValue({ value, depth: required.depth + 1 }));
}

/** Parse and reject unsafe or contradictory cards before terminal display or submission.
 * Broad spend/destructive choices use studio's rejection checks, never local grants.
 * @returns The complete card or a typed rejection; performs no effects.
 * @complexity O(n) time/space for n serialized bytes, capped at 32 KiB.
 */
export function readCard(required: { input: unknown }): Outcome<ConfirmationCard> {
  const serialized = JSON.stringify(required.input);
  if (!serialized || new TextEncoder().encode(serialized).byteLength > 32768) {
    return failure({ code: "limit_exceeded", message: "Approval card exceeds the 32 KiB display limit" });
  }
  if (!safeValue({ value: required.input, depth: 0 })) return failure({ code: "forbidden", message: "Unsafe approval card rejected" });
  const parsed = parseBoundary({ schema: confirmationCardSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const card = parsed.value;
  if (["spend", "destructive"].includes(card.classification) && card.allowedChoices.some(choice => choice === "allow_chat" || choice === "always_allow")) {
    return failure({ code: "forbidden", message: "Contradictory approval card rejected" });
  }
  return parsed;
}

/** Bind an answer to the current card and clock. Never reconstruct arguments or their digest. */
function prepareAnswer(required: { card: ConfirmationCard; cardId: string; choice: ApprovalResponse["choice"]; now: number }): Outcome<ApprovalResponse> {
  if (required.card.cardId !== required.cardId) return failure({ code: "conflict", message: "Server returned a different approval card" });
  if (!Number.isSafeInteger(required.now) || required.now < 0) return failure({ code: "unavailable", message: "Approval clock is unavailable" });
  if (required.now >= required.card.expiresAt) return failure({ code: "expired", message: "Approval card expired; fetch a current card" });
  if (!required.card.allowedChoices.includes(required.choice)) return failure({ code: "forbidden", message: "Choice is not offered by this card" });
  return { ok: true, value: {
    cardId: required.card.cardId, operationId: required.card.operationId,
    argumentsDigest: required.card.argumentsDigest, choice: required.choice,
  } };
}

/** Display precedes confirmation in every mode; a supplied digest never triggers a fallback prompt. */
async function confirmAnswer(required: { runtime: ApprovalRuntime; card: ConfirmationCard; choice: ApprovalResponse["choice"]; confirmDigest?: string }): Promise<Outcome<void>> {
  required.runtime.stderr.write({ text: "Approval card: " + terminalText({ text: JSON.stringify(required.card) }) + "\nChoice: " + required.choice + "\n" });
  if (required.confirmDigest !== undefined) {
    if (required.confirmDigest !== required.card.argumentsDigest) return failure({ code: "conflict", message: "Confirmation digest does not match the displayed card" });
    return { ok: true, value: undefined };
  }
  const confirmed = await required.runtime.confirm({ card: required.card, choice: required.choice });
  if (confirmed !== true) return failure({ code: "cancelled", message: "Explicit confirmation required; no answer submitted" });
  return { ok: true, value: undefined };
}

/** Fetch, validate, display, confirm, then submit the exact offered answer. Two HTTP calls, no retry.
 * Recheck expiry after the owner confirms; success means recorded, never executed.
 * @returns The recorded receipt or a typed failure; confirmation callback errors are caught by the runner.
 * @complexity O(card bytes) time/space, <=32 KiB; one GET and at most one POST.
 */
export async function answerApproval(required: {
  session: HttpSession; runtime: ApprovalRuntime; cardId: string;
  choice: ApprovalResponse["choice"]; confirmDigest?: string;
}): Promise<Outcome<{ status: "recorded" }>> {
  const fetched = await requestOm({ session: required.session, route: routes.approval, id: required.cardId });
  if (!fetched.ok) return fetched;
  const card = readCard({ input: fetched.value });
  if (!card.ok) return card;
  const answer = prepareAnswer({ card: card.value, cardId: required.cardId, choice: required.choice, now: required.runtime.clock.now({}) });
  if (!answer.ok) return answer;
  const confirmed = await confirmAnswer({ ...required, card: card.value });
  if (!confirmed.ok) return confirmed;
  const current = prepareAnswer({ card: card.value, cardId: required.cardId, choice: required.choice, now: required.runtime.clock.now({}) });
  if (!current.ok) return current;
  return requestOm({ session: required.session, route: routes.answer, id: required.cardId, body: current.value });
}
