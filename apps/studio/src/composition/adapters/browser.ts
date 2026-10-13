import type { Outcome, NavigationTarget } from "@open-marketing/contracts";
import { navigationTargetSchema } from "@open-marketing/contracts";
import type { BrowserRoutePort } from "../../features/navigate/index.js";
import type { StudioRuntime, TimerPort } from "../../shared/api/index.js";

/** Host adapter receives browser objects explicitly. No module import touches them. */
export function browserRuntime(required: { host: Window; now: () => number; nextId: () => string }): StudioRuntime {
  const timers = browserTimers({ host: required.host });
  return { clock: { now: required.now }, ids: { next: required.nextId }, timers, abort: () => new AbortController() };
}
function browserTimers(required: { host: Window }): TimerPort {
  return {
    schedule(input) { return required.host.setTimeout(input.callback, Math.max(0, input.delayMs)); },
    cancel(input) { required.host.clearTimeout(input.handle as number); },
    wait(input) {
      const deferred = Promise.withResolvers<void>();
      if (input.signal?.aborted) { deferred.resolve(); return deferred.promise; }
      const finish = (): void => { required.host.clearTimeout(handle); input.signal?.removeEventListener("abort", finish); deferred.resolve(); };
      const handle = required.host.setTimeout(finish, input.delayMs);
      input.signal?.addEventListener("abort", finish, { once: true });
      return deferred.promise;
    },
  };
}
/** Same-document hash routes are allowlisted before browser history is touched. */
export function browserRoutes(required: { host: Window }): BrowserRoutePort {
  return {
    read() { return required.host.location.hash.slice(1); },
    write(input): Outcome<NavigationTarget> {
      const parsed = navigationTargetSchema.safeParse(input.target);
      if (!parsed.success) return { ok: false, error: { code: "invalid_input", message: "Unsupported browser route", retryable: false } };
      try { required.host.location.hash = parsed.data; return { ok: true, value: parsed.data }; }
      catch { return { ok: false, error: { code: "unavailable", message: "Browser route update failed", retryable: false } }; }
    },
    listen(input) { required.host.addEventListener("hashchange", input.listener); return () => required.host.removeEventListener("hashchange", input.listener); },
  };
}
