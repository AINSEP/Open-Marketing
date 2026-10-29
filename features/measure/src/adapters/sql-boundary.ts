import type { CallContext, CallOptions, Outcome, ObserverPort } from "@open-marketing/contracts";
import { runBoundary } from "../boundary.js";

/** A typed domain failure still throws INSIDE a transaction so jobs roll back too.
 * No driver error message is returned across the feature boundary. */
export class MeasureRollback extends Error {
  readonly outcome: Outcome<never>;
  constructor(required: { outcome: Outcome<never> }) { super("Measure transaction rollback"); this.outcome = required.outcome; }
}
export function unwrap<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new MeasureRollback({ outcome: required.outcome });
  return required.outcome.value;
}
/** Restore typed denials only after successful body rollback. Commit/rollback/release failures
 * remain unavailable, preserving uncertainty. @complexity O(1) wrapper around bounded injected work. */
export async function sqlBoundary<T>(required: { context: CallContext; operation: string; observer?: ObserverPort; work: () => Promise<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  return runBoundary<T>({ ...required, work: async (): Promise<Outcome<T>> => {
    try { return { ok: true, value: await required.work() }; }
    catch (error) {
      const body = error instanceof Error && "code" in error && error.code === "transaction_failed" ? error.cause : error;
      if (body instanceof MeasureRollback) return body.outcome;
      throw error;
    }
  } }, optional);
}
