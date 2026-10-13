import { z } from "zod";
import { Ajv } from "ajv";
import {
  callContextSchema, capabilityEnvelopeSchema, digestSchema, effectEnvelopeSchema,
  epochSchema, idSchema, scopeSchema, parseBoundary,
} from "@open-marketing/contracts";
import type { CallContext, EffectEnvelope, Outcome } from "@open-marketing/contracts";
import type { ExternalToolCall, ExternalToolResult, FederatedApproval, FederatedToolDescriptor, FederationConnection } from "./types.js";
import { digestArguments, snapshotJson } from "./json.js";
import { failure, success } from "./outcomes.js";

/** Stable OM names; connection IDs are an explicit namespace segment, not ambiguous concatenation. */
export const toolNameSchema = z.string().max(256).regex(/^io\.github\.ainsep\.openmarketing\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
export const externalToolCallSchema = z.strictObject({
  operationId: idSchema, connectionId: idSchema, toolName: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()), argumentsDigest: digestSchema,
  pluginDigest: digestSchema, schemaFingerprint: digestSchema,
});
export const descriptorSchema = z.strictObject({
  name: toolNameSchema, connectionId: idSchema, fingerprint: digestSchema,
  capability: capabilityEnvelopeSchema,
  inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()).optional(),
});
export const connectionSchema = z.strictObject({ connectionId: idSchema, scope: scopeSchema, pluginId: idSchema, pluginDigest: digestSchema });
export const approvalSchema = z.strictObject({
  approvalId: idSchema, context: callContextSchema, call: externalToolCallSchema,
  argumentsDigest: digestSchema, expiresAt: epochSchema, revoked: z.boolean(),
});
const contentSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string().max(262144) }),
  z.strictObject({ type: z.literal("json"), data: z.record(z.string(), z.unknown()) }),
]);
const resultSchema = z.strictObject({ operationId: idSchema, status: z.enum(["succeeded", "failed", "unknown"]), content: z.array(contentSchema).max(100) });

/** Strict schema parse after bounded JSON copying; no getters or enormous recursive input reaches Zod. */
export function parseJson<T>(required: { schema: z.ZodType<T>; input: unknown; maxBytes: number }): Outcome<T> {
  const snapshot = snapshotJson({ value: required.input, maxBytes: required.maxBytes });
  if (!snapshot.ok) return snapshot;
  return parseBoundary({ schema: required.schema, input: snapshot.value });
}

/** Verify and freeze the exact call independently of caller mutation. @complexity O(n log n), bounded. */
export function freezeCall(required: { call: unknown }): Outcome<ExternalToolCall> {
  const parsed = parseJson({ schema: externalToolCallSchema, input: required.call, maxBytes: 70000 });
  if (!parsed.ok) return parsed;
  const digest = digestArguments({ arguments: parsed.value.arguments });
  if (!digest.ok) return digest;
  if (digest.value !== parsed.value.argumentsDigest) return failure({ code: "invalid_input", message: "Arguments digest mismatch" });
  const frozen = snapshotJson({ value: parsed.value, maxBytes: 70000 });
  if (!frozen.ok) return frozen;
  return success({ value: frozen.value as ExternalToolCall });
}

/** Same scope required at every connection/approval boundary. @complexity O(1). */
export function sameScope(required: { context: Pick<CallContext, "scope">; connection: Pick<FederationConnection, "scope"> }): boolean {
  return required.context.scope.ownerId === required.connection.scope.ownerId && required.context.scope.workspaceId === required.connection.scope.workspaceId;
}

/** AJV is a pure local compiler; references never trigger network reads. Invalid schemas fail closed. */
export function validateSchema(required: { schema: Readonly<Record<string, unknown>>; value: unknown }): Outcome<void> {
  try {
    const validator = new Ajv({ strict: true, allErrors: false, validateFormats: false });
    const validate = validator.compile(required.schema);
    if (!validate(required.value)) return failure({ code: "invalid_input", message: "Tool schema validation failed" });
    return success({ value: undefined });
  } catch {
    return failure({ code: "invalid_input", message: "Tool schema unavailable or invalid" });
  }
}

