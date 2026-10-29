/** Pure add-on wire contracts. Hosts, credential resolution and dispatch live on the server. */
import { z } from "zod";
import { boundedJsonSchema, modelProtocolSchema, toolDescriptorSchema } from "../api/index.js";
import { decimalToMicros } from "../metrics/index.js";
import { effectCategorySchema } from "../capabilities/index.js";
import type { DailyLimitRequirement, MoneyExposure, PluginCapabilityDependencies } from "../capabilities/index.js";
import { digestSchema, epochSchema, idSchema, pageQuerySchema, parseBoundary } from "../values/index.js";
import type { CallContext, CallOptions, Outcome } from "../values/index.js";

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

/** Plugin discovery metadata follows the tool descriptor; connection-only tools must be read-only. */
export const pluginToolSchema = toolDescriptorSchema.extend({
 description: z.string().min(1).max(4096), connectionOnly: z.literal(true).optional(), unavailableReason: z.string().max(200).optional(),
}).refine(tool => !tool.connectionOnly || (tool.effects.length === 1 && tool.effects[0] === "read"));
export type PluginTool = z.infer<typeof pluginToolSchema>;
/** Per-call host identity and effect evidence; the declaration itself grants no authority. */
export type PluginToolInvocation = {
 context: CallContext; connection: { connectionId: string; accountId: string | null };
 name: string; operationId: string; input: unknown; moneyExposure: MoneyExposure | null; requiredLimit: DailyLimitRequirement | null;
};
/** Inert plugin factory; host effects and credentials remain scoped to one invocation. */
export type PluginToolsFactory = (required: PluginCapabilityDependencies) => {
 invoke(required: PluginToolInvocation, optional?: CallOptions): Promise<Outcome<unknown>>;
};

/** Produce JSON Schema discovery and a parser from the same Zod declarations, without effects.
 * Invalid declarations (including duplicate names or unrepresentable schemas) throw at definition.
 * parseTool returns fixed invalid_input errors for unknown names and invalid input.
 * @param required Zod tool declarations, including OM effect floors and optional discovery metadata.
 * @returns Validated descriptors and a parser that retains each original Zod schema.
 * @example definePluginTools({ tools: [{ name: "report", description: "Read reports", effects: ["read"], inputSchema: z.strictObject({}) }] })
 * @complexity Definition O(n + s) time/space for n tools and total schema size s; parsing is schema-dependent with O(1) name lookup.
 */
export function definePluginTools(required: {
 tools: readonly (Omit<PluginTool, "inputSchema"> & { inputSchema: z.ZodType })[];
}): { tools: PluginTool[]; parseTool(required: { name: string; input: unknown }): Outcome<unknown> } {
 const tools = required.tools.map(tool => pluginToolSchema.parse({ ...tool, inputSchema: z.toJSONSchema(tool.inputSchema, { io: "input" }) }));
 if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error("Duplicate plugin tool name");
 const schemas = new Map(required.tools.map(tool => [tool.name, tool.inputSchema]));
 return { tools, parseTool(required: { name: string; input: unknown }): Outcome<unknown> {
  const schema = schemas.get(required.name);
  if (!schema) return { ok: false, error: { code: "invalid_input", message: "Unknown plugin tool", retryable: false } };
  return parseBoundary({ schema, input: required.input });
 } };
}

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

const text = z.string().trim().min(1).max(512);
const name = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const httpsUrl = z.url().max(2048).refine(value => {
 if (!URL.canParse(value)) return false;
 const url = new URL(value);
 // URLSearchParams decodes names before credential aliases are checked.
 const secretQuery = [...url.searchParams.keys()].some(key => /^(key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|auth[_-]?token|authorization|auth|password|secret|token)$/i.test(key));
 return url.protocol === 'https:' && !url.username && !url.password && !url.hash && !secretQuery;
});
const origin = httpsUrl.refine(value => URL.canParse(value) && new URL(value).origin === value);
const assetPath = z.string().max(240).regex(/^io\.github\.ainsep\.openmarketing\/assets\/[A-Za-z0-9_-]+\.(svg|png|html|json)$/);
const field = z.strictObject({ name, label: text, hint: text.optional(), required: z.boolean().optional(), type: z.enum(['string', 'integer']).default('string') });
const secretField = field.omit({ type: true });
// Zod's scalar refinement ABI reuses exact nonnegative money validation; no price arithmetic here.
const modelPrice = z.string().max(32).refine(value => decimalToMicros({ value, rounding: 'reject' }).ok);
/** Data-only provider declaration. Request fragments are bounded JSON objects, not execution authority.
 * Absent pricing means unknown cost; observedOn records the price source's verification date.
 * @example modelProviderSchema.safeParse({ protocol: 'openai', endpoint: 'https://example.test', label: 'Example', models: [{ id: 'model', label: 'Model', efforts: [] }] })
 */
