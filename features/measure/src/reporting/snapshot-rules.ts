import type { Outcome } from "@open-marketing/contracts";
import type { PlatformMetricSnapshot } from "../types.js";
import { failure } from "../rules.js";

/** Canonical snapshot comparison is independent of object-property insertion order. */
export function snapshotIdentity(required: { snapshot: PlatformMetricSnapshot }): string {
  const s = required.snapshot;
  return JSON.stringify([s.snapshotId, s.accountId, s.window.start, s.window.end, s.spend.minorUnits, s.spend.currency, s.timezone, s.attributionWindow, s.retrievedAt, s.restatementOf ?? null]);
}
/** Restatements cannot silently change the account/currency/period being restated. */
export function validateLineage(required: { parent: PlatformMetricSnapshot; snapshot: PlatformMetricSnapshot }): Outcome<void> {
  const parent = required.parent;
  const child = required.snapshot;
  if (parent.accountId !== child.accountId || parent.spend.currency !== child.spend.currency || parent.timezone !== child.timezone) return failure({ code: "conflict", message: "Restatement dimensions differ" });
  if (parent.window.start !== child.window.start || parent.window.end !== child.window.end || parent.attributionWindow !== child.attributionWindow) return failure({ code: "conflict", message: "Restatement window differs" });
  if (child.retrievedAt < parent.retrievedAt) return failure({ code: "invalid_input", message: "Restatement predates its parent" });
  return { ok: true, value: undefined };
}
