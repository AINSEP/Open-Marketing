import { z } from "zod";
import { appErrorSchema, callContextSchema, digestSchema, epochSchema, idSchema } from "../values/index.js";
import { effectCategorySchema } from "../capabilities/index.js";
import type { Outcome } from "../values/index.js";
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
export const apiRequestSchema = z.strictObject({ version: z.literal(1), operationId: idSchema, argumentsDigest: digestSchema, context: callContextSchema, input: z.json() });
export type ApiRequest = z.infer<typeof apiRequestSchema>;
export type ApiResponse<T> = Outcome<T>;
export const mcpRequestSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: z.union([idSchema, z.number().int()]), method: z.enum(["initialize", "tools/list", "tools/call"]), params: z.record(z.string(), z.json()) });
export type OmMcpRequest = z.infer<typeof mcpRequestSchema>;
export const chatMessageSchema = z.strictObject({ id: idSchema, role: z.enum(["user", "assistant"]), text: z.string().max(65536) });
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
export const assistantSettingsSchema = z.strictObject({ mode: z.enum(["sandbox", "model"]), model: idSchema, connectionId: idSchema.nullable() });
export type AssistantSettings = z.infer<typeof assistantSettingsSchema>;
/** Server-configured model choices; optional for compatibility with existing settings responses. */
export const assistantSettingsStatusSchema = z.strictObject({ settings: assistantSettingsSchema, ready: z.boolean(), status: z.enum(["sandbox", "ready", "reconnect_required", "disconnected", "unavailable"]), models: z.array(z.strictObject({ id: idSchema, label: z.string().min(1).max(80) })).max(16).optional() });
export type AssistantSettingsStatus = z.infer<typeof assistantSettingsStatusSchema>;
/** Read the current Jini attachment token at send time; it is never stored in chat history. */
export const assistantRunRequestSchema = z.strictObject({ prompt: z.string().min(1).max(65536), conversationId: idSchema.optional(), frontendSessionId: idSchema.optional(), frontendBindToken: z.string().min(1).max(8192).optional() });
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
/** Model context is limited to 40 messages and 128 KiB; no vendor authentication is present. */
export const assistantContextSchema = z.strictObject({ settings: assistantSettingsSchema, messages: z.array(chatMessageSchema).max(40) })
 .refine(value => new TextEncoder().encode(JSON.stringify(value)).length <= 131072, "Context exceeds 128 KiB");
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
