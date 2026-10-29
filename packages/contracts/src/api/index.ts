import { z } from "zod";
import { appErrorSchema, digestSchema, epochSchema, idSchema } from "../values/index.js";
import { effectCategorySchema } from "../capabilities/index.js";
import { metricValuesSchema } from "../metrics/index.js";
export const navigationTargetSchema = z.enum(["workspaces", "creative", "media-library", "campaigns", "measure", "connections", "plugins", "activity", "settings"]);
export const navigationActionSchema = z.strictObject({ kind: z.literal("navigate"), actionId: idSchema, target: navigationTargetSchema });
export const navigationResultSchema = z.discriminatedUnion("status", [
 z.strictObject({ status: z.literal("requested"), actionId: idSchema }), z.strictObject({ status: z.literal("pending"), actionId: idSchema }),
 z.strictObject({ status: z.literal("completed"), actionId: idSchema, target: navigationTargetSchema }), z.strictObject({ status: z.literal("failed"), actionId: idSchema, error: appErrorSchema }),
]);
export type NavigationTarget = z.infer<typeof navigationTargetSchema>;
export type NavigationAction = z.infer<typeof navigationActionSchema>;
export type NavigationResult = z.infer<typeof navigationResultSchema>;
export const approvalChoiceSchema = z.enum(["allow", "allow_chat", "always_allow", "cancel"]);
export const confirmationCardSchema = z.strictObject({ cardId: idSchema, operationId: idSchema, argumentsDigest: digestSchema, arguments: z.record(z.string(), z.json()), allowedChoices: z.array(approvalChoiceSchema).min(1).max(4), expiresAt: epochSchema, classification: z.enum(["write", "destructive", "spend", "generation"]) });
export const approvalResponseSchema = z.strictObject({ cardId: idSchema, operationId: idSchema, argumentsDigest: digestSchema, choice: approvalChoiceSchema });
export type ConfirmationCard = z.infer<typeof confirmationCardSchema>;
export type ApprovalResponse = z.infer<typeof approvalResponseSchema>;
export const mcpRequestSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([idSchema, z.number().int()]), method: z.enum(["initialize", "tools/list", "tools/call", "resources/list", "resources/read"]), params: z.record(z.string(), z.json()).default({}) });
export type OmMcpRequest = z.infer<typeof mcpRequestSchema>;
const micros = metricValuesSchema.shape.spend.unwrap().unwrap();
/** Flat usage projection. USD as canonical integer micros strings; absent money is unknown, never zero. */
export const assistantUsageSchema = z.strictObject({ kind: z.literal('usage'), inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), costUsdMicros: micros.optional(), durationMs: z.number().nonnegative().optional(), totalCostUsdMicros: micros.optional(), complete: z.boolean(), costBasis: z.enum(['estimated', 'unavailable']) });
export type AssistantUsage = z.infer<typeof assistantUsageSchema>;
export const assistantProviderSchema = idSchema;
export type AssistantProvider = z.infer<typeof assistantProviderSchema>;
/** Wire protocol supplied by the server from the selected provider declaration. */
export const modelProtocolSchema = z.enum(['anthropic', 'openai', 'google', 'azure']);
export type ModelProtocol = z.infer<typeof modelProtocolSchema>;
const reasoningOptionSchema = z.strictObject({ id: idSchema, label: z.string().min(1).max(80) });
const assistantModelSchema = z.strictObject({ id: idSchema, label: z.string().min(1).max(80), reasoning: z.array(reasoningOptionSchema).max(8).optional() });
export const assistantRuntimeSchema = z.strictObject({ id: assistantProviderSchema, name: z.string().max(80), available: z.boolean(), authStatus: z.enum(['ok', 'missing', 'unknown']), models: z.array(assistantModelSchema).max(64), reasoningOptions: z.array(reasoningOptionSchema).max(8), diagnostic: z.string().max(200).optional() });
export const chatMessageSchema = z.strictObject({ id: idSchema, role: z.enum(["user", "assistant"]), text: z.string().max(65536), usage: assistantUsageSchema.optional(), createdAt: epochSchema.optional(), startedAt: epochSchema.optional(), endedAt: epochSchema.optional() });
export type ChatMessage = z.infer<typeof chatMessageSchema>;

/** Additive Studio routes; legacy navigation and exhaustive snapshot records stay unchanged. */
export const addonNavigationTargetSchema = z.enum(["/addons/plugins", "/addons/agent-plugins", "/addons/skills", "/addons/integrations"]);
export type AddonNavigationTarget = z.infer<typeof addonNavigationTargetSchema>;
export const studioNavigationTargetSchema = z.union([navigationTargetSchema, addonNavigationTargetSchema]);
export type StudioNavigationTarget = z.infer<typeof studioNavigationTargetSchema>;

/** Reject excessive nesting before Zod's recursive JSON parser, including cyclic inputs.
 * Pure schema guard; returns false beyond depth 16, without mutating the input.
 * @complexity O(n) values visited, O(16) stack; ingress byte bounds belong to the transport.
 */
function boundedJsonDepth(required: { value: unknown; depth: number }): boolean {
 if (required.depth > 16) return false;
 if (typeof required.value !== "object" || required.value === null) return true;
 return Object.values(required.value).every(value => boundedJsonDepth({ value, depth: required.depth + 1 }));
}

/** JSON wire data: depth <=16 and at most 64 KiB serialized UTF-8, including keys.
 * Zod refinement callbacks use its foreign scalar ABI; no I/O or secret filtering occurs here.
 * @example boundedJsonSchema.safeParse({ query: "campaigns" })
 */
