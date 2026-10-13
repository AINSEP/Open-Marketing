import { it, expect } from "vitest";
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
