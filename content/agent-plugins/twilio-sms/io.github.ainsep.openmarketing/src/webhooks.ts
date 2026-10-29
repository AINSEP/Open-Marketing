import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { pluginConfigurationSchema, scopeSchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";

import { parseCredential } from "./transport.js";

/** Call-local exact account, optional sender and externally visible URL, never request Host headers. */
export const twilioWebhookConfigurationSchema = z.strictObject({ scope: scopeSchema, accountSid: z.string().regex(/^AC[0-9a-fA-F]{32}$/),
  messagingServiceSid: z.string().regex(/^MG[0-9a-fA-F]{32}$/).optional(), sender: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional(), webhookUrl: z.url().max(2048) });
export type TwilioWebhookConfiguration = z.infer<typeof twilioWebhookConfigurationSchema>;
/** Only authenticated observations and withdrawals cross the host boundary. START/HELP never opt in. */
export const twilioWebhookEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("stop"), eventId: z.string().max(256), providerMessageId: z.string().max(64), recipient: z.string().max(16) }),
  z.strictObject({ kind: z.literal("delivery"), eventId: z.string().max(256), providerMessageId: z.string().max(64), recipient: z.string().max(16),
    status: z.enum(["accepted", "queued", "sending", "sent", "delivered", "undelivered", "failed", "read", "canceled"]) }),
]);
export type TwilioWebhookEvent = z.infer<typeof twilioWebhookEventSchema>;
const payloadSchema = z.object({ AccountSid: z.string(), MessageSid: z.string().regex(/^(SM|MM)[0-9a-fA-F]{32}$/),
  MessagingServiceSid: z.string().optional(), From: z.string().regex(/^\+[1-9][0-9]{7,14}$/), To: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  Body: z.string().max(1600).optional(), OptOutType: z.enum(["STOP", "START", "HELP"]).optional(), MessageStatus: z.string().max(64).optional() });

/** Verify the configured callback URL and signed form before returning normalized events.
 * Credentials are fetched once per call; raw text and secrets never enter results or errors.
 * @example ingestWebhook({ dependencies, rawBody, headers, path }, { signal });
 * @complexity O(b+k log k), b<=256KiB and k<=100 form keys; one credential access, no egress. */
export async function ingestWebhook(required: { dependencies: PluginCapabilityDependencies; rawBody: Uint8Array;
  headers: Readonly<Record<string, string | undefined>>; path: string;
}, optional?: CallOptions): Promise<Outcome<{ events: readonly (TwilioWebhookEvent & { channel: "sms" })[] }>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    if (required.rawBody.byteLength > 262144) return failure({ code: "limit_exceeded" });
    const binding = await webhookBinding(required, optional);
    if (!binding.ok) return binding;
    const signature = required.headers["x-twilio-signature"] ?? "";
    const parameters = form({ rawBody: required.rawBody });
    if (!authentic({ token: binding.value.authToken, signature, url: binding.value.configuration.webhookUrl, parameters })) return failure({ code: "unauthenticated" });
    const events = project({ configuration: binding.value.configuration, payload: payloadSchema.parse(parameters) });
    if (!events) return failure({ code: "forbidden" });
    return { ok: true, value: { events: events.map(event => ({ ...event, channel: "sms" as const })) } };
  } catch { return failure({ code: "invalid_input" }); }
}

/** Bind account/service/signing URL from the fresh credential, never request Host/forwarded headers.
 * Missing signing material is unauthenticated; URL/account mismatches are forbidden.
 * @complexity O(c), bounded credential JSON, one broker access. */
