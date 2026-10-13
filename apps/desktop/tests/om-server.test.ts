import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildSupervisorPort } from "../src/ports.js";
import { createServerSupervisor, type ServerEffects } from "../src/om-server.js";

const success = { ok: true, value: undefined };
const schedule: ServerEffects["schedule"] = input => { const timer = setTimeout(input.callback, input.delayMs); return () => clearTimeout(timer); };

class FakeChild extends EventEmitter {
 pid = 43210;
 exitCode: number | null = null;
 signalCode: NodeJS.Signals | null = null;
 stdout = new PassThrough();
 stderr = new PassThrough();
 exit(input: { code?: number; signal?: NodeJS.Signals } = {}) {
  this.exitCode = input.code ?? null;
  this.signalCode = input.signal ?? null;
  this.emit("exit", this.exitCode, this.signalCode);
 }
}

function fake(input: { autoReady?: boolean; ignoreTerm?: boolean; retainGroup?: boolean; stuck?: boolean; platform?: NodeJS.Platform } = {}) {
 const child = new FakeChild();
 const signals: (NodeJS.Signals | 0)[] = [];
 let present = true;
 const spawnEffect = vi.fn((_request: Parameters<ServerEffects["spawn"]>[0]) => {
  if (input.autoReady) queueMicrotask(() => child.stdout.write('OM_READY {"studioUrl":"http://127.0.0.1:43210"}\n'));
  return child;
 });
 const effects: ServerEffects = {
  platform: input.platform ?? "darwin", spawn: spawnEffect, schedule, now: () => globalThis.performance.now(),
  signalGroup(request) {
   expect(request.pid).toBe(43210);
   signals.push(request.signal);
   if (!present) throw Object.assign(new Error("gone"), { code: "ESRCH" });
   if (request.signal === 0) return;
   if (input.stuck) return;
   if (request.signal === "SIGTERM" && input.ignoreTerm) return;
   if (request.signal === "SIGKILL" || !input.retainGroup) present = false;
   queueMicrotask(() => child.exit({ signal: request.signal as NodeJS.Signals }));
  },
 };
 const supervisor = createServerSupervisor({ ...effects, nodeExecutable: "/node", serverEntry: "/server.mjs", stateRoot: "/state" }, { bootTimeoutMs: 100, stopGraceMs: 100 });
 return { child, signals, spawnEffect, supervisor, effects, setAbsent: () => { present = false; }, isPresent: () => present };
}

async function fixture(input: { scenario: string }) {
 const root = await mkdtemp(join(tmpdir(), "om-desktop-"));
 const stateRoot = join(root, input.scenario);
 await mkdir(stateRoot);
 let child: ChildProcess | undefined;
 const supervisor = createServerSupervisor({
  nodeExecutable: process.execPath, serverEntry: fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url)), stateRoot,
  platform: process.platform, schedule, now: () => performance.now(),
  spawn(request) {
   child = spawn(request.nodeExecutable, [request.serverEntry], { env: request.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
   return child;
  },
  signalGroup: request => { process.kill(-request.pid, request.signal); },
 }, { bootTimeoutMs: 3000, stopGraceMs: 150 });
 return {
  supervisor, stateRoot,
  async cleanup() {
   await supervisor.stop({ child: "server" });
   if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already absent. */ } }
   await rm(root, { recursive: true, force: true });
  },
 };
}

/** The same ready/start/stop/exit contract runs against Node fixtures and memory children. */
function supervisionContract(input: { name: string; create: () => Promise<{ supervisor: ChildSupervisorPort; cleanup(): Promise<void> }> }) {
 describe(input.name, () => {
  it("shares startup, exposes readiness, reaps on repeated stop, and replays exit", async () => {
   const adapter = await input.create();
   try {
    const starting = adapter.supervisor.start({ child: "server" });
    expect(adapter.supervisor.start({ child: "server" })).toBe(starting);
    const ready = await starting;
    expect(ready.ok).toBe(true);
    if (!ready.ok) throw new Error("readiness assertion failed");
    expect(new URL(ready.value.studioUrl).hostname).toBe("127.0.0.1");
    const exit = vi.fn();
    const cancelled = vi.fn();
    ready.value.onExit({ listener: exit });
    ready.value.onExit({ listener: cancelled })();
    const stopping = adapter.supervisor.stop({ child: "server" });
    expect(adapter.supervisor.stop({ child: "server" })).toBe(stopping);
    expect(await stopping).toEqual(success);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(cancelled).not.toHaveBeenCalled();
    const replay = vi.fn();
    ready.value.onExit({ listener: replay });
    expect(replay).toHaveBeenCalledWith({ ok: false, error: { code: "unavailable", message: "Local OM server exited; desktop is closing", retryable: false } });
   } finally { await adapter.cleanup(); }
  });
 });
}

