import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ClockPort } from "@open-marketing/contracts";
import type { MailProviderModule, MailProviderCallContext, MailerSendRequired, MailerSendResult, MailerOptional, MailFeedbackParser, OutboundEmail } from "@jini-ai/platform/mail";

const address = z.strictObject({ email: z.email().max(254), name: z.string().max(200).regex(/^[^\r\n<>]*$/).optional() });
const headerValue = z.string().max(4096).regex(/^[^\r\n]*$/);
/** Validated delivery boundary; one recipient, bounded content and no attachments. */
export const resendMailRequestSchema = z.strictObject({
  message: z.strictObject({ workspaceId: z.string().min(1).max(256), to: address, from: address, replyTo: address.optional(), subject: headerValue,
    html: z.string().max(65536).optional(), text: z.string().max(65536).optional(),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), headerValue).refine(h => Object.keys(h).length <= 50).optional(), attachments: z.array(z.never()).max(0).optional() }),
  workspaceId: z.string().min(1).max(256), idempotencyKey: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/),
  sourceContext: z.strictObject({ module: z.string().min(1).max(256), ref: z.string().max(256).optional() }),
}).refine(v => v.workspaceId === v.message.workspaceId && (v.message.html !== undefined || v.message.text !== undefined));
export type ResendMailRequest = z.infer<typeof resendMailRequestSchema>;
/** Only consumed webhook fields; provider additions are stripped. */
export const resendMailEventSchema = z.object({ type: z.string().max(100), created_at: z.iso.datetime({ offset: true }),
  data: z.object({ email_id: z.string().min(1).max(256), to: z.array(z.email().max(254)).min(1).max(100),
    bounce: z.object({ type: z.string().max(64) }).optional() }) });
export type ResendMailEvent = z.infer<typeof resendMailEventSchema>;
const domain = z.object({ id: z.uuid(), name: z.string().min(1).max(253), status: z.string().max(64),
  records: z.array(z.object({ type: z.enum(["TXT", "MX", "CNAME"]), name: z.string().max(253), value: z.string().min(1).max(4096), priority: z.number().int().nonnegative().optional() })).max(100) });
const credential = z.object({ token: z.string().min(1).max(4096).regex(/^[\x21-\x7e]+$/) });
type CreateContext = Parameters<MailProviderModule["create"]>[0];
/** Server holds the subject lane and rechecks current consent, suppression, grant/caps and
 * exact delivery identity through execute. Missing/denied authority never reaches HTTP. */
type MailAuthority = (required: { input: ResendMailRequest; execute: () => Promise<MailerSendResult> }, optional?: MailerOptional) => Promise<MailerSendResult>;

/** Inert Jini provider. authority holds current server authority/subject lane through the attempt.
 * Guarded HTTP bounds response bytes before buffering and appends correlated egress audit.
 * Jini callbacks retain their published ABI; no registry, retries or mail policy is constructed here.
 * @complexity O(b) time/space per call, request <=64KiB, response <=1MiB, one 10s attempt.
 */
export function createResendMailProvider(required: { clock: ClockPort; domainId: string; authority: MailAuthority }): MailProviderModule {
  return { id: "resend_email", label: "Resend", credentialKeys: ["token"], webhookSecretKey: "webhookSecret",
    capabilities: { hosted: true, feedback: true, domainVerification: true, rateLimit: { perSecond: 2, burst: 2 } },
    create(context) {
      return { capabilities: () => ({ driver: "resend-email", supportsIdempotencyKey: true, supportsWebhookFeedback: true, maxBatchSize: 1, supportsAttachments: false }),
        send: (input, options) => send({ context, input, clock: required.clock, authority: required.authority }, options),
        sendBatch: async (input, options) => input.messages.length === 1
          ? [await send({ context, input: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, sourceContext: input.sourceContext, message: input.messages[0]! }, clock: required.clock, authority: required.authority }, options)]
          : [refusal({ code: "batch_not_supported" })] };
    }, feedback: feedback(),
    async domainRequirements(ctx, input) {
      const result = await readDomain({ ctx, domainId: required.domainId, name: input.domain });
      if (result.status !== "ok") return result;
      return { status: "ok", value: { purpose: "mail", domain: input.domain, providerId: "resend_email", records: result.value.records.map(r => ({ ...r,
        name: qualify({ name: r.name, domain: input.domain }) })) } };
    },
    async domainStatus(ctx, input) {
      const result = await readDomain({ ctx, domainId: required.domainId, name: input.domain });
      if (result.status !== "ok") return result;
      const state = result.value.status === "verified" ? "verified" : result.value.status === "failed" ? "failed" : "pending";
      return { status: "ok", value: { domain: input.domain, state } };
    } };
}

/** Installed Jini module: the host guards egress and supplies call-scoped time.
 * Domain reads await a settings-aware Jini callback; Svix feedback stays available.
 * @example provider.create(createMailAdapterContext({ credential, kit }, { now })).send(input)
 * @complexity O(1) construction; delivery reuses the bounded sender above.
 */
