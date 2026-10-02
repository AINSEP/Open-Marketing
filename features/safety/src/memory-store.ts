import type { Outcome } from "@open-marketing/contracts";
import type { SafetyState, StateStore } from "./state.js";
import { initialState, validTimezone } from "./state.js";
import { failure, scopeKey } from "./rules.js";
/** Isolated double for durable aggregate transactions. Rolls back failed decisions and serializes scope writes. @complexity O(s) clone; bounded s <=10,000 journal records. */
export function createMemoryStateStore(required: { ownerTimezone: string }): StateStore {
 if (!validTimezone({ timezone: required.ownerTimezone })) throw new Error("Owner timezone is required");
 const states = new Map<string, SafetyState>();
 const tails = new Map<string, Promise<void>>();
 return {
  async transact(input) {
   const key = scopeKey(input);
   const previous = tails.get(key) ?? Promise.resolve();
   const done = Promise.withResolvers<void>();
   tails.set(key, done.promise);
   await previous;
   try {
    const state = structuredClone(states.get(key) ?? initialState(required));
    const outcome = input.change({ state });
    if (state.journal.length > 10_000 || JSON.stringify(state).length > 4_194_304) return failure({ code: "limit_exceeded", message: "Safety accounting capacity reached; archive required" });
    if (outcome.ok) states.set(key, state);
    return structuredClone(outcome);
   } catch { return failure({ code: "unavailable", message: "Safety transaction failed" }); }
   finally { done.resolve(); if (tails.get(key) === done.promise) tails.delete(key); }
  },
 };
}
