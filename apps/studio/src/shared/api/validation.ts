import { z } from "zod";
import { chatMessageSchema, confirmationCardSchema, navigationActionSchema, navigationTargetSchema, moneySchema, runEventSchema, parseBoundary } from "@open-marketing/contracts";
import type { Outcome, RunEvent } from "@open-marketing/contracts";
import type { StudioPayload, StudioSnapshot } from "./types.js";

const row = z.strictObject({ id: z.string().min(1).max(256), title: z.string().max(200), detail: z.string().max(1024), status: z.string().max(100) });
const displayId = z.string().min(1).max(256);
const title = z.string().min(1).max(200);
const detail = z.string().max(1024);
const evidenceList = z.array(detail).max(100);
const creativeSchema = z.strictObject({
  generations: z.array(z.strictObject({
    id: displayId, title, brief: detail, status: z.enum(["review", "pending", "succeeded", "failed", "unknown"]),
    quote: moneySchema.nullable(), estimated: moneySchema.nullable(), actual: moneySchema.nullable(), costEvidence: detail,
    allowanceClassification: z.enum(["within_allowance", "over_allowance", "unknown_cost"]), approvalCardId: displayId.nullable(),
  })).max(100),
  assets: z.array(z.strictObject({
    id: displayId, title, dimensions: z.string().max(100), originalId: displayId.nullable(), crop: detail.nullable(),
    provenance: detail, cost: moneySchema.nullable(), costEvidence: detail, importEvidence: detail,
  })).max(100),
});
const campaignsSchema = z.strictObject({
  drafts: z.array(z.strictObject({
    id: displayId, title, status: z.literal("paused"), review: z.enum(["ready", "blocked", "unavailable"]),
    reasons: evidenceList, approvalCardId: displayId.nullable(),
  })).max(100),
  halts: z.array(z.strictObject({
    id: displayId, account: title, localBarrier: z.enum(["blocked", "unconfirmed"]),
    remoteStop: z.enum(["stopped", "pending", "partial", "unknown"]), detail, operationId: displayId, auditId: displayId,
  })).max(100),
  allowances: z.array(z.strictObject({
    id: z.enum(["image-generation", "paid-sending"]), title, daily: moneySchema, used: moneySchema,
    reserved: moneySchema, remaining: moneySchema, timezone: z.string().min(1).max(100), reset: detail, revision: detail,
  })).max(100),
});
const operationsSchema = z.strictObject({
  reports: z.array(z.strictObject({
    id: displayId, title, source: z.enum(["om_ledger", "platform_report", "om_attribution"]),
    period: title, freshness: detail, gaps: evidenceList, restates: displayId.nullable(),
    cac: moneySchema.nullable(), cacReason: detail.nullable(),
  })).max(100),
  connections: z.array(z.strictObject({
    id: displayId, title, status: z.enum(["connected", "reauthentication_required", "not_connected"]), scope: detail, recovery: detail,
  })).max(100),
  plugins: z.array(z.strictObject({
    id: displayId, title, version: z.string().min(1).max(100), status: z.enum(["admitted", "update_requires_review", "revoked"]), authority: detail, recovery: detail,
  })).max(100),
  measurementGrant: z.strictObject({ status: z.enum(["active", "revoked", "unavailable"]), events: evidenceList, destinations: evidenceList, purposes: evidenceList, detail }),
  activity: z.array(z.strictObject({
    id: displayId, title, status: z.enum(["recorded", "pending", "unknown"]), operationId: displayId,
    jobId: displayId.nullable(), auditId: displayId.nullable(), detail,
  })).max(100),
});
const snapshotSchema = z.strictObject({
  workspace: z.string().max(100), mode: z.enum(["sample", "connected", "unavailable"]),
  metrics: z.array(z.strictObject({ label: z.string().max(100), value: z.string().max(100), detail: z.string().max(200) })).max(12),
  rows: z.record(navigationTargetSchema, z.array(row).max(100)), messages: z.array(chatMessageSchema).max(200), cards: z.array(confirmationCardSchema).max(50),
  allowance: z.strictObject({ daily: moneySchema, remaining: moneySchema, timezone: z.string().max(100) }),
  pages: z.strictObject({ creative: creativeSchema, campaigns: campaignsSchema, operations: operationsSchema }).optional(),
});
const payloadSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("message"), message: chatMessageSchema }),
  z.strictObject({ type: z.literal("confirmation"), card: confirmationCardSchema }),
  z.strictObject({ type: z.literal("navigation"), action: navigationActionSchema }),
  z.strictObject({ type: z.literal("status"), text: z.string().max(1024) }),
]);
const secretKey = /^(authorization|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|api[_-]?key|bearer|credentials?)$/i;
const secretText = /\bBearer\s+\S+|\bsk-[a-zA-Z0-9_-]{12,}|-----BEGIN .*PRIVATE KEY-----/;

/** Reject sensitive payloads intact: redacting exact arguments changes what was reviewed.
 * Server redaction remains the primary secret boundary.
 * @complexity O(characters), at most 262144 serialized characters and 16 object levels.
 */
export function isSafeUiValue(required: { value: unknown; maxCharacters: number }): boolean {
  try {
    const serialized = JSON.stringify(required.value);
    if (!serialized || serialized.length > required.maxCharacters) return false;
    return inspectValue({ value: required.value, depth: 0 });
  } catch { return false; }
}
function inspectValue(required: { value: unknown; depth: number }): boolean {
  if (required.depth > 16) return false;
  if (typeof required.value === "string") return !secretText.test(required.value);
  if (typeof required.value !== "object" || required.value === null) return true;
  return Object.entries(required.value).every(([key, value]) => !secretKey.test(key) && inspectValue({ value, depth: required.depth + 1 }));
}
function unsafe<T>(): Outcome<T> { return { ok: false, error: { code: "invalid_input", message: "Display payload rejected", retryable: false } }; }
/** Parse a bounded snapshot before storing any server data in React. */
export function parseStudioSnapshot(required: { input: unknown }): Outcome<StudioSnapshot> {
  if (!isSafeUiValue({ value: required.input, maxCharacters: 262144 })) return unsafe();
  return parseBoundary({ schema: snapshotSchema, input: required.input });
}
/** Validate both the shared run envelope and its narrow studio display payload. */
export function parseStudioEvent(required: { input: unknown }): Outcome<{ event: RunEvent; payload: StudioPayload }> {
  if (!isSafeUiValue({ value: required.input, maxCharacters: 65536 })) return unsafe();
  const event = parseBoundary({ schema: runEventSchema, input: required.input });
  if (!event.ok) return event;
  const payload = parseBoundary({ schema: payloadSchema, input: event.value.payload });
  if (!payload.ok) return payload;
  return { ok: true, value: { event: event.value, payload: payload.value } };
}
