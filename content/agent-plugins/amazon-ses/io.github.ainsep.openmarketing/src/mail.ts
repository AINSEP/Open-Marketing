import { verify, X509Certificate } from "node:crypto";
import { z } from "zod";
import { signSigV4 } from "@jini-ai/platform";
import type { CallOptions, Outcome, ClockPort } from "@open-marketing/contracts";
import type { MailProviderModule, MailProviderCallContext, MailFeedbackParser, MailerSendRequired, MailerSendResult, MailerOptional, OutboundEmail } from "@jini-ai/platform/mail";
import { configurationSchema, identitySchema, sesCredentialSchema } from "./commands.js";
import { domainReady } from "./transport.js";

const address = z.strictObject({ email: z.email().max(254), name: z.string().max(200).regex(/^[^\r\n<>]*$/).optional() });
const value = z.string().max(4096).regex(/^[^\r\n]*$/);
/** Single-recipient boundary; attachments are explicitly unsupported. */
export const sesMailRequestSchema = z.strictObject({
  message: z.strictObject({ workspaceId: z.string().min(1).max(256), to: address, from: address, replyTo: address.optional(), subject: value,
    html: z.string().max(65536).optional(), text: z.string().max(65536).optional(),
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,100}$/), value).refine(h => Object.keys(h).length <= 50).optional(),
    attachments: z.array(z.never()).max(0).optional() }),
  workspaceId: z.string().min(1).max(256), idempotencyKey: z.string().min(1).max(256),
  sourceContext: z.strictObject({ module: z.string().min(1).max(256), ref: z.string().max(256).optional() }),
}).refine(v => v.workspaceId === v.message.workspaceId && (v.message.html !== undefined || v.message.text !== undefined));
export type SesMailRequest = z.infer<typeof sesMailRequestSchema>;
/** Trusted host configuration, standard AWS partition only. Quota is observed, never inferred. */
export const sesMailConfigurationSchema = z.strictObject({ region: configurationSchema.shape.region,
  senderDomain: configurationSchema.shape.domainIdentity, snsTopicArn: z.string().regex(/^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/),
  maxSendRate: z.number().finite().positive().max(100000) }).refine(c => c.snsTopicArn.split(":")[3] === c.region);
export type SesMailConfiguration = z.infer<typeof sesMailConfigurationSchema>;
/** Only Notification is accepted; subscription confirmation is an operator setup action. */
export const sesSnsEnvelopeSchema = z.object({ Type: z.literal("Notification"), MessageId: z.string().min(1).max(256),
  Message: z.string().max(262144), Subject: z.string().max(1000).optional(), Timestamp: z.iso.datetime({ offset: true }),
  TopicArn: z.string().max(512), SignatureVersion: z.enum(["1", "2"]), Signature: z.string().min(1).max(4096),
  SigningCertURL: z.url().max(2048) });
export type SesSnsEnvelope = z.infer<typeof sesSnsEnvelopeSchema>;
const eventSchema = z.object({ notificationType: z.enum(["Delivery", "Bounce", "Complaint"]),
  mail: z.object({ messageId: z.string().min(1).max(256), source: z.email().max(254) }),
  delivery: z.object({ timestamp: z.iso.datetime({ offset: true }), recipients: z.array(z.email().max(254)).min(1).max(100) }).optional(),
  bounce: z.object({ timestamp: z.iso.datetime({ offset: true }), bounceType: z.string().max(64),
    bouncedRecipients: z.array(z.object({ emailAddress: z.email().max(254) })).min(1).max(100) }).optional(),
  complaint: z.object({ timestamp: z.iso.datetime({ offset: true }),
    complainedRecipients: z.array(z.object({ emailAddress: z.email().max(254) })).min(1).max(100) }).optional() });
type CreateContext = Parameters<MailProviderModule["create"]>[0];
/** Server holds the subject lane and rechecks current consent, suppression, grant/caps and
 * exact delivery identity through execute. Missing/denied authority never reaches HTTP. */
type MailAuthority = (required: { input: SesMailRequest; execute: () => Promise<MailerSendResult> }, optional?: MailerOptional) => Promise<MailerSendResult>;
type ProviderArgs = { clock: ClockPort; configuration: SesMailConfiguration; authority: MailAuthority;
  fetch: typeof globalThis.fetch; deadlineSignal: (required: { timeoutMs: number }) => AbortSignal };
type FeedbackArgs = ProviderArgs & { certificate: { url: string; value: X509Certificate; expiresAt: number } | null };