/** Catalog and safety effects must match exactly; an empty or unknown classification never becomes read. */
export function validateEffects(required: { input: unknown; call: ExternalToolCall; descriptor: FederatedToolDescriptor }): Outcome<EffectEnvelope> {
  const result = parseBoundary({ schema: effectEnvelopeSchema, input: required.input });
  if (!result.ok) return result;
  const effect = result.value;
  const bound = effect.operationId === required.call.operationId && effect.connectionId === required.call.connectionId && effect.argumentsDigest === required.call.argumentsDigest;
  const expected = [...new Set(required.descriptor.capability.effects)].sort();
  const actual = [...new Set(effect.effects)].sort();
  if (!bound || JSON.stringify(expected) !== JSON.stringify(actual)) return failure({ code: "forbidden", message: "Effect binding mismatch" });
  return result;
}

/** Check complete current confirmation binding, including principal and expiry. @complexity O(n), bounded. */
export function validateApproval(required: { approval: unknown; context: CallContext; call: ExternalToolCall; approvalId: string; now: number }): Outcome<FederatedApproval> {
  const parsed = parseJson({ schema: approvalSchema, input: required.approval, maxBytes: 75000 });
  if (!parsed.ok) return parsed;
  const approval = parsed.value;
  if (approval.revoked || approval.expiresAt <= required.now) return failure({ code: "forbidden", message: "Approval revoked or expired" });
  const expected = { context: required.context, call: required.call };
  const actual = { context: approval.context, call: approval.call };
  const left = snapshotJson({ value: expected, maxBytes: 75000 });
  const right = snapshotJson({ value: actual, maxBytes: 75000 });
  if (!left.ok || !right.ok) return failure({ code: "invalid_input", message: "Approval binding invalid" });
  const bound = approval.approvalId === required.approvalId && approval.argumentsDigest === required.call.argumentsDigest;
  if (!bound || JSON.stringify(left.value) !== JSON.stringify(right.value)) return failure({ code: "forbidden", message: "Approval does not bind this exact call" });
  return parsed;
}

/** Strict agent result projection; binary/resource/link content must be handled by a separate typed importer. */
export function validateResult(required: { input: unknown; operationId: string; maxBytes: number; maxContent: number; outputSchema?: Readonly<Record<string, unknown>> }): Outcome<ExternalToolResult> {
  const parsed = parseJson({ schema: resultSchema, input: required.input, maxBytes: required.maxBytes });
  if (!parsed.ok) return parsed;
  if (parsed.value.operationId !== required.operationId) return failure({ code: "protocol_mismatch", message: "Result operation mismatch" });
  if (parsed.value.content.length > required.maxContent) return failure({ code: "limit_exceeded", message: "Result content limit exceeded" });
  // Failed and uncertain executions need no successful-output payload; preserve uncertainty for reconciliation.
  if (!required.outputSchema || parsed.value.status !== "succeeded") return parsed;
  const structured = parsed.value.content.find(item => item.type === "json");
  if (!structured || structured.type !== "json") return failure({ code: "invalid_input", message: "Required structured result missing" });
  const valid = validateSchema({ schema: required.outputSchema, value: structured.data });
  if (!valid.ok) return valid;
  return parsed;
}

/** Fingerprint both tool schemas from bounded canonical JSON. @complexity O(n log n), bounded.
 * @example fingerprintSchemas({ inputSchema: { type: "object" } })
 */
export function fingerprintSchemas(required: { inputSchema: Readonly<Record<string, unknown>>; outputSchema?: Readonly<Record<string, unknown>> }): Outcome<string> {
  return digestArguments({ arguments: { input: required.inputSchema, output: required.outputSchema ?? null } });
}

/** Parse the transport boundary before any session effect; copy all outbound values. */
export function validateOutbound(required: { context: unknown; call: unknown; credentialReference: unknown }): Outcome<{ context: CallContext; call: ExternalToolCall; credentialReference: string }> {
  const context = parseJson({ schema: callContextSchema, input: required.context, maxBytes: 4096 });
  if (!context.ok) return context;
  const call = freezeCall({ call: required.call });
  if (!call.ok) return call;
  const credentialReference = parseBoundary({ schema: idSchema, input: required.credentialReference });
  if (!credentialReference.ok) return credentialReference;
  const frozenContext = snapshotJson({ value: context.value, maxBytes: 4096 });
  if (!frozenContext.ok) return frozenContext;
  return success({ value: { context: frozenContext.value as CallContext, call: call.value, credentialReference: credentialReference.value } });
}
