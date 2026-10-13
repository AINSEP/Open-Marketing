/** Adapted from Tovu apps/desktop/src/tovu-server.ts (Apache-2.0).
 * OM changes: minimal readiness, explicit sandbox env, injected effects, POSIX group cleanup.
 * Imports/factories are inert; no Tovu runtime dependency.
 */
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import type { Outcome } from "@open-marketing/contracts";
import type { ChildSupervisorPort, ServerReady } from "./ports.js";

type Child = Pick<ChildProcess, "pid" | "stdout" | "stderr" | "exitCode" | "signalCode"> & {
 /** Node event ABI; supervision never consumes the emitter's chaining return value. */
 once(event: "exit" | "error", listener: () => void): unknown;
};
/** Narrow Node effects supplied at the executable composition boundary.
 * schedule returns cancellation; now is monotonic milliseconds.
 */
export interface ServerEffects {
 platform: NodeJS.Platform;
 spawn(required: { nodeExecutable: string; serverEntry: string; env: Record<string, string> }): Child;
 signalGroup(required: { pid: number; signal: NodeJS.Signals | 0 }): void;
 schedule(required: { callback: () => void; delayMs: number }): () => void;
 now(required: Record<string, never>): number;
}

type Failure = Extract<Outcome<never>, { ok: false }>;
const success: Outcome<void> = { ok: true, value: undefined };
const readySchema = z.strictObject({ studioUrl: z.url().max(2048).refine(value => {
 if (!URL.canParse(value)) return false;
 const url = new URL(value);
 return url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0 && !url.username && !url.password;
}) });
const noGroup = z.object({ code: z.literal("ESRCH") });

function failure(required: { code?: Failure["error"]["code"]; message: string }): Failure {
 return { ok: false, error: { code: required.code ?? "unavailable", message: required.message, retryable: false } };
}

/** Strict, bounded server readiness; no credentials or third-party diagnostics escape.
 * @returns A loopback studio URL or a protocol failure.
 * @complexity O(n) time/space for a line bounded to 4096 characters.
 */
function parseReady(required: { line: string }): Outcome<string> {
 try {
  const parsed = readySchema.safeParse(JSON.parse(required.line.slice(9)));
  if (!parsed.success) return failure({ code: "protocol_mismatch", message: "Server readiness must contain only a loopback studioUrl" });
  return { ok: true, value: parsed.data.studioUrl };
 } catch {
  return failure({ code: "protocol_mismatch", message: "Server emitted malformed OM_READY JSON" });
 }
}

/** Capture exit before waiting for readiness; replay closes the ready/subscribe race.
 * Only stdout carries readiness; stderr is drained and never included in errors.
 * @complexity O(n) stream work, constant 4096-character buffer, O(l) exit listeners.
 */
function watchChild(required: { child: Child; effects: ServerEffects; bootTimeoutMs: number }) {
 let settled = false;
 let exited = required.child.exitCode !== null || required.child.signalCode !== null;
 let exit: Outcome<void> | undefined;
 let pending = "";
 const listeners = new Set<(outcome: Outcome<void>) => void>();
 let resolve!: (outcome: Outcome<string>) => void;
 const ready = new Promise<Outcome<string>>(done => { resolve = done; });
 let cancelTimer = () => {};

 function finish(input: { outcome: Outcome<string> }): void {
  if (settled) return;
  settled = true;
  pending = "";
  cancelTimer();
  resolve(input.outcome);
 }

 function publishExit(input: { outcome: Failure }): void {
  exit = input.outcome;
  finish({ outcome: input.outcome });
  for (const listener of listeners) listener(input.outcome);
  listeners.clear();
 }

 // Node stream and process callbacks retain the foreign ABI at this narrow wrapper.
 function readChunk(chunk: string): void {
  if (settled) return;
  let offset = 0;
  while (offset < chunk.length) {
   const newline = chunk.indexOf("\n", offset);
   const end = newline < 0 ? chunk.length : newline;
   if (!appendSegment({ chunk, offset, end })) return;
   if (newline < 0) return;
   consumeLine();
   if (settled) return;
   offset = newline + 1;
  }
 }

 function appendSegment(input: { chunk: string; offset: number; end: number }): boolean {
  if (pending.length + input.end - input.offset > 4096) {
   finish({ outcome: failure({ code: "limit_exceeded", message: "Server stdout line exceeds 4096 characters" }) });
   return false;
  }
  pending += input.chunk.slice(input.offset, input.end);
  return true;
 }

 function consumeLine(): void {
  const line = pending.trimEnd();
  pending = "";
  if (line.startsWith("OM_READY ")) finish({ outcome: parseReady({ line }) });
 }

 required.child.once("exit", () => {
  exited = true;
  publishExit({ outcome: failure({ message: "Local OM server exited; desktop is closing" }) });
 });
 required.child.once("error", () => publishExit({ outcome: failure({ message: "Unable to run the configured OM server" }) }));
 required.child.stdout?.setEncoding("utf8");
 required.child.stdout?.on("data", readChunk);
 required.child.stderr?.resume();
 cancelTimer = required.effects.schedule({ callback: () => finish({ outcome: failure({ message: "OM server did not report readiness within the boot deadline" }) }), delayMs: required.bootTimeoutMs });
 if (exited) publishExit({ outcome: failure({ message: "OM server exited before readiness" }) });
 if (!required.child.stdout || !required.child.stderr) finish({ outcome: failure({ message: "OM server output pipes are unavailable" }) });

 return {
  ready,
  isExited: () => exited,
  cancel: () => finish({ outcome: failure({ code: "cancelled", message: "OM server startup was stopped" }) }),
  onExit(input: { listener: (outcome: Outcome<void>) => void }): () => void {
   if (exit) input.listener(exit);
   else listeners.add(input.listener);
   return () => { listeners.delete(input.listener); };
  },
 };
}