/** Inert Jini module; authority holds the server subject lane and consent recheck through egress.
 * Guarded HTTP bounds response bytes and appends correlated audit. Certificate fetch must use
 * normal TLS trust validation; no ambient network client, credentials or clock is constructed.
 * @example createAmazonSesMailProvider({ clock, configuration, authority, fetch, deadlineSignal })
 * @complexity O(b) per call; <=64KiB send, <=1MiB response, <=16KiB cert, one 10s attempt.
 */
export function createAmazonSesMailProvider(required: ProviderArgs): MailProviderModule & {
  prepareFeedback: (required: { rawBody: Uint8Array }, optional?: CallOptions) => Promise<Outcome<void>>;
} {
  const configuration = sesMailConfigurationSchema.parse(required.configuration);
  const args: FeedbackArgs = { ...required, configuration, certificate: null };
  return { id: "amazon_ses", label: "Amazon SES", credentialKeys: ["token"],
    capabilities: { hosted: true, feedback: true, domainVerification: true,
      rateLimit: { perSecond: configuration.maxSendRate, burst: Math.max(1, Math.floor(configuration.maxSendRate)) } },
    create(context) {
      return { capabilities: () => ({ driver: "amazon-ses", supportsIdempotencyKey: false, supportsWebhookFeedback: true, maxBatchSize: 1, supportsAttachments: false }),
        send: (input, options) => send({ args, context, input }, options),
        sendBatch: async (input, options) => input.messages.length === 1
          ? [await send({ args, context, input: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey, sourceContext: input.sourceContext, message: input.messages[0]! } }, options)]
          : [refusal({ code: "batch_not_supported" })] };
    }, feedback: feedback(args),
    prepareFeedback: (input, options) => prepareFeedback({ args, rawBody: input.rawBody }, options),
    async domainRequirements(ctx, input) {
      const result = await readDomain({ args, ctx, domain: input.domain });
      if (result.status !== "ok") return result;
      const tokens = result.value.DkimAttributes?.Tokens;
      if (!tokens?.length) return domainRefusal();
      return { status: "ok", value: { purpose: "mail", domain: input.domain, providerId: "amazon_ses", records: tokens.map(token => ({
        type: "CNAME" as const, name: token + "._domainkey." + input.domain, value: token + ".dkim.amazonses.com" })) } };
    },
    async domainStatus(ctx, input) {
      const result = await readDomain({ args, ctx, domain: input.domain });
      if (result.status !== "ok") return result;
      return { status: "ok", value: { domain: input.domain, state: domainReady({ data: result.value }) ? "verified" : "pending" } };
    } };
}

/** Installed send module; settings and time belong to this call, and the host gates HTTP.
 * SNS ingest and domain reads await settings-aware Jini callbacks.
 * @example provider.create(createMailAdapterContext({ credential, kit }, { now, settings })).send(input)
 * @returns A refusing mailer when settings or time are missing, without HTTP.
 * @complexity O(k) install keys; delivery reuses the bounded sender above.
 */
const provider: MailProviderModule = {
  id: "amazon_ses", label: "Amazon SES", credentialKeys: ["token"],
  capabilities: { hosted: true, feedback: false, domainVerification: false },
  create(context) {
    const settings = z.record(z.string(), z.unknown()).safeParse(context.settings);
    const { region, senderDomain, snsTopicArn, maxSendRate } = settings.success ? settings.data : {};
    const configuration = sesMailConfigurationSchema.safeParse({ region, senderDomain, snsTopicArn, maxSendRate });
    const now = context.now;
    if (!now || !configuration.success) return {
      capabilities: () => ({ driver: "amazon-ses", supportsIdempotencyKey: false, supportsWebhookFeedback: false, maxBatchSize: 1, supportsAttachments: false }),
      send: async () => refusal({ code: "not_configured" }),
      sendBatch: async () => [refusal({ code: "not_configured" })],
    };
    return createAmazonSesMailProvider({ clock: { now: () => now().getTime() }, configuration: configuration.data,
      authority: ({ execute }) => execute(), fetch: () => Promise.reject(new TypeError("feedback_unavailable")),
      deadlineSignal: () => AbortSignal.abort() }).create(context);
  },
};
export default provider;

