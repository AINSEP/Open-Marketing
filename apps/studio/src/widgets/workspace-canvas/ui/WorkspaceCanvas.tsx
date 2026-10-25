import { useWorkspaceCanvas } from "./WorkspaceCanvas.hooks.js";
import type { WorkspaceCanvasProps, WorkspaceCanvasModel, CampaignLaunchReviewProps } from "./WorkspaceCanvas.hooks.js";
import type { StudioMetric, StudioRow } from "../../../shared/api/index.js";
import type { NavigationTarget } from "@open-marketing/contracts";
import type { ReactElement } from "react";
import { CreativeMediaCanvas } from "./CreativeMediaCanvas.js";
import { CampaignSafetyCanvas, CampaignLaunchReview } from "./CampaignSafetyCanvas.js";
import { OperationsCanvas } from "./OperationsCanvas.js";
import { CanvasEmptyState } from "./CanvasEmptyState.js";

/** Domain inspection and grouped launch reviews through the existing server API. */
export function WorkspaceCanvas(props: WorkspaceCanvasProps): ReactElement {
  const canvas = useWorkspaceCanvas(props);
  return <section className="workspace-canvas" data-view={props.target}>
    <div className="preview-notice"><span aria-hidden="true">◈</span><p>{props.snapshot.mode === "sample" ? "Preview workspace. All content and approvals are samples; no external call or spend will run." : "Review server results before taking the next step."}</p></div>
    {props.target === "workspaces" && <div className="metrics-grid">{canvas.metrics.map(renderMetric)}</div>}
    {props.target === "campaigns" && <div>{canvas.launches.map(renderLaunch)}</div>}
    {props.target === "workspaces" ? <><div className="section-heading"><h2>{canvas.heading}</h2><span className="muted">{props.snapshot.mode === "sample" ? "SAMPLE CONTENT" : "WORKSPACE CONTENT"}</span></div><div className="canvas-grid">{canvas.rows.map(renderRow)}</div></> : canvas.emptyState ? props.target === "campaigns" && canvas.launches.length > 0 ? null : <CanvasEmptyState model={canvas.emptyState} onOpenChat={props.onOpenChat} /> : <DomainCanvas model={canvas} target={props.target} />}
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
function renderRow(row: StudioRow) { return <article key={row.id} className="canvas-card"><div className="canvas-card-body"><span className="row-status">{row.status}</span><h3>{row.title}</h3><p>{row.detail}</p></div></article>; }

function renderLaunch(props: CampaignLaunchReviewProps) { return <CampaignLaunchReview key={props.operationId} {...props} />; }
