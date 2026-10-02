import { parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CreativeService, GenerationPollRequest, GenerationStatus } from "./types.js";
import type { CreativeDependencies } from "./lifecycle.js";
import type { CreativeObserverPort } from "./ports.js";
import { dispatchGeneration, recordOutcome, requestGeneration } from "./lifecycle.js";
import { reconcilePage, refreshJob } from "./reconciliation.js";
import { failure, pollRequestSchema, success, validContext } from "./rules.js";

/** Inert factory. Injects every effect; a server worker calls dispatchGeneration/pollDue/recover.
 * @param required Server-owned boundaries, clock and IDs; never creates a scheduler.
 * @returns Scoped generation lifecycle with explicit boundary outcomes.
 * @example createCreativeService({ repo, generation, assets, jobs, safety, clock, ids, audit })
 * @complexity O(1) construction; bounded work per method.
 */
export function createCreativeService(required: Omit<CreativeDependencies, "observer">, optional?: { observer?: CreativeObserverPort }): CreativeService {
  const deps: CreativeDependencies = { ...required, observer: optional?.observer };
  return {
    async requestGeneration(input, options) {
      const outcome = await requestGeneration({ deps, ...input }, options);
      return report({ deps, ...input, operationId: input.request.operationId, operation: "creative.requestGeneration", outcome }, options);
    },
    async dispatchGeneration(input, options) {
      if (!validContext({ context: input.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const outcome = await dispatchGeneration({ deps, ...input }, options);
      return report({ deps, ...input, operationId: input.generationId, operation: "creative.dispatchGeneration", outcome }, options);
    },
    async refreshJob(input, options) {
      if (!validContext({ context: input.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const outcome = await refreshJob({ deps, ...input }, options);
      return report({ deps, ...input, operationId: input.generationId, operation: "creative.refreshJob", outcome }, options);
    },
    async pollDue(input, options) {
      if (!validContext({ context: input.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const parsed = parseBoundary({ schema: pollRequestSchema, input: input.request });
      if (!parsed.ok) return parsed;
      const outcome = await pollAndReconcile({ deps, context: input.context, request: parsed.value }, options);
      return report({ deps, ...input, operationId: input.request.leaseOwner, operation: "creative.pollDue", outcome }, options);
    },
    async recover(input, options) {
      if (!validContext({ context: input.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const outcome = await deps.generation.recover(input, options);
      if (!outcome.ok) return outcome;
      const page = await reconcilePage({ deps, context: input.context, limit: 100 }, options);
      if (!page.ok) return page;
      return report({ deps, ...input, operationId: "recovery", operation: "creative.recover", outcome }, options);
    },
    async cancelGeneration(input, options) {
      if (!validContext({ context: input.context })) return failure({ code: "forbidden", message: "Invalid creative scope" });
      const outcome = await cancelLocal({ deps, ...input }, options);
      return report({ deps, ...input, operationId: input.generationId, operation: "creative.cancelGeneration", outcome }, options);
    },
  };
}
async function report<T>(required: { deps: CreativeDependencies; context: CallContext; operationId: string; operation: string; outcome: Outcome<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (!validContext({ context: required.context })) return required.outcome;
  return recordOutcome(required, optional);
}
/** A tick polls at most limit vendor rows and reconciles one paginated page independently of chat. */
async function pollAndReconcile(required: { deps: CreativeDependencies; context: CallContext; request: GenerationPollRequest }, optional?: CallOptions) {
  const polled = await required.deps.generation.pollDue(required, optional);
  if (!polled.ok) return polled;
  const page = await reconcilePage({ deps: required.deps, context: required.context, limit: required.request.limit, cursor: required.request.cursor }, optional);
  if (!page.ok) return page;
  return success({ value: { ...polled.value, reconcileCursor: page.value } });
}
/** Cancellation is local scheduling state; preserve actual charges, reservation and late output. */
async function cancelLocal(required: { deps: CreativeDependencies; context: CallContext; generationId: string }, optional?: CallOptions): Promise<Outcome<GenerationStatus>> {
  const current = await required.deps.repo.get(required, optional);
  if (!current.ok) return current;
  if (current.value.state === "succeeded") return current;
  const cancelled = await required.deps.repo.save({ context: required.context, status: { ...current.value, state: "cancelled" } }, optional);
  if (!cancelled.ok) return cancelled;
  if (cancelled.value.dispatchState === "queued") return cancelled;
  const stopped = await required.deps.generation.cancel(required, optional);
  if (!stopped.ok) return stopped;
  return refreshJob(required, optional);
}
