import { z } from "zod";
import { callContextSchema, digestSchema, idSchema } from "@open-marketing/contracts";

/** Pinned local source; no network or environment expansion. */
export const sourceSchema = z.strictObject({
  kind: z.enum(["archive", "directory"]), location: z.string().min(1).max(4096).regex(/^[^\u0000-\u001f]+$/), expectedDigest: digestSchema,
});
/** Metadata contains catalog admission only, never execution grants. */
export const installedSchema = z.strictObject({ pluginId: idSchema, version: z.string().max(65536), digest: digestSchema, enabled: z.boolean(), admitted: z.boolean(), schemaFingerprint: digestSchema.optional() });
export const installSchema = z.strictObject({ context: callContextSchema, source: sourceSchema });
export const enableSchema = z.strictObject({ context: callContextSchema, pluginId: idSchema, enabled: z.boolean() });
export const referenceSchema = z.strictObject({ pluginId: idSchema, digest: digestSchema });
export const removeSchema = z.strictObject({ context: callContextSchema, pluginId: idSchema });
