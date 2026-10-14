import type { ReactElement } from "react";
import type { CanvasEmptyStateModel } from "./WorkspaceCanvas.hooks.js";

/** Shared first-use presentation; existing canvas classes supply ui-theme tokens.
 * Opening the assistant uses the shell's callback and does not submit a request.
 */
export function CanvasEmptyState(props: { readonly model: CanvasEmptyStateModel; readonly onOpenChat: () => void }): ReactElement {
  return <article className="canvas-card" aria-label="Get started">
    <div className="canvas-card-body">
      <p role="status">{props.model.message}</p>
      <p><a href={props.model.href}>{props.model.linkLabel}</a></p>
      <button type="button" className="primary-button" onClick={props.onOpenChat}>{props.model.assistantLabel}</button>
    </div>
  </article>;
}