export const boundedJsonSchema = z.unknown()
 .refine(value => boundedJsonDepth({ value, depth: 0 }), "JSON nesting exceeds 16")
 .pipe(z.json())
 .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 65536, "JSON exceeds 64 KiB");

/** Saved assistant selection. Keys are held by the server; this contains only a connection ID. */
export const assistantSettingsSchema = z.strictObject({ mode: z.enum(["sandbox", "model"]), model: idSchema, connectionId: idSchema.nullable(), provider: assistantProviderSchema.optional(), effort: idSchema.optional() });
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>;
/** Server-configured model choices; optional for compatibility with existing settings responses. */
export const assistantSettingsStatusSchema = z.strictObject({ settings: assistantSettingsSchema, ready: z.boolean(), status: z.enum(["sandbox", "ready", "reconnect_required", "disconnected", "unavailable"]), models: z.array(assistantModelSchema).max(64).optional(), runtimes: z.array(assistantRuntimeSchema).max(32).optional() });
export type AssistantSettingsStatus = z.infer<typeof assistantSettingsStatusSchema>;
/** Durable media references only; bytes are delivered through the grant-scoped run context. */
export const chatAttachmentSchema = z.strictObject({ path: idSchema,
 name: z.string().min(1).max(255).regex(/^[^\u0000-\u001f\u007f/\\]+$/), kind: z.literal('image'),
 size: z.number().int().positive().max(1048576) });
export type ChatAttachmentRef = z.infer<typeof chatAttachmentSchema>;
/** Read the current Jini attachment token at send time; it is never stored in chat history. */
export const assistantRunRequestSchema = z.strictObject({ prompt: z.string().min(1).max(65536), attachments: z.array(chatAttachmentSchema).max(4).optional(), conversationId: idSchema.optional(), frontendSessionId: idSchema.optional(), frontendBindToken: z.string().min(1).max(8192).optional() });
export type AssistantRunRequest = z.infer<typeof assistantRunRequestSchema>;

/** Owner-scoped history DTOs; scope is bound by the authenticated server, never supplied here. */
export const conversationSummarySchema = z.strictObject({ conversationId: idSchema, title: z.string().max(200), createdAt: epochSchema, updatedAt: epochSchema });
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export const conversationListSchema = z.strictObject({ items: z.array(conversationSummarySchema).max(100), cursor: idSchema.nullable() });
export type ConversationList = z.infer<typeof conversationListSchema>;
export const conversationSchema = z.strictObject({ conversation: conversationSummarySchema, messages: z.array(chatMessageSchema).max(100), cursor: idSchema.nullable() });
export type Conversation = z.infer<typeof conversationSchema>;
export const conversationReadSchema = z.strictObject({ conversationId: idSchema, limit: z.number().int().min(1).max(100), cursor: idSchema.optional() });
export type ConversationRead = z.infer<typeof conversationReadSchema>;
/** Text context stays within 40 messages/128 KiB; current-turn images add at most four MiB of decoded bytes. */
export const assistantContextSchema = z.strictObject({ settings: assistantSettingsSchema, protocol: modelProtocolSchema.optional(), messages: z.array(chatMessageSchema).max(40),
 attachments: z.array(chatAttachmentSchema).max(4).optional(),
 images: z.array(z.strictObject({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  data: z.string().min(4).max(1398104).regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0) })).max(4).optional() })
 .refine(value => new TextEncoder().encode(JSON.stringify({ ...value, images: undefined })).length <= 131072, "Context exceeds 128 KiB");
export type AssistantContext = z.infer<typeof assistantContextSchema>;

/** Discovery data only; effects are classified and authority is rechecked by the server. */
export const toolDescriptorSchema = z.strictObject({ name: idSchema, description: z.string().max(4096), inputSchema: boundedJsonSchema.pipe(z.record(z.string(), z.json())), effects: z.array(effectCategorySchema).min(1).max(10) });
export type ToolDescriptor = z.infer<typeof toolDescriptorSchema>;
export const toolSearchSchema = z.strictObject({ query: z.string().max(1024).optional(), limit: z.number().int().min(1).max(100) });
export type ToolSearch = z.infer<typeof toolSearchSchema>;
export const toolCallSchema = z.strictObject({ name: idSchema, input: boundedJsonSchema, operationId: idSchema });
export type ToolCall = z.infer<typeof toolCallSchema>;
/** Pending means no tool output yet. A completed result carries the actual bounded output. */
export const toolResultSchema = z.discriminatedUnion("status", [
 z.strictObject({ status: z.literal("completed"), output: boundedJsonSchema }),
 z.strictObject({ status: z.literal("pending"), operationId: idSchema, cardId: idSchema.optional() }),
]);
export type ToolResult = z.infer<typeof toolResultSchema>;
/** Interrupted approval waits require fresh authority; unknown outcomes are never retried blindly. */
export const toolOperationSchema = z.discriminatedUnion("status", [
 z.strictObject({ status: z.literal("pending"), operationId: idSchema, cardId: idSchema.optional() }),
 z.strictObject({ status: z.literal("completed"), operationId: idSchema, output: boundedJsonSchema }),
 z.strictObject({ status: z.literal("cancelled"), operationId: idSchema }),
 z.strictObject({ status: z.literal("interrupted"), operationId: idSchema }),
 z.strictObject({ status: z.literal("unknown"), operationId: idSchema, error: appErrorSchema }),
]);
export type ToolOperation = z.infer<typeof toolOperationSchema>;
