import { createHash } from "node:crypto";
import { z } from "zod";
import { callContextSchema, idSchema } from "@open-marketing/contracts";
import type { ResendEmailRequest } from "./ports.js";

const vendorId = z.uuid();
/** A single bounded page or domain detail. Lists never establish sending readiness. */
export const domainCommandSchema = z.strictObject({ kind: z.literal("domain_status"), domainId: vendorId.optional(), after: vendorId.optional(), limit: z.number().int().min(1).max(100).default(100) })
  .refine(value => !value.domainId || !value.after);
/** Read-only command boundary. Sending is deferred and fails validation. */
export const commandSchema = domainCommandSchema;
export type ResendCommand = z.infer<typeof commandSchema>;
/** Strict invocation envelope; unknown authority fields fail closed. */
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: commandSchema });
/** Reads only; no send tool or resolved-recipient schema is exposed. */
export const resendEmailTools = [
  { name: "domain_status", description: "Read Resend domain status and DNS records.", effects: ["read"], schema: domainCommandSchema },
] as const;
/** SHA-256 over JSON bytes for scope and exact read-request binding. No I/O. @complexity O(b).
 * @example resendEmailDigest({ value: request }) */
export function resendEmailDigest(required: { value: unknown }): string { return createHash("sha256").update(JSON.stringify(required.value)).digest("hex"); }
/** Pure domain mapping; paths contain only schema-validated UUIDs and bounded limits.
 * @complexity O(1), no user-controlled headers or vendor URLs.
 * @example encodeResendCommand({ command }) */
export function encodeResendCommand(required: { command: ResendCommand }): ResendEmailRequest {
  const command = required.command;
  if (command.domainId) return { method: "GET", path: "/domains/" + command.domainId };
  return { method: "GET", path: "/domains?limit=" + command.limit + (command.after ? "&after=" + command.after : "") };
}
const boundedText = z.string().max(2048);
/** Provider projections strip additions; unknown states and missing flags cannot establish readiness. */
export const domainSchema = z.object({ id: vendorId, name: z.string().min(1).max(253), status: boundedText,
  open_tracking: z.boolean().optional(), click_tracking: z.boolean().optional(), capabilities: z.object({ sending: boundedText }).optional(),
  records: z.array(z.object({ record: boundedText, name: boundedText, type: z.enum(["TXT", "MX", "CNAME"]), value: boundedText,
    status: boundedText, ttl: z.union([z.number().int().nonnegative(), z.literal("Auto")]), priority: z.number().int().nonnegative().optional() })).max(32).optional() });
export type ResendDomain = z.infer<typeof domainSchema>;
