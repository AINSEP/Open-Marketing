/** Electron executable entry; all Node/Electron effects enter the sole composition root here. */
import { app, BrowserWindow, dialog, session } from "electron";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { composeDesktop, type createDesktopApp } from "./composition/index.js";

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

/** Resolve configured paths/environment after Electron readiness; no inherited server env. */
async function start(): Promise<void> {
 await app.whenReady();
 if (quitting) return;
 const composed = composeDesktop({
  env: process.env,
  partition: `om-desktop-${randomUUID()}`,
  showError,
  server: {
   platform: process.platform,
   spawn: required => spawn(required.nodeExecutable, [required.serverEntry], { env: required.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }),
   signalGroup: required => { process.kill(-required.pid, required.signal); },
   schedule: required => { const timer = setTimeout(required.callback, required.delayMs); return () => clearTimeout(timer); },
   now: () => performance.now(),
  },
  electron: {
   createSession: required => session.fromPartition(required.partition, { cache: false }),
   createWindow: required => new BrowserWindow(required),
  },
 });
 if (!composed.ok) { showError({ message: composed.error.message }); requestQuit(); return; }
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
