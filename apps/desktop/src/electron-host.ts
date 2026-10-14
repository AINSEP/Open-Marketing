/** Secure Electron adapter; the real Electron module is loaded only by main.ts. */
import type { BrowserWindow, BrowserWindowConstructorOptions, Rectangle, Screen, Session } from "electron";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import type { ElectronHostPort } from "./ports.js";

/** Electron construction effects injected from the composition root. */
export interface ElectronEffects {
 createSession(required: { partition: string }): Session;
 createWindow(required: BrowserWindowConstructorOptions): BrowserWindow;
 screen: Pick<Screen, "getAllDisplays" | "getCursorScreenPoint" | "getDisplayNearestPoint">;
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

/** Center a 1360×900 default within the primary work area, including its origin.
 * Jini's restore helper only checks saved overlap; it does not cap or center in a work area.
 * @returns Complete initial bounds, capped to fit smaller displays without saved positions.
 */
export function initialWindowBounds(required: { workArea: Rectangle }): Rectangle {
 return centeredWindowBounds({ workArea: required.workArea, bounds: { width: 1360, height: 900 } });
}

/** Preserve visible windows, including negative coordinates and partial overlap.
 * Both window bounds and work areas must use Electron DIP coordinates.
 * @returns Whether at least one display has positive-area overlap; edge contact is off-screen.
 * @example intersectsWorkArea({ bounds: windowBounds, workAreas: displays.map(display => display.workArea) });
 * @complexity O(d) time for d displays, O(1) extra space; no effects.
 */
export function intersectsWorkArea(required: { bounds: Rectangle; workAreas: readonly Rectangle[] }): boolean {
 const bounds = required.bounds;
 return required.workAreas.some(area =>
  Math.max(bounds.x, area.x) < Math.min(bounds.x + bounds.width, area.x + area.width) &&
  Math.max(bounds.y, area.y) < Math.min(bounds.y + bounds.height, area.y + area.height));
}

/** Center existing DIP dimensions, capped to the destination work area. No effects.
 * @returns Complete centered bounds in DIP coordinates.
 * @example centeredWindowBounds({ bounds: { width: 800, height: 600 }, workArea });
 * @complexity O(1) time/space.
 */
export function centeredWindowBounds(required: { workArea: Rectangle; bounds: Pick<Rectangle, "width" | "height"> }): Rectangle {
 const width = Math.min(required.bounds.width, required.workArea.width);
 const height = Math.min(required.bounds.height, required.workArea.height);
 return { width, height, x: required.workArea.x + Math.floor((required.workArea.width - width) / 2), y: required.workArea.y + Math.floor((required.workArea.height - height) / 2) };
}

/** Read current geometry after show: constructor-time display placement can be stale.
 * Move only fully off-screen windows to the cursor's display; native failures reach openNow's typed error boundary.
 * @complexity O(d) time/space for the current display list; one native move at most.
 */
function ensureWindowVisible(required: { window: BrowserWindow; screen: ElectronEffects["screen"] }): void {
 const bounds = required.window.getBounds();
 const workAreas = required.screen.getAllDisplays().map(display => display.workArea);
 if (intersectsWorkArea({ bounds, workAreas })) return;
 const workArea = required.screen.getDisplayNearestPoint(required.screen.getCursorScreenPoint()).workArea;
 required.window.setBounds(centeredWindowBounds({ bounds, workArea }));
}

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

/** One caller-selected session and window per app instance, with no preload/IPC.
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
   ensureWindowVisible({ window, screen: required.screen });
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
