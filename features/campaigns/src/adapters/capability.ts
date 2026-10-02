import type { z } from "zod";
import type { CallContext, CallOptions, Outcome } from "@open-marketing/contracts";
import type { CampaignCapabilityPort, CampaignObserverPort } from "../ports.js";
import { capabilityCreateSchema, capabilityLaunchSchema, capabilityReadSchema } from "../capability-schemas.js";
import { checkCancelled } from "../repo-rules.js";
import { exactMatch, fail, launchReceiptSchema, parseBoundary, readbackSchema, receiptSchema } from "../rules.js";

/** Composition-owned federation binding: admits capabilities, enforces the timeout,
 * verifies account scope and permit at final dispatch, and preserves operation identity.
 * Vendor payload translation/configuration remain entirely in Agent Plugins.
 */
export interface CampaignBackendPort {
  invoke(required: { context: CallContext; operation: "create-paused" | "launch" | "read-state"; operationId: string; payload: unknown; timeoutMs: number }, optional?: CallOptions): Promise<Outcome<unknown>>;
}
interface Dependencies { backend: CampaignBackendPort; observer?: CampaignObserverPort; timeoutMs: number }
/** Validated generic capability adapter. Bounded input/output and injected federation
 * timeout; thrown transport failures remain typed unavailable, never success/retry.
 * @example createCampaignCapabilityAdapter({ backend }, { timeoutMs: 15000, observer });
 * @complexity O(n) bounded DTO traversal, one backend call, no retries.
 */
export function createCampaignCapabilityAdapter(required: { backend: CampaignBackendPort }, optional: { timeoutMs?: number; observer?: CampaignObserverPort } = {}): CampaignCapabilityPort {
  const timeoutMs = optional.timeoutMs ?? 15000;
  const dependencies: Dependencies = { ...required, observer: optional.observer, timeoutMs };
  return {
    async createPaused(input, options) {
      const parsed = parseBoundary({ schema: capabilityCreateSchema, input });
      if (!parsed.ok) return parsed;
      const result = await invoke({ dependencies, context: parsed.value.context, operation: "create-paused", operationId: parsed.value.draft.operationId, payload: parsed.value, schema: receiptSchema }, options);
      if (!result.ok) return result;
      if (result.value.campaignId !== parsed.value.campaignId) return fail({ code: "conflict", message: "Provider campaign mismatch" });
      return result;
    },
    async launch(input, options) {
      const parsed = parseBoundary({ schema: capabilityLaunchSchema, input });
      if (!parsed.ok) return parsed;
      if (!exactMatch({ request: parsed.value.request, proposal: parsed.value.proposal })) return fail({ code: "conflict", message: "Provider argument binding mismatch" });
      const result = await invoke({ dependencies, context: parsed.value.context, operation: "launch", operationId: parsed.value.request.operationId, payload: parsed.value, schema: launchReceiptSchema }, options);
      if (!result.ok) return result;
      if (result.value.operationId !== parsed.value.request.operationId) return fail({ code: "conflict", message: "Provider operation mismatch" });
      return result;
    },
    async readState(input, options) {
      const parsed = parseBoundary({ schema: capabilityReadSchema, input });
      if (!parsed.ok) return parsed;
      const result = await invoke({ dependencies, context: parsed.value.context, operation: "read-state", operationId: parsed.value.operationId, payload: parsed.value, schema: readbackSchema }, options);
      if (!result.ok) return result;
      if (result.value.state.campaignId !== parsed.value.campaignId) return fail({ code: "conflict", message: "Provider readback mismatch" });
      return result;
    },
  };
}
async function invoke<T>(required: { dependencies: Dependencies; context: CallContext; operation: "create-paused" | "launch" | "read-state"; operationId: string; payload: unknown; schema: z.ZodType<T> }, optional?: CallOptions): Promise<Outcome<T>> {
  const cancelled = checkCancelled({ options: optional });
  if (!cancelled.ok) return cancelled;
  const { dependencies, context, operation, operationId, payload, schema } = required;
  if (!Number.isInteger(dependencies.timeoutMs) || dependencies.timeoutMs < 1 || dependencies.timeoutMs > 60000) return fail({ code: "invalid_input", message: "Capability timeout must be 1..60000ms" });
  let result: Outcome<T>;
  try {
    const response = await dependencies.backend.invoke({ context, operation, operationId, payload, timeoutMs: dependencies.timeoutMs }, optional);
    if (!response.ok) result = response;
    else result = parseBoundary({ schema, input: response.value });
  } catch { result = fail({ code: "unavailable", message: "Campaign capability unavailable" }); }
  try { dependencies.observer?.observe({ operation: "campaigns.capability." + operation, outcome: result.ok ? "succeeded" : result.error.code, correlationId: context.correlationId, traceId: context.traceId, runId: context.runId }); }
  catch { /* Telemetry cannot turn an uncertain write into failure or success. */ }
  return result;
}
