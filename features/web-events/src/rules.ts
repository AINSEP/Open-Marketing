import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, campaignKeySchema, encodeCampaignKey, parseCampaignKey, digestSchema, epochSchema, idSchema, scopeSchema, timeWindowSchema } from "@open-marketing/contracts";
import type { AppError, CallContext, CallOptions, Outcome, Scope, TimeWindow } from "@open-marketing/contracts";
import type { AttributionTouch, Visit, WebEvent } from "./types.js";
import { landingPropertiesSchema } from "./types.js";

type Failure = Extract<Outcome<never>, { ok: false }>;
const opaqueId = idSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/).refine(value => value.trim() === value);
const clickId = landingPropertiesSchema.shape.gclid.unwrap();
/** MVP click keys shared by collection mapping and the emitted browser source. */
export const clickKeys = ["gclid", "gbraid", "wbraid", "fbclid"] as const;
/** One landing schema/version; authority-bearing scope is supplied separately by ingress. */
export const eventSchema = z.strictObject({ eventId: opaqueId, schema: z.literal("om.web.landing"), version: z.literal(1), source: z.literal("first-party"), subjectId: opaqueId.optional(), anonymousId: opaqueId.optional(), name: z.literal("landing"), properties: landingPropertiesSchema, occurredAt: epochSchema, receivedAt: epochSchema, cursor: epochSchema, traceId: opaqueId }).refine(value => value.subjectId !== undefined || value.anonymousId !== undefined);
/** Storage accepts only sanitized identifiers, never raw URLs or macro metadata. */
export const storedEventSchema = eventSchema.safeExtend({ properties: z.strictObject({ linkId: opaqueId.optional(), campaignId: opaqueId.optional(), destinationId: digestSchema.optional() }) });
/** Authenticator/storage outputs remain tainted until these strict schemas accept them. */
export const visitSchema = z.strictObject({ visitId: opaqueId, scope: scopeSchema, anonymousId: opaqueId, subjectId: opaqueId.nullable(), expiresAt: epochSchema });
export const touchSchema = z.strictObject({ touchId: opaqueId, eventId: opaqueId, occurredAt: epochSchema, linkId: opaqueId.nullable(), campaignId: opaqueId.nullable(), clickIdentifiers: z.strictObject({ gclid: clickId.optional(), gbraid: clickId.optional(), wbraid: clickId.optional(), fbclid: clickId.optional() }) });
export const storedDigestSchema = digestSchema;

/** Stable sanitized failure: never includes boundary inputs or driver diagnostics. */
export function failure(required: { code: AppError["code"]; message?: string }): Failure {
  return { ok: false, error: { code: required.code, message: required.message ?? "Web-events operation " + required.code, retryable: required.code === "unavailable" } };
}
/** Validate cancellation and scoped caller metadata before any effect. @complexity O(1). */
export function validateContext(required: { context: CallContext; options?: CallOptions }): Failure | undefined {
  if (required.options?.signal?.aborted) return failure({ code: "cancelled" });
  if (!callContextSchema.safeParse(required.context).success) return failure({ code: "invalid_input" });
  const principal = required.context.principal;
  if (principal.kind === "owner" && principal.ownerId !== required.context.scope.ownerId) return failure({ code: "forbidden" });
  return undefined;
}
export function sameScope(required: { left: Scope; right: Scope }): boolean {
  return required.left.ownerId === required.right.ownerId && required.left.workspaceId === required.right.workspaceId;
}
/** Parse the one bounded landing envelope; exclude arbitrary properties and raw PII.
 * @complexity O(p) for eleven properties, each string capped at 2048; JSON <=16 KiB.
 */
export function validateEvent(required: { event: WebEvent }): Outcome<WebEvent> {
  const parsed = eventSchema.safeParse(required.event);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const properties = parsed.data.properties;
  if (Object.values(properties).some(value => typeof value !== "string")) return failure({ code: "invalid_input" });
  if (new TextEncoder().encode(JSON.stringify(properties)).length > 16384) return failure({ code: "invalid_input" });
  return { ok: true, value: parsed.data as WebEvent };
}
/** Normalize a claim, never authority. Ingress verifies ordinary OM IDs in scope.
 * The caller-owned observed port decides vendor-key membership.
 * Mixed canonical/macro claims must agree; unresolved vendor macros stay unattributed. O(1). */
