import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalResponse, ConfirmationCard } from "@open-marketing/contracts";
import type { StudioApiPort } from "../../../shared/api/index.js";
import type { StudioRuntime } from "../../../shared/api/index.js";
import { prepareApproval, readApprovalCard } from "../model/rules.js";

export interface ApprovalCardProps { readonly card: ConfirmationCard; readonly api: StudioApiPort; readonly runtime: StudioRuntime; readonly sample: boolean }
const labels: Record<ApprovalResponse["choice"], string> = { allow: "Allow", allow_chat: "Allow for this chat", always_allow: "Always allow", cancel: "Cancel" };
export interface ApprovalButton { readonly choice: ApprovalResponse["choice"]; readonly label: string; readonly onClick: () => Promise<void> }
/** Keep deadline/submission effects out of markup; a synchronous ref prevents double-click writes. */
export function useApprovalCard(required: ApprovalCardProps) {
  const parsed = useMemo(() => readApprovalCard({ input: required.card }), [required.card]);
  const [status, setStatus] = useState("pending");
  const locked = useRef(false);
  const submission = useRef<{ controller: AbortController; handle: unknown } | null>(null);
  useEffect(() => () => {
    if (!submission.current) return;
    submission.current.controller.abort(); required.runtime.timers.cancel({ handle: submission.current.handle });
  }, [required.runtime]);
  const [now, setNow] = useState(required.runtime.clock.now({}));
  const exposure = useApprovalExposure({ ...required, parsed, now, locked });
  useEffect(() => {
    if (!parsed.ok) return;
    const handle = required.runtime.timers.schedule({ delayMs: Math.max(0, parsed.value.expiresAt - required.runtime.clock.now({})), callback: () => setNow(required.runtime.clock.now({})) });
    return () => required.runtime.timers.cancel({ handle });
  }, [parsed, required.runtime]);
  const submit = async (input: { choice: ApprovalResponse["choice"] }): Promise<void> => {
    if (locked.current || !parsed.ok) return;
    const decidedAt = required.runtime.clock.now({});
    const response = prepareApproval({ card: parsed.value, choice: input.choice, now: decidedAt });
    if (!response.ok) { setStatus("expired"); return; }
    locked.current = true; setStatus("submitting");
    required.runtime.track?.('approval.clicked', { cardId: parsed.value.cardId, operationId: parsed.value.operationId, choice: input.choice, durationMs: Math.max(0, decidedAt - (exposure.current?.at ?? decidedAt)) });
    const controller = required.runtime.abort();
    const handle = required.runtime.timers.schedule({ delayMs: 15000, callback: () => { controller.abort("timeout"); setStatus("failed"); } });
    submission.current = { controller, handle };
    const result = await required.api.approve({ response: response.value, signal: controller.signal });
    required.runtime.timers.cancel({ handle });
    submission.current = null;
    if (controller.signal.aborted) return;
    setStatus(result.ok ? "recorded" : "failed");
    // An unknown write outcome is reconciled through a fresh server card, never blindly retried.
  };
  const buttons: readonly ApprovalButton[] = parsed.ok ? [...new Set(parsed.value.allowedChoices)].map(choice => ({ choice, label: labels[choice], onClick: () => submit({ choice }) })) : [];
  const expired = parsed.ok && now >= parsed.value.expiresAt;
  return {
    valid: parsed.ok, buttons, title: parsed.ok ? cardTitle({ card: parsed.value }) : "Card cannot be displayed",
    classification: parsed.ok ? parsed.value.classification : "unavailable", argumentsText: parsed.ok ? JSON.stringify(parsed.value.arguments, null, 2) : "Unsafe or invalid server card rejected.",
    operationId: parsed.ok ? parsed.value.operationId : "", digest: parsed.ok ? parsed.value.argumentsDigest : "",
    disabled: expired || status !== "pending", statusText: statusText({ status, expired, sample: required.sample }),
  };
}
function cardTitle(required: { card: ConfirmationCard }): string {
  if (required.card.classification === "spend") return "Exact spend approval";
  if (required.card.classification === "destructive") return "Confirm destructive action";
  if (required.card.classification === "generation") return "Review generation";
  return "Review tool call";
}
function statusText(required: { status: string; expired: boolean; sample: boolean }): string {
  if (required.expired && required.status === "pending") return "Expired · request a fresh server card";
  switch (required.status) {
    case "recorded": return required.sample ? "Choice recorded in preview · no external call ran" : "Choice recorded · awaiting the server action result";
    case "submitting": return "Sending your choice…";
    case "failed": return "Choice could not be confirmed · refresh from the server before retrying";
    case "expired": return "Expired · request a fresh server card";
    default: return "Only the choices offered by the server are available.";
  }
}

/** One exposure survives effect replay; a remount is a new exposure. Invalid cards supply no IDs.
 * @complexity O(1) retained state; the existing card deadline drives unanswered expiry.
 */
function useApprovalExposure(required: ApprovalCardProps & { parsed: ReturnType<typeof readApprovalCard>; now: number; locked: { current: boolean } }) {
  const exposure = useRef<{ cardId: string | null; at: number; expired: boolean } | null>(null);
  useEffect(() => {
    try {
      const cardId = required.parsed.ok ? required.parsed.value.cardId : null;
      if (!exposure.current || exposure.current.cardId !== cardId) {
        exposure.current = { cardId, at: required.runtime.clock.now({}), expired: false };
        if (required.parsed.ok) required.runtime.track?.('approval.shown', { cardId: required.parsed.value.cardId, operationId: required.parsed.value.operationId });
        else required.runtime.track?.('approval.invalid_card', { errorCode: 'invalid_card' });
      }
      if (!required.parsed.ok || required.locked.current || exposure.current.expired || required.now < required.parsed.value.expiresAt) return;
      exposure.current.expired = true;
      required.runtime.track?.('approval.expired', { cardId: required.parsed.value.cardId, operationId: required.parsed.value.operationId, durationMs: Math.max(0, required.now - exposure.current.at) });
    } catch { /* Diagnostic clocks/capture never change card authority or deadlines. */ }
  }, [required.card, required.parsed, required.now, required.locked, required.runtime]);
  return exposure;
}
