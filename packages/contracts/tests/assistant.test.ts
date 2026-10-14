import { expect, it } from "vitest";
import {
 a2uiSurfacePayloadSchema, approvalPayloadSchema, assistantContextSchema, assistantRunRequestSchema,
 assistantSettingsSchema, assistantSettingsStatusSchema, boundedJsonSchema, conversationListSchema,
 conversationReadSchema, conversationSchema, frontendInvocationSchema, frontendResultSchema,
 navigationActionSchema, navigationTargetSchema, operationPollSchema, runEventSchema, startRunSchema,
 studioNavigationTargetSchema, surfaceAcknowledgementSchema, toolCallSchema, toolDescriptorSchema,
 toolOperationSchema, toolRequestedPayloadSchema, toolResultPayloadSchema, toolResultSchema, toolSearchSchema,
} from "../src/index.js";
import type { StartRunRequest } from "../src/index.js";

const settings = { mode: "model", model: "claude-sonnet-5-5", connectionId: "anthropic" } as const;
const summary = { conversationId: "chat", title: "Campaign", createdAt: 1, updatedAt: 2 };
const identity = { invocationId: "inv", runId: "run", frontendSessionId: "studio" };

it("preserves old navigation and adds explicit addon paths for Studio", () => {
 expect(navigationActionSchema.parse({ kind: "navigate", actionId: "nav", target: "plugins" }).target).toBe("plugins");
 expect(navigationTargetSchema.safeParse("/addons/plugins").success).toBe(false);
 for (const target of ["/addons/plugins", "/addons/agent-plugins", "/addons/skills", "/addons/integrations", "creative"]) {
  expect(studioNavigationTargetSchema.parse(target)).toBe(target);
 }
 expect(studioNavigationTargetSchema.safeParse("https://example.test").success).toBe(false);
});

it("keeps legacy starts valid and confines the optional OM bearer to control input", () => {
 const scope = { ownerId: "owner", workspaceId: "workspace" };
 const request: StartRunRequest = {
  protocolVersion: 1, context: { scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "c", traceId: "t" },
  agentInstanceId: "agent", conversationId: "chat", runId: "run", prompt: "Hello",
  grant: { grantId: "g", agentInstanceId: "agent", scope, conversationId: "chat", runId: "run", capabilities: [], expiresAt: 100,
   revoked: false, protocolVersion: 1, authenticationEpoch: 1 },
 };
 expect(startRunSchema.parse(request)).toEqual(request);
 expect(startRunSchema.parse({ ...request, runBearer: "fixture-om-bearer", frontendSessionId: "studio", deadlineAt: 100 }).runBearer).toBe("fixture-om-bearer");
 expect(startRunSchema.safeParse({ ...request, runBearer: "" }).success).toBe(false);
 const event = { protocolVersion: 1, eventId: "event", runId: "run", sequence: 1, correlationId: "c", traceId: "t", kind: "delta", payload: { type: "status", text: "Hello" } };
 expect(runEventSchema.parse(event)).toEqual(event);
 expect(runEventSchema.safeParse({ ...event, runBearer: "fixture-om-bearer" }).success).toBe(false);
});

it("rejects key fields in settings and scopes history through server-owned identities", () => {
 expect(assistantSettingsSchema.parse(settings)).toEqual(settings);
 expect(assistantSettingsSchema.parse({ ...settings, model: "claude-opus-5-5" }).model).toBe("claude-opus-5-5");
 expect(assistantSettingsStatusSchema.parse({ settings, ready: false, status: "disconnected" }).ready).toBe(false);
 expect(assistantSettingsSchema.safeParse({ ...settings, apiKey: "fixture" }).success).toBe(false);
 expect(assistantRunRequestSchema.parse({ prompt: "Hello", conversationId: "chat", frontendSessionId: "studio" }).conversationId).toBe("chat");
 expect(conversationReadSchema.safeParse({ conversationId: "chat", limit: 1, ownerId: "other" }).success).toBe(false);
 expect(conversationListSchema.parse({ items: [summary], cursor: null }).items[0]).toEqual(summary);
 expect(conversationSchema.parse({ conversation: summary, messages: [{ id: "m", role: "user", text: "Hello" }], cursor: null }).messages[0]?.text).toBe("Hello");
 expect(conversationListSchema.safeParse({ items: Array.from({ length: 101 }, () => summary), cursor: null }).success).toBe(false);
});

it("bounds model context by both message count and aggregate UTF-8 bytes", () => {
 const message = { id: "m", role: "user", text: "Hello" };
 expect(assistantContextSchema.parse({ settings, messages: Array.from({ length: 40 }, () => message) }).messages).toHaveLength(40);
 expect(assistantContextSchema.safeParse({ settings, messages: Array.from({ length: 41 }, () => message) }).success).toBe(false);
 const large = { ...message, text: "x".repeat(65536) };
 expect(assistantContextSchema.safeParse({ settings, messages: [large] }).success).toBe(true);
 expect(assistantContextSchema.safeParse({ settings, messages: [large, large] }).success).toBe(false);
});

