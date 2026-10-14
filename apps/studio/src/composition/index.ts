import { createElement } from "react";
import type { Root } from "react-dom/client";
import { Shell } from "../app/shell/Shell.js";
import { createSampleStudioApi } from "../shared/api/index.js";
import type { StudioApiPort } from "../shared/api/index.js";
import type { StudioRuntime } from "../shared/api/index.js";
import { createNavigationController } from "../features/navigate/index.js";
import type { BrowserRoutePort } from "../features/navigate/index.js";
import { bindPageActions, createStudioPageDriver, createChatSession } from "../features/chat-run/index.js";
import type { StudioChartHost } from '../features/chart-providers/index.js';
import { ROUTES } from '../shared/navigation/index.js';
import type { StudioNavigationTarget } from '@open-marketing/contracts';
import { applyAppearance } from "../shared/ui/index.js";
import type { AppearanceHost } from "../shared/ui/index.js";

export interface StudioAppDependencies { readonly root: Root; readonly runtime: StudioRuntime; readonly browser: BrowserRoutePort | null; readonly api?: StudioApiPort; readonly appearance?: AppearanceHost;
  readonly charts?: StudioChartHost;
  readonly frontend?: { root: HTMLElement; transport: Parameters<typeof bindPageActions>[0]['transport'];
    navigate(required: { page: StudioNavigationTarget }): void; reducedMotion(required: Record<string, never>): boolean;
    scroll(required: { element: Element; options: ScrollIntoViewOptions }): void };
}
/** Sole composition root. Construction is inert; start mounts and creates route/session instances.
 * An injected HTTP adapter replaces the sample API without changing a component.
 * @example createStudioApp({ root, runtime, browser, api }).start()
 */
export function createStudioApp(required: StudioAppDependencies) {
  let stopCurrent: (() => void) | null = null;
  return {
    start() {
      if (stopCurrent) return;
      if (required.appearance) applyAppearance(required.appearance);
      let mounted = true;
      let chartRevision = 0;
      const refreshCharts = () => { if (!mounted) return; chartRevision++; paint(); };
      const api = chartAwareApi({ api: required.api ?? createSampleStudioApi({ runtime: required.runtime }), changed: refreshCharts });
      const navigation = createNavigationController({ browser: required.browser, timers: required.runtime.timers, timeoutMs: 5000 });
      let bridge: ReturnType<typeof bindPageActions> | undefined;
      const session = createChatSession({ api, runtime: required.runtime, navigate: input => navigation.apply({ input: input.action }),
        frontendSessionId: () => bridge?.sessionId(), frontendBindToken: () => bridge?.bindToken() });
      const page = required.frontend ? studioPageBinding({ frontend: required.frontend, runtime: required.runtime, currentRun: session.currentRun }) : undefined;
      if (page && required.frontend) bridge = bindPageActions({ driver: page.driver, transport: required.frontend.transport,
        currentRun: session.currentRun, onBound: session.receiveFrontendBinding, onVoided: session.voidFrontendRun, onSurface: session.receiveSurface,
        onError: () => { /* Individual requests report typed failures via the server relay. */ } });
      function paint() { required.root.render(createElement(Shell, { api, navigation, session, runtime: required.runtime, appearance: required.appearance,
        charts: required.charts ? { host: required.charts, revision: chartRevision } : undefined })); }
      paint();
      stopCurrent = () => { mounted = false; bridge?.close(); page?.dispose(); required.root.unmount(); session.dispose(); navigation.dispose(); };
    },
    stop() { stopCurrent?.(); stopCurrent = null; },
  };
}

/** Browser effects stay in composition. Only Appearance is a local writable DOM control;
 * routes are published explicitly and every business mutation uses the catalog.
 */
function studioPageBinding(required: { frontend: NonNullable<StudioAppDependencies['frontend']>; runtime: StudioRuntime;
  currentRun: Parameters<typeof createStudioPageDriver>[0]['currentRun'] }): ReturnType<typeof createStudioPageDriver> {
  const frontend = required.frontend;
  return createStudioPageDriver({ dom: { root: frontend.root, pages: Object.fromEntries(Object.entries(ROUTES).map(([page, route]) =>
    [page, { label: route.label, navigate: () => frontend.navigate({ page: page as StudioNavigationTarget }) }])) },
    browser: { root: frontend.root, selection: { candidateSelector: '[data-agent-element]', excludedAncestorSelector: '[data-agent-private], #om-chat, .approval-card' },
      allowPath: input => Object.hasOwn(ROUTES, input.path.slice(1)), navigate: input => frontend.navigate({ page: input.path.slice(1) as StudioNavigationTarget }),
      reducedMotion: frontend.reducedMotion, scroll: frontend.scroll, timers: required.runtime.timers,
      highlightClass: 'agent-highlight', fadeAnimationName: 'agent-highlight-fade', cleanupFallbackMs: 3000 },
    runtime: required.runtime, currentRun: required.currentRun, localWriteHandles: new Set(['appearance-mode']) });
}
/** Plugin mutations refresh one chat-owned inventory; other API effects remain with their owner. */
function chartAwareApi(required: { api: StudioApiPort; changed(): void }): StudioApiPort {
  const addons = required.api.addons;
  if (!addons) return required.api;
  return { ...required.api, addons: { ...addons,
    async install(input) { const result = await addons.install(input); if (result.ok) required.changed(); return result; },
    async setEnabled(input) { const result = await addons.setEnabled(input); if (result.ok) required.changed(); return result; },
    async uninstall(input) { const result = await addons.uninstall(input); if (result.ok) required.changed(); return result; },
  } };
}
