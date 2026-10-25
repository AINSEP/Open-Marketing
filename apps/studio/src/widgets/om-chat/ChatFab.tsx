import type { RefObject } from "react";
import { NAV_ICONS } from "../../shared/navigation/index.js";

/** Visual-only assistant trigger; the chat hook continues to own toggling and focus return. */
export function ChatFab(props: { open: boolean; toggle: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  return <button className="chat-fab" type="button" hidden={props.open} ref={props.buttonRef} aria-label="Assistant" title="Open assistant" aria-expanded={props.open} aria-controls="om-chat" onClick={props.toggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: NAV_ICONS.assistant }} />
  </button>;
}
