import { A2uiSurface } from './A2uiSurface.js';
import type { A2uiSurfaceProps } from './A2uiSurface.hooks.js';
import type { ChatMessage, ConfirmationCard } from "@open-marketing/contracts";
import { ApprovalCard } from "../../features/approve/index.js";
import { useOMChatPane, usePluginOMChatPane } from "./OMChatPane.hooks.js";
import type { OMChatPaneProps, OMChatPaneModel } from "./OMChatPane.hooks.js";
import { ChatFab } from "./ChatFab.js";

/** Preserved global FAB and docked conversation; no old UI or daemon dependency. */
export function OMChatPane(props: OMChatPaneProps) {
  return props.charts ? <PluginChatPane {...props} charts={props.charts} /> : <FallbackChatPane {...props} />;
}
function PluginChatPane(props: OMChatPaneProps & { charts: NonNullable<OMChatPaneProps['charts']> }) {
  const chat = usePluginOMChatPane(props);
  return <ChatPaneView props={props} chat={chat} />;
}
function FallbackChatPane(props: OMChatPaneProps) {
  const chat = useOMChatPane(props);
  return <ChatPaneView props={props} chat={chat} />;
}
function ChatPaneView({ props, chat }: { props: OMChatPaneProps; chat: OMChatPaneModel }) {
  return <>
    <ChatFab buttonRef={chat.buttonRef} open={props.open} toggle={props.toggle} />
    <aside id="om-chat" className="chat-panel" hidden={!props.open} aria-label="Assistant" tabIndex={-1} ref={chat.panelRef} onKeyDown={chat.keyDown}>
      <header className="chat-header"><div><span className="eyebrow">Your thinking partner</span><h2>Open Marketing assistant</h2></div><button type="button" className="icon-button" aria-label="Close assistant" onClick={props.toggle}>×</button></header>
      <p className="chat-mode">{chat.modeText}</p>
      {!props.sample && <div>
        <label>Recent chats <select aria-label="Recent chats" value={chat.state.conversationId ?? ''} onChange={chat.conversationChanged} disabled={chat.busy}>
          <option value="">New chat</option>{chat.conversations.map(renderConversation)}
        </select></label>
        <button type="button" onClick={chat.newChat} disabled={chat.busy}>New chat</button>
        <label>Model <select aria-label="Assistant model" value={chat.selectedModel} onChange={chat.modelChanged} disabled={chat.busy || !chat.state.settings}>
          <option value="sandbox">Sandbox</option><option value="claude-sonnet-5-5">Sonnet 5.5</option><option value="claude-opus-5-5">Opus 5.5</option>
        </select></label>
      </div>}
      <div className="chat-transcript"><div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">{chat.state.messages.map(renderMessage)}</div>{chat.surfaces.map(renderSurface)}<ul aria-label="Tool activity">{chat.tools.map(renderTool)}</ul><div className="chat-cards">{chat.cards.map(renderCard)}</div></div>
      <div className="chat-notice" role="status">{chat.state.notice}{chat.navigationText && <p>{chat.navigationText}</p>}</div>
      <form className="chat-composer" onSubmit={chat.submit}><label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" name="message" aria-label="Message" placeholder="Shape an idea, or ask what’s next…" maxLength={65536} disabled={!props.available} value={chat.draft} onChange={chat.change} rows={3} /><div className="composer-actions"><span className="muted">Exact approval before spend.</span>{chat.busy && <button type="button" onClick={chat.cancel}>Stop</button>}<button className="primary-button" type="submit" disabled={chat.sendDisabled}>Send <span aria-hidden="true">↑</span></button></div></form>
    </aside>
  </>;
}
function renderMessage(message: ChatMessage) { return <article key={message.id} className="chat-message" data-role={message.role}><span className="message-author">{message.role === "assistant" ? "✦ Assistant" : "You"}</span><p>{message.text}</p></article>; }
/** React list renderer; every row is composed by the hook. */
function renderCard(props: { card: ConfirmationCard } & Pick<OMChatPaneProps, "api" | "runtime" | "sample">) { return <ApprovalCard key={props.card.cardId} card={props.card} api={props.api} runtime={props.runtime} sample={props.sample} />; }

/** Native options/list rows contain no handlers; the hook owns selection and activity projections. */
function renderConversation(conversation: { id: string; title: string }) { return <option key={conversation.id} value={conversation.id}>{conversation.title}</option>; }
function renderTool(tool: { id: string; text: string }) { return <li key={tool.id}>{tool.text}</li>; }

/** React list callback; hook supplies all dependencies and handlers. */
function renderSurface(props: A2uiSurfaceProps) { return <A2uiSurface key={props.surface.runId + props.surface.surfaceId} {...props} />; }