function refusal(required: { code: string; unknown?: boolean }): MailerSendResult {
  return { ok: false, retryable: false, errorCode: required.code, message: "Amazon SES mail " + required.code, ...(required.unknown ? { unknown: true } : {}) };
}
function domainRefusal() { return { status: "rejected" as const, error: { code: "invalid_request" as const, message: "Amazon SES domain unavailable" } }; }
function format(required: { address: OutboundEmail["from"] }): string {
  return required.address.name ? `"${required.address.name.replace(/["\\]/g, "\\$&")}" <${required.address.email}>` : required.address.email;
}
/** SES headers must retain RFC8058 exactly; block duplicate casing and reserved MIME headers. */
function validHeaders(required: { message: OutboundEmail; purpose?: string }): boolean {
  const entries = Object.entries(required.message.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v] as const);
  if (new Set(entries.map(([k]) => k)).size !== entries.length) return false;
  if (entries.some(([k]) => /^(from|to|cc|bcc|sender|reply-to|subject|return-path|message-id|date|mime-version|content-.*)$/.test(k))) return false;
  const h = Object.fromEntries(entries);
  if (!h["list-unsubscribe"] && !h["list-unsubscribe-post"]) return required.purpose !== "bulk";
  return h["list-unsubscribe-post"] === "List-Unsubscribe=One-Click" && validUnsubscribe({ value: h["list-unsubscribe"] });
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
function freezeInput(required: { input: SesMailRequest }): SesMailRequest {
  const input = required.input;
  for (const value of Object.values(input.message)) {
    if (value !== null && typeof value === "object") Object.freeze(value);
  }
  Object.freeze(input.message);
  Object.freeze(input.sourceContext);
  return Object.freeze(input);
}
/** Validate before signing; failed/uncertain submissions never request an automatic resend. */
async function send(required: { args: ProviderArgs; context: CreateContext; input: MailerSendRequired }, optional?: MailerOptional): Promise<MailerSendResult> {
  let attempted = false;
  let executed = false;
  try {
    const input = sesMailRequestSchema.safeParse(required.input);
    if (!input.success) return refusal({ code: "invalid_input" });
    const m = input.data.message;
    if (m.from.email.split("@")[1]?.toLowerCase() !== required.args.configuration.senderDomain) return refusal({ code: "invalid_sender" });
    if (!validHeaders({ message: m, purpose: optional?.purpose })) return refusal({ code: "invalid_unsubscribe" });
    const body = payload({ message: m });
    if (Buffer.byteLength(body) > 65536) return refusal({ code: "payload_too_large" });
    return await required.args.authority({ input: freezeInput({ input: input.data }), execute: async () => {
      if (executed) return refusal({ code: "conflict" });
      executed = true;
      const request = signedRequest({ args: required.args, credential: required.context.credential.token, method: "POST", path: "/v2/email/outbound-emails", body });
      attempted = true;
      const response = await required.context.kit.httpClient.send({ request });
      return receipt({ response, now: required.args.clock.now({}) });
    } }, optional);
  } catch { return refusal({ code: "unavailable", unknown: attempted }); }
}
function payload(required: { message: OutboundEmail }): string {
  const m = required.message;
  return JSON.stringify({ FromEmailAddress: format({ address: m.from }), Destination: { ToAddresses: [format({ address: m.to })] },
    ReplyToAddresses: m.replyTo ? [format({ address: m.replyTo })] : undefined,
    Content: { Simple: { Subject: { Data: m.subject, Charset: "UTF-8" },
      Body: { Html: m.html === undefined ? undefined : { Data: m.html, Charset: "UTF-8" }, Text: m.text === undefined ? undefined : { Data: m.text, Charset: "UTF-8" } },
      Headers: Object.entries(m.headers ?? {}).map(([Name, Value]) => ({ Name, Value })) } } });
}
/** No acceptance fallback and no retry classification for uncertain submissions. */
function receipt(required: { response: { status: number; bodyText: string; headers: Readonly<Record<string, string>> }; now: number }): MailerSendResult {
  const { response, now } = required;
  if (response.status === 429) return rateLimited({ headers: response.headers, now });
  const acceptedAt = new Date(now).toISOString();
  if (response.status < 200 || response.status >= 300) return refusal({ code: "provider_rejected", unknown: response.status >= 500 || response.status === 408 });
  if (Buffer.byteLength(response.bodyText) > 1048576) return refusal({ code: "invalid_response", unknown: true });
  const parsed = z.object({ MessageId: z.string().min(1).max(256) }).safeParse(JSON.parse(response.bodyText));
  return parsed.success ? { ok: true, providerMessageId: parsed.data.MessageId, acceptedAt } : refusal({ code: "invalid_response", unknown: true });
}
/** Definitive provider back-pressure; clamp Retry-After to one day using injected time. */
function rateLimited(required: { headers: Readonly<Record<string, string>>; now: number }): MailerSendResult {
  const header = Object.entries(required.headers).find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header ?? "") - required.now;
  const retryAfterMs = Number.isFinite(delay) ? Math.min(86400000, Math.max(0, delay)) : undefined;
  return { ok: false, errorCode: "MAIL_RATE_LIMITED", message: "Provider rate limited", retryable: true,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
}
/** SigV4 mutates a new header map. No ambient credentials, custom hosts or time reads. */
function signedRequest(required: { args: ProviderArgs; credential: string; method: "POST" | "GET"; path: string; body: string }) {
  if (required.credential.length > 8192) throw new TypeError("invalid_credential");
  const credentials = sesCredentialSchema.parse(JSON.parse(required.credential));
  const region = required.args.configuration.region;
  if (credentials.region !== region) throw new TypeError("credential_region_mismatch");
  const now = required.args.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) throw new TypeError("invalid_clock");
  const host = "email." + region + ".amazonaws.com";
  const headers: Record<string, string> = { host, "content-type": "application/json" };
  signSigV4({ method: required.method, path: required.path, query: "", headers, body: Buffer.from(required.body), region, service: "ses", credentials, now: new Date(now) });
  return { method: required.method, url: "https://" + host + required.path, headers, ...(required.method === "POST" ? { body: required.body } : {}), timeoutMs: 10000 };
}
/** Read only the configured identity. DNS records never confer send authority. */
async function readDomain(required: { args: ProviderArgs; ctx: MailProviderCallContext; domain: string }) {
  try {
    if (required.domain !== required.args.configuration.senderDomain) return domainRefusal();
    const request = signedRequest({ args: required.args, credential: required.ctx.credential.token, method: "GET", path: "/v2/email/identities/" + required.domain, body: "" });
    const response = await required.ctx.httpClient.send({ request });
    if (response.status !== 200 || Buffer.byteLength(response.bodyText) > 1048576) return domainRefusal();
    const parsed = identitySchema.safeParse(JSON.parse(response.bodyText));
    return parsed.success ? { status: "ok" as const, value: parsed.data } : domainRefusal();
  } catch { return { status: "unknown" as const, error: { code: "network" as const, message: "Amazon SES domain unavailable" } }; }
}
/** Verify synchronously with a prepared, unexpired certificate from the regional SNS origin.
 * parse verifies again so an unverified caller cannot obtain suppression events.
 * @complexity O(b+r); b<=256KiB and r<=100 recipients. Ingest owns durable replay deduplication.
 */
