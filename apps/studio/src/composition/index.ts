import { createElement } from "react";
import type { Root } from "react-dom/client";
import { Shell } from "../app/shell/Shell.js";
import { createSampleStudioApi } from "../shared/api/index.js";
import type { StudioApiPort } from "../shared/api/index.js";
import type { StudioRuntime } from "../shared/api/index.js";
import { createNavigationController } from "../features/navigate/index.js";
import type { BrowserRoutePort } from "../features/navigate/index.js";
import { createChatSession } from "../features/chat-run/index.js";

export interface StudioAppDependencies { readonly root: Root; readonly runtime: StudioRuntime; readonly browser: BrowserRoutePort | null; readonly api?: StudioApiPort }
/** Sole composition root. Construction is inert; start mounts and creates route/session instances.
 * An injected HTTP adapter replaces the sample API without changing a component.
 * @example createStudioApp({ root, runtime, browser, api }).start()
 */
export function createStudioApp(required: StudioAppDependencies) {
  let stopCurrent: (() => void) | null = null;
  return {
    start() {
      if (stopCurrent) return;
      const api = required.api ?? createSampleStudioApi({ runtime: required.runtime });
      const navigation = createNavigationController({ browser: required.browser, timers: required.runtime.timers, timeoutMs: 5000 });
      const session = createChatSession({ api, runtime: required.runtime, navigate: input => navigation.apply({ input: input.action }) });
      required.root.render(createElement(Shell, { api, navigation, session, runtime: required.runtime }));
      stopCurrent = () => { required.root.unmount(); session.dispose(); navigation.dispose(); };
    },
    stop() { stopCurrent?.(); stopCurrent = null; },
  };
}
