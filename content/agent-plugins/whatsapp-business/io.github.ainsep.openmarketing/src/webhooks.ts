import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pluginConfigurationSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { parseCredential } from "./transport.js";
import { vendorIdSchema } from "./commands.js";

/** Trusted installation binding; tokens/verify-token are not webhook signing secrets. */
export const whatsappWebhookConfigurationSchema = z.strictObject({ scope: scopeSchema, wabaId: vendorIdSchema, phoneNumberId: vendorIdSchema });
export type WhatsAppWebhookConfiguration = z.infer<typeof whatsappWebhookConfigurationSchema>;
const phone = z.string().regex(/^[1-9][0-9]{7,14}$/);
const identifier = z.string().min(1).max(512);
const timestamp = z.string().regex(/^[0-9]{1,12}$/).refine(value => Number(value) <= 253402300799);
const status = z.enum(["sent", "delivered", "read", "failed"]);
/** Verified withdrawals/receipts only; arbitrary inbound text never enters durable observations. */
export const whatsappWebhookEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stop"), eventId: z.string().min(1).max(544), waId: identifier.optional(), userId: identifier.optional(), providerMessageId: identifier.optional(), recipient: z.string().max(16).optional(), occurredAt: z.iso.datetime() }),
  z.strictObject({ kind: z.literal("delivery"), eventId: z.string().min(1).max(544), providerMessageId: identifier, recipient: z.string().max(16), occurredAt: z.iso.datetime(), status }),
]);
export type WhatsAppWebhookEvent = z.infer<typeof whatsappWebhookEventSchema>;
const deliveryStatusSchema = z.object({ id: identifier, recipient_id: phone, status, timestamp });
const valueSchema = z.object({ metadata: z.object({ phone_number_id: vendorIdSchema }),
  messages: z.array(z.object({ id: identifier, from: phone, timestamp, type: z.string().max(64), text: z.object({ body: z.string().max(4096) }).optional(),
    button: z.object({ text: z.string().max(4096).optional(), payload: z.string().max(4096).optional() }).optional() })).max(100).optional(),
  statuses: z.array(z.object({ status: z.string().max(64) }).passthrough()).max(100).optional() });
const preferenceValueSchema = z.object({ metadata: valueSchema.shape.metadata,
  user_preferences: z.array(z.object({ category: z.string().max(100), value: z.string().max(100) }).passthrough()).max(100) });
const preferenceSchema = z.object({ wa_id: identifier.optional(), user_id: identifier.optional(), category: z.literal("marketing_messages"), value: z.literal("stop"),
  timestamp: z.union([z.number().int().min(0).max(253402300799), timestamp]).transform(value => Number(value)) });
const payloadSchema = z.object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.object({ id: vendorIdSchema,
  changes: z.array(z.object({ field: z.string().max(100), value: z.unknown() })).max(100) })).max(100) });

/** Authenticate exact bytes using fresh call-local credentials before parsing or projection.
 * Returns normalized events only; the host owns durable STOP suppression. No GET challenge.
 * @example ingestWebhook({ dependencies, rawBody, headers, path }, { signal });
 * @complexity O(b+n), b<=256KiB and total messages/statuses/preferences<=100; no egress. */
export async function ingestWebhook(required: { dependencies: PluginCapabilityDependencies; rawBody: Uint8Array;
  headers: Readonly<Record<string, string | undefined>>; path: string;
}, optional?: CallOptions): Promise<Outcome<{ events: readonly (WhatsAppWebhookEvent & { channel: "whatsapp" })[] }>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    if (required.rawBody.byteLength > 262144) return failure({ code: "limit_exceeded" });
    const binding = await webhookBinding(required, optional);
    if (!binding.ok) return binding;
    if (!authentic({ rawBody: required.rawBody, signature: required.headers["x-hub-signature-256"], secret: binding.value.appSecret })) return failure({ code: "unauthenticated" });
    const payload = payloadSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(required.rawBody)));
    const events = project({ configuration: binding.value.configuration, payload });
    if (!events) return failure({ code: "forbidden" });
    return { ok: true, value: { events: events.map(event => ({ ...event, channel: "whatsapp" as const })) } };
  } catch { return failure({ code: "invalid_input" }); }
}

/** WABA/phone facts and signing secret come from the credential, never install settings.
 * Missing app secret is unauthenticated before JSON parsing. @complexity One broker read, O(c) bounded card. */