function feedback(required: FeedbackArgs): MailFeedbackParser {
  return { verify(input) {
    return verified({ ...required, rawBody: input.rawBody, now: input.now }) !== null;
  }, parse(input) {
    const envelope = verified({ ...required, rawBody: input.rawBody, now: required.clock.now({}) });
    if (!envelope) return { error: "invalid_signature" };
    try {
      const event = eventSchema.parse(JSON.parse(envelope.Message));
      if (event.mail.source.split("@")[1]?.toLowerCase() !== required.configuration.senderDomain) return { error: "foreign_sender" };
      return events({ envelope, event, workspaceId: input.workspaceId });
    } catch { return { error: "invalid_event" }; }
  } };
}
/** AWS Notification canonical field order, including optional Subject and final newline. */
function verified(required: FeedbackArgs & { rawBody: Uint8Array; now: number }): SesSnsEnvelope | null {
  try {
    if (required.rawBody.byteLength > 262144 || !Number.isFinite(required.now)) return null;
    const e = feedbackEnvelope({ args: required, rawBody: required.rawBody });
    const cert = trustedCertificate({ args: required, envelope: e, now: required.now });
    if (!cert) return null;
    const fields = ["Message", "MessageId", ...(e.Subject === undefined ? [] : ["Subject"]), "Timestamp", "TopicArn", "Type"] as const;
    const canonical = fields.map(key => key + "\n" + e[key as keyof SesSnsEnvelope] + "\n").join("");
    return verify(e.SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1", Buffer.from(canonical), cert.publicKey, Buffer.from(e.Signature, "base64")) ? e : null;
  } catch { return null; }
}
/** Validate topic and exact regional AWS certificate origin/path before any network access. */
function feedbackEnvelope(required: { args: ProviderArgs; rawBody: Uint8Array }): SesSnsEnvelope {
  if (required.rawBody.byteLength > 262144) throw new TypeError("body_too_large");
  const envelope = sesSnsEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(required.rawBody)));
  const url = new URL(envelope.SigningCertURL);
  if (envelope.TopicArn !== required.args.configuration.snsTopicArn) throw new TypeError("foreign_topic");
  if (url.origin !== "https://sns." + required.args.configuration.region + ".amazonaws.com" || !/^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(url.pathname)
    || url.search || url.hash || url.username || url.password) throw new TypeError("invalid_certificate_url");
  return envelope;
}
/** A single instance-owned entry bounds memory; rotation replaces it, expiry never falls back. */
function trustedCertificate(required: { args: FeedbackArgs; envelope: SesSnsEnvelope; now: number }): X509Certificate | null {
  const cached = required.args.certificate;
  if (!cached || cached.url !== required.envelope.SigningCertURL || required.now >= cached.expiresAt) return null;
  return required.now < Date.parse(cached.value.validFrom) ? null : cached.value;
}
/** Jini 0.6.12 feedback is synchronous: await this bounded TLS fetch before feedback ingest.
 * Refuse redirects, invalid topics/URLs, malformed/expired PEMs and outages; never ingest on failure.
 * @complexity O(b), b<=16KiB; one 10s GET on cache miss, one certificate retained <=1h.
 */
