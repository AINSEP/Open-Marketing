import { useWorkspaceCanvas } from "./WorkspaceCanvas.hooks.js";
import type { WorkspaceCanvasProps } from "./WorkspaceCanvas.hooks.js";
import type { StudioMetric, StudioRow } from "../../../shared/api/index.js";

/** Replaceable sample canvas; domain editing belongs to j19–j21. */
export function WorkspaceCanvas(props: WorkspaceCanvasProps) {
  const canvas = useWorkspaceCanvas(props);
  return <section className="workspace-canvas" data-view={props.target}>
    <div className="preview-notice"><span aria-hidden="true">◈</span><p>{props.snapshot.mode === "sample" ? "Preview workspace. All content and approvals are samples; no external call or spend will run." : "Review server results before taking the next step."}</p></div>
    {props.target === "workspaces" && <><div className="metrics-grid">{canvas.metrics.map(renderMetric)}</div><section className="brief-banner"><div><span className="eyebrow">FROM INTENT TO IMPACT</span><h2>A little clarity.<br />A better campaign.</h2><p>Shape the idea. Review the creative.<br />Know exactly what happens next.</p><button type="button" className="primary-button" onClick={props.onOpenChat}>Start with an idea <span aria-hidden="true">↗</span></button></div><div className="banner-art" aria-hidden="true"><div className="art-orbit" /><div className="art-note">Make it<br /><em>meaningful.</em></div><span className="art-spark">✦</span></div></section></>}
    {props.target === "settings" && <section className="settings-card"><h2>Image generation allowance</h2><dl><div><dt>Daily allowance</dt><dd>{canvas.daily}</dd></div><div><dt>Remaining</dt><dd>{canvas.remaining}</dd></div><div><dt>Owner timezone</dt><dd>{canvas.timezone}</dd></div></dl><p>Resets at owner-local midnight. A timezone change takes effect at the next rollover.</p><p className="muted">Generation within the allowance can use normal write grants. Above-allowance or unknown-cost generation requires an exact spend approval. Settings editing awaits the server.</p></section>}
    <div className="section-heading"><h2>{canvas.heading}</h2><span className="muted">{props.snapshot.mode === "sample" ? "SAMPLE CONTENT" : "WORKSPACE CONTENT"}</span></div>
    <div className="canvas-grid">{canvas.rows.map(renderRow)}</div>
    <footer className="canvas-footer"><span>Intent → creative → campaign → evidence</span><span>Every spend call gets its own review.</span></footer>
  </section>;
}
function renderMetric(metric: StudioMetric) { return <article key={metric.label} className="metric-card"><span>{metric.label}</span><strong>{metric.value}</strong><p>{metric.detail}</p></article>; }
function renderRow(row: StudioRow) { return <article key={row.id} className="canvas-card"><div className="canvas-card-art" aria-hidden="true"><span>om</span></div><div className="canvas-card-body"><span className="row-status">{row.status}</span><h3>{row.title}</h3><p>{row.detail}</p></div></article>; }
