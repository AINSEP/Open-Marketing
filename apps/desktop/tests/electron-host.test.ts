import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions, Display, Rectangle, Screen, Session, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { centeredWindowBounds, createElectronHost, initialWindowBounds, intersectsWorkArea } from "../src/electron-host.js";

const success = { ok: true, value: undefined };
const opening = { studioUrl: "http://127.0.0.1:43210/studio", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } as const;
// Reuse Electron's published callbacks; the fake boundary supplies only fields these guards read.
type RequestGuard = NonNullable<Parameters<Session["webRequest"]["onBeforeRequest"]>[0]>;
type HeaderGuard = NonNullable<Parameters<Session["webRequest"]["onHeadersReceived"]>[0]>;
type PermissionGuard = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;

/** Only this fake boundary casts the Electron objects; tests drive registered callbacks. */
function fixture(input: { partition?: string; load?: Promise<void>; bounds?: Rectangle; workAreas?: readonly Rectangle[]; cursorArea?: Rectangle } = {}) {
 const calls: string[] = [];
 const internal = { x: 0, y: 25, width: 1440, height: 875 };
 const screen = {
  // The fake screen supplies only the workArea used by the adapter.
  getAllDisplays: vi.fn<Screen["getAllDisplays"]>(() => (input.workAreas ?? [internal]).map(workArea => ({ workArea }) as Display)),
  getCursorScreenPoint: vi.fn<Screen["getCursorScreenPoint"]>(() => ({ x: 100, y: 100 })),
  getDisplayNearestPoint: vi.fn<Screen["getDisplayNearestPoint"]>(() => ({ workArea: input.cursorArea ?? internal }) as Display),
 };
 const session = {
  setPermissionRequestHandler: vi.fn<Session["setPermissionRequestHandler"]>(),
  setPermissionCheckHandler: vi.fn<Session["setPermissionCheckHandler"]>(),
  webRequest: {
   onBeforeRequest: vi.fn<Session["webRequest"]["onBeforeRequest"]>(),
   onHeadersReceived: vi.fn<Session["webRequest"]["onHeadersReceived"]>(),
  },
 };
 const contents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn<WebContents["setWindowOpenHandler"]>() });
 let destroyed = false;
 const window = {
  webContents: contents,
  loadURL: vi.fn<BrowserWindow["loadURL"]>(async () => {
   calls.push("load");
   expect(session.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
   expect(session.webRequest.onHeadersReceived).toHaveBeenCalledOnce();
   expect(contents.listenerCount("will-redirect")).toBe(1);
   await input.load;
  }),
  show: vi.fn(() => { calls.push("show"); }),
  getBounds: vi.fn<BrowserWindow["getBounds"]>(() => { calls.push("bounds"); return input.bounds ?? { x: 40, y: 25, width: 1360, height: 875 }; }),
  setBounds: vi.fn<BrowserWindow["setBounds"]>(),
  isDestroyed: () => destroyed,
  destroy: vi.fn(() => { destroyed = true; calls.push("destroy"); }),
 };
 const createSession = vi.fn(() => session as unknown as Session);
 const createWindow = vi.fn((_options: BrowserWindowConstructorOptions) => window as unknown as BrowserWindow);
 const host = createElectronHost({ partition: input.partition ?? "om-fixture", createSession, createWindow, screen });
 return { host, session, contents, window, createSession, createWindow, screen, calls };
}

