import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, epochSchema, generationCostQuoteSchema, idSchema, moneySchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { templatesSchema } from "./commands.js";
import { effectiveDate, maximumRate, rateCategorySchema } from "./rates.js";
import type { Rates } from "./rates.js";
import { apiVersion, configurationSchema, parseCredential, readBody } from "./transport.js";
import type { Credential } from "./transport.js";

/** Matches STOP ingress; the host uses this channel for current consent and suppression. */
export const messageChannel = "whatsapp";
/** One owner-started template intent; unknown fields and free-form messages are refused. */
export const whatsappMessageSchema = z.strictObject({ context: callContextSchema, deliveryId: idSchema,
  recipient: z.string().regex(/^\+[1-9][0-9]{7,14}$/), message: z.strictObject({ template: z.strictObject({
    name: z.string().regex(/^[a-z0-9_]{1,512}$/), language: z.string().regex(/^[a-z]{2,3}(?:_[A-Z]{2})?$/),
    bodyParameters: z.array(z.string().min(1).max(1024)).max(30) }) }) });
export type WhatsAppMessage = z.infer<typeof whatsappMessageSchema>;
/** accepted is a provider submission receipt, not handset delivery. */
export const whatsappDeliveryReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("accepted"), deliveryId: idSchema, providerMessageId: z.string().min(1).max(512) }),
  z.strictObject({ status: z.literal("unknown"), deliveryId: idSchema }),
]);
export type WhatsAppDeliveryReceipt = z.infer<typeof whatsappDeliveryReceiptSchema>;
type Request = Readonly<{ method: "POST"; url: string; body: string }>;
const quoteSchema = generationCostQuoteSchema.pick({ quoteId: true, argumentsDigest: true, estimated: true, upperBound: true, pricingEvidenceId: true, expiresAt: true, status: true });
const templateCategorySchema = z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]).transform(category => rateCategorySchema.parse(category.toLowerCase()));
/** Host holds the subject lane, rechecks consent and reserves the exact quote before execute.
 * Delivery dedup, uncertain reconciliation and correlated egress audit remain server-owned.
 */
export type WhatsAppMessageDependencies = Pick<PluginCapabilityDependencies, "configuration" | "credentials" | "fetch" | "clock" | "observer"> & {
  readonly deadlineSignal: (required: { timeoutMs: number }) => AbortSignal;
  readonly authority: (required: { quote: z.infer<typeof quoteSchema>; argumentsDigest: string;
    execute: () => Promise<Outcome<WhatsAppDeliveryReceipt>> }, optional?: CallOptions) => Promise<Outcome<WhatsAppDeliveryReceipt>>;
};
/** Fixture-only rate replacement; production calls use primary-verified local rate rows. */
type MessageOptions = CallOptions & { rates?: Rates };
/** One approved-template POST behind the server authority callback; no local policy or retries.
 * @param required Scoped delivery, E.164 recipient, template name/language/bodyParameters and host dependencies.
 * @param optional Cancellation and fixture rate rows; neither grants send authority.
 * @returns Accepted/unknown submission receipt, or a redacted typed refusal.
 * @example sendMessage({ context, deliveryId, recipient, message: { template }, dependencies }, { signal })
 * @complexity Two GETs + at most one POST, each <=1MiB/10s; request <=64KiB.
 */
export async function sendMessage(required: WhatsAppMessage & { dependencies: WhatsAppMessageDependencies }, optional?: MessageOptions): Promise<Outcome<WhatsAppDeliveryReceipt>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const { dependencies: d, ...intent } = required;
    const input = whatsappMessageSchema.parse(intent);
    const c = configurationSchema.parse(d.configuration);
    if (c.scope.ownerId !== input.context.scope.ownerId || c.scope.workspaceId !== input.context.scope.workspaceId) return failure({ code: "forbidden" });
    const body = JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: input.recipient.slice(1), type: "template",
      template: { name: input.message.template.name, language: { code: input.message.template.language }, components: input.message.template.bodyParameters.length
        ? [{ type: "body", parameters: input.message.template.bodyParameters.map(text => ({ type: "text", text })) }] : [] } });
    if (Buffer.byteLength(body) > 65536) return failure({ code: "limit_exceeded" });
    const outcome = await authorize({ dependencies: d, configuration: c, input, body }, optional);
    observe({ dependencies: d, input, outcome });
    return outcome;
  } catch { return failure({ code: "invalid_input" }); }
}
/** Bind the credential WABA and phone before the server consent authority.
 * @complexity O(b), one broker access and a <=64KiB template request; no retries. */
