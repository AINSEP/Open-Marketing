import type { A2uiSurfaceProps } from './A2uiSurface.hooks.js';
import { useStudioChartProviders } from '../../features/chart-providers/index.js';
import type { StudioChartHost, ChartProviderRegistry } from '../../features/chart-providers/index.js';
import { usePortSnapshot } from "../../shared/ui/index.js";
import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent, KeyboardEvent, RefObject } from "react";
import type { ChatSession, ChatState } from "../../features/chat-run/index.js";
import type { StudioApiPort } from "../../shared/api/index.js";
import type { StudioRuntime } from "../../shared/api/index.js";

import type { ApprovalCardProps } from "../../features/approve/index.js";

export interface OMChatPaneProps { readonly charts?: { host: StudioChartHost; revision: number | string }; readonly session: ChatSession; readonly api: StudioApiPort; readonly runtime: StudioRuntime; readonly sample: boolean; readonly available: boolean; readonly open: boolean; readonly toggle: () => void }
/** Named public model keeps shared JSON types behind their published aliases. */
export interface OMChatPaneModel {
  readonly surfaces: readonly A2uiSurfaceProps[];
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
  readonly conversationChanged: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly modelChanged: (event: ChangeEvent<HTMLSelectElement>) => void;
  readonly newChat: () => void;
  readonly selectedModel: string;
  readonly modeText: string;
  readonly conversations: readonly { id: string; title: string }[];
  readonly tools: readonly { id: string; text: string }[];
}
/** Panel focus is local: Escape closes it, restores the FAB, and does not cancel a remote run. */
export function useOMChatPane(required: OMChatPaneProps & { providers?: ChartProviderRegistry }): OMChatPaneModel {
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
  useEffect(() => { if (required.available && !required.sample) void required.session.refresh(); }, [required.available, required.sample, required.session]);
  const conversationChanged = (event: ChangeEvent<HTMLSelectElement>): void => {
    const conversationId = event.currentTarget.value;
    if (conversationId) void required.session.selectConversation({ conversationId });
    else void required.session.newConversation();
  };
  const modelChanged = (event: ChangeEvent<HTMLSelectElement>): void => {
    const model = event.currentTarget.value;
    if (model === 'sandbox' || model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5') void required.session.selectModel({ model });
  };
  const newChat = (): void => { void required.session.newConversation(); };
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
  return { surfaces: state.surfaces.map(surface => ({ surface, api: required.api, runtime: required.runtime, streaming: busy, succeeded: state.status === 'complete', providers: required.providers, onPendingApproval: required.session.addSurfaceApproval })), state, draft, change, submit, keyDown, cancel, busy, panelRef, buttonRef, cards: state.cards.map(card => ({ card, api: required.api, runtime: required.runtime, sample: required.sample })), sendDisabled: !required.available || busy || !draft.trim(), navigationText: navigationText({ state }), conversationChanged, modelChanged, newChat,
    selectedModel: state.settings?.settings.mode === 'model' ? state.settings.settings.model : 'sandbox', modeText: assistantMode({ state, sample: required.sample }),
    conversations: state.conversations.map(conversation => ({ id: conversation.conversationId, title: conversation.title })),
    tools: state.tools.map(tool => ({ id: tool.operationId, text: tool.name + ' · ' + tool.status })) };
}
/** One provider inventory snapshot for the entire chat, including all A2UI surfaces. */
export function usePluginOMChatPane(required: OMChatPaneProps & { charts: NonNullable<OMChatPaneProps['charts']> }): OMChatPaneModel {
  const snapshot = useStudioChartProviders(required.charts);
  return useOMChatPane({ ...required, providers: snapshot.providers });
}
function navigationText(required: { state: ReturnType<ChatSession["getSnapshot"]> }): string {
  const result = required.state.navigation;
  if (!result) return "";
  if (result.status === "completed") return "Opened " + result.target + " in this browser.";
  if (result.status === "failed") return "Navigation failed: " + result.error.message;
  return "Navigation pending browser acknowledgement.";
}

/** Current run mode is pinned by its server receipt; readiness describes the next turn only. */
function assistantMode(required: { state: ChatState; sample: boolean }): string {
 if (required.sample) return 'Sample conversation · no vendor calls';
 if (required.state.mode === 'sandbox') return 'Sandbox conversation · no model or vendor calls';
 if (required.state.mode === 'model') return 'Anthropic · ' + (required.state.settings?.settings.model ?? 'saved run model');
 if (required.state.settings?.settings.mode === 'model') return required.state.settings.ready ? 'Anthropic is ready' : 'Anthropic needs reconnecting in Integrations';
 return 'Sandbox · connect Anthropic in Add-ons / Integrations, then select a model';
}
