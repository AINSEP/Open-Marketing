import type { CallContext, EffectEnvelope, HaltStopRequest, Outcome } from "@open-marketing/contracts";
import { array, epoch, failure, id, numericId, object, parse, protect, success } from "./schema.ts";
import { bindingSchema, contextSchema } from "./schemas.ts";
import { asRecord, searchRows } from "./readback.ts";
import type { AccountBinding, GoogleTransportPort } from "./types.ts";

const hash = { type: "string" as const, pattern: "^[a-f0-9]{64}$", maxLength: 64 };
const stopSchema = object({ properties: {
  operationId: id, scope: object({ properties: { ownerId: id, workspaceId: id } }), connectionId: id,
  adAccountId: { ...numericId, minLength: 10, maxLength: 10 }, entityIds: array({ items: numericId, min: 1, max: 100 }),
  action: { type: "string", enum: ["pause", "stop"] }, haltId: id, haltEpoch: epoch,
  pluginDigest: hash, bindingId: id, argumentsDigest: hash,
} });
/** This distinct host seam verifies CURRENT halt epoch, stop permit, binding, credentials
 * and audit under the dispatch lock. It cannot consume a normal spend approval. */
export interface StopAuthorityPort {
  dispatchStop<T>(required: { context: CallContext; request: HaltStopRequest; effect: EffectEnvelope; execute: () => Promise<Outcome<T>> }): Promise<Outcome<T>>;
}
/** Backend-only stop binding. Closed input and constant PAUSED/status-only operations
 * make activation/budget/creation impossible. It is never an agent MCP tool.
 * @complexity One bounded mutation and one readback; <=100 existing campaign IDs.
 * @example createStopBinding({ binding, transport, authority }).stop({ context, request }) */
export function createStopBinding(required: { binding: AccountBinding; transport: GoogleTransportPort; authority: StopAuthorityPort }): { stop(input: { context: CallContext; request: HaltStopRequest }): Promise<Outcome<{ status: "stopped" | "unknown" }>> } {
  return { stop: input => protect({ work: () => stop({ ...required, ...input }) }) };
}
async function stop(required: { binding: AccountBinding; transport: GoogleTransportPort; authority: StopAuthorityPort; context: CallContext; request: HaltStopRequest }): Promise<Outcome<{ status: "stopped" | "unknown" }>> {
  const binding = parse<AccountBinding>({ schema: bindingSchema, input: required.binding });
  if (!binding.ok) return binding;
  const context = parse<CallContext>({ schema: contextSchema, input: required.context });
  if (!context.ok) return context;
  const parsed = parse<HaltStopRequest>({ schema: stopSchema, input: required.request });
  if (!parsed.ok) return parsed;
  if (!stopScopeMatches({ binding: binding.value, context: context.value, request: parsed.value })) return failure({ code: "forbidden", message: "Stop binding scope or digest mismatch" });
  if (new Set(parsed.value.entityIds).size !== parsed.value.entityIds.length) return failure({ code: "invalid_input", message: "Duplicate stop entity IDs" });
  const effect: EffectEnvelope = { operationId: parsed.value.operationId, connectionId: parsed.value.connectionId, accountId: parsed.value.adAccountId, argumentsDigest: parsed.value.argumentsDigest, effects: ["halt_stop"], moneyExposure: null, requiredLimit: null };
  return required.authority.dispatchStop({ context: context.value, request: parsed.value, effect,
    execute: () => transmitStop({ transport: required.transport, context: context.value, request: parsed.value }),
  });
}
/** Compare only identity/digest fields; halt does not need account metadata. O(1), no effects. */
export function stopScopeMatches(required: { binding: Pick<AccountBinding, "scope" | "connectionId" | "customerId" | "pluginDigest">; context: CallContext; request: HaltStopRequest }): boolean {
  const { binding, context, request } = required;
  return request.scope.ownerId === binding.scope.ownerId && request.scope.workspaceId === binding.scope.workspaceId
    && context.scope.ownerId === binding.scope.ownerId && context.scope.workspaceId === binding.scope.workspaceId
    && request.adAccountId === binding.customerId && request.connectionId === binding.connectionId
    && request.pluginDigest === binding.pluginDigest && request.bindingId === "google-ads.stop.v1";
}
/** Send status-only PAUSED operations, then read back <=100 IDs; failures remain unknown. */
export async function transmitStop(required: { transport: GoogleTransportPort; context: CallContext; request: HaltStopRequest }): Promise<Outcome<{ status: "stopped" | "unknown" }>> {
  const { request, context, transport } = required;
  const operations = request.entityIds.map(entityId => ({ campaignOperation: { update: { resourceName: `customers/${request.adAccountId}/campaigns/${entityId}`, status: "PAUSED" }, updateMask: "status" } }));
  const response = await transport.request({ method: "mutate", body: { mutateOperations: operations, partialFailure: false, validateOnly: false }, context, operationId: request.operationId });
  if (!response.ok) return success({ value: { status: "unknown" } });
  const result = await transport.request({ method: "search", body: { query: "SELECT campaign.id, campaign.status FROM campaign WHERE campaign.id IN (" + request.entityIds.join(",") + ")" }, context, operationId: request.operationId });
  if (!result.ok) return success({ value: { status: "unknown" } });
  const rows = searchRows({ value: result.value });
  if (!rows.ok) return success({ value: { status: "unknown" } });
  const seen = new Set(rows.value.map(row => String(asRecord({ value: row.campaign }).id)));
  const confirmed = request.entityIds.every(entityId => seen.has(entityId)) && rows.value.every(row => asRecord({ value: row.campaign }).status === "PAUSED");
  return success({ value: { status: confirmed ? "stopped" : "unknown" } });
}
