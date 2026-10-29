import type { Outcome } from "@open-marketing/contracts";
import type { ConversionDiagnostics, ConversionDispatchRecord } from "../types.js";
import { failure } from "../rules.js";

/** Pure ledger invariants shared by memory and SQL. Delivery status and local
 * record time cannot regress; vendor diagnostics are merged separately.
 * @complexity O(1), three diagnostic fields and no I/O. */
export function validateDeliveryTransition(required: { previous?: ConversionDispatchRecord; record: ConversionDispatchRecord }): Outcome<void> {
  const previous = required.previous;
  const record = required.record;
  if (!previous) return failure({ code: "conflict", message: "Delivery claim is missing" });
  if ((["identity", "subjectId", "eventId"] as const).some(key => previous[key] !== record[key])) return failure({ code: "conflict", message: "Delivery identity changed" });
  if (previous.status === "not_sent") return failure({ code: "conflict", message: "Not-sent evidence is final" });
  if ((record.status === "not_sent") !== (record.reason !== undefined)) return failure({ code: "conflict", message: "Not-sent reason is required only for not-sent evidence" });
  if (previous.receiptId !== undefined && record.receiptId !== previous.receiptId) return failure({ code: "conflict", message: "Delivery receipt cannot change" });
  if (previous.status === "delivered" && required.record.status !== "delivered") return failure({ code: "conflict", message: "Delivered evidence cannot regress" });
  if (required.record.status === "dispatching" || required.record.recordedAt < previous.recordedAt) return failure({ code: "conflict", message: "Invalid delivery transition" });
  return { ok: true, value: undefined };
}
/** Merge vendor observations without blocking delivery. Confirmed true survives,
 * null retains prior evidence, and other values come from the newer observation.
 * Missing diagnostics retain the previous observation; no stages are inferred.
 * @complexity O(1), three stages, no mutation or I/O. */
export function mergeDeliveryDiagnostics({ before, after }: { before?: ConversionDiagnostics; after?: ConversionDiagnostics }): ConversionDiagnostics | undefined {
  if (!before) return after;
  if (!after) return before;
  const newer = after.observedAt >= before.observedAt ? after : before;
  const older = newer === after ? before : after;
  return {
    accepted: before.accepted === true || after.accepted === true || (newer.accepted ?? older.accepted),
    processed: before.processed === true || after.processed === true || (newer.processed ?? older.processed),
    attributed: before.attributed === true || after.attributed === true || (newer.attributed ?? older.attributed),
    observedAt: Math.max(before.observedAt, after.observedAt),
  };
}
