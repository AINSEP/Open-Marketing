import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import type { ElectronHostPort, ChildSupervisorPort } from "../ports.js";
import { createServerSupervisor, type ServerEffects } from "../om-server.js";
import { createElectronHost, type ElectronEffects } from "../electron-host.js";

const success: Outcome<void> = { ok: true, value: undefined };
const cancelled: Outcome<void> = { ok: false, error: { code: "cancelled", message: "Desktop startup was stopped", retryable: false } };
const remoteUrl = z.url().max(2048).refine(value => {
 if (!URL.canParse(value)) return false;
 const url = new URL(value);
 return url.protocol === "https:" && !url.username && !url.password;
});
const absolutePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && !value.includes("\0"));
const configuration = z.discriminatedUnion("mode", [
 z.strictObject({ mode: z.literal("remote"), studioUrl: remoteUrl }),
 z.strictObject({ mode: z.literal("local-sandbox"), nodeExecutable: absolutePath, serverEntry: absolutePath, stateRoot: absolutePath }),
]);

/** Relocatable local startup defaults; retains existing state and sealed credentials.
 * @returns The four OM environment fields; pure, with no filesystem access.
 * @example packagedEnv({ resourcesPath: "/Applications/Open Marketing.app/Contents/Resources", home: "/Users/owner" });
 * @complexity O(1) path joins, bounded by input path lengths.
 */
export function packagedEnv(required: { resourcesPath: string; home: string }): NodeJS.ProcessEnv {
 return {
  OM_MODE: "local-sandbox",
  OM_NODE_EXECUTABLE: join(required.resourcesPath, "node/bin/node"),
  OM_SERVER_ENTRY: join(required.resourcesPath, "om/apps/server/dist/composition/serve.js"),
  OM_STATE_ROOT: join(required.home, ".open-marketing"),
 };
}

/** Inert shell lifecycle; ready server precedes window, shutdown cancels boot.
 * Remote services are never started/stopped. Repeated calls share in-flight work.
 * @returns start/stop with typed startup and cleanup failures; no API restart.
 * @example createDesktopApp({ host, children }).start();
 * @complexity O(1) owned state, excluding injected lifecycle calls.
 */
export function createDesktopApp(required: { host: ElectronHostPort; children: ChildSupervisorPort; studioUrl?: string; mode?: "local-sandbox" | "remote" }): { start(): Promise<Outcome<void>>; stop(): Promise<Outcome<void>> } {
 let starting: Promise<Outcome<void>> | undefined;
 let stopping: Promise<Outcome<void>> | undefined;
 let stopped = false;
 let unsubscribe = () => {};
 let terminal: Outcome<void> | undefined;
 const mode = required.mode ?? "local-sandbox";

 /** Attempt both owned resources; a failed window close must not leak the server. */
 async function cleanup(): Promise<Outcome<void>> {
  const closed = await required.host.close({});
  if (mode === "remote") return closed;
  const reaped = await required.children.stop({ child: "server" });
  if (!reaped.ok) return reaped;
  return closed;
 }

 /** Subscribe before opening; replay makes an exit immediately after readiness observable. */
 async function startLocal(): Promise<Outcome<string>> {
  const ready = await required.children.start({ child: "server" });
  if (!ready.ok) return ready;
  unsubscribe = ready.value.onExit({ listener: outcome => {
   terminal = outcome;
   void stop();
  } });
  return { ok: true, value: ready.value.studioUrl };
 }

 /** Resolve readiness, open studio, and recheck cancellation after the asynchronous load. */
 async function startNow(): Promise<Outcome<void>> {
  let url: Outcome<string>;
  if (mode === "remote") url = resolveRemote({ studioUrl: required.studioUrl });
  else url = await startLocal();
  if (!url.ok) return failStart({ failure: url });
  if (stopped) return terminal ?? cancelled;
  const opened = await required.host.open({ studioUrl: url.value, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  if (!opened.ok) return failStart({ failure: opened });
  if (stopped) return terminal ?? cancelled;
  return success;
 }

 async function failStart(input: { failure: Outcome<void> }): Promise<Outcome<void>> {
  const cleaned = await cleanup();
  if (!cleaned.ok) return cleaned;
  return input.failure;
 }

 function start(): Promise<Outcome<void>> {
  if (stopped) return Promise.resolve(cancelled);
  starting ??= startNow();
  return starting;
 }

 /** Stop children before waiting for boot so a pending ready signal cannot deadlock quit. */
 function stop(): Promise<Outcome<void>> {
  stopped = true;
  unsubscribe();
  stopping ??= stopNow();
  return stopping;
 }

 async function stopNow(): Promise<Outcome<void>> {
  const cleaned = await cleanup();
  await starting;
  const closed = await required.host.close({});
  if (!cleaned.ok) return cleaned;
  return closed;
 }

 return { start, stop };
}

/** Remote connections require HTTPS and use the server's sign-in flow. */
function resolveRemote(required: { studioUrl?: string }): Outcome<string> {
 const parsed = remoteUrl.safeParse(required.studioUrl);
 if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Remote desktop requires an HTTPS studio URL without credentials", retryable: false } };
 return { ok: true, value: parsed.data };
}

/** Sole executable composition: parse selected environment fields, construct adapters.
 * No paths/ports are guessed. Missing configuration fails before spawning or opening.
 * @returns An inert desktop lifecycle, or a safe configuration failure.
 * @complexity O(1) bounded configuration and adapter construction.
 */
export function composeDesktop(required: { env: NodeJS.ProcessEnv; server: ServerEffects; electron: ElectronEffects; partition: string; showError: (required: { message: string }) => void }): Outcome<ReturnType<typeof createDesktopApp>> {
 const mode = required.env.OM_MODE ?? "local-sandbox";
 let input: unknown;
 if (mode === "remote") input = { mode, studioUrl: required.env.OM_STUDIO_URL };
 else input = { mode, nodeExecutable: required.env.OM_NODE_EXECUTABLE, serverEntry: required.env.OM_SERVER_ENTRY, stateRoot: required.env.OM_STATE_ROOT };
 const parsed = configuration.safeParse(input);
 if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Set OM_MODE=remote and OM_STUDIO_URL (HTTPS), or absolute OM_NODE_EXECUTABLE, OM_SERVER_ENTRY, OM_STATE_ROOT for local-sandbox", retryable: false } };
 const host = createElectronHost({ ...required.electron, partition: required.partition });
 if (parsed.data.mode === "remote") {
  const children: ChildSupervisorPort = {
   start: async () => ({ ok: false, error: { code: "forbidden", message: "Remote services are not desktop-owned", retryable: false } }),
   stop: async () => success,
  };
  return { ok: true, value: createDesktopApp({ host, children, ...parsed.data }) };
 }
 const supervisor = createServerSupervisor({ ...required.server, ...parsed.data });
 let closing = false;
 const children: ChildSupervisorPort = {
  async start(input) {
   const result = await supervisor.start(input);
   if (result.ok) result.value.onExit({ listener: outcome => {
    if (!closing && !outcome.ok) required.showError({ message: outcome.error.message });
   } });
   return result;
  },
  stop(input) { closing = true; return supervisor.stop(input); },
 };
 return { ok: true, value: createDesktopApp({ host, children }) };
}
