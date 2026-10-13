import type { ReactElement } from "react";
import { ApprovalCard } from "../../../features/approve/index.js";
import type { CreativeMediaModel, GenerationView, AssetView } from "./WorkspaceCanvas.hooks.js";

/** Inspect generation evidence or original/rendition relationships from the API snapshot. */
export function CreativeMediaCanvas(props: { readonly model: CreativeMediaModel; readonly target: "creative" | "media-library" }): ReactElement {
  return <>
    {props.target === "creative" ? <>
      <div className="section-heading"><h2>Generation review and outcomes</h2></div>
      <p className="muted domain-note">Quote, estimate and actual charge are separate evidence. Submission and durable status recovery await server integration.</p>
      <div className="canvas-grid">{props.model.generations.map(renderGeneration)}</div>
      {props.model.generations.length === 0 && <p>No generation details supplied.</p>}
    </> : <>
      <div className="section-heading"><h2>Originals and renditions</h2></div>
      <p className="muted domain-note">Inspect provenance and duplicate-import evidence. Upload and crop editing await server integration.</p>
      <div className="canvas-grid">{props.model.assets.map(renderAsset)}</div>
      {props.model.assets.length === 0 && <p>No asset details supplied.</p>}
    </>}
    <p className="domain-note">Missing a capability? <a href="#plugins">Inspect plugins</a> and <a href="#connections">connect or reauthenticate an account</a>.</p>
  </>;
}
function GenerationCard(props: { readonly item: GenerationView }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body">
    <span className="row-status">Outcome: {props.item.status}</span><h3>{props.item.title}</h3><p>{props.item.brief}</p>
    <dl className="domain-facts"><div><dt>Quote</dt><dd>{props.item.quoteText}</dd></div><div><dt>Estimated cost</dt><dd>{props.item.estimatedText}</dd></div><div><dt>Actual cost</dt><dd>{props.item.actualText}</dd></div></dl>
    <p>{props.item.costEvidence}</p><p>{props.item.classificationText}</p>
    {props.item.approval ? <ApprovalCard {...props.item.approval} /> : props.item.status === "review" && <p>Exact review unavailable · request a fresh server card.</p>}
  </div></article>;
}
function AssetCard(props: { readonly item: AssetView }): ReactElement {
  return <article className="canvas-card" aria-label={props.item.title}><div className="canvas-card-body">
    <span className="row-status">{props.item.originalId ? "Crop rendition" : "Original"}</span><h3>{props.item.title}</h3>
    <dl className="domain-facts"><div><dt>Dimensions</dt><dd>{props.item.dimensions}</dd></div><div><dt>Original</dt><dd>{props.item.originalTitle}</dd></div><div><dt>Observed cost</dt><dd>{props.item.costText}</dd></div></dl>
    {props.item.crop && <p>{props.item.crop}</p>}
    <details><summary>Provenance, cost and import evidence</summary><p>{props.item.provenance}</p><p>{props.item.costEvidence}</p><p>{props.item.importEvidence}</p><code>{props.item.id}</code>{props.item.originalId && <code>Original: {props.item.originalId}</code>}</details>
  </div></article>;
}
// Array.map callback ABI; renderers only wrap declarative components.
function renderGeneration(item: GenerationView): ReactElement { return <GenerationCard key={item.id} item={item} />; }
function renderAsset(item: AssetView): ReactElement { return <AssetCard key={item.id} item={item} />; }
