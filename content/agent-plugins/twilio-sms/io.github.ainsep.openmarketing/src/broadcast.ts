import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, decimalToMicros, generationCostQuoteSchema, idSchema, moneySchema } from "@open-marketing/contracts";
import type { CallOptions, Outcome } from "@open-marketing/contracts";
import { configurationSchema } from "./commands.js";
import { parseCredential, readBody } from "./transport.js";
import type { Credential } from "./transport.js";
import type { TwilioDependencies } from "./ports.js";

/** Matches STOP ingress; the host uses this channel for current consent and suppression. */
export const messageChannel = "sms";
/** One frozen owner-started intent; subject resolution and durable dedup belong to the host. */
export const twilioMessageSchema = z.strictObject({ context: callContextSchema, deliveryId: idSchema,
  recipient: z.string().regex(/^\+[1-9][0-9]{7,14}$/), message: z.strictObject({ content: z.string().min(1).max(1600) }) });
export type TwilioMessage = z.infer<typeof twilioMessageSchema>;
/** Vendor acceptance never claims handset delivery. Unknown requires reconciliation, not resend. */
export const twilioDeliveryReceiptSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("accepted"), deliveryId: idSchema, providerMessageId: z.string().regex(/^SM[0-9a-fA-F]{32}$/) }),
  z.strictObject({ status: z.literal("unknown"), deliveryId: idSchema }),
]);
export type TwilioDeliveryReceipt = z.infer<typeof twilioDeliveryReceiptSchema>;
const quoteSchema = generationCostQuoteSchema.pick({ quoteId: true, argumentsDigest: true, estimated: true, upperBound: true, pricingEvidenceId: true, expiresAt: true, status: true });
const lookupSchema = z.object({ valid: z.literal(true), phone_number: z.string(), country_code: z.string().regex(/^[A-Z]{2}$/) });
const pricingSchema = z.object({ price_unit: z.literal("USD"), outbound_sms_prices: z.array(z.object({
  prices: z.array(z.object({ current_price: z.string().min(1).max(100) })).min(1).max(100),
})).min(1).max(1000) });
type Request = Readonly<{ method: "POST"; url: string; body: string }>;
/** Authority reserves the quote under the host's subject lane and exact owner approval.
 * No denial may execute; delivery-key dedup and egress audit remain server-owned.
 */
export type TwilioMessageDependencies = Pick<TwilioDependencies, "configuration" | "credentials" | "fetch" | "deadlineSignal" | "clock" | "observer"> & {
  readonly authority: (required: { quote: z.infer<typeof quoteSchema>; argumentsDigest: string;
    execute: () => Promise<Outcome<TwilioDeliveryReceipt>> }, optional?: CallOptions) => Promise<Outcome<TwilioDeliveryReceipt>>;
};

/** Resolve credentials and pricing before one host-gated Messages POST. No retries or queue.
 * @example sendMessage({ context, deliveryId, recipient, message: { content: "Hello" }, dependencies }, { signal })
 * @complexity <=2 GETs + 1 POST, each <=64KiB/10s; message <=1600 UTF-16 units.
 */
