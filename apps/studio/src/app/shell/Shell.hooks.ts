import { useAppearance, usePortSnapshot } from "../../shared/ui/index.js";
import type { AppearanceHost } from "../../shared/ui/index.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { NavigationTarget, StudioNavigationTarget, AddonNavigationTarget } from "@open-marketing/contracts";
import type { ChatSession, ChatState } from "../../features/chat-run/index.js";
import type { NavigationController } from "../../features/navigate/index.js";
import { parseStudioSnapshot } from "../../shared/api/index.js";
import type { StudioApiPort, StudioSnapshot } from "../../shared/api/index.js";
import type { StudioRuntime } from "../../shared/api/index.js";
import type { StudioChartHost } from '../../features/chart-providers/index.js';
import { NAV_GROUPS, ROUTES, isAddonTarget } from "../../shared/navigation/index.js";
import { useSidebarEmptyClickToggle } from "./sidebar-blank-click.hooks.js";

export interface ShellProps { readonly api: StudioApiPort; readonly runtime: StudioRuntime; readonly navigation: NavigationController; readonly session: ChatSession; readonly appearance?: AppearanceHost; readonly doc?: Document; readonly charts?: { host: StudioChartHost; revision: number } }
export interface NavLink { readonly target: StudioNavigationTarget; readonly label: string; readonly icon: string; readonly soon?: boolean; readonly active: boolean; readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }
export interface NavGroup { readonly label: string; readonly id: string; readonly links: readonly NavLink[]; readonly open: boolean; readonly toggle: () => void }
/** App owns shared routing and boot data; widgets receive only downward ports and state. */
export function useShell(required: ShellProps) {
  const appearance = useAppearance(required.appearance ?? { root: null, storage: null });
  const target = usePortSnapshot(required.navigation);
  const session: ChatState = usePortSnapshot(required.session);
  const sidebar = useSidebar({ ...required, target });
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [error, setError] = useState("");
  const [chatOpen, setChatOpen] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const controller = required.runtime.abort();
    const deadline = required.runtime.timers.schedule({ delayMs: 10000, callback: () => { controller.abort(); setError("Workspace request timed out. No external action is implied."); } });
    const load = async (): Promise<void> => {
      const result = await required.api.snapshot({ signal: controller.signal });
      required.runtime.timers.cancel({ handle: deadline });
      if (controller.signal.aborted) return;
      if (!result.ok) { setError("Workspace is unavailable. No action has been dispatched."); return; }
      const parsed = parseStudioSnapshot({ input: result.value });
      if (!parsed.ok) { setError("Workspace data could not be safely displayed."); return; }
      setSnapshot(parsed.value); required.session.hydrate({ input: parsed.value });
    };
    void load(); return () => { controller.abort(); required.runtime.timers.cancel({ handle: deadline }); };
  }, [required.api, required.runtime, required.session]);
  useEffect(() => {
    headingRef.current?.focus();
    required.navigation.rendered({ target });
    return required.navigation.subscribe({ listener: () => {
      if (required.navigation.getSnapshot() === target) required.navigation.rendered({ target });
    } });
  }, [target, required.navigation]);
  const toggleChat = (): void => setChatOpen(value => !value);
  const openChat = (): void => setChatOpen(true);
  const route = { target };
  const addonTarget: AddonNavigationTarget | null = isAddonTarget(route) ? route.target : null;
  const canvasTarget: NavigationTarget | null = isAddonTarget(route) ? null : route.target as NavigationTarget;
  return { target, addonTarget, canvasTarget, snapshot, session, error, chatOpen, toggleChat, openChat, headingRef, sidebar, appearance, page: ROUTES[target], workspace: workspaceLabel({ value: snapshot?.workspace }), connection: connectionLabels({ snapshot, error }), chatAvailable: snapshot !== null && snapshot.mode !== "unavailable", mode: snapshot?.mode ?? "unavailable" };
}

/** Rail preference is device-local, best effort; a malformed value means expanded. */
function readRail(required: { storage: AppearanceHost["storage"] }): boolean {
  try { return required.storage?.getItem("om.sidebar-rail.v1") === "true"; }
  catch { return false; }
}

/** Small OM-owned navigation model. React callbacks live here, never inside TSX bodies.
 * Fixed navigation is linear in 12 links; there is no registry or routing ownership change.
 */
function useSidebar(required: ShellProps & { target: StudioNavigationTarget }) {
  const storage = required.appearance?.storage ?? null;
  const [rail, setRail] = useState(() => readRail({ storage }));
  const [closed, setClosed] = useState<readonly string[]>([]);
  const toggleRail = useCallback((): void => setRail(value => !value), []);
  useEffect(() => {
    try { storage?.setItem("om.sidebar-rail.v1", String(rail)); }
    catch { /* Restricted storage does not disable the visible toggle. */ }
  }, [storage, rail]);
  useSidebarEmptyClickToggle({ doc: required.doc, matchMedia: required.appearance?.matchMedia, navId: "studio-sidebar", toggleRail });
  const groups: readonly NavGroup[] = NAV_GROUPS.map(group => ({
    label: group.label, id: "nav-" + group.label.toLowerCase(), open: !closed.includes(group.label),
    toggle: () => setClosed(value => value.includes(group.label) ? value.filter(label => label !== group.label) : [...value, group.label]),
    links: group.targets.map(route => ({ target: route, ...ROUTES[route], active: route === required.target,
      onClick: navigationClick({ target: route, navigation: required.navigation }),
    })),
  }));
  return { rail, toggleRail, groups, groupLabel: NAV_GROUPS.find(group => group.targets.includes(required.target))?.label,
    toggleLabel: rail ? "Expand sidebar" : "Collapse sidebar" };
}

/** Add-on hash links use the controller's validated browser-listen path, as before this redesign.
 * Legacy targets use select; modified clicks keep the browser's copy/open-link behavior.
 */
function navigationClick(required: { target: StudioNavigationTarget; navigation: NavigationController }): NavLink["onClick"] {
  if (isAddonTarget({ target: required.target })) return undefined;
  const target = required.target as NavigationTarget;
  return event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); required.navigation.select({ target });
  };
}

function workspaceLabel(required: { value?: string }): string {
  const label = required.value?.trim();
  if (!label || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(label)) return "My workspace";
  return label;
}

/** Snapshot access is the only connection claim; it does not assert agent/vendor readiness. */
function connectionLabels(required: { snapshot: StudioSnapshot | null; error: string }) {
  if (required.error) return { state: "unavailable", badge: "Unavailable", sidebar: "Server unavailable" };
  if (!required.snapshot) return { state: "loading", badge: "Connecting", sidebar: "Connecting to server" };
  const labels = {
    connected: { state: "connected", badge: "Connected", sidebar: "Server connected" },
    sample: { state: "sample", badge: "Sample data", sidebar: "Local sandbox · preview" },
    unavailable: { state: "unavailable", badge: "Unavailable", sidebar: "Server unavailable" },
  };
  return labels[required.snapshot.mode];
}
