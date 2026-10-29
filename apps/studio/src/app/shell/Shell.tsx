import { OMChatPane } from "../../widgets/om-chat/index.js";
import { WorkspaceCanvas } from "../../widgets/workspace-canvas/index.js";
import { PluginsPage, AgentPluginsPage, SkillsPage, IntegrationsPage } from "../../pages/addons/index.js";
import type { AddonNavigationTarget } from "@open-marketing/contracts";
import { NAV_ICONS } from "../../shared/navigation/index.js";
import { useShell } from "./Shell.hooks.js";
import type { ShellProps, NavLink, NavGroup } from "./Shell.hooks.js";
import { Events } from "./Events.js";
import { AppearancePicker } from "./AppearancePicker.js";
import { TrackingPage } from "../../pages/tracking/index.js";
import { LeadsPage } from "../../pages/leads/index.js";
import { MeasurePage } from "../../pages/measure/index.js";

/** One operator application: feature rail, central canvas, global docked assistant. */
export function Shell(props: ShellProps) {
  const shell = useShell(props);
  return <div className="shell" data-chat-open={shell.chatOpen} data-rail={shell.sidebar.rail}>
    <a className="skip-link" href="#workspace-canvas">Skip to workspace canvas</a>
    <Sidebar shell={shell} />
    <main id="workspace-canvas" className="workspace-main" tabIndex={-1} aria-label="Workspace canvas" data-agent-page={shell.target}>
      <div className="canvas-content"><header className="page-heading"><div><span className="eyebrow">{shell.sidebar.groupLabel}</span><h1 tabIndex={-1} ref={shell.headingRef}>{shell.page.label}</h1><p>{shell.page.description}</p></div><span className="mode-badge" role="status" data-state={shell.connection.state}>{shell.connection.badge}</span></header>
        {shell.error && <p role="alert" className="error-notice">{shell.error}</p>}
        {shell.target === "settings" && <><AppearancePicker appearance={shell.appearance} /><Events api={props.api} runtime={props.runtime} /></>}
        {shell.target === "measure" && <><TrackingPage api={props.api} runtime={props.runtime} /><MeasurePage api={props.api} runtime={props.runtime} /></>}
        {shell.target === "activity" && <LeadsPage api={props.api} runtime={props.runtime} />}
        {shell.addonTarget ? <AddonPage target={shell.addonTarget} api={props.api} runtime={props.runtime} /> : shell.snapshot && shell.canvasTarget ? <WorkspaceCanvas target={shell.canvasTarget} snapshot={shell.snapshot} cards={shell.session.cards} onOpenChat={shell.openChat} api={props.api} runtime={props.runtime} /> : !shell.error && <p role="status">Opening your workspace…</p>}
      </div>
    </main>
    <OMChatPane session={props.session} api={props.api} runtime={props.runtime} charts={props.charts} sample={shell.mode === "sample"} available={shell.chatAvailable} open={shell.chatOpen} toggle={shell.toggleChat} />
  </div>;
}
/** Local shell chrome follows Tovu's grouped sidebar without taking over OM routing. */
function Sidebar(props: { shell: ReturnType<typeof useShell> }) {
  return <nav id="studio-sidebar" className="sidebar" aria-label="Features"><div className="sidebar-inner">
    <a className="brand" href="#workspaces" aria-label="Open Marketing overview"><span className="brand-mark" aria-hidden="true">om</span><span className="brand-label">Open Marketing</span></a>
    <div className="workspace-label"><strong>{props.shell.workspace}</strong><span>Marketing workspace</span></div>
    <div className="nav-groups">{props.shell.sidebar.groups.map(renderNavGroup)}</div>
    <div className="sidebar-footer"><div className="connection" data-state={props.shell.connection.state}><span className="status-dot" aria-hidden="true" /><span>{props.shell.connection.sidebar}</span></div>
      <button className="rail-toggle" type="button" onClick={props.shell.sidebar.toggleRail} aria-controls="studio-sidebar" aria-expanded={!props.shell.sidebar.rail} aria-label={props.shell.sidebar.toggleLabel} title={props.shell.sidebar.toggleLabel}><NavIcon markup={NAV_ICONS.rail} /></button>
    </div>
  </div></nav>;
}
function renderNavGroup(group: NavGroup) {
  return <section className="nav-group" key={group.id} aria-label={group.label}>
    <button className="group-toggle" type="button" onClick={group.toggle} aria-expanded={group.open} aria-controls={group.id}><span>{group.label}</span><NavIcon markup={NAV_ICONS.chevron} /></button>
    <div id={group.id} className="nav-links" hidden={!group.open}>{group.links.map(renderNavLink)}</div>
  </section>;
}
function renderNavLink(link: NavLink) {
  return <a key={link.target} className="nav-link" href={"#" + link.target} aria-label={link.label} title={link.soon ? link.label + " · Preview; more coming soon" : link.label} aria-current={link.active ? "page" : undefined} onClick={link.onClick} data-action="navigate" data-target={link.target}>
    <NavIcon markup={link.icon} /><span className="nav-label">{link.label}</span>{link.soon && <span className="soon" aria-hidden="true">SOON</span>}
  </a>;
}
/** Markup comes exclusively from the checked-in Lucide constants, never external input. */
function NavIcon(props: { markup: string }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: props.markup }} />;
}
/** App composition mounts pages through their public entry; widgets never import upward. */
function AddonPage(props: Pick<ShellProps, 'api' | 'runtime'> & { readonly target: AddonNavigationTarget }) {
  switch (props.target) {
    case '/addons/plugins': return <PluginsPage api={props.api} runtime={props.runtime} />;
    case '/addons/agent-plugins': return <AgentPluginsPage api={props.api} runtime={props.runtime} />;
    case '/addons/skills': return <SkillsPage api={props.api} runtime={props.runtime} />;
    case '/addons/integrations': return <IntegrationsPage api={props.api} runtime={props.runtime} />;
    default: { const exhaustive: never = props.target; throw new Error('Unsupported add-ons page: ' + exhaustive); }
  }
}
