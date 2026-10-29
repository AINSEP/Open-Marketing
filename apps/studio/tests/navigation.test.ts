import { it, expect, vi } from "vitest";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatFab } from "../src/widgets/om-chat/ChatFab.js";
import { createNavigationController } from "../src/features/navigate/index.js";
import type { BrowserRoutePort } from "../src/features/navigate/index.js";
import { testRuntime } from "./support/runtime.js";

it("structured navigation completes after render and replay does not write twice", async () => {
  const timer = testRuntime(); const paths: string[] = [];
  const browser: BrowserRoutePort = { read() { return "workspaces"; }, write(input) { paths.push(input.target); return { ok: true, value: input.target }; }, listen() { return () => {}; } };
  const route = createNavigationController({ browser, timers: timer.runtime.timers, timeoutMs: 5000 });
  const action = { kind: "navigate", actionId: "nav-1", target: "campaigns" };
  const pending = route.apply({ input: action });
  expect(route.getSnapshot()).toBe("campaigns");
  let settled = false; void pending.then(() => { settled = true; }); await Promise.resolve(); expect(settled).toBe(false);
  route.rendered({ target: "creative" }); await Promise.resolve(); expect(settled).toBe(false);
  route.rendered({ target: "campaigns" });
  expect(await pending).toEqual({ status: "completed", actionId: "nav-1", target: "campaigns" });
  expect(await route.apply({ input: action })).toEqual({ status: "completed", actionId: "nav-1", target: "campaigns" });
  expect(paths).toEqual(["campaigns"]); route.dispose(); expect(timer.pending()).toBe(0);
});
it("no browser, unsupported route, timeout, and detach never claim completion", async () => {
  const timer = testRuntime(); const noBrowser = createNavigationController({ browser: null, timers: timer.runtime.timers, timeoutMs: 5000 });
  const action = { kind: "navigate", actionId: "nav-2", target: "campaigns" };
  expect(await noBrowser.apply({ input: action })).toMatchObject({ status: "failed", error: { code: "unavailable" } });
  expect(await noBrowser.apply({ input: { ...action, target: "https://example.com" } })).toMatchObject({ status: "failed", error: { code: "invalid_input" } });
  const browser: BrowserRoutePort = { read() { return "workspaces"; }, write(input) { return { ok: true, value: input.target }; }, listen() { return () => {}; } };
  const route = createNavigationController({ browser, timers: timer.runtime.timers, timeoutMs: 5000 });
  const pending = route.apply({ input: action }); timer.advance({ ms: 5000 });
  expect(await pending).toMatchObject({ status: "failed", error: { message: "Browser did not acknowledge navigation before timeout" } });
  const detached = route.apply({ input: { ...action, actionId: "nav-detach" } }); route.dispose();
  expect(await detached).toMatchObject({ status: "failed", error: { code: "unavailable" } }); noBrowser.dispose();
});
it("a changed target with the same action ID is rejected and a superseded action fails honestly", async () => {
  const timer = testRuntime(); const browser: BrowserRoutePort = { read() { return "workspaces"; }, write(input) { return { ok: true, value: input.target }; }, listen() { return () => {}; } };
  const route = createNavigationController({ browser, timers: timer.runtime.timers, timeoutMs: 5000 });
  const first = route.apply({ input: { kind: "navigate", actionId: "first", target: "campaigns" } });
  expect(await route.apply({ input: { kind: "navigate", actionId: "first", target: "settings" } })).toMatchObject({ status: "failed", error: { code: "conflict" } });
  const second = route.apply({ input: { kind: "navigate", actionId: "second", target: "creative" } });
  expect(await first).toMatchObject({ status: "failed", error: { code: "conflict" } });
  route.rendered({ target: "creative" }); expect(await second).toEqual({ status: "completed", actionId: "second", target: "creative" }); route.dispose();
});

it("keeps literal grouped destinations, distinct icons, and SOON preview targets", async () => {
  const { NAV_GROUPS, ROUTES, NAV_ICONS } = await import("../src/shared/navigation/index.js");
  expect(NAV_GROUPS.map(group => group.label)).toEqual(["WORKSPACE", "ADD-ONS", "SYSTEM"]);
  const targets = NAV_GROUPS.flatMap(group => group.targets);
  expect(targets).toEqual(["workspaces", "creative", "media-library", "campaigns", "measure", "activity",
    "/addons/plugins", "/addons/agent-plugins", "/addons/skills", "/addons/integrations", "connections", "settings"]);
  expect(new Set(targets).size).toBe(12);
  expect(targets.filter(target => ROUTES[target].soon)).toEqual(["creative", "measure"]);
  expect(new Set(targets.map(target => ROUTES[target].icon)).size).toBe(12);
  expect(NAV_ICONS.assistant).toContain('<path d="M12 8V4H8" />');
  expect(NAV_ICONS.assistant).toContain('<rect width="16" height="12" x="4" y="8" rx="2" />');
  expect(ROUTES['/addons/agent-plugins'].icon).toContain('<rect x="14" y="2" width="8" height="8" rx="1" />');
  expect(new Set(Object.values(NAV_ICONS)).size).toBe(Object.keys(NAV_ICONS).length);
  for (const icon of Object.values(NAV_ICONS)) {
    expect(icon).toMatch(/<(?:path|rect|circle|line|polyline|polygon)\b/);
    expect(icon).not.toMatch(/<script|<use|href=|\bon\w+=/);
  }
});

it('renders the pinned Lucide robot in the assistant FAB', async () => {
  const { NAV_ICONS } = await import('../src/shared/navigation/index.js');
  const html = renderToStaticMarkup(createElement(ChatFab, { open: false, toggle() {}, buttonRef: createRef<HTMLButtonElement>() }));
  expect(html).toContain('aria-label="Assistant"');
  expect(html).toContain(NAV_ICONS.assistant);
  expect(html).not.toContain(NAV_ICONS.agentPlugins);
});

it('captures initial and committed screen views, ignoring stale/duplicate acknowledgements and diagnostic failures', async () => {
  const { runtime } = testRuntime(); const track = vi.fn();
  const route = createNavigationController({ browser: null, timers: runtime.timers, timeoutMs: 5000, track });
  route.rendered({ target: 'workspaces' }); route.rendered({ target: 'workspaces' }); route.select({ target: 'campaigns' });
  route.rendered({ target: 'workspaces' }); expect(track.mock.calls).toEqual([[{ name: 'screen.viewed' }, { properties: { screen: 'workspaces' } }]]);
  route.rendered({ target: 'campaigns' }); route.rendered({ target: 'campaigns' });
  expect(track.mock.calls).toEqual([[{ name: 'screen.viewed' }, { properties: { screen: 'workspaces' } }], [{ name: 'screen.viewed' }, { properties: { screen: 'campaigns' } }]]);
  track.mockImplementation(() => { throw new Error('capture'); }); route.select({ target: 'creative' });
  expect(() => route.rendered({ target: 'creative' })).not.toThrow(); expect(route.getSnapshot()).toBe('creative'); route.dispose();
  route.rendered({ target: 'settings' }); expect(track).toHaveBeenCalledTimes(3);
});
