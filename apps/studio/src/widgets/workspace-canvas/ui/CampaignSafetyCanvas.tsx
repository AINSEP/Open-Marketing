import { useCampaignOutcome } from "./WorkspaceCanvas.hooks.js";
import type { LaunchOutcomeRow } from "./WorkspaceCanvas.hooks.js";
import type { ReactElement } from "react";
import { ApprovalCard } from "../../../features/approve/index.js";
import type { CampaignSafetyModel, DraftView, AllowanceView, CampaignLaunchReviewProps } from "./WorkspaceCanvas.hooks.js";

/** Show server draft review, separate halt receipts, or allowance settings without mutations. */
export function CampaignSafetyCanvas(props: { readonly model: CampaignSafetyModel; readonly target: "campaigns" | "settings" }): ReactElement {
  return props.target === "settings" ? <>
    <div className="section-heading"><h2>Daily allowances</h2></div>
    <p className="muted domain-note">Amounts, usage, reservations and revisions are supplied by the API. Settings editing awaits server integration.</p>
    {props.model.allowances.map(renderAllowance)}
    {props.model.allowances.length === 0 && <p>Allowance settings unavailable.</p>}
    <p className="domain-note">Neither allowance grants ad-spend authority. Every ad-spend call requires its own exact approval.</p>
  </> : <>
    <div className="section-heading"><h2>Paused drafts and exact approvals</h2></div>
    <p className="muted domain-note">Review the grouped exact arguments, then inspect the server outcome. Activation requires a separate exact approval.</p>
    <div className="canvas-grid">{props.model.drafts.map(renderDraft)}</div>
    {props.model.drafts.length === 0 && <p>No draft reviews supplied.</p>}
    <section className="domain-section" aria-label="Account halt status"><div className="section-heading"><h2>Account halt status</h2></div>
      <p className="muted domain-note">A local dispatch barrier does not confirm remote ads stopped. Halt submission awaits server integration.</p>
      <div className="canvas-grid">{props.model.halts.map(renderHalt)}</div>
      {props.model.halts.length === 0 && <p>No halt receipts supplied; remote serving is unconfirmed.</p>}
    </section>
  </>;
}
function DraftCard(props: { readonly item: DraftView }): ReactElement {
  const outcome = useCampaignOutcome({ operationId: props.item.operationId, api: props.item.api, runtime: props.item.runtime });
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body">
    <span className="row-status">{props.item.status} · Review: {props.item.review}</span><h3>{props.item.title}</h3>
    <ul className="domain-evidence">{renderReasons({ reasons: props.item.reasons })}</ul>
    {props.item.approval ? <ApprovalCard {...props.item.approval} /> : <p>Launch approval unavailable · request a ready review and fresh exact card from the server.</p>}
    {outcome.available && <section className="launch-outcomes" aria-label="Launch outcomes"><h3>Per-vendor launch outcomes</h3><p role="status">{outcome.status}</p>
      <ul>{outcome.rows.map(renderOutcome)}</ul><div className="integration-actions"><button type="button" onClick={outcome.refresh} disabled={outcome.busy}>Refresh launch outcome</button><button type="button" onClick={outcome.reconcile} disabled={outcome.busy}>Reconcile deployment (read only)</button></div>
    </section>}
  </div></article>;
}
function HaltCard(props: { readonly item: CampaignSafetyModel["halts"][number] }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.account}><div className="canvas-card-body"><h3>{props.item.account}</h3>
    <dl className="domain-facts"><div><dt>Local dispatch barrier</dt><dd>{props.item.localBarrier}</dd></div><div><dt>Remote stop</dt><dd>{props.item.remoteStop}</dd></div></dl><p>{props.item.detail}</p>
    <details><summary>Operation and audit evidence</summary><code>Operation: {props.item.operationId}</code><code>Audit: {props.item.auditId}</code><a href="#activity">Inspect correlated activity</a></details>
  </div></article>;
}
function AllowanceCard(props: { readonly item: AllowanceView }): ReactElement {
  return <section className="settings-card" aria-label={props.item.title}><h2>{props.item.title}</h2>
    <dl><div><dt>Daily allowance</dt><dd>{props.item.dailyText}/day</dd></div><div><dt>Used</dt><dd>{props.item.usedText}</dd></div><div><dt>Reservations</dt><dd>{props.item.reservedText}</dd></div><div><dt>Remaining</dt><dd>{props.item.remainingText}</dd></div><div><dt>Owner timezone</dt><dd>{props.item.timezone}</dd></div></dl>
    <p>{props.item.reset}</p><p>Revision outcome: {props.item.revision}</p>
  </section>;
}
// Render scalar lists outside component bodies without defining nested callbacks.
function renderReasons({ reasons }: { reasons: readonly string[] }): ReactElement[] {
  const items: ReactElement[] = [];
  for (const reason of reasons) items.push(<li key={reason}>{reason}</li>);
  return items;
}
function renderDraft(item: DraftView): ReactElement { return <DraftCard key={item.id} item={item} />; }
function renderHalt(item: CampaignSafetyModel["halts"][number]): ReactElement { return <HaltCard key={item.id} item={item} />; }
function renderAllowance(item: AllowanceView): ReactElement { return <AllowanceCard key={item.id} item={item} />; }

function renderOutcome(row: LaunchOutcomeRow): ReactElement { return <li key={row.id}><strong>{row.vendor}</strong><p>{row.account}</p><span className="integration-status">{row.status}</span><code>{row.id}</code><code>{row.references}</code></li>; }

/** Session cards supply live authority; retained operation IDs keep outcomes reachable after resolution. */
export function CampaignLaunchReview(props: CampaignLaunchReviewProps): ReactElement {
  const outcome = useCampaignOutcome({ operationId: props.operationId, api: props.api, runtime: props.runtime });
  return <section className="settings-card" aria-label="Campaign launch review">{props.approval && <ApprovalCard key={props.approval.card.cardId} {...props.approval} />}
    <section className="launch-outcomes" aria-label="Launch outcomes"><h3>Per-vendor launch outcomes</h3><p role="status">{outcome.status}</p>
      <ul>{outcome.rows.map(renderOutcome)}</ul><div className="integration-actions"><button type="button" onClick={outcome.refresh} disabled={outcome.busy}>Refresh launch outcome</button><button type="button" onClick={outcome.reconcile} disabled={outcome.busy}>Reconcile deployment (read only)</button></div>
    </section>
  </section>;
}
