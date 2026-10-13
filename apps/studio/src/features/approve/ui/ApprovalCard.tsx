import { useApprovalCard } from "./ApprovalCard.hooks.js";
import type { ApprovalCardProps, ApprovalButton } from "./ApprovalCard.hooks.js";

/** Server-owned exact review card, rendered with native accessible controls. */
export function ApprovalCard(props: ApprovalCardProps) {
  const card = useApprovalCard(props);
  return <article className="approval-card" aria-label={card.title}>
    <header><span className="eyebrow">{card.classification}</span><h3>{card.title}</h3></header>
    <p className="muted">Review the exact arguments before deciding.</p>
    <pre aria-label="Exact arguments">{card.argumentsText}</pre>
    {card.valid && <details><summary>Operation and argument digest</summary><code>{card.operationId}</code><code>{card.digest}</code></details>}
    <fieldset disabled={card.disabled}><legend className="sr-only">Approval choices</legend>{card.buttons.map(renderApprovalButton)}</fieldset>
    <p role="status" className="card-status">{card.statusText}</p>
  </article>;
}
function renderApprovalButton(button: ApprovalButton) { return <button key={button.choice} type="button" className="approval-choice" data-choice={button.choice} onClick={button.onClick}>{button.label}</button>; }