async function authorize(required: { dependencies: WhatsAppMessageDependencies; configuration: WhatsAppMessageDependencies["configuration"]; input: WhatsAppMessage; body: string }, optional?: MessageOptions): Promise<Outcome<WhatsAppDeliveryReceipt>> {
  const { dependencies: d, configuration: c, input, body } = required;
  let executed = false;
  try {
    const result = await d.credentials.access({ connectionId: c.connectionId, accountId: c.accountId }, optional);
    if (!result.ok) return failure({ code: "unauthenticated" });
    const credential = parseCredential({ envelope: result.value });
    if (!credential.ok) return credential;
    if (credential.value.wabaId !== c.accountId || !credential.value.phoneNumberId) return failure({ code: "forbidden" });
    const request: Request = Object.freeze({ method: "POST", url: `https://graph.facebook.com/${apiVersion}/${credential.value.phoneNumberId}/messages`, body });
    const now = epochSchema.parse(d.clock.now({}));
    const expiresAt = epochSchema.optional().parse(credential.value.expiresAt);
    if ((expiresAt ?? Infinity) <= now) return failure({ code: "unauthenticated" });
    const argumentsDigest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const quote = await priceQuote({ dependencies: d, input, credential: credential.value, argumentsDigest }, optional);
    if (!quote.ok) return quote;
    return await d.authority({ quote: quote.value, argumentsDigest, execute: async () => {
        if (executed) return failure({ code: "conflict" });
        executed = true;
        return submit({ dependencies: d, input, request, credential: credential.value, quoteExpiresAt: quote.value.expiresAt }, optional);
      } }, optional);
  } catch { return executed ? unknown({ deliveryId: input.deliveryId }) : failure({ code: "unavailable" }); }
}
/** Account currency and an exact approved template are evidence, never caller configuration.
 * @complexity Exactly two bounded GETs, <=100 templates; no pagination or retries.
 */
async function priceQuote(required: { dependencies: WhatsAppMessageDependencies; input: WhatsAppMessage; credential: Credential; argumentsDigest: string }, optional?: MessageOptions): Promise<Outcome<z.infer<typeof quoteSchema>>> {
  const base = `https://graph.facebook.com/${apiVersion}/${required.credential.wabaId}`;
  const account = await readGraph({ ...required, url: base + "?fields=currency" }, optional);
  if (!account.ok) return account;
  if (!z.object({ currency: z.literal("USD") }).safeParse(account.value).success) return failure({ code: "not_implemented" });
  const template = required.input.message.template;
  const query = new URLSearchParams({ fields: "id,name,language,status,category", name: template.name, limit: "100" });
  const templates = await readGraph({ ...required, url: `${base}/message_templates?${query}` }, optional);
  if (!templates.ok) return templates;
  const parsed = templatesSchema.safeParse(templates.value);
  if (!parsed.success) return failure({ code: "forbidden" });
  const matches = parsed.data.data.filter(row => row.name === template.name && row.language === template.language);
  if (matches.length !== 1 || parsed.data.paging?.next !== undefined) return failure({ code: "forbidden" });
  const row = matches[0]!;
  const category = templateCategorySchema.safeParse(row.category);
  if (row.status !== "APPROVED" || !category.success) return failure({ code: "forbidden" });
  const rate = maximumRate({ digits: required.input.recipient.slice(1), category: category.data }, optional);
  if (!rate.ok) return rate;
  const upperBound = moneySchema.parse({ currency: "USD", minorUnits: Number((rate.value.micros + 9999n) / 10000n) });
  const pricingEvidenceId = createHash("sha256").update(JSON.stringify([effectiveDate, rate.value.matchedPrefix, category.data, rate.value.rateString])).digest("hex");
  return { ok: true, value: quoteSchema.parse({ quoteId: required.input.deliveryId, argumentsDigest: required.argumentsDigest,
    estimated: upperBound, upperBound, status: "known", pricingEvidenceId, expiresAt: required.dependencies.clock.now({}) + 300000 }) };
}
/** Read through existing bounded JSON transport; never follow Graph paging URLs or redirects.
 * @complexity One <=1MiB GET with an injected 10s deadline covering body consumption.
 */
