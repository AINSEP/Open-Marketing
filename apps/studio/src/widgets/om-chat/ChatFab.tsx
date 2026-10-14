import type { RefObject } from "react";

/** Visual-only assistant trigger; the chat hook continues to own toggling and focus return. */
export function ChatFab(props: { open: boolean; toggle: () => void; buttonRef: RefObject<HTMLButtonElement | null> }) {
  return <button className="chat-fab" type="button" ref={props.buttonRef} aria-label="Assistant" title="Open assistant" aria-expanded={props.open} aria-controls="om-chat" onClick={props.toggle}>
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m10 3 2.1 5.9L18 11l-5.9 2.1L10 19l-2.1-5.9L2 11l5.9-2.1L10 3Z" /><path d="m19 2 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" /><path d="m19 15 1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3Z" /></svg>
  </button>;
}