async function prepareFeedback(required: { args: FeedbackArgs; rawBody: Uint8Array }, optional?: CallOptions): Promise<Outcome<void>> {
  let fetching = false;
  try {
    if (optional?.signal?.aborted) return feedbackFailure({ code: "cancelled" });
    const { args } = required;
    const envelope = feedbackEnvelope(required);
    const now = z.number().int().nonnegative().max(8640000000000000).parse(args.clock.now({}));
    if (trustedCertificate({ args, envelope, now })) return { ok: true, value: undefined };
    const deadline = args.deadlineSignal({ timeoutMs: 10000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    signal.throwIfAborted();
    fetching = true;
    const response = await args.fetch(envelope.SigningCertURL, { method: "GET", redirect: "error", signal });
    if (response.status !== 200 || response.redirected) { await response.body?.cancel(); return feedbackFailure({ code: "unavailable" }); }
    const pem = await readCertificate({ response });
    signal.throwIfAborted();
    const cert = new X509Certificate(pem);
    const fetchedAt = z.number().int().nonnegative().max(8640000000000000).parse(args.clock.now({}));
    if (fetchedAt < Date.parse(cert.validFrom) || fetchedAt >= Date.parse(cert.validTo)) return feedbackFailure({ code: "unauthenticated" });
    args.certificate = { url: envelope.SigningCertURL, value: cert, expiresAt: Math.min(Date.parse(cert.validTo), fetchedAt + 3600000) };
    return { ok: true, value: undefined };
  } catch { return feedbackFailure({ code: fetching ? "unavailable" : "invalid_input" }); }
}
/** Count streamed bytes before PEM parsing; Content-Length is not a bound. */
async function readCertificate(required: { response: Response }): Promise<Buffer> {
  if (!required.response.body) throw new TypeError("missing_certificate");
  const reader = required.response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 16384) { await reader.cancel(); throw new TypeError("certificate_too_large"); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks);
  } finally { reader.releaseLock(); }
}
function feedbackFailure(required: { code: "cancelled" | "invalid_input" | "unavailable" | "unauthenticated" }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "SNS certificate " + required.code, retryable: required.code === "unavailable" } };
}

function events(required: { envelope: SesSnsEnvelope; event: z.infer<typeof eventSchema>; workspaceId: string }) {
  const { event, envelope, workspaceId } = required;
  const detail = eventDetail({ event });
  if (!detail) return { error: "invalid_event" };
  return [...new Set(detail.recipients.map(r => r.toLowerCase()))].map(recipient => ({ workspaceId, providerMessageId: event.mail.messageId,
    sourceContext: { module: "unknown" }, kind: detail.kind, eventId: envelope.MessageId + ":" + recipient,
    recipient, occurredAt: detail.occurredAt, hardBounce: detail.hardBounce }));
}
/** Select the matching notification branch, never combine unrelated feedback subobjects. */
function eventDetail(required: { event: z.infer<typeof eventSchema> }) {
  const event = required.event;
  if (event.notificationType === "Delivery") return event.delivery ? { recipients: event.delivery.recipients,
    kind: "delivered" as const, occurredAt: event.delivery.timestamp, hardBounce: false } : null;
  if (event.notificationType === "Bounce") return event.bounce ? { recipients: event.bounce.bouncedRecipients.map(r => r.emailAddress),
    kind: "bounced" as const, occurredAt: event.bounce.timestamp, hardBounce: event.bounce.bounceType === "Permanent" } : null;
  return event.complaint ? { recipients: event.complaint.complainedRecipients.map(r => r.emailAddress),
    kind: "complained" as const, occurredAt: event.complaint.timestamp, hardBounce: false } : null;
}