supervisionContract({ name: "memory supervisor contract", create: async () => {
 const adapter = fake({ autoReady: true });
 return { supervisor: adapter.supervisor, cleanup: async () => { await adapter.supervisor.stop({ child: "server" }); } };
} });
describe.skipIf(process.platform === "win32")("POSIX fixture supervision", () => {
 supervisionContract({ name: "Node supervisor contract", create: () => fixture({ scenario: "split" }) });
 it.each(["no-ready", "exit-before-ready"])("cleans up %s startup failures", async scenario => {
  const adapter = await fixture({ scenario });
  try {
   expect(await adapter.supervisor.start({ child: "server" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
   expect(await adapter.supervisor.stop({ child: "server" })).toEqual(success);
  } finally { await adapter.cleanup(); }
 });
 it.each(["ignore-term", "descendant"])("terminates the owned group for %s", async scenario => {
  const adapter = await fixture({ scenario });
  try {
   expect((await adapter.supervisor.start({ child: "server" })).ok).toBe(true);
   let descendant: number | undefined;
   if (scenario === "descendant") descendant = Number(await readFile(join(adapter.stateRoot, "descendant.pid"), "utf8"));
   expect(await adapter.supervisor.stop({ child: "server" })).toEqual(success);
   if (descendant) expect(() => process.kill(descendant, 0)).toThrow();
  } finally { await adapter.cleanup(); }
 });
});

afterEach(() => { vi.useRealTimers(); });

it("uses only explicit sandbox env and spawns once for split readiness", async () => {
 const adapter = fake();
 const starting = adapter.supervisor.start({ child: "server" });
 expect(adapter.spawnEffect).toHaveBeenCalledExactlyOnceWith({ nodeExecutable: "/node", serverEntry: "/server.mjs", env: { OM_MODE: "local-sandbox", OM_STATE_ROOT: "/state", OM_HOST: "127.0.0.1", OM_PORT: "0" } });
 adapter.child.stdout.write('noise\nOM_RE');
 adapter.child.stderr.write("not a readiness source\n");
 adapter.child.stdout.write('ADY {"studioUrl":"http://127.0.0.1:43210/studio"}\n');
 expect(await starting).toMatchObject({ ok: true, value: { studioUrl: "http://127.0.0.1:43210/studio" } });
 await adapter.supervisor.stop({ child: "server" });
});

it.each([
 'OM_READY {"studioUrl":"https://evil.example"}\n',
 'OM_READY {"studioUrl":"http://127.0.0.1.evil.example:1234"}\n',
 'OM_READY {"studioUrl":"http://owner:secret@127.0.0.1:1234"}\n',
 'OM_READY {"studioUrl":"bad-url"}\n',
 'OM_READY {"studioUrl":"http://127.0.0.1:1234","extra":true}\n',
 'OM_READY invalid-json\n',
])("rejects tainted readiness and reaps the server: %s", async line => {
 const adapter = fake();
 const starting = adapter.supervisor.start({ child: "server" });
 adapter.child.stdout.write(line);
 expect(await starting).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
 expect(adapter.isPresent()).toBe(false);
});

it("bounds a newline-free stdout buffer", async () => {
 const adapter = fake();
 const starting = adapter.supervisor.start({ child: "server" });
 adapter.child.stdout.write("x".repeat(4097));
 expect(await starting).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
 expect(adapter.isPresent()).toBe(false);
});

it("times out boot and reaps without leaking stderr diagnostics", async () => {
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
 const adapter = fake();
 const starting = adapter.supervisor.start({ child: "server" });
 adapter.child.stderr.write("credential-looking-fixture\n");
 await vi.advanceTimersByTimeAsync(200);
 const result = await starting;
 expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
 expect(JSON.stringify(result)).not.toContain("credential-looking-fixture");
 expect(adapter.isPresent()).toBe(false);
});

it("stop during boot wins over a subsequent readiness line", async () => {
 const adapter = fake();
 const starting = adapter.supervisor.start({ child: "server" });
 const stopping = adapter.supervisor.stop({ child: "server" });
 adapter.child.stdout.write('OM_READY {"studioUrl":"http://127.0.0.1:43210"}\n');
 expect(await starting).toMatchObject({ ok: false, error: { code: "cancelled" } });
 expect(await stopping).toEqual(success);
});

it("parent exit does not skip SIGKILL of a surviving descendant group", async () => {
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
 const adapter = fake({ autoReady: true, retainGroup: true });
 await adapter.supervisor.start({ child: "server" });
 const stopping = adapter.supervisor.stop({ child: "server" });
 await vi.advanceTimersByTimeAsync(200);
 expect(await stopping).toEqual(success);
 expect(adapter.signals).toContain("SIGKILL");
 expect(adapter.isPresent()).toBe(false);
});

it("SIGKILL without confirmed group termination is an explicit failure", async () => {
 vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
 const adapter = fake({ autoReady: true, stuck: true });
 await adapter.supervisor.start({ child: "server" });
 const stopping = adapter.supervisor.stop({ child: "server" });
 await vi.advanceTimersByTimeAsync(1200);
 expect(await stopping).toMatchObject({ ok: false, error: { message: "Owned OM process group did not terminate after SIGKILL" } });
});

it("Windows start is unavailable and has no process effects", async () => {
 const adapter = fake({ platform: "win32" });
 expect(await adapter.supervisor.start({ child: "server" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
 expect(adapter.spawnEffect).not.toHaveBeenCalled();
});

it("spawn error and premature exit return safe typed failures", async () => {
 for (const event of ["error", "exit"] as const) {
  const adapter = fake();
  const starting = adapter.supervisor.start({ child: "server" });
  if (event === "exit") { adapter.setAbsent(); adapter.child.exit({ code: 7 }); }
  else { adapter.child.pid = undefined as unknown as number; adapter.child.emit("error", new Error("fixture-spawn-failure")); }
  expect(await starting).toMatchObject({ ok: false, error: { code: "unavailable" } });
 }
});

it("a synchronous spawn failure remains an outcome without attempted group cleanup", async () => {
 const adapter = fake();
 adapter.spawnEffect.mockImplementation(() => { throw new Error("fixture-spawn-failure"); });
 expect(await adapter.supervisor.start({ child: "server" })).toMatchObject({ ok: false, error: { message: "Unable to spawn the configured OM server" } });
 expect(await adapter.supervisor.stop({ child: "server" })).toEqual(success);
 expect(adapter.signals).toEqual([]);
});

it("a child already exited when observed fails startup", async () => {
 const adapter = fake();
 adapter.setAbsent();
 adapter.child.exit({ code: 7 });
 expect(await adapter.supervisor.start({ child: "server" })).toMatchObject({ ok: false, error: { message: "OM server exited before readiness" } });
});

it("missing output pipes fail boot and clean up the owned group", async () => {
 const adapter = fake();
 adapter.child.stdout = null as unknown as PassThrough;
 expect(await adapter.supervisor.start({ child: "server" })).toMatchObject({ ok: false, error: { message: "OM server output pipes are unavailable" } });
 expect(adapter.isPresent()).toBe(false);
});

it("accepts a complete stdout line at the buffer limit", async () => {
 const adapter = fake();
 const starting = adapter.supervisor.start({ child: "server" });
 adapter.child.stdout.write(`${"x".repeat(4096)}\nOM_READY {"studioUrl":"http://127.0.0.1:43210"}\n`);
 expect((await starting).ok).toBe(true);
 await adapter.supervisor.stop({ child: "server" });
});

it("group signal failure is reported rather than claiming cleanup succeeded", async () => {
 const adapter = fake({ autoReady: true });
 const supervisor = createServerSupervisor({ ...adapter.effects,
  nodeExecutable: "/node", serverEntry: "/server.mjs", stateRoot: "/state",
  signalGroup: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); },
 });
 expect((await supervisor.start({ child: "server" })).ok).toBe(true);
 expect(await supervisor.stop({ child: "server" })).toMatchObject({ ok: false, error: { message: "Unable to inspect or terminate the owned OM process group" } });
 expect(adapter.isPresent()).toBe(true);
});
