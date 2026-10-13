import { usePortSnapshot } from "../../shared/ui/index.js";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import type { ChatSession, ChatState } from "../../features/chat-run/index.js";
import type { StudioApiPort } from "../../shared/api/index.js";
import type { StudioRuntime } from "../../shared/api/index.js";

import type { ApprovalCardProps } from "../../features/approve/index.js";

export interface OMChatPaneProps { readonly session: ChatSession; readonly api: StudioApiPort; readonly runtime: StudioRuntime; readonly sample: boolean; readonly available: boolean; readonly open: boolean; readonly toggle: () => void }
/** Named public model keeps shared JSON types behind their published aliases. */
export interface OMChatPaneModel {
  readonly state: ChatState;
  readonly draft: string;
  readonly change: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly submit: (event: FormEvent<HTMLFormElement>) => void;
  readonly keyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly cancel: () => void;
  readonly busy: boolean;
  readonly panelRef: RefObject<HTMLElement | null>;
  readonly buttonRef: RefObject<HTMLButtonElement | null>;
  readonly cards: readonly ApprovalCardProps[];
  readonly sendDisabled: boolean;
  readonly navigationText: string;
}
/** Panel focus is local: Escape closes it, restores the FAB, and does not cancel a remote run. */
export function useOMChatPane(required: OMChatPaneProps): OMChatPaneModel {
  const state = usePortSnapshot(required.session);
  const [draft, setDraft] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (required.open) panelRef.current?.focus();
    if (wasOpen.current && !required.open) buttonRef.current?.focus();
    wasOpen.current = required.open;
  }, [required.open]);
  const change = (event: ChangeEvent<HTMLTextAreaElement>): void => setDraft(event.currentTarget.value);
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!required.available || !draft.trim() || ["starting", "running", "cancelling"].includes(state.status)) return;
    const text = draft; setDraft(""); void required.session.send({ text });
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation(); required.toggle();
  };
  const cancel = (): void => { void required.session.cancel(); };
  const busy = ["starting", "running", "cancelling"].includes(state.status);
  return { state, draft, change, submit, keyDown, cancel, busy, panelRef, buttonRef, cards: state.cards.map(card => ({ card, api: required.api, runtime: required.runtime, sample: required.sample })), sendDisabled: !required.available || busy || !draft.trim(), navigationText: navigationText({ state }) };
}
function navigationText(required: { state: ReturnType<ChatSession["getSnapshot"]> }): string {
  const result = required.state.navigation;
  if (!result) return "";
  if (result.status === "completed") return "Opened " + result.target + " in this browser.";
  if (result.status === "failed") return "Navigation failed: " + result.error.message;
  return "Navigation pending browser acknowledgement.";
}
