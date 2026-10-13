import type { ChatMessage, ConfirmationCard } from "@open-marketing/contracts";
import { ApprovalCard } from "../../features/approve/index.js";
import { useOMChatPane } from "./OMChatPane.hooks.js";
import type { OMChatPaneProps } from "./OMChatPane.hooks.js";

/** Preserved global FAB and docked conversation; no old UI or daemon dependency. */
export function OMChatPane(props: OMChatPaneProps) {
  const chat = useOMChatPane(props);
  return <>
    <button className="chat-fab" type="button" ref={chat.buttonRef} aria-label="Assistant" aria-expanded={props.open} aria-controls="om-chat" onClick={props.toggle}><span aria-hidden="true">✦</span><span>Assistant</span></button>
    <aside id="om-chat" className="chat-panel" hidden={!props.open} aria-label="Assistant" tabIndex={-1} ref={chat.panelRef} onKeyDown={chat.keyDown}>
      <header className="chat-header"><div><span className="eyebrow">Your thinking partner</span><h2>Open Marketing assistant</h2></div><button type="button" className="icon-button" aria-label="Close assistant" onClick={props.toggle}>×</button></header>
      <p className="chat-mode">{props.sample ? "Sample conversation · no vendor calls" : props.available ? "Server conversation" : "Agent runtime is not connected."}</p>
      <div className="chat-transcript"><div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text">{chat.state.messages.map(renderMessage)}</div><div className="chat-cards">{chat.cards.map(renderCard)}</div></div>
      <div className="chat-notice" role="status">{chat.state.notice}{chat.navigationText && <p>{chat.navigationText}</p>}</div>
      <form className="chat-composer" onSubmit={chat.submit}><label className="sr-only" htmlFor="chat-message">Message</label><textarea id="chat-message" name="message" aria-label="Message" placeholder="Shape an idea, or ask what’s next…" maxLength={65536} disabled={!props.available} value={chat.draft} onChange={chat.change} rows={3} /><div className="composer-actions"><span className="muted">Exact approval before spend.</span>{chat.busy && <button type="button" onClick={chat.cancel}>Stop</button>}<button className="primary-button" type="submit" disabled={chat.sendDisabled}>Send <span aria-hidden="true">↑</span></button></div></form>
    </aside>
  </>;
}
function renderMessage(message: ChatMessage) { return <article key={message.id} className="chat-message" data-role={message.role}><span className="message-author">{message.role === "assistant" ? "✦ Assistant" : "You"}</span><p>{message.text}</p></article>; }
/** React list renderer; every row is composed by the hook. */
function renderCard(props: { card: ConfirmationCard } & Pick<OMChatPaneProps, "api" | "runtime" | "sample">) { return <ApprovalCard key={props.card.cardId} card={props.card} api={props.api} runtime={props.runtime} sample={props.sample} />; }