export async function sendMessage(required: TwilioMessage & { dependencies: TwilioMessageDependencies }, optional?: CallOptions): Promise<Outcome<TwilioDeliveryReceipt>> {
  try {
    if (optional?.signal?.aborted) return failure({ code: "cancelled" });
    const { dependencies, ...intent } = required;
    const input = twilioMessageSchema.parse(intent);
    const c = configurationSchema.parse(dependencies.configuration);
    if (input.context.scope.ownerId !== c.scope.ownerId || input.context.scope.workspaceId !== c.scope.workspaceId) return failure({ code: "forbidden" });
    return await authorize({ dependencies, input, configuration: c }, optional);
  } catch { return failure({ code: "invalid_input" }); }
}
/** Bind the credential sender/registration and a fresh vendor quote before authority. */
async function authorize(required: { dependencies: TwilioMessageDependencies; input: TwilioMessage; configuration: TwilioDependencies["configuration"] }, optional?: CallOptions): Promise<Outcome<TwilioDeliveryReceipt>> {
  const { dependencies: d, input, configuration: c } = required;
  let executed = false;
  try {
    const result = await d.credentials.access({ connectionId: c.connectionId, accountId: c.accountId }, optional);
    if (!result.ok) return failure({ code: "unauthenticated" });
    const credential = parseCredential({ envelope: result.value });
    if (!credential.ok) return credential;
    const sender = credential.value;
    const prepared = prepareRequest({ input, configuration: c, credential: sender, now: d.clock.now({}) });
    if (!prepared.ok) return prepared;
    const request = prepared.value;
    const argumentsDigest = createHash("sha256").update(JSON.stringify(request)).digest("hex");
    const quote = await priceQuote({ dependencies: d, input, credential: sender, argumentsDigest }, optional);
    if (!quote.ok) return quote;
    const outcome = await d.authority({ quote: quote.value, argumentsDigest, execute: async () => {
      if (executed) return failure({ code: "conflict" });
      executed = true;
      return submit({ dependencies: d, input, request, credential: sender }, optional);
    } }, optional);
    observe({ dependencies: d, input, outcome });
    return outcome;
  } catch { return executed ? unknown({ deliveryId: input.deliveryId }) : failure({ code: "unavailable" }); }
}
/** Registration, account and credential lifetime must cover this exact sender before pricing. */
function prepareRequest(required: { input: TwilioMessage; configuration: TwilioDependencies["configuration"]; credential: Credential; now: number }): Outcome<Request> {
  const { input, configuration: c, credential: sender } = required;
  if (sender.accountSid !== c.accountId) return failure({ code: "forbidden" });
  const registrationSid = sender.tollfreeVerificationSid ?? (sender.brandSid && sender.campaignSid);
  if (!sender.messagingServiceSid || !registrationSid) return failure({ code: "forbidden" });
  const now = z.number().int().nonnegative().max(8640000000000000).parse(required.now);
  if ((sender.expiresAt ?? Infinity) <= now) return failure({ code: "unauthenticated" });
  return { ok: true, value: Object.freeze({ method: "POST", url: `https://api.twilio.com/2010-04-01/Accounts/${sender.accountSid}/Messages.json`,
    body: new URLSearchParams({ MessagingServiceSid: sender.messagingServiceSid, To: input.recipient, Body: input.message.content }).toString() }) };
}
/** Count whole graphemes conservatively; oversized graphemes return invalid_input without I/O.
 * @complexity O(n) time and O(n) segmenter storage for <=1600 UTF-16 units.
 */
function countSegments(required: { content: string }): Outcome<number> {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  let segments = 1;
  let used = 0;
  for (const { segment } of segmenter.segment(required.content)) {
    const length = segment.length;
    if (length > 66) return failure({ code: "invalid_input" });
    if (used + length > 66) {
      segments++;
      used = length;
    } else used += length;
  }
  return { ok: true, value: required.content.length <= 70 ? 1 : segments };
}
/** Free basic Lookup selects the country; Pricing supplies every carrier/number-type rate.
 * UCS-2 segments: 70 single, 66 per part (Twilio's smallest, toll-free US/CA), whole graphemes per part; a grapheme >66 units refuses.
 * UCS-2 segmentation and cent rounding overstate normal GSM SMS. +1 cent/segment covers
 * US SMS carrier fees checked against https://www.twilio.com/en-us/sms/pricing/us (2026-10-28).
 * @complexity O(p), p is bounded by the 64KiB response; exactly two GETs, no retries.
 */
