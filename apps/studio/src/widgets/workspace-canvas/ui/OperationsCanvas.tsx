import type { ReactElement } from "react";
import type { OperationsModel, ReportView } from "./WorkspaceCanvas.hooks.js";

/** Source-labelled evidence and sanitized capability status; recovery actions await j22. */
export function OperationsCanvas(props: { readonly model: OperationsModel; readonly target: "measure" | "connections" | "plugins" | "activity" }): ReactElement {
  return <>
    {props.target === "measure" && <>
      <div className="section-heading"><h2>Three views of evidence</h2></div>
      <p className="muted domain-note">OM ledger costs, platform reports and OM attribution have separate truth models. CAC availability and reasons come from the API; platform totals are not summed here.</p>
      <div className="canvas-grid">{props.model.reports.map(renderReport)}</div>
      {props.model.reports.length === 0 && <p>No report evidence supplied.</p>}
      <section className="settings-card domain-section" aria-label="Measurement grant"><h2>Measurement grant</h2><p>Status: {props.model.measurementGrant.status}</p>
        <dl><div><dt>Events</dt><dd>{props.model.measurementGrant.events.map(renderScope)}</dd></div><div><dt>Destinations</dt><dd>{props.model.measurementGrant.destinations.map(renderScope)}</dd></div><div><dt>Purpose</dt><dd>{props.model.measurementGrant.purposes.map(renderScope)}</dd></div></dl><p>{props.model.measurementGrant.detail}</p><p className="muted">Grant editing awaits server integration.</p>
      </section>
    </>}
    {props.target === "connections" && <>
      <p className="muted domain-note">Credentials stay on the server. Browser connection and reauthentication flows await server integration.</p>
      <div className="canvas-grid">{props.model.connections.map(renderConnection)}</div>
      {props.model.connections.length === 0 && <p>No connection summaries supplied.</p>}
    </>}
    {props.target === "plugins" && <>
      <p className="muted domain-note">Installation grants no spend authority. Install, update and revoke controls await server integration.</p>
      <div className="canvas-grid">{props.model.plugins.map(renderPlugin)}</div>
      {props.model.plugins.length === 0 && <p>No plugin summaries supplied.</p>}
    </>}
    {props.target === "activity" && <>
      <p className="muted domain-note">Follow operation, job and audit evidence together. Recorded approvals do not confirm execution.</p>
      <div className="canvas-grid">{props.model.activity.map(renderActivity)}</div>
      {props.model.activity.length === 0 && <p>No activity evidence supplied.</p>}
    </>}
  </>;
}
function ReportCard(props: { readonly item: ReportView }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body"><span className="row-status">{props.item.sourceText}</span><h3>{props.item.title}</h3><p>{props.item.period}</p>
    <dl className="domain-facts"><div><dt>CAC</dt><dd>{props.item.cacText}</dd></div></dl>{props.item.cacReason && <p>{props.item.cacReason}</p>}
    <details open><summary>Freshness, gaps and restatement</summary><p>{props.item.freshness}</p><ul className="domain-evidence">{props.item.gaps.map(renderGap)}</ul><p>{props.item.restatementText}</p><code>{props.item.id}</code>{props.item.restates && <a href="#activity">Inspect restatement activity</a>}</details>
  </div></article>;
}
function ConnectionCard(props: { readonly item: OperationsModel["connections"][number] }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body"><span className="row-status">{props.item.status}</span><h3>{props.item.title}</h3><p>{props.item.scope}</p><p>{props.item.recovery}</p><a href="#plugins">Inspect required plugins</a></div></article>;
}
function PluginCard(props: { readonly item: OperationsModel["plugins"][number] }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body"><span className="row-status">{props.item.status}</span><h3>{props.item.title}</h3><p>Version {props.item.version}</p><p>{props.item.authority}</p><p>{props.item.recovery}</p><a href="#connections">Inspect account connection</a></div></article>;
}
function ActivityCard(props: { readonly item: OperationsModel["activity"][number] }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body"><span className="row-status">{props.item.status}</span><h3>{props.item.title}</h3><p>{props.item.detail}</p>
    <details open><summary>Operation, job and audit evidence</summary><code>Operation: {props.item.operationId}</code><code>Job: {props.item.jobId ?? "No job evidence supplied"}</code><code>Audit: {props.item.auditId ?? "No audit evidence supplied"}</code></details>
  </div></article>;
}
// Standard map callbacks are markup wrappers; no domain state is inferred here.
function renderGap(gap: string): ReactElement { return <li key={gap}>{gap}</li>; }
function renderScope(scope: string): ReactElement { return <span className="domain-scope" key={scope}>{scope}</span>; }
function renderReport(item: ReportView): ReactElement { return <ReportCard key={item.id} item={item} />; }
function renderConnection(item: OperationsModel["connections"][number]): ReactElement { return <ConnectionCard key={item.id} item={item} />; }
function renderPlugin(item: OperationsModel["plugins"][number]): ReactElement { return <PluginCard key={item.id} item={item} />; }
function renderActivity(item: OperationsModel["activity"][number]): ReactElement { return <ActivityCard key={item.id} item={item} />; }
