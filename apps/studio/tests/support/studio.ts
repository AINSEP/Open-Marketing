import { createSampleStudioApi } from "../../src/shared/api/index.js";
import type { ShellProps } from "../../src/app/shell/Shell.hooks.js";
import { createChatSession } from "../../src/features/chat-run/index.js";
import { createNavigationController } from "../../src/features/navigate/index.js";
import type { BrowserRoutePort } from "../../src/features/navigate/index.js";
import { testRuntime } from "./runtime.js";

/** Mirrors the production composition while retaining host effects for assertions. */
export function testStudio() {
  const timer = testRuntime();
  let route: unknown = "workspaces";
  const browser: BrowserRoutePort = { read() { return route; }, write(input) { route = input.target; return { ok: true, value: input.target }; }, listen() { return () => {}; } };
  const navigation = createNavigationController({ browser, timers: timer.runtime.timers, timeoutMs: 5000 });
  const api = createSampleStudioApi({ runtime: timer.runtime });
  const session = createChatSession({ api, runtime: timer.runtime, navigate: input => navigation.apply({ input: input.action }) });
  const props: ShellProps = { api, session, navigation, runtime: timer.runtime };
  return { props, timer, route: () => route, dispose: () => { session.dispose(); navigation.dispose(); } };
}
