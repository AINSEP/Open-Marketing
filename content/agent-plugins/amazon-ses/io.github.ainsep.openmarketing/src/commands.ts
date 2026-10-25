import { z } from "zod";
import { callContextSchema, digestSchema, idSchema, scopeSchema } from "@open-marketing/contracts";

/** Fixed regional AWS host construction excludes URLs, China and custom endpoints. */
const regionSchema = z.string().max(64).regex(/^(?:us|eu|ap|sa|ca|me|af|il|mx)-(?:[a-z]{2,12}-){1,2}[1-9][0-9]?$/);
const domainSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/);
/** Paste this JSON bundle into the owner-only sealed integration token. Never use root keys.
 * AKIA identifies long-lived credentials; it cannot prove that the principal is an IAM user.
 */
export const sesCredentialSchema = z.strictObject({
  accessKeyId: z.string().regex(/^AKIA[A-Z0-9]{16}$/),
  secretAccessKey: z.string().regex(/^[A-Za-z0-9/+=]{40}$/), region: regionSchema,
});
export type SesCredentials = z.infer<typeof sesCredentialSchema>;
/** Read-only, closed commands; the domain is bound by server configuration. */
export const commandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("account_status") }),
  z.strictObject({ kind: z.literal("domain_identity_status") }),
]);
export type SesCommand = z.infer<typeof commandSchema>;
export const configurationSchema = z.strictObject({ scope: scopeSchema, connectionId: idSchema,
  region: regionSchema, domainIdentity: domainSchema, pluginDigest: digestSchema, bindingId: idSchema });
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
const count = z.number().finite().nonnegative();
const status = z.string().min(1).max(64);
/** Provider objects strip unconsumed fields, including account contacts and IAM policies. */
export const accountSchema = z.object({ SendingEnabled: z.boolean(), ProductionAccessEnabled: z.boolean(),
  SendQuota: z.object({ Max24HourSend: z.union([count, z.literal(-1)]), MaxSendRate: count, SentLast24Hours: count }),
  PricingAttributes: z.object({ CurrentPlan: status.optional(), NextPlan: status.optional() }).optional() });
export const identitySchema = z.object({ IdentityType: status, VerifiedForSendingStatus: z.boolean(),
  VerificationStatus: status.optional(), DkimAttributes: z.object({ SigningEnabled: z.boolean(), Status: status,
    Tokens: z.array(z.string().regex(/^[a-z0-9]{1,64}$/)).max(10).optional() }).optional() });
/** Daily maximum retains AWS's -1 sentinel; remaining quota uses "unlimited" for that case. */
export type SesData =
  | { kind: "account_status"; sendingEnabled: boolean; productionAccessEnabled: boolean;
      quota: { max24HourSend: number; maxSendRate: number; sentLast24Hours: number; remaining24HourSend: number | "unlimited" };
      currentPlan: string | null; nextPlan: string | null }
  | { kind: "domain_identity_status"; domainIdentity: string; verifiedForSending: boolean;
      verificationStatus: string; dkimStatus: string; dkimSigningEnabled: boolean; dkimTokens: readonly string[]; domainReady: boolean };
export const amazonSesTools = [
  { name: "account_status", description: "Read regional SES sending access, quota and pricing plan.", effect: "read", capabilityId: "email.account-read.v1" },
  { name: "domain_identity_status", description: "Read the configured domain verification and DKIM status.", effect: "read", capabilityId: "email.identity-read.v1" },
] as const;
