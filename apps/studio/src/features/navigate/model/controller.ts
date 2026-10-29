import { navigationActionSchema, navigationTargetSchema, studioNavigationTargetSchema, parseBoundary } from "@open-marketing/contracts";
import type { NavigationResult, NavigationTarget, StudioNavigationTarget, Outcome } from "@open-marketing/contracts";
import type { TimerPort, StudioTrack } from "../../../shared/api/index.js";

/** Browser route writes are separate from React's rendered-route acknowledgement. */
export interface BrowserRoutePort {
  read(required: Record<string, never>): unknown;
  write(required: { target: NavigationTarget }): Outcome<NavigationTarget>;
  listen(required: { listener: () => void }): () => void;
}
export interface NavigationController {
  getSnapshot(): StudioNavigationTarget;
  subscribe(required: { listener: () => void }): () => void;
  select(required: { target: NavigationTarget }): void;
  apply(required: { input: unknown }): Promise<NavigationResult>;
  rendered(required: { target: StudioNavigationTarget }): void;
  dispose(): void;
}
interface Pending { target: NavigationTarget; actionId: string; handle: unknown; finish: (input: { result: NavigationResult }) => void }
function failed(required: { actionId: string; code: "unavailable" | "invalid_input" | "conflict" | "limit_exceeded"; message: string }): NavigationResult {
  return { status: "failed", actionId: required.actionId, error: { code: required.code, message: required.message, retryable: false } };
}
/** A completed result requires a committed React canvas. Missing browser and deadlines fail honestly.
 * The bounded per-instance action cache prevents duplicate native navigation effects.
 * @example controller.apply({ input: { kind: "navigate", actionId: "a1", target: "campaigns" } })
 * @complexity O(1) per action; at most 100 retained results and one pending action.
 */
export function createNavigationController(required: { browser: BrowserRoutePort | null; timers: TimerPort; timeoutMs: number; track?: StudioTrack }): NavigationController {
  const initial = studioNavigationTargetSchema.safeParse(required.browser?.read({}));
  let target: StudioNavigationTarget = initial.success ? initial.data : "workspaces";
  let pending: Pending | null = null;
  let disposed = false;
  let renderedTarget: StudioNavigationTarget | undefined;
  const listeners = new Set<() => void>();
  const results = new Map<string, { target: NavigationTarget; result: Promise<NavigationResult> }>();
  const publish = (): void => { for (const listener of listeners) listener(); };
  const finish = (input: { result: NavigationResult }): void => {
    if (!pending) return;
    required.timers.cancel({ handle: pending.handle });
    const resolve = pending.finish;
    pending = null;
    resolve(input);
  };
  const select = (input: { target: NavigationTarget }): void => {
    const parsed = navigationTargetSchema.safeParse(input.target);
    if (!parsed.success || disposed) return;
    const written = required.browser?.write({ target: parsed.data });
    if (written && !written.ok) return;
    target = parsed.data;
    publish();
  };
  const unlisten = required.browser?.listen({ listener: () => {
    const parsed = studioNavigationTargetSchema.safeParse(required.browser?.read({}));
    if (parsed.success) { target = parsed.data; publish(); }
  } });
  const begin = (input: { actionId: string; target: NavigationTarget }): Promise<NavigationResult> => {
    if (pending) finish({ result: failed({ actionId: pending.actionId, code: "conflict", message: "Navigation superseded" }) });
    const deferred = Promise.withResolvers<NavigationResult>();
    const handle = required.timers.schedule({ delayMs: required.timeoutMs, callback: () => finish({ result: failed({ actionId: input.actionId, code: "unavailable", message: "Browser did not acknowledge navigation before timeout" }) }) });
    pending = { ...input, handle, finish: result => deferred.resolve(result.result) };
    const written = required.browser!.write({ target: input.target });
    if (!written.ok) { finish({ result: failed({ actionId: input.actionId, code: "unavailable", message: "Browser route update failed" }) }); return deferred.promise; }
    target = written.value;
    publish();
    return deferred.promise;
  };
  return {
    getSnapshot() { return target; },
    subscribe(input) { listeners.add(input.listener); return () => { listeners.delete(input.listener); }; },
    select,
    async apply(input) {
      const parsed = parseBoundary({ schema: navigationActionSchema, input: input.input });
      if (!parsed.ok) return failed({ actionId: "invalid-action", code: "invalid_input", message: "Unsupported navigation action" });
      const action = parsed.value;
      if (!required.browser || disposed) return failed({ actionId: action.actionId, code: "unavailable", message: "No active browser can apply this action" });
      const previous = results.get(action.actionId);
      if (previous) {
        if (previous.target !== action.target) return failed({ actionId: action.actionId, code: "conflict", message: "Navigation action identifier changed target" });
        return previous.result;
      }
      if (results.size >= 100) return failed({ actionId: action.actionId, code: "limit_exceeded", message: "Navigation action bound reached" });
      const result = begin(action);
      results.set(action.actionId, { target: action.target, result });
      return result;
    },
    rendered(input) {
      if (disposed || target !== input.target) return;
      if (renderedTarget !== input.target) {
        renderedTarget = input.target;
        try { required.track?.({ name: 'screen.viewed' }, { properties: { screen: input.target } }); } catch { /* Capture cannot block navigation. */ }
      }
      if (pending?.target === input.target && target === input.target) finish({ result: { status: "completed", actionId: pending.actionId, target: pending.target } });
    },
    dispose() {
      disposed = true;
      if (pending) finish({ result: failed({ actionId: pending.actionId, code: "unavailable", message: "Browser detached before navigation completed" }) });
      unlisten?.(); listeners.clear(); results.clear();
    },
  };
}
