import { z } from "zod";
import { appErrorSchema, callContextSchema, digestSchema, epochSchema, idSchema, scopeSchema } from "../values/index.js";
import { boundedJsonSchema, confirmationCardSchema, toolCallSchema, toolResultSchema } from "../api/index.js";
export const PROTOCOL_VERSION = 1 as const;
export const runGrantMetadataSchema = z.strictObject({ grantId: idSchema, agentInstanceId: idSchema, scope: scopeSchema, conversationId: idSchema, runId: idSchema, capabilities: z.array(idSchema).max(100), expiresAt: epochSchema, revoked: z.boolean(), protocolVersion: z.literal(1), authenticationEpoch: epochSchema });
export type RunGrantMetadata = z.infer<typeof runGrantMetadataSchema>;
/** Service-control credential is never a scoped OM run grant. No token appears in event DTOs. */
export interface ServiceControlCredential { readonly kind: "service-control"; readonly bearer: string }
export interface RunGrantCredential { readonly kind: "run-grant"; readonly bearer: string; readonly metadata: RunGrantMetadata }
/** Sent only over authenticated service control. Model runtimes require runBearer; sandbox callers may omit it.
 * The run-scoped bearer authenticates OM requests, never the vendor; it must not enter events/history.
 */
export const startRunSchema = z.strictObject({ protocolVersion: z.literal(1), context: callContextSchema, agentInstanceId: idSchema, conversationId: idSchema, runId: idSchema, grant: runGrantMetadataSchema, prompt: z.string().min(1).max(65536), runBearer: z.string().min(1).max(8192).optional(), frontendSessionId: idSchema.optional(), frontendBindToken: z.string().min(1).max(8192).optional(), deadlineAt: epochSchema.optional() });
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

/** Typed payloads are additive: legacy runEventSchema remains compatible with sandbox events. */
export const toolRequestedPayloadSchema = z.strictObject({ type: z.literal("tool_requested"), call: toolCallSchema });
export type ToolRequestedPayload = z.infer<typeof toolRequestedPayloadSchema>;
export const toolResultPayloadSchema = z.strictObject({ type: z.literal("tool_result"), operationId: idSchema, result: toolResultSchema });
export type ToolResultPayload = z.infer<typeof toolResultPayloadSchema>;
export const approvalPayloadSchema = z.discriminatedUnion("type", [
 z.strictObject({ type: z.literal("confirmation"), card: confirmationCardSchema.refine(card => boundedJsonSchema.safeParse(card.arguments).success, "Confirmation arguments exceed JSON limits") }),
 z.strictObject({ type: z.literal("confirmation_resolved"), cardId: idSchema, operationId: idSchema, status: z.enum(["completed", "cancelled", "interrupted"]) }),
]);
export type ApprovalPayload = z.infer<typeof approvalPayloadSchema>;
/** Polling is cancellable via the caller's signal. deadlineAt MUST equal the run's deadline. */
export const operationPollSchema = z.strictObject({ operationId: idSchema, intervalMs: z.number().int().min(1000).max(60000), deadlineAt: epochSchema });
export type OperationPoll = z.infer<typeof operationPollSchema>;

/** Browser invocations bind one frontend session and invocation ID to the originating run. */
export const frontendInvocationSchema = z.strictObject({ invocationId: idSchema, runId: idSchema, frontendSessionId: idSchema, operationId: idSchema, name: idSchema, input: boundedJsonSchema });
export type FrontendInvocation = z.infer<typeof frontendInvocationSchema>;
export const frontendResultSchema = z.discriminatedUnion("status", [
 z.strictObject({ status: z.literal("completed"), invocationId: idSchema, runId: idSchema, frontendSessionId: idSchema, output: boundedJsonSchema }),
 z.strictObject({ status: z.literal("failed"), invocationId: idSchema, runId: idSchema, frontendSessionId: idSchema, error: appErrorSchema }),
]);
export type FrontendResult = z.infer<typeof frontendResultSchema>;
/** Count declared components across create/update messages without interpreting vendor wire data.
 * @complexity O(1) time/space per message; component bodies are not traversed here.
 */
function surfaceComponentCount(required: { message: z.infer<typeof boundedJsonSchema> }): number {
 const message = required.message;
 if (typeof message !== "object" || message === null || Array.isArray(message)) return 0;
 return [message.createSurface, message.updateComponents].reduce<number>((total, body) => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return total;
  return total + (Array.isArray(body.components) ? body.components.length : 0);
 }, 0);
}

/** A2UI v1.0 transport envelope. Jini owns message, catalog, props and component-tree validation.
 * Transport bounds: depth 16 and 64 KiB per envelope, 100 declared components in total.
 */
export const a2uiSurfacePayloadSchema = z.strictObject({ type: z.literal("a2ui"), surfaceId: idSchema, invocationId: idSchema, runId: idSchema, frontendSessionId: idSchema, version: z.literal("v1.0"), messages: z.array(boundedJsonSchema).min(1).max(100) })
 .refine(value => value.messages.reduce<number>((total, message) => total + surfaceComponentCount({ message }), 0) <= 100, "Surface exceeds 100 components")
 .refine(value => boundedJsonSchema.safeParse(value).success, "Surface exceeds JSON limits");
export type A2uiSurfacePayload = z.infer<typeof a2uiSurfacePayloadSchema>;
/** Rendered is an explicit browser acknowledgement, never inferred from silence. */
export const surfaceAcknowledgementSchema = z.discriminatedUnion("status", [
 z.strictObject({ status: z.enum(["sent", "rendered"]), surfaceId: idSchema, invocationId: idSchema, runId: idSchema, frontendSessionId: idSchema }),
 z.strictObject({ status: z.literal("failed"), surfaceId: idSchema, invocationId: idSchema, runId: idSchema, frontendSessionId: idSchema, error: appErrorSchema }),
]);
export type SurfaceAcknowledgement = z.infer<typeof surfaceAcknowledgementSchema>;
