import { z } from "zod";
import { callContextSchema, idSchema, pluginConfigurationSchema } from "@open-marketing/contracts";

/** Meta IDs remain decimal strings, including IDs beyond safe JS integer precision. */
export const vendorIdSchema = z.string().regex(/^[1-9][0-9]{0,31}$/);
export const configurationSchema = pluginConfigurationSchema.extend({ accountId: vendorIdSchema });
const cursor = z.string().min(1).max(2048).regex(/^[\x21-\x7e]+$/);
const page = { limit: z.number().int().min(1).max(100).default(100), after: cursor.optional() };
/** Closed read surface: no URL, token, raw destination, write or account overrides. */
export const whatsappReadCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("get_account_status") }),
  z.strictObject({ kind: z.literal("list_senders"), ...page }),
  z.strictObject({ kind: z.literal("list_templates"), ...page }),
]);
export type WhatsAppReadCommand = z.input<typeof whatsappReadCommandSchema>;
export const invocationSchema = z.strictObject({ context: callContextSchema, operationId: idSchema, command: whatsappReadCommandSchema });
/** Catalog data only; registration and admission belong to the server. */
export const whatsappBusinessTools = whatsappReadCommandSchema.options.map(inputSchema => ({ name: inputSchema.shape.kind.value, inputSchema, effect: "read" as const }));
const text = z.string().min(1).max(256);
// Strip unrequested provider fields. Unknown status strings stay visible without inventing tiers.
export const accountSchema = z.object({ id: vendorIdSchema, name: text.optional(), business_verification_status: text.optional(), account_review_status: text.optional() });
const senderSchema = z.object({ id: vendorIdSchema, display_phone_number: text.optional(), verified_name: text.optional(), quality_rating: text.optional(), name_status: text.optional(), code_verification_status: text.optional(), messaging_limit_tier: text.optional() });
const templateSchema = z.object({ id: vendorIdSchema, name: text, language: text, status: text, category: text });
const paging = z.object({ cursors: z.object({ after: cursor.optional() }).optional(), next: z.string().min(1).max(8192).optional() }).refine(value => value.next === undefined || value.cursors?.after !== undefined);
export const sendersSchema = z.object({ data: z.array(senderSchema).max(100), paging: paging.optional() });
export const templatesSchema = z.object({ data: z.array(templateSchema).max(100), paging: paging.optional() });
/** Only a continuation cursor leaves the boundary; provider next URLs are discarded. */
export type WhatsAppReadData = z.infer<typeof accountSchema> | { items: readonly z.infer<typeof senderSchema>[] | readonly z.infer<typeof templateSchema>[]; cursor: string | null };