export function campaignClaim(required: { properties: WebEvent["properties"] }): string | null {
  const p = required.properties;
  const canonical = parseCampaignKey({ value: p.campaignId });
  const ordinary = typeof p.campaignId === "string" && !p.campaignId.startsWith("ck1:") && opaqueId.safeParse(p.campaignId).success;
  const fallback = canonical.ok || ordinary ? p.campaignId as string : null;
  if (p.utm_medium !== "paid") return fallback;
  const key = campaignKeySchema.safeParse({ pluginId: p.utm_source, accountId: p.om_a, vendorCampaignId: p.utm_id });
  if (!key.success || Object.values(key.data).some(value => /[{}]/.test(value))) return fallback;
  const encoded = encodeCampaignKey({ key: key.data });
  if (!encoded.ok) return null;
  if (p.campaignId !== undefined && p.campaignId !== encoded.value) return null;
  return encoded.value;
}
/** Query/fragment-free HTTPS origin/path identity; invalid inputs return a typed error.
 * O(u) time/space for a URL bounded to 2048 characters. */
export function destinationIdentity(required: { destinationUrl: string }): Outcome<string> {
  const parsed = landingPropertiesSchema.shape.pageUrl.unwrap().safeParse(required.destinationUrl);
  if (!parsed.success) return failure({ code: "invalid_input" });
  const url = new URL(parsed.data);
  return { ok: true, value: createHash("sha256").update(url.origin + url.pathname).digest("hex") };
}
/** Missing page metadata yields no heartbeat; ingress validates any supplied URL first. */
function eventDestination(required: { event: WebEvent }): string | null {
  if (typeof required.event.properties.pageUrl !== "string") return null;
  const identity = destinationIdentity({ destinationUrl: required.event.properties.pageUrl });
  return identity.ok ? identity.value : null;
}
/** Derive the allowlisted mapping; campaign IDs remain untrusted claims in storage. */
export function mapTouch(required: { event: WebEvent; touchId: string }): AttributionTouch {
  const properties = required.event.properties;
  const clickIdentifiers: Record<string, string> = {};
  for (const key of clickKeys) {
    const value = properties[key];
    if (typeof value === "string") clickIdentifiers[key] = value;
  }
  return { touchId: required.touchId, eventId: required.event.eventId, occurredAt: required.event.occurredAt, linkId: typeof properties.linkId === "string" ? properties.linkId : null, campaignId: campaignClaim({ properties }), clickIdentifiers };
}
/** Repository ingress checks event/touch agreement; adapters own receipt time and cursor. */
export function validateRecord(required: { context: CallContext; event: WebEvent; touch: AttributionTouch; options?: CallOptions }): Failure | undefined {
  const invalid = validateContext(required);
  if (invalid) return invalid;
  const event = validateEvent(required);
  if (!event.ok) return event;
  if (!touchSchema.safeParse(required.touch).success) return failure({ code: "invalid_input" });
  if (Object.values(required.touch.clickIdentifiers).some(value => typeof value !== "string")) return failure({ code: "invalid_input" });
  const expected = mapTouch({ event: event.value, touchId: required.touch.touchId });
  if (!touchMatches({ expected, actual: required.touch })) return failure({ code: "invalid_input" });
  return undefined;
}
function touchMatches(required: { expected: AttributionTouch; actual: AttributionTouch }): boolean {
  const { expected, actual } = required;
  const metadataMatches = expected.eventId === actual.eventId && expected.occurredAt === actual.occurredAt && expected.linkId === actual.linkId && expected.campaignId === actual.campaignId;
  return metadataMatches && JSON.stringify(expected.clickIdentifiers) === JSON.stringify(canonicalClicks({ clicks: actual.clickIdentifiers }));
}
/** Normalize allowlisted click key order before equality/digest operations. */
function canonicalClicks(required: { clicks: Readonly<Record<string, string>> }): Record<string, string> {
  return Object.fromEntries(clickKeys.filter(key => required.clicks[key] !== undefined).map(key => [key, required.clicks[key]]));
}
/** Replay excludes generated metadata; a digest retains no raw click identifiers.
 * @complexity O(p), bounded envelope; no randomness or I/O.
 */
