import { createHash } from "node:crypto";
import { z } from "zod";
import { idSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome, ServiceContext } from "@open-marketing/contracts";
import type { ConversionInput, MeasureGrant, ResolvedConversionInput } from "../types.js";
import { conversionSchema, eventIdentity, failure, measureGrantSchema, resolvedConversionSchema, serviceContextSchema } from "../rules.js";

/** Durable worker input; only the capability payload carries resolved identifiers. */
export type DeliveryInput = { context: ServiceContext; event: ConversionInput; grant: MeasureGrant; deliveryId: string };
/** Transient send/reconciliation input; never write this payload to the inbox or ledger. */
export type ResolvedDeliveryInput = Omit<DeliveryInput, "event"> & { event: ResolvedConversionInput };
const deliveryInputSchema = z.strictObject({ context: serviceContextSchema, event: conversionSchema, grant: measureGrantSchema, deliveryId: idSchema });
const reconciliationInputSchema = deliveryInputSchema.extend({ event: resolvedConversionSchema.partial({ identifiers: true }), receiptId: idSchema.optional() });
/** Readback carries saved receipt evidence; identifiers are unnecessary. */
type ReconciliationInput = z.infer<typeof reconciliationInputSchema>;

/** Parse readback independently of the transient send payload. No identifier lookup.
 * @complexity O(k), at most 16 optional identifier keys; no I/O. */
export function parseReconciliationInput(required: { input: ReconciliationInput }): Outcome<ReconciliationInput> {
  return parseBoundary({ schema: reconciliationInputSchema, input: required.input });
}

/** Optional delivery IDs at the port boundary are rejected before I/O.
 * @complexity O(k) time/space for a maximum of 16 identifier keys. */
export function parseDeliveryInput(required: { input: Omit<DeliveryInput, "deliveryId"> & { deliveryId?: string } }): Outcome<DeliveryInput> {
  return parseBoundary({ schema: deliveryInputSchema, input: required.input });
}

/** Capability boundary accepts identifiers only transiently and requires exact digest keys.
 * @complexity O(k log k) for at most 16 keys; no I/O. */
export function parseResolvedDeliveryInput(required: { input: Omit<ResolvedDeliveryInput, "deliveryId"> & { deliveryId?: string } }): Outcome<ResolvedDeliveryInput> {
  const parsed = parseBoundary({ schema: deliveryInputSchema.extend({ event: resolvedConversionSchema }), input: required.input });
  if (!parsed.ok) return parsed;
  const event = parsed.value.event;
  if (JSON.stringify(Object.keys(event.identifiers).sort()) !== JSON.stringify(Object.keys(event.identifierDigests).sort())) return failure({ code: "forbidden", message: "Identifier keys do not match committed digests" });
  return parsed;
}

/** Identity binds the account/connection and schema as well as the event. Trace IDs,
 * revocation state and wall time never change delivery identity during recovery.
 * @complexity O(k log k) time/O(k) space for bounded identifiers. */
export function deliveryIdentity(required: { input: DeliveryInput }): string {
  const input = required.input;
  return createHash("sha256").update(JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId, input.grant.grantId, input.grant.connectionId, input.grant.accountId, input.grant.payloadSchema, input.grant.payloadVersion, eventIdentity({ event: input.event })])).digest("hex");
}