async function readGraph(required: { dependencies: WhatsAppMessageDependencies; credential: Credential; url: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const deadline = required.dependencies.deadlineSignal({ timeoutMs: 10000 });
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  signal.throwIfAborted();
  const response = await required.dependencies.fetch(required.url, { method: "GET", redirect: "error", signal,
    headers: { Authorization: "Bearer " + required.credential.accessToken } });
  if (!response.ok) { await response.body?.cancel(); return failure({ code: "unavailable" }); }
  const body = await readBody({ response });
  signal.throwIfAborted();
  return body;
}
/** Treat timeout, cancellation after submission, redirects and malformed success as unknown. */
async function submit(required: { dependencies: WhatsAppMessageDependencies; input: WhatsAppMessage; request: Request; credential: Credential; quoteExpiresAt: number }, optional?: CallOptions): Promise<Outcome<WhatsAppDeliveryReceipt>> {
  const { dependencies: d, input, request } = required;
  const now = epochSchema.parse(d.clock.now({}));
  if ((required.credential.expiresAt ?? Infinity) <= now) return failure({ code: "unauthenticated" });
  if (required.quoteExpiresAt <= now) return failure({ code: "expired" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  let attempted = false;
  try {
    const deadline = d.deadlineSignal({ timeoutMs: 10000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    signal.throwIfAborted();
    attempted = true;
    const response = await d.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal,
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + required.credential.accessToken } });
    return await receipt({ response, input, signal });
  } catch { return attempted ? unknown({ deliveryId: input.deliveryId }) : failure({ code: "cancelled" }); }
}
async function receipt(required: { response: Response; input: WhatsAppMessage; signal: AbortSignal }): Promise<Outcome<WhatsAppDeliveryReceipt>> {
  const { response, input } = required;
  if (response.status === 429) { await response.body?.cancel(); return failure({ code: "limit_exceeded", retryable: true }); }
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409) {
    const body = await readBody({ response });
    required.signal.throwIfAborted();
    const error = z.object({ error: z.object({ code: z.union([z.literal(130429), z.literal(131056)]) }) }).safeParse(body.ok ? body.value : null);
    return error.success ? failure({ code: "limit_exceeded", retryable: true }) : failure({ code: "forbidden" });
  }
  if (response.status < 200 || response.status >= 300) { await response.body?.cancel(); return unknown({ deliveryId: input.deliveryId }); }
  const body = await readBody({ response });
  if (!body.ok) return unknown({ deliveryId: input.deliveryId });
  required.signal.throwIfAborted();
  const parsed = z.object({ messaging_product: z.literal("whatsapp"), contacts: z.array(z.object({ input: z.literal(input.recipient.slice(1)), wa_id: z.string().regex(/^[1-9][0-9]{7,14}$/) })).length(1),
    messages: z.array(z.object({ id: z.string().min(1).max(512) })).length(1) }).safeParse(body.value);
  return parsed.success ? { ok: true, value: { status: "accepted", deliveryId: input.deliveryId, providerMessageId: parsed.data.messages[0]!.id } } : unknown({ deliveryId: input.deliveryId });
}
function unknown(required: { deliveryId: string }): Outcome<WhatsAppDeliveryReceipt> { return { ok: true, value: { status: "unknown", deliveryId: required.deliveryId } }; }
function failure(required: { code: "invalid_input" | "not_implemented" | "expired" | "forbidden" | "unauthenticated" | "unavailable" | "conflict" | "cancelled" | "limit_exceeded"; retryable?: boolean }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "WhatsApp delivery " + required.code, retryable: required.retryable ?? false } };
}
function observe(required: { dependencies: WhatsAppMessageDependencies; input: WhatsAppMessage; outcome: Outcome<WhatsAppDeliveryReceipt> }): void {
  const c = required.input.context;
  try { required.dependencies.observer.observe({ operation: "whatsapp-business.send", outcome: required.outcome.ok ? required.outcome.value.status : required.outcome.error.code,
    correlationId: c.correlationId, traceId: c.traceId, runId: c.runId }); } catch { /* Host egress audit remains authoritative. */ }
}
