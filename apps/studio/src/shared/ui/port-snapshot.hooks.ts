import { useEffect, useState } from "react";
/** Object-shaped store subscription; subscribe then read closes the render/effect update gap. */
export function usePortSnapshot<T>(required: { getSnapshot: () => T; subscribe: (input: { listener: () => void }) => () => void }): T {
  const [snapshot, setSnapshot] = useState(required.getSnapshot);
  useEffect(() => {
    const refresh = (): void => setSnapshot(required.getSnapshot());
    const unsubscribe = required.subscribe({ listener: refresh });
    refresh();
    return unsubscribe;
  }, [required.getSnapshot, required.subscribe]);
  return snapshot;
}
