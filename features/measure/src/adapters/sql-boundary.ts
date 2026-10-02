import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { MeasureObserverPort } from "../ports.js";
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
/** Transaction errors preserve typed domain denials; driver throws become unavailable. */
export async function sqlBoundary<T>(required: { context: CallContext; operation: string; observer?: MeasureObserverPort; work: () => Promise<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  return runBoundary({ ...required, work: async () => {
    try { return { ok: true, value: await required.work() }; }
    catch (error) { if (error instanceof MeasureRollback) return error.outcome; throw error; }
  } }, optional);
}
