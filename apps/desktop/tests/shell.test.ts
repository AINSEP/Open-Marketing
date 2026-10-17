import { expect, it } from "vitest";
import type { Outcome } from "@open-marketing/contracts";
import type { ChildSupervisorPort, ElectronHostPort, ServerReady } from "../src/ports.js";
import { createDesktopApp } from "../src/index.js";
import { composeDesktop, packagedEnv } from "../src/composition/index.js";

const success: Outcome<void> = { ok: true, value: undefined };
const unavailable: Outcome<never> = { ok: false, error: { code: "unavailable", message: "fixture failure", retryable: false } };

function deferred<T>() {
 const { promise: promise, resolve: resolve } = Promise.withResolvers<T>();
 return { promise, resolve };
}

function doubles() {
 const calls: string[] = [];
 const window = { open: false, url: "" };
 let listener: ((outcome: Outcome<void>) => void) | undefined;
 const ready: ServerReady = {
  studioUrl: "http://127.0.0.1:43210/studio",
  onExit(input) { listener = input.listener; return () => { listener = undefined; }; },
 };
 const host: ElectronHostPort = {
  async open(input) { calls.push("open"); window.open = true; window.url = input.studioUrl; expect(input.webPreferences).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false }); return success; },
  async close() { calls.push("close"); window.open = false; return success; },
 };
 const children: ChildSupervisorPort = {
  async start() { calls.push("start:server"); return { ok: true, value: ready }; },
  async stop() { calls.push("stop:server"); return success; },
 };
 return { calls, window, host, children, ready, exit: () => listener?.(unavailable) };
}

it("factory is inert, defaults to sandbox, and opens the ready server URL once", async () => {
 const fixture = doubles();
 const app = createDesktopApp(fixture);
 expect(fixture.calls).toEqual([]);
 const first = app.start();
 expect(app.start()).toBe(first);
 expect(await first).toEqual(success);
 expect(fixture.calls).toEqual(["start:server", "open"]);
 expect(fixture.window).toEqual({ open: true, url: "http://127.0.0.1:43210/studio" });
 expect("reloadApi" in app).toBe(false);
 const stopping = app.stop();
 expect(app.stop()).toBe(stopping);
 expect(await stopping).toEqual(success);
 expect(fixture.window.open).toBe(false);
 expect(fixture.calls.filter(call => call === "stop:server")).toHaveLength(1);
});

it("remote start/close never takes service ownership", async () => {
 const fixture = doubles();
 const app = createDesktopApp({ ...fixture, mode: "remote", studioUrl: "https://om.example/studio" });
 expect(await app.start()).toEqual(success);
 expect(fixture.window.url).toBe("https://om.example/studio");
 expect(await app.stop()).toEqual(success);
 expect(fixture.window.open).toBe(false);
 expect(fixture.calls).toEqual(["open", "close", "close"]);
});

it.each([undefined, "http://om.example", "https://owner:secret@om.example", "bad-url"])("rejects remote configuration %s before opening", async studioUrl => {
 const fixture = doubles();
 const app = createDesktopApp({ ...fixture, mode: "remote", studioUrl });
 expect(await app.start()).toMatchObject({ ok: false, error: { code: "invalid_input" } });
 expect(fixture.window.open).toBe(false);
 expect(fixture.calls).not.toContain("start:server");
});

it("stop during boot cancels the child wait and prevents a late window", async () => {
 const fixture = doubles();
 const boot = deferred<Outcome<ServerReady>>();
 fixture.children.start = () => boot.promise;
 fixture.children.stop = async () => { boot.resolve({ ok: false, error: { code: "cancelled", message: "stopped", retryable: false } }); return success; };
 const app = createDesktopApp(fixture);
 const starting = app.start();
 expect(await app.stop()).toEqual(success);
 expect(await starting).toMatchObject({ ok: false, error: { code: "cancelled" } });
 expect(fixture.calls).not.toContain("open");
});

it("stop during window load closes it again after the pending load completes", async () => {
 const fixture = doubles();
 const load = deferred<Outcome<void>>();
 const entered = deferred<void>();
 fixture.host.open = async () => { entered.resolve(); await load.promise; fixture.window.open = true; return success; };
 const app = createDesktopApp(fixture);
 const starting = app.start();
 await entered.promise;
 const stopping = app.stop();
 load.resolve(success);
 expect(await starting).toMatchObject({ ok: false, error: { code: "cancelled" } });
 expect(await stopping).toEqual(success);
 expect(fixture.window.open).toBe(false);
});

it("window load failure stops the server and cleanup failure stays explicit", async () => {
 const fixture = doubles();
 fixture.host.open = async () => unavailable;
 fixture.children.stop = async () => ({ ok: false, error: { code: "unavailable", message: "cleanup failed", retryable: false } });
 expect(await createDesktopApp(fixture).start()).toMatchObject({ ok: false, error: { message: "cleanup failed" } });
 expect(fixture.window.open).toBe(false);
});

it("retained terminal observation closes a ready window and cleans descendants", async () => {
 const fixture = doubles();
 const app = createDesktopApp(fixture);
 await app.start();
 fixture.exit();
 expect(await app.stop()).toEqual(success);
 expect(fixture.window.open).toBe(false);
 expect(fixture.calls).toContain("stop:server");
});

it("terminal exit replay between readiness and subscription never opens studio", async () => {
 const fixture = doubles();
 fixture.ready.onExit = input => { input.listener(unavailable); return () => {}; };
 const app = createDesktopApp(fixture);
 expect(await app.start()).toEqual(unavailable);
 expect(await app.stop()).toEqual(success);
 expect(fixture.calls).not.toContain("open");
});

it("composition rejects missing/relative local paths without constructing effects", () => {
 const unexpected = () => { throw new Error("effects must stay inert"); };
 const effects = { platform: "darwin" as const, spawn: unexpected, signalGroup: unexpected, schedule: unexpected, now: unexpected };
 const electron = { createSession: unexpected, createWindow: unexpected, screen: { getAllDisplays: unexpected, getCursorScreenPoint: unexpected, getDisplayNearestPoint: unexpected } };
 for (const env of [{}, { OM_NODE_EXECUTABLE: "node", OM_SERVER_ENTRY: "/server.js", OM_STATE_ROOT: "/state" }]) {
  expect(composeDesktop({ env, server: effects, electron, partition: "fixture", showError: unexpected })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
 }
});

it("packaged paths relocate under Resources and pass the inert desktop composition", () => {
 const unexpected = () => { throw new Error("composition must stay inert"); };
 const env = packagedEnv({ resourcesPath: "/Applications/Open Marketing.app/Contents/Resources", home: "/Users/owner" });
 expect(env).toEqual({
  OM_MODE: "local-sandbox",
  OM_NODE_EXECUTABLE: "/Applications/Open Marketing.app/Contents/Resources/node/bin/node",
  OM_SERVER_ENTRY: "/Applications/Open Marketing.app/Contents/Resources/om/apps/server/dist/composition/serve.js",
  OM_STATE_ROOT: "/Users/owner/.open-marketing",
 });
 const server = { platform: "darwin" as const, spawn: unexpected, signalGroup: unexpected, schedule: unexpected, now: unexpected };
 const electron = { createSession: unexpected, createWindow: unexpected, screen: { getAllDisplays: unexpected, getCursorScreenPoint: unexpected, getDisplayNearestPoint: unexpected } };
 expect(composeDesktop({ env, server, electron, partition: "fixture", showError: unexpected }).ok).toBe(true);
});