it("bounds JSON depth and bytes without throwing on a cycle", () => {
 expect(boundedJsonSchema.parse("x".repeat(65534))).toHaveLength(65534);
 expect(boundedJsonSchema.safeParse("x".repeat(65535)).success).toBe(false);
 expect(boundedJsonSchema.safeParse("é".repeat(32768)).success).toBe(false);
 let nested: unknown = null;
 for (let depth = 0; depth < 16; depth++) nested = { value: nested };
 expect(boundedJsonSchema.safeParse(nested).success).toBe(true);
 expect(boundedJsonSchema.safeParse({ value: nested }).success).toBe(false);
 const cycle: { self?: unknown } = {}; cycle.self = cycle;
 expect(boundedJsonSchema.safeParse(cycle).success).toBe(false);
 expect(boundedJsonSchema.safeParse({ value: undefined }).success).toBe(false);
});

it("distinguishes pending tools from actual results and interrupted operations", () => {
 const call = { name: "report", input: { account: "a" }, operationId: "op" };
 expect(toolCallSchema.parse(call)).toEqual(call);
 expect(toolRequestedPayloadSchema.parse({ type: "tool_requested", call }).call).toEqual(call);
 expect(toolResultPayloadSchema.parse({ type: "tool_result", operationId: "op", result: { status: "completed", output: { count: 2 } } }).result).toEqual({ status: "completed", output: { count: 2 } });
 expect(toolResultSchema.parse({ status: "pending", operationId: "op", cardId: "card" })).toEqual({ status: "pending", operationId: "op", cardId: "card" });
 expect(toolResultSchema.safeParse({ status: "pending", operationId: "op", output: { count: 2 } }).success).toBe(false);
 expect(toolResultSchema.safeParse({ status: "completed" }).success).toBe(false);
 for (const status of ["cancelled", "interrupted"]) expect(toolOperationSchema.parse({ status, operationId: "op" }).status).toBe(status);
 expect(toolOperationSchema.safeParse({ status: "unknown", operationId: "op" }).success).toBe(false);
 expect(toolDescriptorSchema.parse({ name: "report", description: "Report", inputSchema: {}, effects: ["read"] }).effects).toEqual(["read"]);
 expect(toolDescriptorSchema.safeParse({ name: "report", description: "Report", inputSchema: "invalid", effects: ["read"] }).success).toBe(false);
 expect(toolSearchSchema.safeParse({ limit: 101 }).success).toBe(false);
 expect(operationPollSchema.parse({ operationId: "op", intervalMs: 1000, deadlineAt: 100 }).intervalMs).toBe(1000);
 expect(operationPollSchema.safeParse({ operationId: "op", intervalMs: 999, deadlineAt: 100 }).success).toBe(false);
});

it("binds frontend responses and approval resolution to explicit identities", () => {
 expect(frontendInvocationSchema.parse({ ...identity, operationId: "op", name: "page.navigate", input: { target: "/addons/skills" } }).runId).toBe("run");
 expect(frontendResultSchema.parse({ ...identity, status: "completed", output: null }).status).toBe("completed");
 expect(frontendResultSchema.safeParse({ invocationId: "inv", status: "completed", output: null }).success).toBe(false);
 expect(approvalPayloadSchema.parse({ type: "confirmation_resolved", cardId: "card", operationId: "op", status: "interrupted" }).type).toBe("confirmation_resolved");
 const card = { cardId: "card", operationId: "op", argumentsDigest: "a".repeat(64), arguments: { account: "a" }, allowedChoices: ["allow", "cancel"], expiresAt: 100, classification: "spend" };
 expect(approvalPayloadSchema.parse({ type: "confirmation", card }).type).toBe("confirmation");
 expect(approvalPayloadSchema.safeParse({ type: "confirmation", card: { ...card, arguments: { text: "x".repeat(65536) } } }).success).toBe(false);
 expect(surfaceAcknowledgementSchema.parse({ ...identity, surfaceId: "s", status: "sent" }).status).toBe("sent");
 expect(surfaceAcknowledgementSchema.parse({ ...identity, surfaceId: "s", status: "rendered" }).status).toBe("rendered");
 expect(surfaceAcknowledgementSchema.safeParse({ ...identity, surfaceId: "s", status: "failed" }).success).toBe(false);
});

it("caps surface components across messages and preserves the Jini v1.0 envelope", () => {
 const components = Array.from({ length: 50 }, (_, index) => ({ id: "c" + index, component: "Text", text: "Hello" }));
 const surface = { ...identity, type: "a2ui", surfaceId: "s", version: "v1.0", messages: [
  { version: "v1.0", createSurface: { surfaceId: "s", catalogId: "om", components } },
  { version: "v1.0", updateComponents: { surfaceId: "s", components } },
 ] };
 expect(a2uiSurfacePayloadSchema.parse(surface).messages).toEqual(surface.messages);
 const extra = { version: "v1.0", updateComponents: { surfaceId: "s", components: [{ id: "extra", component: "Text" }] } };
 expect(a2uiSurfacePayloadSchema.safeParse({ ...surface, messages: [...surface.messages, extra] }).success).toBe(false);
 expect(a2uiSurfacePayloadSchema.safeParse({ ...surface, version: "v0.9" }).success).toBe(false);
 expect(a2uiSurfacePayloadSchema.safeParse({ ...surface, messages: ["x".repeat(40000), "x".repeat(40000)] }).success).toBe(false);
});
