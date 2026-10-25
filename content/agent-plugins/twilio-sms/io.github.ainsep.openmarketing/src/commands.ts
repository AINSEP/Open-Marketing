import { z } from "zod";
import { callContextSchema, digestSchema, idSchema, scopeSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { TwilioCommand, TwilioConfiguration, TwilioReadData } from "./ports.js";

const account = z.string().regex(/^AC[0-9a-fA-F]{32}$/);
const service = z.string().regex(/^MG[0-9a-fA-F]{32}$/);
const number = z.string().regex(/^PN[0-9a-fA-F]{32}$/);
const brand = z.string().regex(/^BN[0-9a-fA-F]{32}$/);
const campaign = z.string().regex(/^QE[0-9a-fA-F]{32}$/);
const tollfree = z.string().regex(/^HH[0-9a-fA-F]{32}$/);
const status = z.string().min(1).max(64);
/** Unknown registration is explicit; this configuration never provisions resources. */
export const configurationSchema = z.strictObject({
  scope: scopeSchema, connectionId: idSchema, accountSid: account, messagingServiceSid: service, phoneNumberSid: number,
  pluginDigest: digestSchema, admitted: z.boolean(),
  registration: z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("unknown") }), z.strictObject({ kind: z.literal("us_a2p"), brandSid: brand, campaignSid: campaign }), z.strictObject({ kind: z.literal("toll_free"), verificationSid: tollfree })]),
});
/** Two OM MCP tools. Sender resources are separate bounded observations, never a readiness verdict. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account_status"), connectionId: idSchema }),
  z.strictObject({ kind: z.literal("sender_status"), connectionId: idSchema, resource: z.enum(["service", "number", "brand", "campaign", "toll_free"]) }),
]);
/** Strict OM invocation boundary; assistant input cannot supply authority. */
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Canonical tool schemas consumed by host registration; importing performs no registration. */
export const twilioSmsTools = commandSchema.options.map(inputSchema => ({ name: "om_twilio_" + inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));
/** Provider additions are stripped; status remains an observation even for future vendor states. */
export const readDataSchema = z.union([
  z.object({ sid: account, status: z.enum(["active", "suspended", "closed"]), type: z.enum(["Trial", "Full"]) }),
  z.object({ sid: service, account_sid: account, use_inbound_webhook_on_number: z.boolean(), smart_encoding: z.boolean() }),
  z.object({ sid: number, account_sid: account, service_sid: service, capabilities: z.array(z.string().min(1).max(32)).max(16) }),
  z.object({ sid: brand, status }),
  z.object({ sid: campaign, account_sid: account, messaging_service_sid: service, brand_registration_sid: brand, campaign_status: status }),
  z.object({ sid: tollfree, account_sid: account, tollfree_phone_number_sid: number, status }),
]);

/** Encode only fixed GET endpoints from a parsed server binding. Missing registration has zero I/O.
 * @returns A URL or null when the requested registration is not configured. @complexity O(1).
 * @example encodeTwilioRead({ configuration, command: { kind: "account_status", connectionId } })
 */
export function encodeTwilioRead(required: { configuration: TwilioConfiguration; command: TwilioCommand }): string | null {
  const c = required.configuration;
  if (required.command.kind === "account_status") return `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}.json`;
  const base = "https://messaging.twilio.com/v1";
  switch (required.command.resource) {
    case "service": return `${base}/Services/${c.messagingServiceSid}`;
    case "number": return `${base}/Services/${c.messagingServiceSid}/PhoneNumbers/${c.phoneNumberSid}`;
    case "brand": return c.registration.kind === "us_a2p" ? `${base}/a2p/BrandRegistrations/${c.registration.brandSid}` : null;
    case "campaign": return c.registration.kind === "us_a2p" ? `${base}/Services/${c.messagingServiceSid}/Compliance/Usa2p/${c.registration.campaignSid}` : null;
    case "toll_free": return c.registration.kind === "toll_free" ? `${base}/Tollfree/Verifications/${c.registration.verificationSid}` : null;
    default: { const exhaustive: never = required.command.resource; return exhaustive; }
  }
}

/** Bind every consumed identifier to the configured resource, rejecting foreign data atomically.
 * Brand responses have no account SID; broker/gateway must establish configured brand ownership.
 * @returns A stripped read projection or protocol_mismatch. @complexity O(b), b<=64KiB.
 */
export function decodeTwilioRead(required: { configuration: TwilioConfiguration; command: TwilioCommand; input: unknown }): Outcome<TwilioReadData> {
  const c = required.configuration;
  const resource = required.command.kind === "account_status" ? "account" : required.command.resource;
  const bindings: Record<string, Record<string, string>> = {
    account: { sid: c.accountSid }, service: { sid: c.messagingServiceSid, account_sid: c.accountSid },
    number: { sid: c.phoneNumberSid, account_sid: c.accountSid, service_sid: c.messagingServiceSid },
    brand: { sid: c.registration.kind === "us_a2p" ? c.registration.brandSid : "" },
    campaign: { sid: c.registration.kind === "us_a2p" ? c.registration.campaignSid : "", account_sid: c.accountSid, messaging_service_sid: c.messagingServiceSid, brand_registration_sid: c.registration.kind === "us_a2p" ? c.registration.brandSid : "" },
    toll_free: { sid: c.registration.kind === "toll_free" ? c.registration.verificationSid : "", account_sid: c.accountSid, tollfree_phone_number_sid: c.phoneNumberSid },
  };
  const parsed = readDataSchema.safeParse(required.input);
  if (!parsed.success) return { ok: false, error: { code: "protocol_mismatch", message: "Invalid Twilio read response", retryable: false } };
  const data = parsed.data;
  const matches = Object.entries(bindings[resource]).every(([key, value]) => Reflect.get(data, key) === value);
  if (!matches) return { ok: false, error: { code: "protocol_mismatch", message: "Twilio resource binding mismatch", retryable: false } };
  return { ok: true, value: data };
}
