import { usePortSnapshot } from "../../shared/ui/index.js";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import type { NavigationTarget } from "@open-marketing/contracts";
import type { ChatSession } from "../../features/chat-run/index.js";
import type { NavigationController } from "../../features/navigate/index.js";
import { parseStudioSnapshot } from "../../shared/api/index.js";
import type { StudioApiPort, StudioSnapshot } from "../../shared/api/index.js";
import type { StudioRuntime } from "../../shared/api/index.js";
import { NAVIGATION, ROUTES } from "../../shared/navigation/index.js";

export interface ShellProps { readonly api: StudioApiPort; readonly runtime: StudioRuntime; readonly navigation: NavigationController; readonly session: ChatSession }
export interface NavLink { readonly target: NavigationTarget; readonly label: string; readonly glyph: string; readonly active: boolean; readonly onClick: (event: MouseEvent<HTMLAnchorElement>) => void }
/** App owns shared routing and boot data; widgets receive only downward ports and state. */
export function useShell(required: ShellProps) {
  const target = usePortSnapshot(required.navigation);
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
  const links: readonly NavLink[] = NAVIGATION.map(route => ({ target: route, ...ROUTES[route], active: route === target, onClick: (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); required.navigation.select({ target: route });
  } }));
  return { target, snapshot, error, chatOpen, toggleChat, openChat, headingRef, links, page: ROUTES[target], workspace: snapshot?.workspace ?? "Open Marketing", chatAvailable: snapshot !== null && snapshot.mode !== "unavailable", mode: snapshot?.mode ?? "unavailable" };
}