async function priceQuote(required: { dependencies: TwilioMessageDependencies; input: TwilioMessage; credential: Credential; argumentsDigest: string }, optional?: CallOptions): Promise<Outcome<z.infer<typeof quoteSchema>>> {
  const segments = countSegments({ content: required.input.message.content });
  if (!segments.ok) return segments;
  const lookup = await readPricing({ ...required, url: "https://lookups.twilio.com/v2/PhoneNumbers/" + encodeURIComponent(required.input.recipient) }, optional);
  if (!lookup.ok) return lookup;
  const country = lookupSchema.safeParse(lookup.value);
  if (!country.success || country.data.phone_number !== required.input.recipient) return failure({ code: "invalid_input" });
  const pricing = await readPricing({ ...required, url: "https://pricing.twilio.com/v1/Messaging/Countries/" + country.data.country_code }, optional);
  if (!pricing.ok) return pricing;
  const prices = pricingSchema.safeParse(pricing.value);
  if (!prices.success) return failure({ code: "not_implemented" });
  const maximum = maximumPrice({ prices: prices.data });
  if (!maximum.ok) return maximum;
  const upperBound = moneySchema.parse({ currency: "USD", minorUnits: Number(BigInt(segments.value) * ((maximum.value + 9999n) / 10000n + 1n)) });
  const pricingEvidenceId = createHash("sha256").update(JSON.stringify([country.data.country_code, prices.data])).digest("hex");
  return { ok: true, value: quoteSchema.parse({ quoteId: required.input.deliveryId, argumentsDigest: required.argumentsDigest,
    estimated: upperBound, upperBound, status: "known", pricingEvidenceId, expiresAt: required.dependencies.clock.now({}) + 300000 }) };
}
/** Preserve exact decimals until conservative cent rounding; malformed rates refuse the send. */
function maximumPrice(required: { prices: z.infer<typeof pricingSchema> }): Outcome<bigint> {
  let maximum = 0n;
  for (const price of required.prices.outbound_sms_prices.flatMap(row => row.prices)) {
    const micros = decimalToMicros({ value: price.current_price, rounding: "reject" });
    if (!micros.ok) return failure({ code: "invalid_input" });
    const amount = BigInt(micros.value);
    if (amount > maximum) maximum = amount;
  }
  return { ok: true, value: maximum };
}
/** Bounded read-only evidence requests never authorize a Messages POST; all failures are pre-send. */
async function readPricing(required: { dependencies: TwilioMessageDependencies; credential: Credential; url: string }, optional?: CallOptions): Promise<Outcome<unknown>> {
  const deadline = required.dependencies.deadlineSignal({ timeoutMs: 10000 });
  const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
  signal.throwIfAborted();
  const response = await required.dependencies.fetch(required.url, { method: "GET", redirect: "error", signal,
    headers: { Authorization: authorization(required) } });
  if (!response.ok) { await response.body?.cancel(); return failure({ code: "unavailable" }); }
  const body = await readBody({ response });
  signal.throwIfAborted();
  return body;
}
function authorization(required: { credential: Credential }): string {
  return "Basic " + Buffer.from(required.credential.apiKeySid + ":" + required.credential.apiKeySecret).toString("base64");
}
/** Any failure after fetch starts is ambiguous; a definitive 4xx is a refusal. */
async function submit(required: { dependencies: TwilioMessageDependencies; input: TwilioMessage; request: Request; credential: Credential }, optional?: CallOptions): Promise<Outcome<TwilioDeliveryReceipt>> {
  const { dependencies: d, input, request } = required;
  if ((required.credential.expiresAt ?? Infinity) <= d.clock.now({})) return failure({ code: "unauthenticated" });
  if (optional?.signal?.aborted) return failure({ code: "cancelled" });
  let attempted = false;
  try {
    const deadline = d.deadlineSignal({ timeoutMs: 10000 });
    const signal = optional?.signal ? AbortSignal.any([deadline, optional.signal]) : deadline;
    signal.throwIfAborted();
    attempted = true;
    const response = await d.fetch(request.url, { method: request.method, body: request.body, redirect: "error", signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: authorization(required) } });
    return await receipt({ response, input, configuration: d.configuration, signal });
  } catch { return attempted ? unknown({ deliveryId: input.deliveryId }) : failure({ code: "cancelled" }); }
}
async function receipt(required: { response: Response; input: TwilioMessage; configuration: TwilioDependencies["configuration"]; signal: AbortSignal }): Promise<Outcome<TwilioDeliveryReceipt>> {
  const { response, input } = required;
  if (response.status === 429) { await response.body?.cancel(); return failure({ code: "limit_exceeded", retryable: true }); }
  if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 409) {
    await response.body?.cancel();
    return failure({ code: "forbidden" });
  }
  if (response.status < 200 || response.status >= 300) { await response.body?.cancel(); return unknown({ deliveryId: input.deliveryId }); }
  const body = await readBody({ response });
  if (!body.ok) return unknown({ deliveryId: input.deliveryId });
  required.signal.throwIfAborted();
  const parsed = z.object({ sid: z.string().regex(/^SM[0-9a-fA-F]{32}$/), account_sid: z.literal(required.configuration.accountId), to: z.literal(input.recipient) }).safeParse(body.value);
  return parsed.success ? { ok: true, value: { status: "accepted", deliveryId: input.deliveryId, providerMessageId: parsed.data.sid } } : unknown({ deliveryId: input.deliveryId });
}
function unknown(required: { deliveryId: string }): Outcome<TwilioDeliveryReceipt> { return { ok: true, value: { status: "unknown", deliveryId: required.deliveryId } }; }
function failure(required: { code: "invalid_input" | "forbidden" | "unauthenticated" | "unavailable" | "not_implemented" | "conflict" | "cancelled" | "limit_exceeded"; retryable?: boolean }): Outcome<never> {
  return { ok: false, error: { code: required.code, message: "Twilio delivery " + required.code, retryable: required.retryable ?? false } };
}
function observe(required: { dependencies: TwilioMessageDependencies; input: TwilioMessage; outcome: Outcome<TwilioDeliveryReceipt> }): void {
  const c = required.input.context;
  try { required.dependencies.observer.observe({ operation: "twilio-sms.send", outcome: required.outcome.ok ? required.outcome.value.status : required.outcome.error.code,
    correlationId: c.correlationId, traceId: c.traceId, runId: c.runId }); } catch { /* Host egress audit remains authoritative. */ }
}
