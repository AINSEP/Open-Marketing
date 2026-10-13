import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions, Session, WebContents } from "electron";
import { expect, it, vi } from "vitest";
import { createElectronHost } from "../src/electron-host.js";

const success = { ok: true, value: undefined };
const opening = { studioUrl: "http://127.0.0.1:43210/studio", webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } as const;
// Reuse Electron's published callbacks; the fake boundary supplies only fields these guards read.
type RequestGuard = NonNullable<Parameters<Session["webRequest"]["onBeforeRequest"]>[0]>;
type HeaderGuard = NonNullable<Parameters<Session["webRequest"]["onHeadersReceived"]>[0]>;
type PermissionGuard = NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;

/** Only this fake boundary casts the Electron objects; tests drive registered callbacks. */
function fixture(input: { partition?: string; load?: Promise<void> } = {}) {
 const calls: string[] = [];
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
  isDestroyed: () => destroyed,
  destroy: vi.fn(() => { destroyed = true; calls.push("destroy"); }),
 };
 const createSession = vi.fn(() => session as unknown as Session);
 const createWindow = vi.fn((_options: BrowserWindowConstructorOptions) => window as unknown as BrowserWindow);
 const host = createElectronHost({ partition: input.partition ?? "om-fixture", createSession, createWindow });
 return { host, session, contents, window, createSession, createWindow, calls };
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
 expect(adapter.calls).toEqual(["load", "show"]);
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