it("is inert and applies secure preferences and session guards before loading", async () => {
 const adapter = fixture();
 expect(adapter.createSession).not.toHaveBeenCalled();
 const pending = adapter.host.open(opening);
 expect(adapter.host.open(opening)).toBe(pending);
 expect(await pending).toEqual(success);
 expect(adapter.createSession).toHaveBeenCalledExactlyOnceWith({ partition: "om-fixture" });
 expect(adapter.createWindow).toHaveBeenCalledExactlyOnceWith({ show: false, webPreferences: {
  session: adapter.session, contextIsolation: true, sandbox: true, webSecurity: true,
  nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
  webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false,
 } });
 expect(adapter.createWindow.mock.calls[0][0].webPreferences).not.toHaveProperty("preload");
 expect(adapter.calls).toEqual(["load", "show", "bounds"]);
 expect(adapter.window.setBounds).not.toHaveBeenCalled();
 expect(adapter.screen.getDisplayNearestPoint).not.toHaveBeenCalled();
 expect(await adapter.host.close({})).toEqual(success);
 expect(await adapter.host.close({})).toEqual(success);
 expect(adapter.window.destroy).toHaveBeenCalledOnce();
});

it("denies popup and permission requests including permission checks", async () => {
 const adapter = fixture();
 await adapter.host.open(opening);
 expect(adapter.contents.setWindowOpenHandler.mock.calls[0][0]({} as Parameters<Parameters<WebContents["setWindowOpenHandler"]>[0]>[0])).toEqual({ action: "deny" });
 const permission = vi.fn();
 adapter.session.setPermissionRequestHandler.mock.calls[0][0]!({} as Parameters<PermissionGuard>[0], "notifications", permission, {} as Parameters<PermissionGuard>[3]);
 expect(permission).toHaveBeenCalledExactlyOnceWith(false);
 expect(adapter.session.setPermissionCheckHandler.mock.calls[0][0]!(null, "notifications", "", {} as Parameters<NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>>[3])).toBe(false);
});

it.each([
 ["http://127.0.0.1:43210/studio/next", false],
 ["http://127.0.0.1:43211/studio", true],
 ["http://127.0.0.1.evil.example:43210", true],
 ["http://owner:secret@127.0.0.1:43210", true],
 ["https://evil.example", true],
 ["file:///tmp/index.html", true],
 ["javascript:alert(1)", true],
 ["invalid-url", true],
])("locks requests, frame navigation and redirects for %s", async (url, denied) => {
 const adapter = fixture();
 await adapter.host.open(opening);
 const callback = vi.fn();
 adapter.session.webRequest.onBeforeRequest.mock.calls[0][0]!({ url } as Parameters<RequestGuard>[0], callback);
 expect(callback).toHaveBeenCalledExactlyOnceWith({ cancel: denied });
 for (const event of ["will-navigate", "will-redirect", "will-frame-navigate"]) {
  const preventDefault = vi.fn();
  adapter.contents.emit(event, { url, preventDefault }, url);
  expect(preventDefault).toHaveBeenCalledTimes(Number(denied));
 }
});

it("replaces conflicting CSP headers while preserving unrelated headers", async () => {
 const adapter = fixture();
 await adapter.host.open(opening);
 const callback = vi.fn();
 adapter.session.webRequest.onHeadersReceived.mock.calls[0][0]!({ responseHeaders: {
  "content-security-policy": ["script-src *"], "Content-Security-Policy": ["default-src *"], "Content-Type": ["text/html"],
 } } as unknown as Parameters<HeaderGuard>[0], callback);
 const headers = callback.mock.calls[0][0].responseHeaders;
 expect(headers["Content-Type"]).toEqual(["text/html"]);
 expect(headers).not.toHaveProperty("content-security-policy");
 expect(headers["Content-Security-Policy"]).toEqual(["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"]);
});

