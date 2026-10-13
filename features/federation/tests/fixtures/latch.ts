import { EventEmitter, once } from "node:events";

/** Explicit synchronization for races; no sleeps, polling or scheduler assumptions. */
export function latch(): { wait: () => Promise<void>; release: () => void } {
  const events = new EventEmitter();
  const pending = once(events, "release");
  return { wait: async () => { await pending; }, release: () => { events.emit("release"); } };
}
