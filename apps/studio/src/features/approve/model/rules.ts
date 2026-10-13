import { confirmationCardSchema, parseBoundary } from "@open-marketing/contracts";
import type { ApprovalResponse, ConfirmationCard, Outcome } from "@open-marketing/contracts";
import { isSafeUiValue } from "../../../shared/api/index.js";

function denied<T>(): Outcome<T> { return { ok: false, error: { code: "forbidden", message: "Card is unavailable, expired, or does not permit this choice", retryable: false } }; }
/** Reject unsafe display data intact. Client checks add friction and never grant authority. */
export function readApprovalCard(required: { input: unknown }): Outcome<ConfirmationCard> {
  if (!isSafeUiValue({ value: required.input, maxCharacters: 32768 })) return denied();
  const parsed = parseBoundary({ schema: confirmationCardSchema, input: required.input });
  if (!parsed.ok) return parsed;
  const card = parsed.value;
  if (["spend", "destructive"].includes(card.classification) && card.allowedChoices.some(choice => isBroadChoice({ choice }))) return denied();
  return parsed;
}
function isBroadChoice(required: { choice: string }): boolean { return required.choice === "always_allow" || required.choice === "allow_chat"; }
/** Echo the immutable identifiers/digest and only a server-offered choice; never reconstruct arguments.
 * @example prepareApproval({ card, choice: "allow", now })
 * @complexity O(card bytes), bounded to 32768 characters.
 */
export function prepareApproval(required: { card: unknown; choice: ApprovalResponse["choice"]; now: number }): Outcome<ApprovalResponse> {
  const parsed = readApprovalCard({ input: required.card });
  if (!parsed.ok) return parsed;
  const card = parsed.value;
  if (required.now >= card.expiresAt || !card.allowedChoices.includes(required.choice)) return denied();
  return { ok: true, value: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: required.choice } };
}
