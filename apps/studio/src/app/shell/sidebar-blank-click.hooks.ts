import { useEffect } from "react";
import type { MatchMediaPort } from "@jini-ai/ui/theme";

/** Adapted from Tovu's use-sidebar-empty-click-toggle: controls and preview rows are not blank. */
export const SIDEBAR_CONTROL_SELECTOR =
  'a, button, input, select, textarea, summary, label, [role="button"], [role="link"], [tabindex]';

/** Pure click decision. The containing element is injected, so cross-document targets work too. */
export function isEmptySidebarClick(required: {
  event: Pick<MouseEvent, "target" | "button" | "defaultPrevented">;
  nav: Element; selectingText: boolean; dragged: boolean;
}): boolean {
  if (required.event.button !== 0 || required.event.defaultPrevented || required.selectingText || required.dragged) return false;
  const target = required.event.target;
  if (!target || !("closest" in target)) return false;
  const element = target as Element;
  if (!required.nav.contains(element)) return false;
  const control = element.closest(SIDEBAR_CONTROL_SELECTOR);
  return control === null || !required.nav.contains(control);
}

type SidebarHost = {
  doc?: Document | null; matchMedia?: MatchMediaPort | null; navId: string; toggleRail(): void;
};

/** Bind two native listeners; the returned disposer removes both. No ambient browser reads.
 * Pointer motion and selection are sampled only on click; work and retained state are constant.
 * @example const dispose = bindSidebarEmptyClickToggle({ doc, matchMedia, navId: "studio-sidebar", toggleRail });
 */
export function bindSidebarEmptyClickToggle(required: SidebarHost): () => void {
  const doc = required.doc;
  const nav = doc?.getElementById(required.navId);
  if (!doc || !nav || !required.matchMedia) return () => {};
  let pressedAt: { x: number; y: number } | null = null;
  const onPointerDown = (event: PointerEvent): void => { pressedAt = { x: event.clientX, y: event.clientY }; };
  const onClick = (event: MouseEvent): void => {
    const press = pressedAt;
    pressedAt = null;
    if (!press || !required.matchMedia?.("(min-width: 901px)").matches) return;
    const selection = doc.getSelection();
    const selectingText = !!selection && !selection.isCollapsed && nav.contains(selection.anchorNode);
    const dragged = Math.abs(event.clientX - press.x) > 4 || Math.abs(event.clientY - press.y) > 4;
    if (isEmptySidebarClick({ event, nav, selectingText, dragged })) required.toggleRail();
  };
  nav.addEventListener("pointerdown", onPointerDown);
  nav.addEventListener("click", onClick);
  return () => {
    nav.removeEventListener("pointerdown", onPointerDown);
    nav.removeEventListener("click", onClick);
  };
}

/** React lifecycle wrapper; the same toggle handles blank clicks and the keyboard button. */
export function useSidebarEmptyClickToggle(required: SidebarHost): void {
  const { doc, matchMedia, navId, toggleRail } = required;
  useEffect(() => bindSidebarEmptyClickToggle({ doc, matchMedia, navId, toggleRail }), [doc, matchMedia, navId, toggleRail]);
}
