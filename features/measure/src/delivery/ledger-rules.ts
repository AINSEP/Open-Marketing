import type { Outcome } from "@open-marketing/contracts";
import type { ConversionDispatchRecord } from "../types.js";
import { failure } from "../rules.js";

/** Pure ledger invariants shared by memory and SQL. */
export function validateDeliveryTransition(required: { previous?: ConversionDispatchRecord; record: ConversionDispatchRecord }): Outcome<void> {
  const previous = required.previous;
  if (!previous) return failure({ code: "conflict", message: "Delivery claim is missing" });
  if (previous.identity !== required.record.identity) return failure({ code: "conflict", message: "Delivery identity changed" });
  if (previous.status === "delivered" && required.record.status !== "delivered") return failure({ code: "conflict", message: "Delivered evidence cannot regress" });
  if (required.record.status === "dispatching" || required.record.recordedAt < previous.recordedAt) return failure({ code: "conflict", message: "Invalid delivery transition" });
  return { ok: true, value: undefined };
}
