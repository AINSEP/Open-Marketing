import { z } from "zod";
import { appErrorSchema, callContextSchema, digestSchema, epochSchema, idSchema } from "../values/index.js";
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
