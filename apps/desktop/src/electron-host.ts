/** Secure Electron adapter; the real Electron module is loaded only by main.ts. */
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import type { ElectronHostPort } from "./ports.js";

/** Electron construction effects injected from the composition root. */
export interface ElectronEffects {
 createSession(required: { partition: string }): Session;
 createWindow(required: BrowserWindowConstructorOptions): BrowserWindow;
}

const success: Outcome<void> = { ok: true, value: undefined };
const studioUrlSchema = z.url().max(2048).refine(value => {
 if (!URL.canParse(value)) return false;
 const url = new URL(value);
 if (url.username || url.password) return false;
 if (url.protocol === "https:") return true;
 return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0;
});
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

/** Reject malformed URLs, credentials, and lookalike hosts before Electron uses them. */
function sameOrigin(required: { url: string; origin: string }): boolean {
 if (!URL.canParse(required.url)) return false;
 const url = new URL(required.url);
 return url.origin === required.origin && !url.username && !url.password;
}

/** Session policy precedes any network traffic. Foreign callback ABIs stay in this adapter.
 * Replaces every casing of CSP so the server cannot accidentally weaken the shell policy.
 * @complexity O(h) response header copying; bounded browser response metadata.
 */
function secureSession(required: { session: Session; origin: string }): void {
 required.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
 required.session.setPermissionCheckHandler(() => false);
 required.session.webRequest.onBeforeRequest((details, callback) => {
  callback({ cancel: !sameOrigin({ url: details.url, origin: required.origin }) });
 });
 required.session.webRequest.onHeadersReceived((details, callback) => {
  const headers = Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([name]) => name.toLowerCase() !== "content-security-policy"));
  callback({ responseHeaders: { ...headers, "Content-Security-Policy": [csp] } });
 });
}

/** Lock top-level/frame navigations and redirects, and deny every popup. */
function secureWindow(required: { window: BrowserWindow; origin: string }): void {
 const contents = required.window.webContents;
 contents.setWindowOpenHandler(() => ({ action: "deny" }));
 // Electron's will-navigate/will-redirect ABI uses (event, url).
 const guard = ({ event, url }: { event: { preventDefault(): void }; url: string }) => {
  if (!sameOrigin({ url, origin: required.origin })) event.preventDefault();
 };
 contents.on("will-navigate", (event, url) => guard({ event, url }));
 contents.on("will-redirect", (event, url) => guard({ event, url }));
 contents.on("will-frame-navigate", event => {
  if (!sameOrigin({ url: event.url, origin: required.origin })) event.preventDefault();
 });
}

/** One isolated, nonpersistent session and window per app instance, with no preload/IPC.
 * Close destroys an in-flight load. Load failures destroy the window and return safe errors.
 * @example host.open({ studioUrl, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
 * @complexity O(1) state, excluding Electron I/O and response header copying.
 */
export function createElectronHost(required: ElectronEffects & { partition: string }): ElectronHostPort {
 let window: BrowserWindow | undefined;
 let opening: Promise<Outcome<void>> | undefined;
 let closed = false;

 async function openNow(input: Parameters<ElectronHostPort["open"]>[0]): Promise<Outcome<void>> {
  const parsed = studioUrlSchema.safeParse(input.studioUrl);
  if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Studio must use HTTPS or the local loopback server", retryable: false } };
  try {
   const session = required.createSession({ partition: required.partition });
   const origin = new URL(parsed.data).origin;
   secureSession({ session, origin });
   window = required.createWindow({ show: false, webPreferences: {
    session, contextIsolation: true, sandbox: true, webSecurity: true,
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
    webviewTag: false, allowRunningInsecureContent: false, experimentalFeatures: false,
   } });
   secureWindow({ window, origin });
   await window.loadURL(parsed.data);
   if (closed) return { ok: false, error: { code: "cancelled", message: "Studio opening was stopped", retryable: false } };
   window.show();
   return success;
  } catch {
   const cleaned = destroyWindow();
   if (!cleaned.ok) return cleaned;
   return { ok: false, error: { code: "unavailable", message: "Unable to load studio in the desktop window", retryable: false } };
  }
 }

 /** Destroy rather than ask the renderer to close; map native cleanup errors. */
 function destroyWindow(): Outcome<void> {
  try {
   if (window && !window.isDestroyed()) window.destroy();
   return success;
  } catch {
   return { ok: false, error: { code: "unavailable", message: "Unable to close the desktop window", retryable: false } };
  }
 }

 return {
  open(input) {
   if (closed) return Promise.resolve({ ok: false, error: { code: "cancelled", message: "Desktop window is closed", retryable: false } });
   opening ??= openNow(input);
   return opening;
  },
  async close() {
   closed = true;
   return destroyWindow();
  },
 };
}
