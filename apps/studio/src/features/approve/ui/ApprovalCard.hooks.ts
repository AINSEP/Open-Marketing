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
  useEffect(() => {
    if (!parsed.ok) return;
    const handle = required.runtime.timers.schedule({ delayMs: Math.max(0, parsed.value.expiresAt - required.runtime.clock.now({})), callback: () => setNow(required.runtime.clock.now({})) });
    return () => required.runtime.timers.cancel({ handle });
  }, [parsed, required.runtime]);
  const submit = async (input: { choice: ApprovalResponse["choice"] }): Promise<void> => {
    if (locked.current || !parsed.ok) return;
    const response = prepareApproval({ card: parsed.value, choice: input.choice, now: required.runtime.clock.now({}) });
    if (!response.ok) { setStatus("expired"); return; }
    locked.current = true; setStatus("submitting");
    const controller = required.runtime.abort();
    const handle = required.runtime.timers.schedule({ delayMs: 15000, callback: () => { controller.abort(); setStatus("failed"); } });
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
