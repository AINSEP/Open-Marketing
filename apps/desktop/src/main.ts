/** Electron executable entry; all Node/Electron effects enter the sole composition root here. */
import { app, BrowserWindow, dialog, screen, session } from "electron";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import type { Outcome } from "@open-marketing/contracts";
import { composeDesktop, packagedEnv, type createDesktopApp } from "./composition/index.js";
import { initialWindowBounds } from "./electron-host.js";

// Keep the origin stable: localStorage preferences are scoped to session AND origin.
const localServerPort = 43120;

let desktop: ReturnType<typeof createDesktopApp> | undefined;
let quitting: Promise<void> | undefined;
let finished = false;

function showError(required: { message: string }): void {
 dialog.showErrorBox("Open Marketing desktop", required.message);
}

/** Native quit waits for bounded owned-child cleanup; cleanup errors are shown explicitly. */
async function quit(): Promise<void> {
 const result = await desktop?.stop();
 if (result && !result.ok) showError({ message: result.error.message });
 finished = true;
 app.quit();
}

function requestQuit(): void {
 // Assign the shared promise before destroying windows can reenter through Electron events.
 quitting ??= Promise.resolve().then(quit);
}

/** Probe the fixed loopback port before spawning; report collisions without changing origin.
 * The server still owns its actual bind, so this probe never substitutes for readiness.
 * @returns A safe native-boundary failure or success after closing the probe socket.
 */
function checkLocalPort(): Promise<Outcome<void>> {
 return new Promise(resolve => {
  const probe = createServer();
  probe.once("error", error => {
   const occupied = "code" in error && error.code === "EADDRINUSE";
   const message = occupied ? `Local server port ${localServerPort} is already in use. Close the other process and reopen Open Marketing.` : `Unable to use local server port ${localServerPort}.`;
   resolve({ ok: false, error: { code: "unavailable", message, retryable: false } });
  });
  probe.listen(localServerPort, "127.0.0.1", () => probe.close(error => {
   if (error) resolve({ ok: false, error: { code: "unavailable", message: "Unable to close the local port check", retryable: false } });
   else resolve({ ok: true, value: undefined });
  }));
 });
}

/** Resolve configured paths/environment after Electron readiness; no inherited server env. */
async function start(): Promise<void> {
 await app.whenReady();
 if (quitting) return;
 const env = app.isPackaged ? { ...process.env, ...packagedEnv({ resourcesPath: process.resourcesPath, home: app.getPath("home") }) } : process.env;
 const composed = composeDesktop({
  env,
  partition: "persist:om-desktop",
  showError,
  server: {
   platform: process.platform,
   spawn: required => spawn(required.nodeExecutable, [required.serverEntry], { env: { ...required.env, OM_PORT: String(localServerPort) }, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
   signalGroup: required => { process.kill(-required.pid, required.signal); },
   schedule: required => { const timer = setTimeout(required.callback, required.delayMs); return () => clearTimeout(timer); },
   now: () => performance.now(),
  },
  electron: {
   screen,
   createSession: required => session.fromPartition(required.partition, { cache: false }),
   createWindow: required => new BrowserWindow({ ...required, ...initialWindowBounds({ workArea: screen.getPrimaryDisplay().workArea }) }),
  },
 });
 if (!composed.ok) { showError({ message: composed.error.message }); requestQuit(); return; }
 if (env.OM_MODE !== "remote") {
  const available = await checkLocalPort();
  if (!available.ok) { showError({ message: available.error.message }); requestQuit(); return; }
 }
 if (quitting) return;
 desktop = composed.value;
 const result = await desktop.start();
 if (!result.ok) { showError({ message: result.error.message }); requestQuit(); }
}

// Electron event wrappers retain the foreign event ABI; lifecycle logic stays above.
app.on("before-quit", event => { if (!finished) { event.preventDefault(); requestQuit(); } });
app.on("window-all-closed", requestQuit);
process.on("SIGTERM", requestQuit);
process.on("SIGINT", requestQuit);
void start();
