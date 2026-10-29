import { z } from "zod";
import { callContextSchema, idSchema, pluginConfigurationSchema } from "@open-marketing/contracts";
import type { Outcome } from "@open-marketing/contracts";
import type { TwilioCommand, TwilioReadData } from "./ports.js";
import type { Credential } from "./transport.js";

const account = z.string().regex(/^AC[0-9a-fA-F]{32}$/);
const service = z.string().regex(/^MG[0-9a-fA-F]{32}$/);
const number = z.string().regex(/^PN[0-9a-fA-F]{32}$/);
const brand = z.string().regex(/^BN[0-9a-fA-F]{32}$/);
const campaign = z.string().regex(/^QE[0-9a-fA-F]{32}$/);
const tollfree = z.string().regex(/^HH[0-9a-fA-F]{32}$/);
const status = z.string().min(1).max(64);
/** Host account binding; sender/registration selectors belong to the credential card. */
export const configurationSchema = pluginConfigurationSchema.extend({ accountId: account });
/** Two OM MCP tools. Sender resources are separate bounded observations, never a readiness verdict. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account_status") }),
  z.strictObject({ kind: z.literal("sender_status"), resource: z.enum(["service", "number", "brand", "campaign", "toll_free"]) }),
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

/** Encode fixed GET endpoints from this call's credential. Missing selectors have zero vendor I/O.
 * @returns A URL or null when a required resource selector is absent. @complexity O(1).
 * @example encodeTwilioRead({ credential, command: { kind: "account_status" } })
 */
export function encodeTwilioRead(required: { credential: Credential; command: TwilioCommand }): string | null {
  const c = required.credential;
  if (required.command.kind === "account_status") return `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}.json`;
  const base = "https://messaging.twilio.com/v1";
  const resources = {
    service: { selectors: [c.messagingServiceSid], url: `${base}/Services/${c.messagingServiceSid}` },
    number: { selectors: [c.messagingServiceSid, c.phoneNumberSid], url: `${base}/Services/${c.messagingServiceSid}/PhoneNumbers/${c.phoneNumberSid}` },
    brand: { selectors: [c.brandSid], url: `${base}/a2p/BrandRegistrations/${c.brandSid}` },
    campaign: { selectors: [c.messagingServiceSid, c.brandSid, c.campaignSid], url: `${base}/Services/${c.messagingServiceSid}/Compliance/Usa2p/${c.campaignSid}` },
    toll_free: { selectors: [c.phoneNumberSid, c.tollfreeVerificationSid], url: `${base}/Tollfree/Verifications/${c.tollfreeVerificationSid}` },
  };
  const resource = resources[required.command.resource];
  return resource.selectors.every(Boolean) ? resource.url : null;
}

/** Bind every consumed identifier to the credential resource, rejecting foreign data atomically.
 * Brand responses have no account SID; broker/gateway must establish credential brand ownership.
 * @returns A stripped read projection or protocol_mismatch. @complexity O(b), b<=64KiB.
 */
export function decodeTwilioRead(required: { credential: Credential; command: TwilioCommand; input: unknown }): Outcome<TwilioReadData> {
  const c = required.credential;
  const resource = required.command.kind === "account_status" ? "account" : required.command.resource;
  const bindings: Record<string, Record<string, string | undefined>> = {
    account: { sid: c.accountSid }, service: { sid: c.messagingServiceSid, account_sid: c.accountSid },
    number: { sid: c.phoneNumberSid, account_sid: c.accountSid, service_sid: c.messagingServiceSid },
    brand: { sid: c.brandSid },
    campaign: { sid: c.campaignSid, account_sid: c.accountSid, messaging_service_sid: c.messagingServiceSid, brand_registration_sid: c.brandSid },
    toll_free: { sid: c.tollfreeVerificationSid, account_sid: c.accountSid, tollfree_phone_number_sid: c.phoneNumberSid },
  };
  const parsed = readDataSchema.safeParse(required.input);
  if (!parsed.success) return { ok: false, error: { code: "protocol_mismatch", message: "Invalid Twilio read response", retryable: false } };
  const data = parsed.data;
  const matches = Object.entries(bindings[resource]).every(([key, value]) => Reflect.get(data, key) === value);
  if (!matches) return { ok: false, error: { code: "protocol_mismatch", message: "Twilio resource binding mismatch", retryable: false } };
  return { ok: true, value: data };
}