type Owned = { child: Child; watch: ReturnType<typeof watchChild> };

/** Signal/query only the detached group we own. ESRCH alone proves absence. */
function signalOwned(required: { effects: ServerEffects; pid: number; signal: NodeJS.Signals | 0 }): Outcome<boolean> {
 try {
  required.effects.signalGroup({ pid: required.pid, signal: required.signal });
  return { ok: true, value: true };
 } catch (error) {
  if (noGroup.safeParse(error).success) return { ok: true, value: false };
  return failure({ message: "Unable to inspect or terminate the owned OM process group" });
 }
}

/** Poll until the child is reaped AND its group is absent, bounded by a monotonic deadline.
 * A parent exit alone does not establish descendant cleanup.
 * @complexity O(timeout/50ms) OS queries, O(1) space.
 */
async function waitGone(required: { owned: Owned; effects: ServerEffects; timeoutMs: number }): Promise<Outcome<boolean>> {
 const deadline = required.effects.now({}) + required.timeoutMs;
 while (true) {
  const present = signalOwned({ effects: required.effects, pid: required.owned.child.pid!, signal: 0 });
  if (!present.ok) return present;
  if (!present.value && required.owned.watch.isExited()) return { ok: true, value: true };
  if (required.effects.now({}) >= deadline) return { ok: true, value: false };
  await new Promise<void>(resolve => { required.effects.schedule({ callback: resolve, delayMs: 50 }); });
 }
}

/** SIGTERM group, grace, SIGKILL group, then verify/reap. Cleanup failures stay explicit. */
async function stopOwned(required: { owned: Owned; effects: ServerEffects; graceMs: number }): Promise<Outcome<void>> {
 required.owned.watch.cancel();
 if (required.owned.child.pid === undefined) return success;
 const term = signalOwned({ effects: required.effects, pid: required.owned.child.pid, signal: "SIGTERM" });
 if (!term.ok) return term;
 const graceful = await waitGone({ ...required, timeoutMs: required.graceMs });
 if (!graceful.ok) return graceful;
 if (graceful.value) return success;
 const killed = signalOwned({ effects: required.effects, pid: required.owned.child.pid, signal: "SIGKILL" });
 if (!killed.ok) return killed;
 const gone = await waitGone({ ...required, timeoutMs: 1000 });
 if (!gone.ok) return gone;
 if (!gone.value) return failure({ message: "Owned OM process group did not terminate after SIGKILL" });
 return success;
}

/** One local server per supervisor; repeated start/stop share work. No restart or agent API.
 * Paths are validated by composition. The child inherits only the four explicit sandbox vars.
 * @returns An inert supervisor; Windows start is unavailable.
 * @example supervisor.start({ child: "server" });
 * @complexity O(1) owned state plus bounded boot/shutdown stream/poll work.
 */
export function createServerSupervisor(required: ServerEffects & { nodeExecutable: string; serverEntry: string; stateRoot: string }, options: { bootTimeoutMs?: number; stopGraceMs?: number } = {}): ChildSupervisorPort {
 let owned: Owned | undefined;
 let starting: Promise<Outcome<ServerReady>> | undefined;
 let stopping: Promise<Outcome<void>> | undefined;

 async function startNow(): Promise<Outcome<ServerReady>> {
  try {
   const child = required.spawn({ nodeExecutable: required.nodeExecutable, serverEntry: required.serverEntry, env: { OM_MODE: "local-sandbox", OM_STATE_ROOT: required.stateRoot, OM_HOST: "127.0.0.1", OM_PORT: "0" } });
   owned = { child, watch: watchChild({ child, effects: required, bootTimeoutMs: options.bootTimeoutMs ?? 60_000 }) };
  } catch {
   return failure({ message: "Unable to spawn the configured OM server" });
  }
  const ready = await owned.watch.ready;
  if (!ready.ok) {
   const cleaned = await stop();
   if (!cleaned.ok) return cleaned;
   return ready;
  }
  return { ok: true, value: { studioUrl: ready.value, onExit: owned.watch.onExit } };
 }

 function start(): Promise<Outcome<ServerReady>> {
  if (required.platform === "win32") return Promise.resolve(failure({ message: "Local desktop supervision is unavailable on Windows" }));
  if (stopping) return Promise.resolve(failure({ code: "cancelled", message: "OM server is stopping" }));
  starting ??= startNow();
  return starting;
 }

 function stop(): Promise<Outcome<void>> {
  if (stopping) return stopping;
  if (!owned) return Promise.resolve(success);
  stopping = stopOwned({ owned, effects: required, graceMs: options.stopGraceMs ?? 5000 });
  return stopping;
 }

 return { start, stop };
}
