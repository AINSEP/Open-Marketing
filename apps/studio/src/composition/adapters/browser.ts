import type { Outcome, NavigationTarget, ObserverPort } from "@open-marketing/contracts";
import { navigationTargetSchema } from "@open-marketing/contracts";
import type { BrowserRoutePort } from "../../features/navigate/index.js";
import type { StudioRuntime, TimerPort } from "../../shared/api/index.js";

/** Access may itself throw in restricted browser contexts; appearance then uses System. */
export function browserStorage(required: { host: Window }): Storage | null {
  try { return required.host.localStorage; }
  catch { return null; }
}

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

/** Jini's foreign request ABI is confined here. Bound response writes get one 15s deadline,
 * same-origin cookies and tracing; an interrupted write is never automatically retried.
 * @complexity One HTTP call; no retained queues or credentials.
 */
export function browserFrontendRequest(required: { fetch: typeof fetch; runtime: StudioRuntime; observer: ObserverPort }):
  (input: { url: string; init: RequestInit; timeoutMs: number }) => Promise<Response> {
  return async input => {
    const controller = required.runtime.abort();
    const abort = () => controller.abort();
    input.init.signal?.addEventListener('abort', abort, { once: true });
    if (input.init.signal?.aborted) abort();
    const handle = required.runtime.timers.schedule({ delayMs: Math.min(input.timeoutMs, 15000), callback: abort });
    const correlationId = required.runtime.ids.next({}); const traceId = required.runtime.ids.next({});
    let outcome = 'unavailable';
    try {
      const headers = new Headers(input.init.headers); headers.set('x-correlation-id', correlationId); headers.set('x-trace-id', traceId);
      const response = await required.fetch(input.url, { ...input.init, headers, signal: controller.signal, credentials: 'same-origin', redirect: 'error' });
      if (controller.signal.aborted) throw new Error('Frontend response interrupted');
      outcome = String(response.status); return response;
    } finally {
      required.runtime.timers.cancel({ handle }); input.init.signal?.removeEventListener('abort', abort);
      try { required.observer.observe({ operation: 'studio.frontend.response', outcome, correlationId, traceId }); }
      catch { /* Diagnostics cannot change response delivery. */ }
    }
  };
}