export function replayDigest(required: { event: WebEvent }): string {
  const event = required.event;
  const touch = mapTouch({ event, touchId: "digest" });
  const semantic = { eventId: event.eventId, schema: event.schema, version: event.version, source: event.source, name: event.name, subjectId: event.subjectId ?? null, anonymousId: event.anonymousId ?? null, occurredAt: event.occurredAt, linkId: touch.linkId, campaignId: touch.campaignId, destinationId: eventDestination(required), clicks: canonicalClicks({ clicks: touch.clickIdentifiers }) };
  return createHash("sha256").update(JSON.stringify(semantic)).digest("hex");
}
/** Immutable envelope contains IDs only; click values live solely in mutable touches. */
export function storedEvent(required: { event: WebEvent; receivedAt: number; cursor: number }): WebEvent {
  const properties: Record<string, string> = {};
  const touch = mapTouch({ event: required.event, touchId: "stored" });
  if (touch.linkId !== null) properties.linkId = touch.linkId;
  if (touch.campaignId !== null) properties.campaignId = touch.campaignId;
  const destinationId = eventDestination(required);
  if (destinationId !== null) properties.destinationId = destinationId;
  return { ...required.event, properties, receivedAt: required.receivedAt, cursor: required.cursor };
}
/** Validate visit metadata, scope and expiry at issuer and authenticator boundaries. */
export function validateVisit(required: { context: CallContext; visit: Visit; now: number; options?: CallOptions }): Failure | undefined {
  const invalid = validateContext(required);
  if (invalid) return invalid;
  if (!visitSchema.safeParse(required.visit).success || !epochSchema.safeParse(required.now).success) return failure({ code: "invalid_input" });
  if (!sameScope({ left: required.visit.scope, right: required.context.scope })) return failure({ code: "forbidden" });
  if (required.visit.expiresAt <= required.now) return failure({ code: "expired" });
  return undefined;
}
/** Stable issuer replay never overwrites a later authenticated binding. */
export function checkVisitReplay(required: { existing: Visit; visit: Visit }): Outcome<Visit> {
  const { existing, visit } = required;
  if (existing.anonymousId !== visit.anonymousId || existing.expiresAt !== visit.expiresAt) return failure({ code: "conflict" });
  if (visit.subjectId !== null && visit.subjectId !== existing.subjectId) return failure({ code: "conflict" });
  return { ok: true, value: structuredClone(existing) };
}
/** Scoped reads/erasure accept opaque subject IDs, never contact addresses. */
export function validateSubject(required: { context: CallContext; subjectId: string; options?: CallOptions }): Failure | undefined {
  return validateContext(required) ?? (opaqueId.safeParse(required.subjectId).success ? undefined : failure({ code: "invalid_input" }));
}
/** Validate binding references before repository work. */
export function validateBinding(required: { context: CallContext; visitId: string; subjectId: string; options?: CallOptions }): Failure | undefined {
  return validateSubject(required) ?? (opaqueId.safeParse(required.visitId).success ? undefined : failure({ code: "invalid_input" }));
}
/** Bind only an existing, unexpired visit; no consent grant or subject merge. */
export function bindVisit(required: { visit: Visit | undefined; subjectId: string; now: number }): Outcome<Visit> {
  if (!required.visit) return failure({ code: "unauthenticated" });
  if (!epochSchema.safeParse(required.now).success) return failure({ code: "unavailable" });
  if (required.visit.expiresAt <= required.now) return failure({ code: "expired" });
  if (required.visit.subjectId !== null && required.visit.subjectId !== required.subjectId) return failure({ code: "conflict" });
  return { ok: true, value: { ...required.visit, subjectId: required.subjectId } };
}
/** Half-open time window and 1..100 limit bound every attribution response. */
export function validateRead(required: { context: CallContext; subjectId: string; window: TimeWindow; limit: number; options?: CallOptions }): Failure | undefined {
  const invalid = validateSubject(required);
  if (invalid) return invalid;
  if (!timeWindowSchema.safeParse(required.window).success || !z.number().int().min(1).max(100).safeParse(required.limit).success) return failure({ code: "invalid_input" });
  return undefined;
}
/** Catch opaque injected I/O failures and check cancellation at the operation boundary. */
export async function boundary<T>(required: { options?: CallOptions; work: () => Promise<Outcome<T>> }): Promise<Outcome<T>> {
  try {
    if (required.options?.signal?.aborted) return failure({ code: "cancelled" });
    return await required.work();
  } catch { return failure({ code: "unavailable" }); }
}
