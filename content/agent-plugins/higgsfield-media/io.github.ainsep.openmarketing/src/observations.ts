import { createHash } from "node:crypto";
import type { Money, Outcome } from "@open-marketing/contracts";
import type { ChargeObservation, HiggsfieldDependencies } from "./types.js";
import type { ProviderStatus } from "./provider-results.js";
import { observedCreditCharge } from "./pricing.js";
import { portBoundary } from "./results.js";

/** One stable append identity per provider job and observation kind; amount drift must conflict.
 * @example createChargeObservation({ operationId, providerJobId, kind: "estimated", amount, pricingEvidenceId, quoteId, providerChargeEvidenceId: null })
 * @complexity O(i), i bounded identity text; no I/O or hidden clock.
 */
export function createChargeObservation(required: {
  operationId: string; providerJobId: string; kind: "estimated" | "actual"; amount: Money;
  pricingEvidenceId: string; quoteId: string; providerChargeEvidenceId: string | null;
}): ChargeObservation {
  const observationId = createHash("sha256").update(JSON.stringify(["higgsfield", required.operationId, required.providerJobId, required.kind])).digest("hex");
  return { ...required, observationId };
}

/** Append known estimate and explicit actual charge before import, even on a failed vendor job.
 * The job handle is already durable at poll time. Failure stops import and leaves possible charge
 * for server reconciliation; no refund/zero inference. Repeated status is idempotent at the port.
 * @returns Typed port failure or void success. @complexity O(1), at most two appends per poll.
 */
export async function recordCharges(required: { dependencies: HiggsfieldDependencies; jobId: string; status: ProviderStatus }): Promise<Outcome<void>> {
  const d = required.dependencies;
  if (d.quote.estimated !== null) {
    const estimated = await appendObservation({ dependencies: d, jobId: required.jobId, kind: "estimated", amount: d.quote.estimated, providerChargeEvidenceId: null });
    if (!estimated.ok) return estimated;
  }
  if (required.status.credits === null) return { ok: true, value: undefined };
  const actual = observedCreditCharge({ credits: required.status.credits, pricing: d.pricing, binding: d.binding, intent: d.intent, now: d.clock.now({}) });
  if (actual === null) return { ok: true, value: undefined };
  return appendObservation({ dependencies: d, jobId: required.jobId, kind: "actual", amount: actual, providerChargeEvidenceId: required.status.chargeEvidenceId });
}

/** The only observation effect; never catches/echoes repository text, and never creates a ledger. */
function appendObservation(required: { dependencies: HiggsfieldDependencies; jobId: string; kind: "estimated" | "actual"; amount: Money; providerChargeEvidenceId: string | null }): Promise<Outcome<void>> {
  const d = required.dependencies;
  const observation = createChargeObservation({ operationId: d.intent.operationId, providerJobId: required.jobId, kind: required.kind,
    amount: required.amount, pricingEvidenceId: d.quote.pricingEvidenceId, quoteId: d.quote.quoteId, providerChargeEvidenceId: required.providerChargeEvidenceId });
  return portBoundary({ execute: () => d.deadlines.run({ timeoutMs: 15000,
    execute: input => d.observations.append({ context: d.context, observation }, input) }) });
}
