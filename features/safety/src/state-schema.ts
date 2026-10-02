import { z } from "zod";
import { generationAllowanceSettingsSchema, generationCostQuoteSchema, moneySchema, timeWindowSchema, idSchema, epochSchema } from "@open-marketing/contracts";
import { dispatchRequestSchema, generationRequestSchema, settlementSchema } from "./rules.js";
const halt = z.strictObject({ haltId: idSchema, adAccountId: idSchema, epoch: epochSchema, remoteStatus: z.enum(["pending", "stopped", "partial", "unknown"]) });
const permit = z.strictObject({ operationId: idSchema, argumentsDigest: z.string(), approvalId: idSchema, expiresAt: epochSchema, reservationId: idSchema });
const reservation = z.strictObject({ reservationId: idSchema, operationId: idSchema, quoteId: idSchema, dispatchDay: idSchema, allowanceRevision: epochSchema, amount: moneySchema, kind: z.enum(["normal_write", "exact_spend"]) });
/** Durable snapshots are tainted DB output; strict decoding must precede any decision. */
export const safetyStateSchema = z.strictObject({
 revision: epochSchema,
 halts: z.record(z.string(), halt),
 reservations: z.record(z.string(), z.strictObject({ request: dispatchRequestSchema, permit, amount: moneySchema.nullable(), window: timeWindowSchema.nullable() })),
 settings: generationAllowanceSettingsSchema,
 cycle: z.strictObject({ day: idSchema, timezone: idSchema, end: epochSchema }).nullable(),
 generations: z.record(z.string(), z.strictObject({ request: generationRequestSchema, quote: generationCostQuoteSchema, reservation, latestObservation: idSchema.nullable(), actual: epochSchema.nullable() })),
 observations: z.record(z.string(), settlementSchema),
 discrepancy: z.boolean(),
 journal: z.array(z.strictObject({ kind: idSchema, operationId: idSchema, at: epochSchema, correlationId: idSchema, traceId: idSchema, runId: idSchema.optional(), value: z.json() })).max(10_000),
});
