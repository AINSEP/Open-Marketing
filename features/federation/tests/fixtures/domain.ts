import type { CallContext, EffectCategory, Outcome } from "@open-marketing/contracts";
import {
  createFederationHost, createMemoryFederationConnectionRepo, createMemoryFederationCredential,
  createMemoryFederatedToolPermissionGate, createMemoryFederatedCallConfirmation,
  createMemoryExternalMcpToolApprovalRepo, createMemoryFederatedDispatchGate,
  createMemoryFederationAudit, createMemoryToolRegistry, createMemoryMcpTransport,
  digestArguments, fingerprintSchemas,
} from "../../index.js";
import type { ExternalToolCall, ExternalToolResult, FederatedToolDescriptor, FederationConnection, McpTransportPort } from "../../index.js";

export const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
export const pluginDigest = "a".repeat(64);
export const connection: FederationConnection = { connectionId: "fixture", scope: context.scope, pluginId: "fixture-plugin", pluginDigest };
export const inputSchema = { type: "object", properties: { query: { type: "string", maxLength: 1024 } }, required: ["query"], additionalProperties: false };
export const outputSchema = { type: "object", properties: { echo: { type: "string" } }, required: ["echo"], additionalProperties: false };

/** Fixture assertion aid; production code uses explicit outcomes. */
export function value<T>(required: { outcome: Outcome<T> }): T {
  if (!required.outcome.ok) throw new Error(`Fixture setup failed: ${required.outcome.error.code}`);
  return required.outcome.value;
}
export function descriptor(required: { effects?: readonly EffectCategory[]; inputSchema?: Readonly<Record<string, unknown>> } = {}): FederatedToolDescriptor {
  const schema = required.inputSchema ?? inputSchema;
  const fingerprint = value({ outcome: fingerprintSchemas({ inputSchema: schema, outputSchema }) });
  return { name: "io.github.ainsep.openmarketing.fixture.echo", connectionId: "fixture", fingerprint, inputSchema: schema, outputSchema, capability: { capabilityId: "echo", version: 1, pluginId: "fixture-plugin", pluginDigest, schemaFingerprint: fingerprint, admitted: true, effects: [...(required.effects ?? ["read"])] } };
}
export function call(required: { operationId?: string; query?: string; descriptor?: FederatedToolDescriptor } = {}): ExternalToolCall {
  const argumentsValue = { query: required.query ?? "hello" };
  const tool = required.descriptor ?? descriptor({});
  return { operationId: required.operationId ?? "operation", connectionId: "fixture", toolName: tool.name, arguments: argumentsValue, argumentsDigest: value({ outcome: digestArguments({ arguments: argumentsValue }) }), pluginDigest, schemaFingerprint: tool.fingerprint };
}

/** Fixture output exercises metadata arrival through the actual outbound transport. */
export function echoResult(required: { call: ExternalToolCall; context: CallContext }): ExternalToolResult {
  const metadata = { operationId: required.call.operationId, correlationId: required.context.correlationId, traceId: required.context.traceId, runId: required.context.runId, argumentsDigest: required.call.argumentsDigest, pluginDigest: required.call.pluginDigest, schemaFingerprint: required.call.schemaFingerprint };
  return { operationId: required.call.operationId, status: "succeeded", content: [{ type: "text", text: JSON.stringify({ arguments: required.call.arguments, metadata: { "io.github.ainsep.openmarketing": metadata } }) }, { type: "json", data: { echo: required.call.arguments.query } }] };
}

/** Memory response modes match local HTTP and stdio fixture responses. */
export async function respond(required: Parameters<McpTransportPort["invoke"]>[0]): Promise<Outcome<ExternalToolResult>> {
  const result = echoResult(required);
  switch (required.call.arguments.query) {
    case "oversized": return { ok: true, value: { ...result, content: [{ type: "text", text: "x".repeat(262145) }] } };
    case "tainted": return { ok: true, value: { ...result, content: [{ type: "text", text: 42 }] } };
    case "invalid": return { ok: true, value: { ...result, content: [{ type: "resource_link", uri: "file:///secret" }] } };
    case "unknown": throw new Error("Vendor exception must never escape");
    default: return { ok: true, value: result };
  }
}

/** Host test assembly: each safety decision is explicit and independently revocable. */
export async function harness(required: { transport?: McpTransportPort; effects?: readonly EffectCategory[]; afterCard?: (required: { call: ExternalToolCall; context: CallContext }) => Promise<void> } = {}) {
  const tool = descriptor({ effects: required.effects });
  const invocation = { context, call: call({ descriptor: tool }) };
  const connections = createMemoryFederationConnectionRepo({ entries: [connection] });
  const credentials = createMemoryFederationCredential({ entries: [{ connectionId: "fixture", credentialReference: "broker-reference" }] });
  const permissionGate = createMemoryFederatedToolPermissionGate({ entries: [{ toolName: tool.name, effects: tool.capability.effects }] });
  const approvalRepo = createMemoryExternalMcpToolApprovalRepo({});
  const dispatchGate = createMemoryFederatedDispatchGate({ entries: [{ ...invocation, permitId: "permit" }] });
  const audit = createMemoryFederationAudit({});
  const registry = createMemoryToolRegistry({});
  const memoryTransport = createMemoryMcpTransport({ respond });
  const transport = required.transport ?? memoryTransport;
  const clock = { now: () => 100 };
  const confirmation = createMemoryFederatedCallConfirmation({ approve: async input => {
    const approval = approvalRepo.put({ approval: { approvalId: "approval", ...input, argumentsDigest: input.call.argumentsDigest, expiresAt: 1000, revoked: false } });
    if (!approval.ok) return approval;
    await required.afterCard?.(input);
    return { ok: true, value: { approvalId: "approval" } };
  } });
  value({ outcome: await registry.register({ descriptor: tool }) });
  const dependencies = { connections, credentials, permissionGate, confirmation, approvalRepo, dispatchGate, audit, registry, transport, clock };
  const host = createFederationHost(dependencies);
  return { host, dependencies, invocation, tool, memoryTransport };
}
