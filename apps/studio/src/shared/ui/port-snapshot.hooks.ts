import { useCallback, useSyncExternalStore } from "react";
/** Adapt the object-shaped port to React's subscription lifecycle and snapshot consistency checks. */
export function usePortSnapshot<T>(required: { getSnapshot: () => T; subscribe: (input: { listener: () => void }) => () => void }): T {
  const subscribe = useCallback((listener: () => void) => required.subscribe({ listener }), [required.subscribe]);
  return useSyncExternalStore(subscribe, required.getSnapshot);
}
