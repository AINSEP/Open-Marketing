import { z } from "zod";
import { callContextSchema, digestSchema, epochSchema, idSchema, scopeSchema } from "../values/index.js";
export const PROTOCOL_VERSION = 1 as const;
export const runGrantMetadataSchema = z.strictObject({ grantId: idSchema, agentInstanceId: idSchema, scope: scopeSchema, conversationId: idSchema, runId: idSchema, capabilities: z.array(idSchema).max(100), expiresAt: epochSchema, revoked: z.boolean(), protocolVersion: z.literal(1), authenticationEpoch: epochSchema });
export type RunGrantMetadata = z.infer<typeof runGrantMetadataSchema>;
/** Service-control credential is never a scoped OM run grant. No token appears in event DTOs. */
export interface ServiceControlCredential { readonly kind: "service-control"; readonly bearer: string }
export interface RunGrantCredential { readonly kind: "run-grant"; readonly bearer: string; readonly metadata: RunGrantMetadata }
export const startRunSchema = z.strictObject({ protocolVersion: z.literal(1), context: callContextSchema, agentInstanceId: idSchema, conversationId: idSchema, runId: idSchema, grant: runGrantMetadataSchema, prompt: z.string().min(1).max(65536) });
export type StartRunRequest = z.infer<typeof startRunSchema>;
export const cancelRunSchema = z.strictObject({ protocolVersion: z.literal(1), runId: idSchema, reason: z.enum(["owner", "expired", "revoked", "shutdown"]) });
export type CancelRunRequest = z.infer<typeof cancelRunSchema>;
export const eventCursorSchema = epochSchema;
export const runEventSchema = z.strictObject({ protocolVersion: z.literal(1), eventId: idSchema, runId: idSchema, sequence: eventCursorSchema, correlationId: idSchema, traceId: idSchema, kind: z.enum(["started", "delta", "tool_requested", "tool_result", "cancelled", "ended", "error"]), operationId: idSchema.optional(), argumentsDigest: digestSchema.optional(), payload: z.json() });
export type RunEvent = z.infer<typeof runEventSchema>;
export type SseEvent = RunEvent;
export const eventSubscriptionSchema = z.strictObject({ runId: idSchema, after: eventCursorSchema, limit: z.number().int().min(1).max(1000) });
export type EventSubscription = z.infer<typeof eventSubscriptionSchema>;
export interface RunReceipt { readonly runId: string; readonly status: "requested" | "pending" }
export interface CancellationReceipt { readonly runId: string; readonly status: "requested" | "cancelled" }
export interface AgentHealth { readonly protocolVersion: 1; readonly ready: boolean; readonly runtime: "unavailable" | "available" }
