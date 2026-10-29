import type { AppError, CallContext, Outcome, ObserverPort } from '@open-marketing/contracts';
import { MediaConflictError, MediaNotFoundError, MediaValidationError, TransformValidationError } from '@jini-ai/cms/media';
import { MediaImportValidationError } from '@jini-ai/cms/media/import';
import { fail } from './validation.js';

/** Preserve an OM port refusal when a foreign exception-based ABI needs a thrown failure. */
export class MediaBoundaryFailure extends Error {
  readonly error: AppError;
  constructor(required: { error: AppError }) { super(required.error.message); this.error = required.error; }
}

/** Contain opaque dependency errors and emit bounded correlation telemetry. No retries or authority grants.
 * @complexity O(1) wrapper overhead. @example boundary({ context, operation: 'media.list', run: async () => result })
 */
export async function boundary<T>(required: { context: CallContext; operation: string; run: () => Promise<Outcome<T>> }, optional?: { observer?: ObserverPort }): Promise<Outcome<T>> {
  let outcome: Outcome<T>;
  try { outcome = await required.run(); } catch (error) { outcome = dependencyFailure<T>({ error }); }
  observe({ context: required.context, operation: required.operation, outcome, observer: optional?.observer });
  return outcome;
}
/** Jini exceptions become stable OM values; unknown outcomes are never automatically retried. */
function dependencyFailure<T>(required: { error: unknown }): Outcome<T> {
  if (required.error instanceof MediaBoundaryFailure) return { ok: false, error: required.error.error };
  if (required.error instanceof MediaNotFoundError) return fail({ code: 'forbidden', message: 'Asset is absent or inaccessible' });
  if (required.error instanceof MediaConflictError) return fail({ code: 'conflict', message: 'Canonical media conflict' });
  if (isValidationFailure(required)) return fail({ code: 'invalid_input', message: 'Invalid media operation' });
  return fail({ code: 'unavailable', message: 'Media dependency failed; reconcile before retrying' });
}
function isValidationFailure(required: { error: unknown }): boolean {
  return required.error instanceof MediaValidationError || required.error instanceof TransformValidationError || required.error instanceof MediaImportValidationError;
}
/** Observer failure cannot change committed effects; prompts, URLs and driver details are not emitted. */
function observe<T>(required: { context: CallContext; operation: string; outcome: Outcome<T>; observer?: ObserverPort }): void {
  if (!required.observer || !required.context?.correlationId) return;
  try {
    required.observer.observe({ operation: required.operation, outcome: required.outcome.ok ? 'ok' : required.outcome.error.code,
      correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId });
  } catch { /* Telemetry is best-effort and cannot turn a committed append into a failed append. */ }
}