export const modelProviderSchema = z.strictObject({
 protocol: modelProtocolSchema, endpoint: origin, label: text,
 models: z.array(z.strictObject({
  id: idSchema, label: text,
  efforts: z.array(z.strictObject({ id: idSchema, label: text, request: boundedJsonSchema.pipe(z.record(z.string(), z.json())) })).max(8),
  pricing: z.strictObject({
   inputUsdPerMTok: modelPrice, outputUsdPerMTok: modelPrice,
   cachedInputUsdPerMTok: modelPrice.optional(), cacheWriteUsdPerMTok: z.record(idSchema, modelPrice).optional(),
   source: httpsUrl, observedOn: z.iso.date(),
  }).optional(),
 })).min(1).max(64),
});
export type ModelProvider = z.infer<typeof modelProviderSchema>;

/** Declarative mail discovery; contained module paths grant no execution authority.
 * @example mailAdapterDescriptorSchema.safeParse({ id: 'example-mail', label: 'Example mail', module: 'mail/index.mjs', credentialKeys: ['token'], feedback: true })
 */
export const mailAdapterDescriptorSchema = z.strictObject({
 id: idSchema, label: text, module: relativePathSchema.regex(/\.mjs$/),
 credentialKeys: z.array(name).min(1).max(8), feedback: z.boolean(),
});
export type MailAdapterDescriptor = z.infer<typeof mailAdapterDescriptorSchema>;
/** Parse mail declarations alongside other extension fields; sibling keys are accepted and stripped.
 * @example mailManifestExtensionSchema.safeParse({ enabled: false, mailAdapters: [] })
 */
export const mailManifestExtensionSchema = z.object({ mailAdapters: z.array(mailAdapterDescriptorSchema).max(16).optional() });
export type MailManifestExtension = z.infer<typeof mailManifestExtensionSchema>;

/** Owner mail selection and readiness; null explicitly clears a selection. */
export const mailProviderSelectionSchema = z.strictObject({
 selected: idSchema.nullable(),
 /** Owner-set From address, syntax-checked only (not verified).
  * Null clears to the manifest alertFrom default; omitted = unchanged. */
 alertFrom: z.email().max(254).nullable().optional(),
});
export const mailProviderSettingsSchema = mailProviderSelectionSchema.extend({ candidates: z.array(z.strictObject({
    pluginId: idSchema, label: z.string().min(1).max(200), status: z.enum(['connected', 'not_connected']),
})).max(1000) });
export type MailProviderSelection = z.infer<typeof mailProviderSelectionSchema>;
export type MailProviderSettings = z.infer<typeof mailProviderSettingsSchema>;
/** Declarative credential forms; declarations confer no authority or storage access.
 * Zod callbacks retain its foreign value/context ABI, matching the server's card validation.
 */
export const cardSchema = z.strictObject({
 target: idSchema, title: text, label: text, category: text, intro: text,
 usedFor: z.array(z.string().min(1).max(120)).max(8), keyHint: text.optional(),
 helpUrl: httpsUrl, helpLabel: text, baseUrl: origin, probeUrl: httpsUrl.optional(),
 additionalHosts: z.array(origin).max(8).optional(), fields: z.array(field).max(16).optional(),
 secretFields: z.array(secretField).max(16).optional(),
 saveKind: z.enum(['oauth', 'oauth-client', 'api-key',
  'app-credentials', 'plugin-secret']),
 saveTarget: idSchema.optional(), permissions: z.array(z.string().min(1).max(120)).max(16).optional(), icon: assetPath.optional(),
}).superRefine((card, ctx) => {
 const fields = [...(card.fields ?? []), ...(card.secretFields ?? [])];
 if (fields.length > 16 || new Set(fields.map(entry => entry.name)).size !== fields.length) ctx.addIssue({ code: 'custom', message: 'Invalid fields' });
 if (card.probeUrl && URL.canParse(card.probeUrl) && new URL(card.probeUrl).origin !== card.baseUrl) ctx.addIssue({ code: 'custom', message: 'Invalid probe origin' });
 if (card.saveKind === 'api-key' && (fields.length !== 1 || fields[0].name !== 'token' || !card.secretFields?.[0]?.required)) ctx.addIssue({ code: 'custom', message: 'Token requires a password field' });
});
/** Host-bound public card metadata; icon digests verify corruption only. */
export const credentialCardSchema = cardSchema.safeExtend({ pluginId: idSchema, actionSupported: z.boolean(), iconDigest: digestSchema.optional() });
export type CredentialCard = z.infer<typeof credentialCardSchema>;
/** Secret-free integration status and host-bound cards. */
export const credentialPluginStatusSchema = z.strictObject({
 configured: z.boolean(), clientId: z.string().min(1).max(2048).optional(), guidance: text.optional(),
 credentialCards: z.array(credentialCardSchema).max(32), connections: z.array(integrationSummarySchema).max(100),
 connectionsCursor: idSchema.nullable(),
});

