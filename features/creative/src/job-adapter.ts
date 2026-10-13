import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { CreativeJobPort, CreativeRepoPort } from "./ports.js";
import { failure, sameEvidence, validContext } from "./rules.js";
import { validateStatus } from "./repository-rules.js";

/** Jobs-owned enqueue within the SAME transaction as the supplied creative repository session. */
export type CreativeTransactionalEnqueue = (required: { context: CallContext; operationId: string; argumentsDigest: string; generationId: string }) => Promise<Outcome<{ readonly jobId: string }>>;
/** Composition supplies a transaction joining creative and the ONE jobs outbox. Failure rolls everything back. */
export type CreativeJobTransaction = <T>(required: { context: CallContext; run: (required: { repo: CreativeRepoPort; enqueue: CreativeTransactionalEnqueue }) => Promise<Outcome<T>> }) => Promise<Outcome<T>>;

/** Adapter atomically persists immutable domain intent and jobs enqueue. No SQL/outbox implementation here.
 * @example createTransactionalCreativeJob({ transaction: serverCreativeJobsTransaction })
 * @complexity Constant port calls, O(n log n) bounded original intent comparison.
 */
export function createTransactionalCreativeJob(required: { transaction: CreativeJobTransaction }): CreativeJobPort {
  return {
    async enqueue(input) {
      if (!validContext(input)) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const valid = validateStatus({ status: input.intent });
      if (!valid.ok) return valid;
      if (input.operationId !== input.intent.request.operationId || input.argumentsDigest !== input.intent.request.argumentsDigest) return failure({ code: "conflict", message: "Outbox arguments do not bind generation intent" });
      return transactionBoundary({ transaction: required.transaction, context: input.context, run: async ports => {
        const current = await ports.repo.get({ context: input.context, generationId: input.intent.generationId });
        if (current.ok && !sameEvidence({ left: current.value.request, right: input.intent.request })) return failure({ code: "conflict", message: "Operation already binds different arguments" });
        if (!current.ok) {
          if (current.error.code !== "unavailable") return current;
          const saved = await ports.repo.save({ context: input.context, status: input.intent, expectedRevision: -1 });
          if (!saved.ok) return saved;
        }
        return ports.enqueue({ context: input.context, operationId: input.operationId, argumentsDigest: input.argumentsDigest, generationId: input.intent.generationId });
      } });
    },
  };
}
/** The injected DB/jobs transaction is an opaque I/O boundary; failures never escape as raw exceptions.
 * @complexity Constant transaction calls; rollback is owned by the injected transaction.
 */
async function transactionBoundary<T>(required: { transaction: CreativeJobTransaction; context: CallContext; run: (required: { repo: CreativeRepoPort; enqueue: CreativeTransactionalEnqueue }) => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try { return await required.transaction({ context: required.context, run: required.run }); }
  catch { return failure({ code: "unavailable", message: "Creative intent/outbox transaction unavailable", retryable: true }); }
}
