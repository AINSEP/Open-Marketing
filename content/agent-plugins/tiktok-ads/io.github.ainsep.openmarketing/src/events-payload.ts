import { z } from "zod";
import { digestSchema, epochSchema, idSchema } from "@open-marketing/contracts";
import { tiktokUrlSchema } from "./commands.js";

/** Contacts alone normalizes/hashes identifiers; page URL is captured metadata, never fetched.
 * Projection drops unknown identifier keys; the final payload rejects raw/uppercase digests and extra fields.
 */
const userSchema = z.strictObject({ email: digestSchema.optional(), phone: digestSchema.optional(), external_id: digestSchema.optional() }).refine(value => value.email !== undefined || value.phone !== undefined || value.external_id !== undefined);
/** One web event per POST. Unix seconds and the original event ID survive channel deduplication. */
export const tiktokEventsPayloadSchema = z.strictObject({ event_source: z.literal("web"), event_source_id: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/), data: z.array(z.strictObject({ event: z.enum(["CompleteRegistration", "StartTrial"]), event_time: epochSchema, event_id: idSchema, user: userSchema, page: z.strictObject({ url: tiktokUrlSchema }), properties: z.strictObject({ value: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/) }).optional() })).length(1) });
export type TikTokEventsPayload = z.infer<typeof tiktokEventsPayloadSchema>;
