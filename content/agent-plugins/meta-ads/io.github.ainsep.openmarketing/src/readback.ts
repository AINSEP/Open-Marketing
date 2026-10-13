import { z } from "zod";
import { epochSchema, moneySchema } from "@open-marketing/contracts";
import type { Money, Outcome } from "@open-marketing/contracts";
import { boundedJson, failure, parse } from "./boundary.js";
import { vendorIdSchema } from "./commands.js";
import { verifyMetaAccountMetadata } from "./account.js";
import type { MetaAccountMetadata } from "./account.js";

const amount = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(value => Number.isSafeInteger(Number(value)));
const entity = z.strictObject({ id: vendorIdSchema, account_id: vendorIdSchema, configured_status: z.enum(["PAUSED", "ACTIVE", "DELETED", "ARCHIVED"]), effective_status: z.string().min(1).max(64), spend_cap: amount.optional(), daily_budget: amount.optional() });
/** Adapter's normalized readback shape; the actual hosted output must be bound by verified schema evidence. */
export const readbackSchema = z.strictObject({ complete: z.boolean(), entities: z.array(entity).min(1).max(100) });
export interface MetaHierarchyObservation { readonly state: "paused" | "active" | "unknown"; readonly complete: boolean; readonly observedAt: number; readonly hierarchy: readonly { readonly entityId: string; readonly state: "paused" | "active" | "unknown" }[] }

/** Require exact complete entity coverage and configured PAUSED on every entity before claiming paused.
 * Inherited effective pauses never prove a child's configured status; unknown/stale/foreign data denies.
 * @example decodeMetaHierarchy({ input, accountId: "123", expectedEntityIds: ["456"], observedAt: clock.now({}) })
 * @complexity O(n) time/space, n<=100; no I/O or retries.
 */
export function decodeMetaHierarchy(required: { input: unknown; accountId: string; expectedEntityIds: readonly string[]; observedAt: number }): Outcome<MetaHierarchyObservation> {
  const expected = parse({ schema: z.array(vendorIdSchema).min(1).max(100).refine(ids => new Set(ids).size === ids.length), input: required.expectedEntityIds });
  if (!expected.ok) return expected;
  const time = parse({ schema: epochSchema, input: required.observedAt });
  if (!time.ok) return time;
  const parsed = parseReadback({ input: required.input });
  if (!parsed.ok) return parsed;
  const rows = parsed.value.entities;
  const ids = new Set(rows.map(row => row.id));
  const expectedIds = new Set(expected.value);
  if (ids.size !== rows.length || rows.some(row => row.account_id !== required.accountId)) return failure({ code: "forbidden", message: "Meta readback identity mismatch" });
  if (rows.some(row => !expectedIds.has(row.id))) return failure({ code: "conflict", message: "Meta readback contains unexpected entities" });
  const complete = parsed.value.complete && expected.value.length === rows.length;
  const hierarchy = rows.map(row => ({ entityId: row.id, state: observedState({ configured: row.configured_status, effective: row.effective_status }) }));
  return { ok: true, value: { complete, observedAt: time.value, hierarchy, state: aggregateState({ hierarchy, complete }) } };
}

/** Configured PAUSED is explicit; configured ACTIVE with an inherited pause stays unknown. @complexity O(1). */
function observedState(required: { configured: string; effective: string }): "paused" | "active" | "unknown" {
  if (required.configured === "PAUSED" && ["PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED"].includes(required.effective)) return "paused";
  if (required.configured === "ACTIVE" && required.effective === "ACTIVE") return "active";
  return "unknown";
}

/** A mixed/incomplete hierarchy cannot confirm a launch or paused draft. @complexity O(n), O(1) auxiliary space. */
function aggregateState(required: { hierarchy: MetaHierarchyObservation["hierarchy"]; complete: boolean }): MetaHierarchyObservation["state"] {
  if (!required.complete) return "unknown";
  if (required.hierarchy.every(row => row.state === "paused")) return "paused";
  if (required.hierarchy.every(row => row.state === "active")) return "active";
  return "unknown";
}

/** A campaign cap is cumulative. An average daily budget is NEVER evidence of a hard daily limit. */
export interface MetaLimitReadback { readonly entityId: string; readonly amount: Money; readonly semantics: "cumulative_cap" | "average_budget"; readonly observedAt: number }

/** Compare the exact requested cap/budget with a scoped readback; unsupported controls fail closed.
 * Currency is separately host-verified account metadata, never guessed from the amount.
 * @example decodeMetaLimit({ input, metadata, accountId: "123", entityId: "456", control: "campaign_cap", currency: "USD", expectedMinor: 10000, observedAt })
 * @complexity O(n) time/space, n<=100 rows.
 */
export function decodeMetaLimit(required: { input: unknown; metadata: MetaAccountMetadata; accountId: string; entityId: string; control: "campaign_cap" | "daily_budget"; currency: string; expectedMinor: number; observedAt: number }): Outcome<MetaLimitReadback> {
  const request = parse({ schema: z.strictObject({ accountId: vendorIdSchema, entityId: vendorIdSchema, control: z.enum(["campaign_cap", "daily_budget"]), money: moneySchema, observedAt: epochSchema }), input: { accountId: required.accountId, entityId: required.entityId, control: required.control, money: { currency: required.currency, minorUnits: required.expectedMinor }, observedAt: required.observedAt } });
  if (!request.ok) return request;
  const metadata = verifyMetaAccountMetadata({ input: required.metadata, accountId: required.accountId, currency: required.currency, now: required.observedAt });
  if (!metadata.ok) return metadata;
  const parsed = parseReadback({ input: required.input });
  if (!parsed.ok) return parsed;
  const matches = parsed.value.entities.filter(row => row.id === required.entityId && row.account_id === required.accountId);
  if (!parsed.value.complete || matches.length !== 1) return failure({ code: "unavailable", message: "Meta cap readback incomplete or ambiguous" });
  const value = required.control === "campaign_cap" ? matches[0].spend_cap : matches[0].daily_budget;
  if (value === undefined || Number(value) !== required.expectedMinor) return failure({ code: "conflict", message: "Meta cap/budget readback differs from the reviewed value" });
  return { ok: true, value: { entityId: required.entityId, amount: request.value.money, observedAt: request.value.observedAt, semantics: required.control === "campaign_cap" ? "cumulative_cap" : "average_budget" } };
}

/** Bound all normalized readback rows before schema parsing. @complexity O(n) time/space, <=64KiB. */
function parseReadback(required: { input: unknown }): Outcome<z.infer<typeof readbackSchema>> {
  const bounded = boundedJson({ input: required.input, maxBytes: 65536 });
  if (!bounded.ok) return bounded;
  return parse({ schema: readbackSchema, input: bounded.value });
}
