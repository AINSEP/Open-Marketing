import { z } from "zod";
import { appErrorSchema, callContextSchema, idSchema, scopeSchema } from "@open-marketing/contracts";

/** Canonical global identity; owner-qualified authorization remains unchanged. */
export const workspaceIdSchema = z.uuid().toLowerCase();
export const workspaceScopeSchema = scopeSchema.extend({ workspaceId: workspaceIdSchema });
const workspaceContextSchema = callContextSchema.extend({ scope: workspaceScopeSchema });

/** Strict, bounded values at the identity/repository boundary. */
export const sessionSchema = z.strictObject({ sessionId: idSchema });
export const identitySchema = z.strictObject({ ownerId: idSchema, sessionId: idSchema });
export const bindingSchema = z.strictObject({ id: idSchema, scope: workspaceScopeSchema, connectionId: idSchema, externalAccountId: idSchema });
export const resolveSchema = z.strictObject({ session: sessionSchema, workspaceId: workspaceIdSchema });
export const bindSchema = z.strictObject({ context: workspaceContextSchema, binding: bindingSchema });
export const findSchema = z.strictObject({ context: workspaceContextSchema, externalAccountId: idSchema });
/** Parse adapter outcomes too: a TypeScript interface does not make I/O trusted. */
export function outcomeSchema<T>(required: { value: z.ZodType<T> }) {
  return z.discriminatedUnion("ok", [z.strictObject({ ok: z.literal(true), value: required.value }), z.strictObject({ ok: z.literal(false), error: appErrorSchema })]);
}