/** Owner ingress only: the host binds secret access to the executing plugin, never tool input. */
export const pluginSecretQuerySchema = z.strictObject({ pluginId: idSchema });
export type PluginSecretQuery = z.infer<typeof pluginSecretQuerySchema>;
/** Named declared fields; null removes the plugin's sealed record. */
export const pluginSecretSetSchema = pluginSecretQuerySchema.extend({ values: z.record(name, z.string().min(1).max(8192)).nullable() });
export type PluginSecretSet = z.infer<typeof pluginSecretSetSchema>;
/** Status never includes secret values. */
export const pluginSecretStatusSchema = z.strictObject({ configured: z.boolean() });
export type PluginSecretStatus = z.infer<typeof pluginSecretStatusSchema>;

/** Plugin-declared, non-secret conversion settings; declarations grant no authority. */
export const conversionSettingsDeclarationSchema = z.strictObject({ fields: z.array(z.strictObject({ name, label: text, hint: text.optional(), kind: z.enum(['string', 'string-map']), format: z.enum(['decimal-id', 'code']) })).min(1).max(8)
 .refine(fields => new Set(fields.map(field => field.name)).size === fields.length) });
export type ConversionSettingsDeclaration = z.infer<typeof conversionSettingsDeclarationSchema>;
export const conversionSettingsValuesSchema = z.record(name, z.union([z.string().min(1).max(128), z.record(idSchema, z.string().min(1).max(128))]));
export type ConversionSettingsValues = z.infer<typeof conversionSettingsValuesSchema>;
export const setConversionSettingsSchema = z.strictObject({ pluginId: idSchema, values: conversionSettingsValuesSchema });
export type SetConversionSettings = z.infer<typeof setConversionSettingsSchema>;
export const conversionSettingsStatusSchema = z.strictObject({ pluginId: idSchema, declaration: conversionSettingsDeclarationSchema.nullable(), values: conversionSettingsValuesSchema.nullable() });
export type ConversionSettingsStatus = z.infer<typeof conversionSettingsStatusSchema>;

/** Secret-free OAuth wire replies; hosts may apply stricter browser display checks. */
export const oauthClientStatusSchema = z.union([z.strictObject({ configured: z.literal(false), guidance: z.string().max(512).optional() }), z.strictObject({ configured: z.literal(true), clientId: z.string().min(1).max(2048), guidance: z.string().max(512).optional() })]);
export const oauthStatusSchema = z.union([z.strictObject({ status: z.enum(['pending', 'complete', 'expired']), connection: integrationSummarySchema.optional() }), oauthClientStatusSchema]);
export const oauthChallengeSchema = z.strictObject({ transactionId: idSchema, authorizationUrl: z.url().max(4096), expiresAt: epochSchema });
/** Asset addresses expose only the server's digest route; digest checks corruption, not admission. */
const chartAssetUrlSchema = z.string().max(2048).regex(/^\/api\/addons\/v1\/chart-assets\/[a-f0-9]{64}\/[A-Za-z0-9_.-]+$/);
export const chartProviderDescriptorSchema = z.strictObject({ id: idSchema, pluginId: idSchema, version: idSchema, digest: digestSchema, contractVersion: z.literal(1), kinds: z.array(idSchema).min(1).max(100), javascript: chartAssetUrlSchema, stylesheet: chartAssetUrlSchema.optional() });
export type ChartProviderDescriptor = z.infer<typeof chartProviderDescriptorSchema>;
export const chartProviderListSchema = z.strictObject({ providers: z.array(chartProviderDescriptorSchema).max(100) });
export type ChartProviderList = z.infer<typeof chartProviderListSchema>;
