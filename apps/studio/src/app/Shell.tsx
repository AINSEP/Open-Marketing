import { OMChatPane } from "../widgets/om-chat/index.js";
import { WorkspaceCanvas } from "../widgets/workspace-canvas/index.js";
import { useShell } from "./Shell.hooks.js";
import type { ShellProps, NavLink } from "./Shell.hooks.js";

/** One operator application: feature rail, central canvas, global docked assistant. */
export function Shell(props: ShellProps) {
  const shell = useShell(props);
  return <div className="shell" data-chat-open={shell.chatOpen}>
    <a className="skip-link" href="#workspace-canvas">Skip to workspace canvas</a>
    <nav className="sidebar" aria-label="Features"><a className="brand" href="#workspaces"><span className="brand-mark" aria-hidden="true">om</span><span>Open<br />Marketing</span></a><div className="workspace-label"><span className="workspace-avatar" aria-hidden="true">R</span><div><strong>{shell.workspace}</strong><span>Marketing workspace</span></div></div><span className="nav-caption">WORKSPACE</span><div className="nav-links">{shell.links.map(renderNavLink)}</div><div className="sidebar-footer"><span className="status-dot" aria-hidden="true" /><span>{shell.mode === "sample" ? "Local sandbox · preview" : "Server status unconfirmed"}</span></div></nav>
    <main id="workspace-canvas" className="workspace-main" tabIndex={-1} aria-label="Workspace canvas">
      <header className="topbar"><span>Workspace <span aria-hidden="true">/</span> <strong>{shell.page.label}</strong></span><span className="mode-badge">{shell.mode === "sample" ? "Sample data" : "Connection pending"}</span></header>
      <div className="canvas-content"><header className="page-heading"><div><span className="eyebrow">OPEN MARKETING</span><h1 tabIndex={-1} ref={shell.headingRef}>{shell.page.label}</h1><p>{shell.page.description}</p></div><button type="button" className="assistant-action" onClick={shell.openChat}><span aria-hidden="true">✦</span> Think with Assistant</button></header>
        {shell.error && <p role="alert" className="error-notice">{shell.error}</p>}
        {shell.snapshot ? <WorkspaceCanvas target={shell.target} snapshot={shell.snapshot} onOpenChat={shell.openChat} api={props.api} runtime={props.runtime} /> : !shell.error && <p role="status">Opening your workspace…</p>}
      </div>
    </main>
    <OMChatPane session={props.session} api={props.api} runtime={props.runtime} sample={shell.mode === "sample"} available={shell.chatAvailable} open={shell.chatOpen} toggle={shell.toggleChat} />
  </div>;
}
function renderNavLink(link: NavLink) { return <a key={link.target} className="nav-link" href={"#" + link.target} aria-current={link.active ? "page" : undefined} onClick={link.onClick}><span className="nav-glyph" aria-hidden="true">{link.glyph}</span>{link.label}</a>; }
