import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
 assistantUsageSchema, a2uiSurfacePayloadSchema, approvalPayloadSchema, assistantContextSchema, assistantRunRequestSchema,
 assistantSettingsSchema, assistantSettingsStatusSchema, boundedJsonSchema, cardSchema, conversationListSchema,
 conversationReadSchema, conversationSchema, frontendInvocationSchema, frontendResultSchema,
 modelProviderSchema, navigationActionSchema, navigationTargetSchema, operationPollSchema, runEventSchema, startRunSchema,
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

it("carries the current frontend bind token additively without putting it in events", () => {
 const scope = { ownerId: "owner", workspaceId: "workspace" };
 const request: StartRunRequest = {
  protocolVersion: 1, context: { scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "c", traceId: "t" },
  agentInstanceId: "agent", conversationId: "chat", runId: "run", prompt: "Hello",
  grant: { grantId: "g", agentInstanceId: "agent", scope, conversationId: "chat", runId: "run", capabilities: [], expiresAt: 100,
   revoked: false, protocolVersion: 1, authenticationEpoch: 1 },
 };
 expect(assistantRunRequestSchema.parse({ prompt: "Hello" })).toEqual({ prompt: "Hello" });
 expect(startRunSchema.parse(request)).toEqual(request);
 const binding = { frontendSessionId: "studio", frontendBindToken: "fixture-current-attachment" };
 expect(assistantRunRequestSchema.parse({ prompt: "Hello", ...binding }).frontendBindToken).toBe(binding.frontendBindToken);
 expect(startRunSchema.parse({ ...request, ...binding }).frontendBindToken).toBe(binding.frontendBindToken);
 for (const frontendBindToken of ["", "x".repeat(8193)]) {
  expect(assistantRunRequestSchema.safeParse({ prompt: "Hello", frontendBindToken }).success).toBe(false);
  expect(startRunSchema.safeParse({ ...request, frontendBindToken }).success).toBe(false);
 }
 expect(runEventSchema.safeParse({ protocolVersion: 1, eventId: "e", runId: "run", sequence: 1, kind: "started", payload: {},
  correlationId: "c", traceId: "t", frontendBindToken: binding.frontendBindToken }).success).toBe(false);
});

it('accepts additive provider/effort and flat usage while preserving unknown cost', () => {
 expect(assistantSettingsSchema.parse({ ...settings, provider: 'openai', effort: 'high' }).provider).toBe('openai');
 expect(assistantSettingsSchema.parse({ ...settings, provider: 'acme-models' }).provider).toBe('acme-models');
 for (const provider of ['', 'x'.repeat(257)]) expect(assistantSettingsSchema.safeParse({ ...settings, provider }).success).toBe(false);
 const usage = assistantUsageSchema.parse({ kind: 'usage', complete: false, costBasis: 'unavailable', durationMs: 8000 });
 expect(usage.costUsdMicros).toBeUndefined(); expect(usage.totalCostUsdMicros).toBeUndefined();
 expect(assistantUsageSchema.parse({ ...usage, costUsdMicros: '70000' }).costUsdMicros).toBe('70000');
 for (const costUsdMicros of [0.07, '-1', '0.5', '007']) expect(assistantUsageSchema.safeParse({ ...usage, costUsdMicros }).success).toBe(false);
 expect(assistantUsageSchema.safeParse({ ...usage, inputTokens: -1 }).success).toBe(false);
});

const providerModel = { id: "example-model", label: "Example model", efforts: [{ id: "default", label: "Default", request: {} }] };
const providerDeclaration = { protocol: "openai", endpoint: "https://example.test", label: "Example provider", models: [providerModel] };

it("parses all three real data-only provider manifests and their API-key cards", () => {
 for (const id of ["anthropic", "openai", "google"]) {
  const manifest = JSON.parse(readFileSync(new URL(`../../../content/agent-plugins/${id}/plugin.json`, import.meta.url), "utf8"));
  const extension = manifest.extensions["io.github.ainsep.openmarketing"];
  expect(manifest.name).toBe(id);
  expect(extension).toMatchObject({ version: 1, provides: ["model"], enabled: true, admitted: true, capabilities: {} });
  const provider = modelProviderSchema.parse(extension.modelProvider);
  expect(provider.protocol).toBe(id);
  expect(provider.models.length).toBeGreaterThan(0);
  expect(extension.credentialCards).toHaveLength(1);
  for (const raw of extension.credentialCards) {
   const card = cardSchema.parse(raw);
   expect(card).toMatchObject({ target: id, saveTarget: id, saveKind: "api-key", baseUrl: provider.endpoint,
    secretFields: [{ name: "token", label: "API key", required: true }] });
   expect(card.fields).toBeUndefined();
   expect(card.probeUrl).toBeUndefined();
  }
 }
});

it("rejects unknown keys within provider models and efforts", () => {
 expect(modelProviderSchema.safeParse({ ...providerDeclaration, models: [{ ...providerModel, unknown: true }] }).success).toBe(false);
 const model = { ...providerModel, efforts: [{ ...providerModel.efforts[0], unknown: true }] };
 expect(modelProviderSchema.safeParse({ ...providerDeclaration, models: [model] }).success).toBe(false);
});

it("keeps omitted pricing absent and rejects a non-decimal price", () => {
 const parsed = modelProviderSchema.parse(providerDeclaration);
 expect(parsed.models[0]).not.toHaveProperty("pricing");
 const pricing = { inputUsdPerMTok: "1.75", outputUsdPerMTok: "14", source: "https://example.test/pricing", observedOn: "2026-10-28" };
 const model = { ...providerModel, pricing };
 expect(modelProviderSchema.parse({ ...providerDeclaration, models: [model] }).models[0]?.pricing).toEqual(pricing);
 expect(modelProviderSchema.safeParse({ ...providerDeclaration, models: [{ ...model, pricing: { ...pricing, inputUsdPerMTok: "free" } }] }).success).toBe(false);
});

it("accepts optional server-derived context protocol and rejects an unknown protocol", () => {
 const context = { settings, messages: [] };
 expect(assistantContextSchema.parse(context)).toEqual(context);
 for (const protocol of ["anthropic", "openai", "google", "azure"]) {
  expect(assistantContextSchema.parse({ ...context, protocol }).protocol).toBe(protocol);
 }
 expect(assistantContextSchema.safeParse({ ...context, protocol: "other" }).success).toBe(false);
});
