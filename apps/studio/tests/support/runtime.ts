import type { StudioRuntime, TimerPort } from "../../src/shared/api/index.js";
/** Deterministic host double: no hidden clock, random source, sleep, or live vendor. */
export function testRuntime(required: { start?: number } = {}) {
  let now = required.start ?? 1000;
  let id = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const timers: TimerPort = {
    schedule(input) { const handle = ++id; tasks.set(handle, { at: now + input.delayMs, callback: input.callback }); return handle; },
    cancel(input) { tasks.delete(input.handle as number); },
    wait(input) {
      const deferred = Promise.withResolvers<void>();
      if (input.signal?.aborted) { deferred.resolve(); return deferred.promise; }
      const finish = (): void => { timers.cancel({ handle }); input.signal?.removeEventListener("abort", finish); deferred.resolve(); };
      const handle = timers.schedule({ delayMs: input.delayMs, callback: finish });
      input.signal?.addEventListener("abort", finish, { once: true });
      return deferred.promise;
    },
  };
  const runtime: StudioRuntime = { clock: { now() { return now; } }, ids: { next() { return "test-" + ++id; } }, timers, abort: () => new AbortController() };
  return {
    runtime,
    advance(input: { ms: number }) {
      now += input.ms;
      const due = [...tasks.entries()].filter(([, task]) => task.at <= now).sort((left, right) => left[1].at - right[1].at);
      for (const [handle, task] of due) { if (tasks.delete(handle)) task.callback(); }
    },
    pending() { return tasks.size; },
  };
}
