import { z } from "zod";
import { appErrorSchema, callContextSchema, idSchema, scopeSchema } from "@open-marketing/contracts";

/** Strict, bounded values at the identity/repository boundary. */
export const sessionSchema = z.strictObject({ sessionId: idSchema });
export const identitySchema = z.strictObject({ ownerId: idSchema, sessionId: idSchema });
export const bindingSchema = z.strictObject({ id: idSchema, scope: scopeSchema, connectionId: idSchema, externalAccountId: idSchema });
export const resolveSchema = z.strictObject({ session: sessionSchema, workspaceId: idSchema });
export const bindSchema = z.strictObject({ context: callContextSchema, binding: bindingSchema });
export const findSchema = z.strictObject({ context: callContextSchema, externalAccountId: idSchema });
/** Parse adapter outcomes too: a TypeScript interface does not make I/O trusted. */
export function outcomeSchema<T>(required: { value: z.ZodType<T> }) {
  return z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: required.value }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
}