it.each(["http://om.example", "http://127.0.0.1.evil.example:1234", "https://owner:secret@om.example", "file:///tmp/index.html", "bad-url"])("rejects %s without constructing a session/window", async studioUrl => {
 const adapter = fixture();
 expect(await adapter.host.open({ ...opening, studioUrl })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
 expect(adapter.createSession).not.toHaveBeenCalled();
 expect(adapter.createWindow).not.toHaveBeenCalled();
});

it("destroys a failed load and returns a safe native boundary error", async () => {
 const adapter = fixture();
 adapter.window.loadURL.mockRejectedValueOnce(new Error("credential-looking-fixture"));
 const result = await adapter.host.open(opening);
 expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
 expect(JSON.stringify(result)).not.toContain("credential-looking-fixture");
 expect(adapter.window.destroy).toHaveBeenCalledOnce();
 expect(adapter.window.show).not.toHaveBeenCalled();
});

it("cleanup errors after a failed load remain typed outcomes", async () => {
 const adapter = fixture();
 adapter.window.loadURL.mockRejectedValueOnce(new Error("load failed"));
 adapter.window.destroy.mockImplementation(() => { throw new Error("native failure"); });
 expect(await adapter.host.open(opening)).toMatchObject({ ok: false, error: { message: "Unable to close the desktop window" } });
 expect(await adapter.host.close({})).toMatchObject({ ok: false, error: { code: "unavailable" } });
});

it("close during load destroys the window and prevents a later show", async () => {
 const { promise: load, resolve: finish } = Promise.withResolvers<void>();
 const adapter = fixture({ load });
 const pending = adapter.host.open(opening);
 expect(await adapter.host.close({})).toEqual(success);
 finish();
 expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
 expect(adapter.window.show).not.toHaveBeenCalled();
 expect(await adapter.host.open(opening)).toMatchObject({ ok: false, error: { code: "cancelled" } });
});

it("uses distinct injected nonpersistent partitions and windows for two instances", async () => {
 const first = fixture({ partition: "om-fixture-a" });
 const second = fixture({ partition: "om-fixture-b" });
 expect(await first.host.open(opening)).toEqual(success);
 expect(await second.host.open({ ...opening, studioUrl: "https://om.example/studio" })).toEqual(success);
 expect(first.createSession).toHaveBeenCalledWith({ partition: "om-fixture-a" });
 expect(second.createSession).toHaveBeenCalledWith({ partition: "om-fixture-b" });
 await first.host.close({});
 expect(second.window.destroy).not.toHaveBeenCalled();
 await second.host.close({});
});

it.each([
 [{ x: 0, y: 0, width: 1920, height: 1080 }, { x: 280, y: 90, width: 1360, height: 900 }],
 [{ x: 0, y: 24, width: 1280, height: 776 }, { x: 0, y: 24, width: 1280, height: 776 }],
 [{ x: 1920, y: 40, width: 1600, height: 1000 }, { x: 2040, y: 90, width: 1360, height: 900 }],
 [{ x: -1600, y: -100, width: 1600, height: 1000 }, { x: -1480, y: -50, width: 1360, height: 900 }],
])("centers and caps initial geometry inside the primary work area %j", (workArea, expected) => {
 const bounds = initialWindowBounds({ workArea });
 expect(bounds).toEqual(expected);
 expect(bounds.x).toBeGreaterThanOrEqual(workArea.x);
 expect(bounds.y).toBeGreaterThanOrEqual(workArea.y);
 expect(bounds.x + bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width);
 expect(bounds.y + bounds.height).toBeLessThanOrEqual(workArea.y + workArea.height);
});

it("uses an injected persistent partition without changing session guards", async () => {
 const adapter = fixture({ partition: "persist:om-desktop" });
 expect(await adapter.host.open(opening)).toEqual(success);
 expect(adapter.createSession).toHaveBeenCalledExactlyOnceWith({ partition: "persist:om-desktop" });
 expect(adapter.session.setPermissionRequestHandler).toHaveBeenCalledOnce();
 expect(adapter.session.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
 await adapter.host.close({});
});

const retinaWorkArea = { x: 0, y: 25, width: 1440, height: 875 };
const leftWorkArea = { x: -1920, y: 25, width: 1920, height: 1055 };
const rightWorkArea = { x: 1440, y: 25, width: 1920, height: 1055 };

it.each([
 { workAreas: [retinaWorkArea, leftWorkArea], bounds: { x: -1655, y: 94, width: 1360, height: 900 }, visible: true },
 { workAreas: [retinaWorkArea, rightWorkArea], bounds: { x: -1655, y: 94, width: 1360, height: 900 }, visible: false },
 { workAreas: [rightWorkArea, retinaWorkArea], bounds: { x: 1720, y: 94, width: 1360, height: 900 }, visible: true },
 { workAreas: [retinaWorkArea, leftWorkArea], bounds: { x: 1439, y: 100, width: 800, height: 600 }, visible: true },
 { workAreas: [retinaWorkArea, leftWorkArea], bounds: { x: 1440, y: 100, width: 800, height: 600 }, visible: false },
 { workAreas: [retinaWorkArea, leftWorkArea], bounds: { x: 0, y: 900, width: 800, height: 600 }, visible: false },
 { workAreas: [{ x: 0, y: 25, width: 1440, height: 0 }], bounds: { x: 0, y: 0, width: 800, height: 600 }, visible: false },
])("checks positive overlap against every DIP work area: %j", ({ bounds, workAreas, visible }) => {
 expect(intersectsWorkArea({ bounds, workAreas })).toBe(visible);
});

it.each([
 [leftWorkArea, { x: -1640, y: 102, width: 1360, height: 900 }],
 [rightWorkArea, { x: 1720, y: 102, width: 1360, height: 900 }],
 [retinaWorkArea, { x: 40, y: 25, width: 1360, height: 875 }],
])("recovers an off-screen restored window on the cursor display %j after showing", async (cursorArea, expected) => {
 const adapter = fixture({ bounds: { x: -4000, y: 94, width: 1360, height: 900 }, workAreas: [retinaWorkArea, cursorArea], cursorArea });
 expect(await adapter.host.open(opening)).toEqual(success);
 expect(adapter.calls).toEqual(["load", "show", "bounds"]);
 expect(adapter.screen.getAllDisplays).toHaveBeenCalledOnce();
 expect(adapter.screen.getDisplayNearestPoint).toHaveBeenCalledExactlyOnceWith({ x: 100, y: 100 });
 expect(adapter.window.setBounds).toHaveBeenCalledExactlyOnceWith(expected);
});

it("preserves a visible window on the negative-x external display", async () => {
 const adapter = fixture({ bounds: { x: -1655, y: 94, width: 1360, height: 900 }, workAreas: [retinaWorkArea, leftWorkArea] });
 expect(await adapter.host.open(opening)).toEqual(success);
 expect(adapter.window.setBounds).not.toHaveBeenCalled();
});

it("uses the display layout at show time after a display changes during load", async () => {
 const { promise: load, resolve: finish } = Promise.withResolvers<void>();
 const adapter = fixture({ load, bounds: { x: -1655, y: 94, width: 1360, height: 900 }, workAreas: [retinaWorkArea, leftWorkArea], cursorArea: rightWorkArea });
 const pending = adapter.host.open(opening);
 expect(adapter.screen.getAllDisplays).not.toHaveBeenCalled();
 adapter.screen.getAllDisplays.mockReturnValue([{ workArea: retinaWorkArea }, { workArea: rightWorkArea }] as Display[]);
 finish();
 expect(await pending).toEqual(success);
 expect(adapter.window.setBounds).toHaveBeenCalledExactlyOnceWith({ x: 1720, y: 102, width: 1360, height: 900 });
});

it("centers restored dimensions without growing them", () => {
 expect(centeredWindowBounds({ bounds: { width: 800, height: 600 }, workArea: rightWorkArea })).toEqual({ x: 2000, y: 252, width: 800, height: 600 });
});

it("maps a native recovery failure to the existing safe open error and destroys the window", async () => {
 const adapter = fixture({ bounds: { x: -4000, y: 94, width: 1360, height: 900 } });
 adapter.window.setBounds.mockImplementation(() => { throw new Error("native move failed"); });
 expect(await adapter.host.open(opening)).toMatchObject({ ok: false, error: { code: "unavailable" } });
 expect(adapter.window.destroy).toHaveBeenCalledOnce();
});
