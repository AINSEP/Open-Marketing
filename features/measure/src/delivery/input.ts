import { z } from "zod";
import { idSchema, measurementGrantSchema, parseBoundary } from "@open-marketing/contracts";
import type { MeasurementGrant, Outcome, ServiceContext } from "@open-marketing/contracts";
import type { ConversionInput } from "../types.js";
import { conversionSchema, eventIdentity, serviceContextSchema } from "../rules.js";

/** Both dispatch and reconciliation take the same validated, detached payload. */
export type DeliveryInput = { context: ServiceContext; event: ConversionInput; grant: MeasurementGrant; deliveryId: string };
const deliveryInputSchema = z.strictObject({ context: serviceContextSchema, event: conversionSchema, grant: measurementGrantSchema, deliveryId: idSchema });

/** Optional delivery IDs at the legacy port boundary are rejected before I/O.
 * @complexity O(k) time/space for a maximum of 16 identifier keys. */
export function parseDeliveryInput(required: { input: Omit<DeliveryInput, "deliveryId"> & { deliveryId?: string } }): Outcome<DeliveryInput> {
  return parseBoundary({ schema: deliveryInputSchema, input: required.input });
}

/** Identity binds the account/connection and schema as well as the event. Trace IDs,
 * revocation state and wall time never change delivery identity during recovery.
 * @complexity O(k log k) time/O(k) space for bounded identifiers. */
export function deliveryIdentity(required: { input: DeliveryInput }): string {
  const input = required.input;
  return JSON.stringify([input.context.scope.ownerId, input.context.scope.workspaceId, input.grant.grantId, input.grant.connectionId, input.grant.accountId, input.grant.payloadSchema, input.grant.payloadVersion, eventIdentity({ event: input.event })]);
}
