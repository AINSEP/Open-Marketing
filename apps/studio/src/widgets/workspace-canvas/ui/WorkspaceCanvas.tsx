import { useWorkspaceCanvas } from "./WorkspaceCanvas.hooks.js";
import type { WorkspaceCanvasProps, WorkspaceCanvasModel } from "./WorkspaceCanvas.hooks.js";
import type { StudioMetric, StudioRow } from "../../../shared/api/index.js";
import type { NavigationTarget } from "@open-marketing/contracts";
import type { ReactElement } from "react";
import { CreativeMediaCanvas } from "./CreativeMediaCanvas.js";
import { CampaignSafetyCanvas } from "./CampaignSafetyCanvas.js";
import { OperationsCanvas } from "./OperationsCanvas.js";
import { CanvasEmptyState } from "./CanvasEmptyState.js";

/** Domain inspection through the existing API port; actions beyond exact review await j22. */
export function WorkspaceCanvas(props: WorkspaceCanvasProps): ReactElement {
  const canvas = useWorkspaceCanvas(props);
  return <section className="workspace-canvas" data-view={props.target}>
    <div className="preview-notice"><span aria-hidden="true">◈</span><p>{props.snapshot.mode === "sample" ? "Preview workspace. All content and approvals are samples; no external call or spend will run." : "Review server results before taking the next step."}</p></div>
    {props.target === "workspaces" && <><div className="metrics-grid">{canvas.metrics.map(renderMetric)}</div><section className="brief-banner"><div><span className="eyebrow">FROM INTENT TO IMPACT</span><h2>A little clarity.<br />A better campaign.</h2><p>Shape the idea. Review the creative.<br />Know exactly what happens next.</p><button type="button" className="primary-button" onClick={props.onOpenChat}>Start with an idea <span aria-hidden="true">↗</span></button></div><div className="banner-art" aria-hidden="true"><div className="art-orbit" /><div className="art-note">Make it<br /><em>meaningful.</em></div><span className="art-spark">✦</span></div></section></>}
    {props.target === "workspaces" ? <><div className="section-heading"><h2>{canvas.heading}</h2><span className="muted">{props.snapshot.mode === "sample" ? "SAMPLE CONTENT" : "WORKSPACE CONTENT"}</span></div><div className="canvas-grid">{canvas.rows.map(renderRow)}</div></> : canvas.emptyState ? <CanvasEmptyState model={canvas.emptyState} onOpenChat={props.onOpenChat} /> : <DomainCanvas model={canvas} target={props.target} />}
    <footer className="canvas-footer"><span>Intent → creative → campaign → evidence</span><span>Every spend call gets its own review.</span></footer>
  </section>;
}
function DomainCanvas(props: { readonly model: WorkspaceCanvasModel; readonly target: Exclude<NavigationTarget, "workspaces"> }): ReactElement {
  switch (props.target) {
    case "creative":
    case "media-library": return props.model.creative ? <CreativeMediaCanvas model={props.model.creative} target={props.target} /> : <p role="status">Domain details unavailable</p>;
    case "campaigns":
    case "settings": return props.model.campaigns ? <CampaignSafetyCanvas model={props.model.campaigns} target={props.target} /> : <p role="status">Domain details unavailable</p>;
    case "measure":
    case "connections":
    case "plugins":
    case "activity": return props.model.operations ? <OperationsCanvas model={props.model.operations} target={props.target} /> : <p role="status">Domain details unavailable</p>;
    default: { const exhaustive: never = props.target; throw new Error("Unsupported domain canvas: " + exhaustive); }
  }
}
function renderMetric(metric: StudioMetric) { return <article key={metric.label} className="metric-card"><span>{metric.label}</span><strong>{metric.value}</strong><p>{metric.detail}</p></article>; }
function renderRow(row: StudioRow) { return <article key={row.id} className="canvas-card"><div className="canvas-card-art" aria-hidden="true"><span>om</span></div><div className="canvas-card-body"><span className="row-status">{row.status}</span><h3>{row.title}</h3><p>{row.detail}</p></div></article>; }