const provider: MailProviderModule = {
  id: "resend_email", label: "Resend", credentialKeys: ["token"], webhookSecretKey: "webhookSecret",
  capabilities: { hosted: true, feedback: true, domainVerification: false, rateLimit: { perSecond: 2, burst: 2 } },
  feedback: feedback(),
  create(context) {
    const now = context.now;
    if (!now) return {
      capabilities: () => ({ driver: "resend-email", supportsIdempotencyKey: true, supportsWebhookFeedback: true, maxBatchSize: 1, supportsAttachments: false }),
      send: async () => refusal({ code: "not_configured" }),
      sendBatch: async () => [refusal({ code: "not_configured" })],
    };
    return createResendMailProvider({ clock: { now: () => now().getTime() }, domainId: "",
      authority: ({ execute }) => execute() }).create(context);
  },
};
export default provider;

function refusal(required: { code: string; unknown?: boolean }): MailerSendResult {
  return { ok: false, retryable: false, errorCode: required.code, message: "Resend mail " + required.code, ...(required.unknown ? { unknown: true } : {}) };
}
function format(required: { address: OutboundEmail["from"] }): string {
  return required.address.name ? `"${required.address.name.replace(/["\\]/g, "\\$&")}" <${required.address.email}>` : required.address.email;
}
/** Headers are case-insensitive and unique; reserved MIME fields cannot change the approved envelope. */
function validHeaders(required: { message: OutboundEmail; purpose?: string }): boolean {
  const entries = Object.entries(required.message.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const);
  const headers = Object.fromEntries(entries);
  if (new Set(entries.map(([k]) => k)).size !== entries.length) return false;
  if (entries.some(([k]) => /^(from|to|cc|bcc|sender|reply-to|subject|return-path|message-id|date|mime-version|content-.*)$/.test(k))) return false;
  const unsubscribe = headers["list-unsubscribe"];
  const oneClick = headers["list-unsubscribe-post"];
  if (!unsubscribe && !oneClick) return required.purpose !== "bulk";
  return oneClick === "List-Unsubscribe=One-Click" && validUnsubscribe({ value: unsubscribe });
}
/** Accept a bounded URI list with at least one safe HTTPS endpoint and optional mailto. */
function validUnsubscribe(required: { value: string | undefined }): boolean {
  if (!required.value) return false;
  const entries = required.value.split(",").map(entry => entry.trim());
  if (!entries.every(entry => /^<[^<>\s]+>$/.test(entry))) return false;
  const urls = entries.map(entry => new URL(entry.slice(1, -1)));
  return urls.every(url => ["https:", "mailto:"].includes(url.protocol) && !url.username && !url.password && !url.hash)
    && urls.some(url => url.protocol === "https:");
}
/** Freeze the parsed delivery snapshot before handing it to server authority. */
function freezeInput(required: { input: ResendMailRequest }): ResendMailRequest {
  const input = required.input;
  for (const value of Object.values(input.message)) {
    if (value !== null && typeof value === "object") Object.freeze(value);
  }
  Object.freeze(input.message);
  Object.freeze(input.sourceContext);
  return Object.freeze(input);
}
/** Parse before HTTP; ambiguous acceptance is never turned into a fabricated provider id. */
async function send(required: { context: CreateContext; input: MailerSendRequired; clock: ClockPort; authority: MailAuthority }, optional?: MailerOptional): Promise<MailerSendResult> {
  let attempted = false;
  let executed = false;
  try {
    const input = resendMailRequestSchema.safeParse(required.input);
    const key = credential.safeParse(required.context.credential);
    if (!input.success || !key.success) return refusal({ code: "invalid_input" });
    const m = input.data.message;
    if (!validHeaders({ message: m, purpose: optional?.purpose })) return refusal({ code: "invalid_unsubscribe" });
    const body = JSON.stringify({ from: format({ address: m.from }), to: [format({ address: m.to })], subject: m.subject,
      ...(m.replyTo ? { reply_to: format({ address: m.replyTo }) } : {}), html: m.html, text: m.text, headers: m.headers });
    if (Buffer.byteLength(body) > 65536) return refusal({ code: "payload_too_large" });
    return await required.authority({ input: freezeInput({ input: input.data }), execute: async () => {
      if (executed) return refusal({ code: "conflict" });
      executed = true;
      z.number().int().nonnegative().max(8640000000000000).parse(required.clock.now({}));
      attempted = true;
      const response = await required.context.kit.httpClient.send({ request: { method: "POST", url: "https://api.resend.com/emails",
        headers: { Authorization: "Bearer " + key.data.token, "Content-Type": "application/json", "Idempotency-Key": input.data.idempotencyKey }, body, timeoutMs: 10000 } });
      return receipt({ response, now: required.clock.now({}) });
    } }, optional);
  } catch { return refusal({ code: "unavailable", unknown: attempted }); }
}
/** A successful HTTP response without a validated provider receipt remains uncertain. */
function receipt(required: { response: { status: number; bodyText: string; headers: Readonly<Record<string, string>> }; now: number }): MailerSendResult {
  const { response, now } = required;
  if (response.status === 429) return rateLimited({ headers: response.headers, now });
  const acceptedAt = new Date(now).toISOString();
  if (response.status < 200 || response.status >= 300) return refusal({ code: "provider_rejected", unknown: response.status >= 500 || response.status === 408 || response.status === 409 });
  if (Buffer.byteLength(response.bodyText) > 1048576) return refusal({ code: "invalid_response", unknown: true });
  const parsed = z.object({ id: z.string().min(1).max(256) }).safeParse(JSON.parse(response.bodyText));
  return parsed.success ? { ok: true, providerMessageId: parsed.data.id, acceptedAt } : refusal({ code: "invalid_response", unknown: true });
}
/** Definitive provider back-pressure; clamp Retry-After to one day using injected time. */
function rateLimited(required: { headers: Readonly<Record<string, string>>; now: number }): MailerSendResult {
  const header = Object.entries(required.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? "") - required.now;
  const retryAfterMs = Number.isFinite(delay) ? Math.min(86400000, Math.max(0, delay)) : undefined;
  return { ok: false, errorCode: "MAIL_RATE_LIMITED", message: "Provider rate limited", retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
/** Domain reads and delivery use the same host-resolved Full access key. */
async function readDomain(required: { ctx: MailProviderCallContext; domainId: string; name: string }) {
  const rejected = { status: "rejected" as const, error: { code: "invalid_request" as const, message: "Resend domain unavailable" } };
  try {
    if (!z.uuid().safeParse(required.domainId).success || !z.hostname().safeParse(required.name).success) return rejected;
    const key = credential.safeParse(required.ctx.credential);
    if (!key.success) return rejected;
    const response = await required.ctx.httpClient.send({ request: { method: "GET", url: "https://api.resend.com/domains/" + required.domainId,
      headers: { Authorization: "Bearer " + key.data.token }, timeoutMs: 10000 } });
    if (response.status !== 200 || Buffer.byteLength(response.bodyText) > 1048576) return rejected;
    const parsed = domain.safeParse(JSON.parse(response.bodyText));
    if (!parsed.success || parsed.data.id !== required.domainId || parsed.data.name.toLowerCase() !== required.name.toLowerCase()) return rejected;
    return { status: "ok" as const, value: parsed.data };
  } catch { return { status: "unknown" as const, error: { code: "network" as const, message: "Resend domain unavailable" } }; }
}
function qualify(required: { name: string; domain: string }): string {
  if (required.name === "" || required.name === "@") return required.domain;
  const name = required.name.toLowerCase();
  return name === required.domain || name.endsWith("." + required.domain) ? name : name + "." + required.domain;
}
/** Svix authenticates raw bytes with bounded headers/secrets and a five-minute replay window.
 * Ingest owns durable replay deduplication and suppression; parse never writes state. */
function feedback(): MailFeedbackParser {
  return { verify(input) {
    try {
      const h = z.object({ "svix-id": z.string().min(1).max(256), "svix-timestamp": z.string().regex(/^\d{1,12}$/), "svix-signature": z.string().min(1).max(4096) }).parse(input.headers);
      if (input.rawBody.byteLength > 262144 || !Number.isFinite(input.now) || Math.abs(input.now / 1000 - Number(h["svix-timestamp"])) > 300) return false;
      if (input.secrets.length === 0 || input.secrets.length > 10) return false;
      const signed = Buffer.concat([Buffer.from(h["svix-id"] + "." + h["svix-timestamp"] + "."), input.rawBody]);
      return input.secrets.some(secret => matches({ secret, signed, signature: h["svix-signature"] }));
    } catch { return false; }
  }, parse(input) {
    try {
      if (input.rawBody.byteLength > 262144) return { error: "body_too_large" };
      const event = resendMailEventSchema.parse(JSON.parse(Buffer.from(input.rawBody).toString("utf8")));
      const kinds = { "email.delivered": "delivered", "email.bounced": "bounced", "email.complained": "complained" } as const;
      const kind = kinds[event.type as keyof typeof kinds];
      if (!kind) return [];
      const id = z.string().min(1).max(256).parse(input.headers["svix-id"]);
      return [...new Set(event.data.to.map(to => to.toLowerCase()))].map(recipient => ({ workspaceId: input.workspaceId,
        providerMessageId: event.data.email_id, sourceContext: { module: "unknown" }, kind, eventId: id + ":" + recipient, recipient,
        hardBounce: kind === "bounced" && event.data.bounce?.type === "Permanent", occurredAt: event.created_at }));
    } catch { return { error: "invalid_event" }; }
  } };
}
function matches(required: { secret: string; signed: Buffer; signature: string }): boolean {
  if (!/^whsec_[A-Za-z0-9+/=]{1,256}$/.test(required.secret)) return false;
  const expected = createHmac("sha256", Buffer.from(required.secret.slice(6), "base64")).update(required.signed).digest();
  return required.signature.split(" ").some(entry => {
    if (!entry.startsWith("v1,")) return false;
    const actual = Buffer.from(entry.slice(3), "base64");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
