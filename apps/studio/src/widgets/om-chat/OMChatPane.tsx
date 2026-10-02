import { useOMChatPane } from "./OMChatPane.hooks.js";
/** Preserved app-global FAB/panel intent, using the OM process boundary. */
export function OMChatPane() {
 const chat = useOMChatPane({});
 return <aside className="chat"><button type="button" aria-expanded={chat.open} aria-controls="om-chat" onClick={chat.toggle}>Assistant</button>{chat.open && <section id="om-chat" aria-label="Assistant"><h2>Open Marketing assistant</h2><p>Agent runtime is not connected.</p><textarea aria-label="Message" disabled placeholder="Chat integration pending" /><button disabled>Send</button></section>}</aside>;
}
