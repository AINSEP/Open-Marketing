import { z } from "zod";
import { epochSchema, idSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import { failure, parse } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";

/** Host-verified account currency/exponent/timezone, reused by cap and report codecs. No inferred units. */
export const accountMetadataSchema = z.strictObject({ accountId: vendorIdSchema, currency: z.string().regex(/^[A-Z]{3}$/), minorUnitExponent: z.number().int().min(0).max(3), timezone: idSchema, evidenceId: idSchema, observedAt: epochSchema, expiresAt: epochSchema });
export type MetaAccountMetadata = z.infer<typeof accountMetadataSchema>;

/** Match host-owned metadata identity/freshness; trust authentication remains with the host evidence store.
 * @example verifyMetaAccountMetadata({ input: metadata, accountId: "123", currency: "USD", now })
 * @complexity O(1) bounded fields. No I/O.
 */
export function verifyMetaAccountMetadata(required: { input: unknown; accountId: string; currency: string; now: number }): Outcome<MetaAccountMetadata> {
  const parsed = parse({ schema: accountMetadataSchema, input: required.input });
  if (!parsed.ok) return parsed;
  if (parsed.value.accountId !== required.accountId || parsed.value.currency !== required.currency) return failure({ code: "forbidden", message: "Meta account currency evidence mismatch" });
  if (!Number.isSafeInteger(required.now) || required.now < parsed.value.observedAt || required.now >= parsed.value.expiresAt) return failure({ code: "expired", message: "Meta account metadata expired" });
  return parsed;
}
