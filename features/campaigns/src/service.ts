import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignService } from "./types.js";
import type { CampaignDependencies, CampaignInstrumentation } from "./dependencies.js";
import { createAndDispatch } from "./create-and-dispatch.js";
import { proposeLaunch, queueLaunch } from "./launch.js";
import { dispatchOperation, reconcileOperation } from "./dispatch.js";
import { fail } from "./rules.js";

/** Inert service. Inject scoped ports; call createPaused, proposeLaunch, approve its exact
 * operation through safety, launch, then drive dispatch/reconcile from a server worker.
 * Factory starts no services. Adapter exceptions map to typed unavailable; an already
 * claimed write remains uncertain and cannot be retried. @complexity O(1) construction.
 */
export function createCampaignService(required: CampaignDependencies, optional: CampaignInstrumentation = {}): CampaignService {
  return {
    saveLocal(input, options) { return boundary({ context: input?.context, operation: "campaigns.saveLocal", instrumentation: optional, execute: () => required.repo.saveNeutral(input, options) }, options); },
    getLocal(input, options) { return boundary({ context: input?.context, operation: "campaigns.getLocal", instrumentation: optional, execute: () => required.repo.getNeutral(input, options) }, options); },
    createPaused(input, options) { return boundary({ context: input?.context, operation: "campaigns.createPaused", instrumentation: optional, execute: () => createAndDispatch({ dependencies: required, input }, options) }, options); },
    proposeLaunch(input, options) { return boundary({ context: input?.context, operation: "campaigns.proposeLaunch", instrumentation: optional, execute: () => proposeLaunch({ dependencies: required, input }, options) }, options); },
    launch(input, options) { return boundary({ context: input?.context, operation: "campaigns.launch", instrumentation: optional, execute: () => queueLaunch({ dependencies: required, input }, options) }, options); },
    dispatch(input, options) { return boundary({ context: input?.context, operation: "campaigns.dispatch", instrumentation: optional, execute: () => dispatchOperation({ dependencies: required, input }, options) }, options); },
    reconcile(input, options) { return boundary({ context: input?.context, operation: "campaigns.reconcile", instrumentation: optional, execute: () => reconcileOperation({ dependencies: required, input }, options) }, options); },
  };
}
/** One module boundary catches broken/thrown injected adapter failures without claiming success. */
async function boundary<T>(required: { context: CallContext; operation: string; instrumentation: CampaignInstrumentation; execute: () => Promise<Outcome<T>> }, optional?: CallOptions): Promise<Outcome<T>> {
  if (optional?.signal?.aborted) return fail({ code: "cancelled", message: "Campaign call cancelled" });
  let outcome: Outcome<T>;
  try { outcome = await required.execute(); }
  catch { outcome = fail({ code: "unavailable", message: "Campaign boundary unavailable" }); }
  report({ ...required, outcome: outcome.ok ? "succeeded" : outcome.error.code });
  return outcome;
}
function report(required: { context: CallContext; operation: string; instrumentation: CampaignInstrumentation; outcome: string }): void {
  try { required.instrumentation.observer?.observe({ operation: required.operation, outcome: required.outcome, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId }); }
  catch { /* Observability must not change an irreversible operation's outcome. */ }
}
