/** Pure add-on wire contracts. Hosts, credential resolution and dispatch live on the server. */
import { z } from "zod";
import { boundedJsonSchema } from "../api/index.js";
import { effectCategorySchema } from "../capabilities/index.js";
import { digestSchema, idSchema, pageQuerySchema } from "../values/index.js";

export const addonKindSchema = z.enum(["plugin", "agent-plugin", "skill"]);
export type AddonKind = z.infer<typeof addonKindSchema>;
/** Activation is operator-owned. Installation alone never implies enabled. */
export const addonSummarySchema = z.strictObject({ id: idSchema, kind: addonKindSchema, name: z.string().min(1).max(200), description: z.string().max(4096), version: idSchema, enabled: z.boolean(), revision: idSchema });
export type AddonSummary = z.infer<typeof addonSummarySchema>;
export const addonListRequestSchema = pageQuerySchema.extend({ kind: addonKindSchema.optional() });
export type AddonListRequest = z.infer<typeof addonListRequestSchema>;
export const addonListSchema = z.strictObject({ items: z.array(addonSummarySchema).max(100), cursor: idSchema.nullable() });
export type AddonList = z.infer<typeof addonListSchema>;
export const setAddonEnabledSchema = z.strictObject({ kind: addonKindSchema, id: idSchema, enabled: z.boolean() });
export type SetAddonEnabled = z.infer<typeof setAddonEnabledSchema>;
export const uninstallAddonSchema = z.strictObject({ kind: addonKindSchema, id: idSchema });
export type UninstallAddon = z.infer<typeof uninstallAddonSchema>;
export const addonUninstallReceiptSchema = z.strictObject({ kind: addonKindSchema, id: idSchema, removed: z.literal(true) });
export type AddonUninstallReceipt = z.infer<typeof addonUninstallReceiptSchema>;

const relativePathSchema = z.string().min(1).max(1024).regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[^\\:\x00-\x1f]+$/)
 .refine(path => !path.startsWith("/") && !path.endsWith("/") && !path.includes("//"));
const uploadBytes = z.string().max(44739244).regex(/^[A-Za-z0-9+/]*={0,2}$/)
 .refine(base64 => base64.length % 4 === 0);

/** Base64 is validated before this pure byte count. No decoding or filesystem access occurs.
 * @complexity O(1) time and space for a single validated base64 string.
 */
function decodedBytes(required: { base64: string }): number {
 const padding = required.base64.endsWith("==") ? 2 : Number(required.base64.endsWith("="));
 return required.base64.length / 4 * 3 - padding;
}

/** One upload flow: ZIP bytes or relative folder files. Aggregate decoded cap is 32 MiB.
 * The HTTP host must also enforce the 48 MiB JSON ingress cap and Jini's stricter format caps.
 * @example addonUploadSchema.safeParse({ kind: "files", files: [{ path: "SKILL.md", base64: "YQ==" }] })
 */
export const addonUploadSchema = z.discriminatedUnion("kind", [
 z.strictObject({ kind: z.literal("zip"), base64: uploadBytes.min(1) }),
 z.strictObject({ kind: z.literal("files"), files: z.array(z.strictObject({ path: relativePathSchema, base64: uploadBytes })).min(1).max(4096) }),
]).refine(upload => {
 if (upload.kind === "zip") return decodedBytes({ base64: upload.base64 }) <= 33554432;
 return upload.files.reduce((total, file) => total + decodedBytes({ base64: file.base64 }), 0) <= 33554432;
}, "Upload exceeds 32 MiB decoded");
export type AddonUpload = z.infer<typeof addonUploadSchema>;
export const installAddonSchema = z.strictObject({ kind: addonKindSchema.optional(), upload: addonUploadSchema });
export type InstallAddon = z.infer<typeof installAddonSchema>;

/** Preserve known effects, including ad_spend, and map unknown/missing/empty effects to write.
 * Zod union order matters: a mixed [ad_spend, future_effect] must retain financial authority.
 */
export const addonToolEffectsSchema = z.array(z.union([effectCategorySchema, z.string().min(1).max(100).transform(() => "write" as const)]))
 .max(10).nullish().transform(effects => effects?.length ? effects : ["write" as const]);
/** Secret-free discovery metadata; revision and activation are rechecked at invocation.
 * @example addonToolSourceSchema.safeParse({ id: "s", kind: "plugin", addonId: "p", name: "report", description: "Read a report", inputSchema: {}, revision: "r1", effects: ["read"] })
 */
export const addonToolSourceSchema = z.strictObject({ id: idSchema, kind: addonKindSchema, addonId: idSchema, name: idSchema, description: z.string().max(4096), inputSchema: boundedJsonSchema.pipe(z.record(z.string(), z.json())), revision: idSchema, effects: addonToolEffectsSchema });
export type AddonToolSource = z.infer<typeof addonToolSourceSchema>;

/** Public connection status is saved/reconnect_required/disconnected; no verification probe exists. */
export const integrationSummarySchema = z.strictObject({ connectionId: idSchema, pluginId: idSchema, status: z.enum(["saved", "reconnect_required", "disconnected"]) });
export type IntegrationSummary = z.infer<typeof integrationSummarySchema>;
export const integrationListSchema = z.strictObject({ items: z.array(integrationSummarySchema).max(100), cursor: idSchema.nullable() });
export type IntegrationList = z.infer<typeof integrationListSchema>;
/** Owner HTTP or CLI stdin only. Never use this schema as a chat tool's input. */
export const connectIntegrationTokenSchema = z.strictObject({ connectionId: idSchema, pluginId: idSchema, plaintext: z.string().min(1).max(65536) });
export type ConnectIntegrationToken = z.infer<typeof connectIntegrationTokenSchema>;
export const disconnectIntegrationSchema = z.strictObject({ connectionId: idSchema });
export type DisconnectIntegration = z.infer<typeof disconnectIntegrationSchema>;

/** Asset addresses expose only the server's digest route; digest checks corruption, not admission. */
const chartAssetUrlSchema = z.string().max(2048).regex(/^\/api\/addons\/v1\/chart-assets\/[a-f0-9]{64}\/[A-Za-z0-9_.-]+$/);
export const chartProviderDescriptorSchema = z.strictObject({ id: idSchema, pluginId: idSchema, version: idSchema, digest: digestSchema, contractVersion: z.literal(1), kinds: z.array(idSchema).min(1).max(100), javascript: chartAssetUrlSchema, stylesheet: chartAssetUrlSchema.optional() });
export type ChartProviderDescriptor = z.infer<typeof chartProviderDescriptorSchema>;
export const chartProviderListSchema = z.strictObject({ providers: z.array(chartProviderDescriptorSchema).max(100) });
export type ChartProviderList = z.infer<typeof chartProviderListSchema>;
