import { useLaunchSummary } from "../model/rules.js";
import type { LaunchDestinationSummary } from "../model/rules.js";
import { useApprovalCard } from "./ApprovalCard.hooks.js";
import type { ApprovalCardProps, ApprovalButton } from "./ApprovalCard.hooks.js";

/** Server-owned exact review card, rendered with native accessible controls. */
export function ApprovalCard(props: ApprovalCardProps) {
  const card = useApprovalCard(props);
  const launch = useLaunchSummary({ card: props.card });
  return <article className="approval-card" aria-label={card.title}>
    <header><span className="eyebrow">{card.classification}</span><h3>{card.title}</h3></header>
    {launch && <section aria-label="Grouped campaign launch">
      <div className="approval-summary"><div><h3>{launch.name}</h3><p>{launch.objective} · {launch.callCount} destination sequences</p></div><span className="integration-status">Exact launch review</span></div>
      <p>{launch.schedule}</p><p>Creatives: {launch.creatives}</p><p>Expires: {launch.expires}</p>
      <ul className="approval-destinations">{launch.destinations.map(renderDestination)}</ul>
      <p className="muted">Creates paused or draft entities. Daily budgets are not hard spending caps. Each currency is shown separately. Activation requires another exact review.</p>
    </section>}
    <p className="muted">Review the exact arguments before deciding.</p>
    <pre aria-label="Exact arguments">{card.argumentsText}</pre>
    {card.valid && <details><summary>Operation and argument digest</summary><code>{card.operationId}</code><code>{card.digest}</code></details>}
    <fieldset disabled={card.disabled}><legend className="sr-only">Approval choices</legend>{card.buttons.map(renderApprovalButton)}</fieldset>
    <p role="status" className="card-status">{card.statusText}</p>
  </article>;
}
function renderApprovalButton(button: ApprovalButton) { return <button key={button.choice} type="button" className="approval-choice" data-choice={button.choice} onClick={button.onClick}>{button.label}</button>; }

/** Narrow map callback for a parsed destination; exact JSON remains visible immediately below. */
function renderDestination(item: LaunchDestinationSummary) { return <li key={item.key}><strong>{item.vendor}</strong><span>{item.account}</span><span>Daily budget: {item.budget} · Expected flight exposure: {item.exposure}</span></li>; }