async function webhookBinding(required: { dependencies: PluginCapabilityDependencies; path: string }, optional?: CallOptions): Promise<Outcome<{ configuration: TwilioWebhookConfiguration; authToken: string }>> {
  const c = pluginConfigurationSchema.parse(required.dependencies.configuration);
  const envelope = await required.dependencies.credentials.access({ connectionId: c.connectionId, accountId: c.accountId }, optional);
  if (!envelope.ok) return failure({ code: "unauthenticated" });
  const credential = parseCredential({ envelope: envelope.value });
  if (!credential.ok) return credential;
  const card = credential.value;
  if (!card.authToken) return failure({ code: "unauthenticated" });
  const callback = z.url().safeParse(card.webhookUrl);
  if (card.accountSid !== c.accountId || !callback.success) return failure({ code: "forbidden" });
  const url = new URL(callback.data);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== required.path) return failure({ code: "forbidden" });
  if (card.expiresAt !== undefined && card.expiresAt <= required.dependencies.clock.now({})) return failure({ code: "unauthenticated" });
  const settings = z.object({ sender: z.string().regex(/^\+[1-9][0-9]{7,14}$/).optional() }).parse(c.settings);
  return { ok: true, value: { authToken: card.authToken, configuration: twilioWebhookConfigurationSchema.parse({ scope: c.scope,
    accountSid: card.accountSid, messagingServiceSid: card.messagingServiceSid, webhookUrl: callback.data, sender: settings.sender }) } };
}
/** Sign the exact configured URL and every decoded form field in case-sensitive key order.
 * Reject non-canonical/incorrect-length base64 before the constant-time comparison. */
function authentic(required: { token: string; signature: string; url: string; parameters: Record<string, string> }): boolean {
  if (!/^[A-Za-z0-9+/]{27}=$/.test(required.signature)) return false;
  const canonical = required.url + Object.keys(required.parameters).sort().map(key => key + required.parameters[key]).join("");
  const expected = createHmac("sha1", required.token).update(canonical).digest("base64");
  return timingSafeEqual(Buffer.from(required.signature), Buffer.from(expected));
}
/** Reject repeated keys rather than dropping parameters from the signature's input. */
function form(required: { rawBody: Uint8Array }): Record<string, string> {
  const parameters = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(required.rawBody));
  const entries = [...parameters.entries()];
  if (entries.length > 100 || new Set(entries.map(([key]) => key)).size !== entries.length) throw new TypeError("invalid_form");
  if (entries.some(([key, value]) => key.length > 128 || value.length > 65536)) throw new TypeError("invalid_form");
  return Object.fromEntries(entries);
}
function project(required: { configuration: TwilioWebhookConfiguration; payload: z.infer<typeof payloadSchema> }): readonly TwilioWebhookEvent[] | null {
  const { configuration: c, payload: p } = required;
  if (p.AccountSid !== c.accountSid) return null;
  if (c.messagingServiceSid !== undefined && p.MessagingServiceSid !== c.messagingServiceSid) return null;
  const incoming = p.MessageStatus === "received" || p.MessageStatus === undefined;
  if (c.sender !== undefined && !c.messagingServiceSid && (incoming ? p.To !== c.sender : p.From !== c.sender)) return null;
  if (incoming) return stopEvents({ payload: p });
  const event = twilioWebhookEventSchema.safeParse({ kind: "delivery", eventId: p.MessageSid + ":" + p.MessageStatus,
    providerMessageId: p.MessageSid, recipient: p.To, status: p.MessageStatus });
  return event.success ? [event.data] : null;
}
/** Incoming messages can also carry MessageStatus=received; direction wins over status. */
function stopEvents(required: { payload: z.infer<typeof payloadSchema> }): readonly TwilioWebhookEvent[] {
  const p = required.payload;
  const stop = p.OptOutType === "STOP" || /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPTOUT)$/.test(p.Body?.trim().toUpperCase() ?? "");
  return stop ? [{ kind: "stop", eventId: p.MessageSid + ":stop", providerMessageId: p.MessageSid, recipient: p.From }] : [];
}
function failure(required: { code: "invalid_input" | "forbidden" | "unauthenticated" | "cancelled" | "limit_exceeded" }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Twilio webhook " + required.code, retryable: false } };
}