async function webhookBinding(required: { dependencies: PluginCapabilityDependencies }, optional?: CallOptions): Promise<Outcome<{ configuration: WhatsAppWebhookConfiguration; appSecret: string }>> {
  const c = pluginConfigurationSchema.parse(required.dependencies.configuration);
  const envelope = await required.dependencies.credentials.access({ connectionId: c.connectionId, accountId: c.accountId }, optional);
  if (!envelope.ok) return failure({ code: "unauthenticated" });
  const credential = parseCredential({ envelope: envelope.value });
  if (!credential.ok) return credential;
  const card = credential.value;
  if (!card.appSecret) return failure({ code: "unauthenticated" });
  if (card.wabaId !== c.accountId || !card.phoneNumberId) return failure({ code: "forbidden" });
  if (card.expiresAt !== undefined && card.expiresAt <= required.dependencies.clock.now({})) return failure({ code: "unauthenticated" });
  return { ok: true, value: { appSecret: card.appSecret,
    configuration: whatsappWebhookConfigurationSchema.parse({ scope: c.scope, wabaId: card.wabaId, phoneNumberId: card.phoneNumberId }) } };
}
function authentic(required: { rawBody: Uint8Array; signature: string | undefined; secret: string }): boolean {
  if (!required.signature?.match(/^sha256=[a-fA-F0-9]{64}$/)) return false;
  const actual = Buffer.from(required.signature.slice(7), "hex");
  const expected = createHmac("sha256", required.secret).update(required.rawBody).digest();
  return timingSafeEqual(actual, expected);
}
/** Validate all assets and total count before returning events; a late foreign/invalid item rejects all. */
function project(required: { configuration: WhatsAppWebhookConfiguration; payload: z.infer<typeof payloadSchema> }): readonly WhatsAppWebhookEvent[] | null {
  const { configuration: c, payload } = required;
  if (payload.entry.some(e => e.id !== c.wabaId)) return null;
  const changes = payload.entry.flatMap(e => e.changes);
  const values = changes.filter(change => change.field === "messages").map(change => valueSchema.parse(change.value));
  const preferences = changes.filter(change => change.field === "user_preferences").map(change => preferenceValueSchema.parse(change.value));
  if ([...values, ...preferences].some(v => v.metadata.phone_number_id !== c.phoneNumberId)) return null;
  const total = values.reduce((sum, v) => sum + (v.messages?.length ?? 0) + (v.statuses?.length ?? 0), 0)
    + preferences.reduce((sum, v) => sum + v.user_preferences.length, 0);
  if (total > 100) return null;
  return [...values.flatMap(value => eventsFor({ value })), ...preferences.flatMap(value => preferenceEvents({ configuration: c, value }))];
}
/** Skip future status variants; validate known receipts before projecting the signed batch. */
function eventsFor(required: { value: z.infer<typeof valueSchema> }): WhatsAppWebhookEvent[] {
  const value = required.value;
  const receipts: WhatsAppWebhookEvent[] = (value.statuses ?? []).filter(s => status.safeParse(s.status).success).map(s => deliveryStatusSchema.parse(s)).map(s => ({ kind: "delivery", eventId: s.id + ":" + s.status,
    providerMessageId: s.id, recipient: "+" + s.recipient_id, occurredAt: new Date(Number(s.timestamp) * 1000).toISOString(), status: s.status }));
  const stops: WhatsAppWebhookEvent[] = (value.messages ?? []).filter(message => isOptOut({ message })).map(m => ({
    kind: "stop", eventId: m.id + ":stop", waId: m.from, providerMessageId: m.id, recipient: "+" + m.from, occurredAt: new Date(Number(m.timestamp) * 1000).toISOString() }));
  return [...receipts, ...stops];
}
/** Project only marketing withdrawals; no message ID or E.164 number is invented.
 * Replay identity binds the installation, identity kind/value, preference and vendor time.
 * @complexity O(n), at most 100 preferences; no I/O or consent restoration. */
function preferenceEvents(required: { configuration: WhatsAppWebhookConfiguration; value: z.infer<typeof preferenceValueSchema> }): WhatsAppWebhookEvent[] {
  const c = required.configuration;
  return required.value.user_preferences.filter(p => p.category === "marketing_messages" && p.value === "stop" && (p.wa_id !== undefined || p.user_id !== undefined))
    .map(p => preferenceSchema.parse(p)).map(p => ({ kind: "stop", ...(p.wa_id !== undefined ? { waId: p.wa_id } : { userId: p.user_id }),
      eventId: createHash("sha256").update(JSON.stringify([c.scope.ownerId, c.scope.workspaceId, c.wabaId, c.phoneNumberId, p.wa_id !== undefined ? "wa_id" : "user_id", p.wa_id ?? p.user_id, p.category, p.value, p.timestamp])).digest("hex"),
      occurredAt: new Date(p.timestamp * 1000).toISOString() }));
}
/** OM's bounded whole-value opt-out vocabulary; button text and payload are independent signals.
 * Punctuation/case/spacing variants match, while START, HELP and sentences never opt in. */
function isOptOut(required: { message: NonNullable<z.infer<typeof valueSchema>["messages"]>[number] }): boolean {
  const m = required.message;
  const values = m.type === "button" ? [m.button?.text, m.button?.payload] : [m.type === "text" ? m.text?.body : undefined];
  return values.some(value => /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT|STOPPROMOTIONS|DETENERPROMOCIONES)$/.test(value?.toUpperCase().replace(/[\p{P}\s]/gu, "") ?? ""));
}
function failure(required: { code: "invalid_input" | "forbidden" | "unauthenticated" | "cancelled" | "limit_exceeded" }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "WhatsApp webhook " + required.code, retryable: false } };
}
