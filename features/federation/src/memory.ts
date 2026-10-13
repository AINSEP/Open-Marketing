import { effectEnvelopeSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, EffectCategory, ObserverEvent, Outcome } from "@open-marketing/contracts";
import type {
  FederationConnectionRepoPort, McpTransportPort, FederationCredentialPort, FederatedToolPermissionGate,
  FederatedCallConfirmation, ExternalMcpToolApprovalRepoPort, FederatedDispatchGatePort, FederationAuditPort, FederationObserverPort,
} from "./ports.js";
import type { ExternalToolCall, ExternalToolResult, FederationConnection, FederatedApproval } from "./types.js";
import { failure, success } from "./outcomes.js";
import { snapshotJson } from "./json.js";
import { approvalSchema, connectionSchema, freezeCall, parseJson, sameScope, validateOutbound, validateResult } from "./validation.js";
export { createMemoryToolRegistry } from "./registry.js";

type Invocation = { context: CallContext; call: ExternalToolCall };
/** Test control for a connection repository; mutations remain explicit and scoped to this instance. */
export interface MemoryConnectionRepo extends FederationConnectionRepoPort {
  put(required: { connection: FederationConnection }): Outcome<void>;
  revoke(required: { connectionId: string }): void;
}
/** Scoped functional connection double. Missing/revoked entries deny; no durable storage claim.
 * @example createMemoryFederationConnectionRepo({}).put({ connection }) @complexity O(1) lookup, bounded entries.
 */
export function createMemoryFederationConnectionRepo(required: { entries?: readonly FederationConnection[]; maxEntries?: number }): MemoryConnectionRepo {
  const entries = new Map<string, FederationConnection>();
  const port: MemoryConnectionRepo = {
    put(input) {
      const parsed = parseJson({ schema: connectionSchema, input: input.connection, maxBytes: 4096 });
      if (!parsed.ok) return parsed;
      if (!entries.has(parsed.value.connectionId) && entries.size >= (required.maxEntries ?? 100)) return failure({ code: "limit_exceeded", message: "Connection capacity exceeded" });
      entries.set(parsed.value.connectionId, parsed.value);
      return success({ value: undefined });
    },
    revoke(input) { entries.delete(input.connectionId); },
    async get(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Connection lookup cancelled" });
      const connection = entries.get(input.connectionId);
      if (!connection) return failure({ code: "forbidden", message: "Connection unavailable" });
      if (!sameScope({ context: input.context, connection })) return failure({ code: "forbidden", message: "Connection scope mismatch" });
      return parseJson({ schema: connectionSchema, input: connection, maxBytes: 4096 });
    },
  };
  for (const connection of required.entries ?? []) port.put({ connection });
  return port;
}
/** Explicit memory broker controls store only opaque references. */
export interface MemoryCredential extends FederationCredentialPort {
  put(required: { connectionId: string; credentialReference: string }): Outcome<void>;
  revoke(required: { connectionId: string }): void;
}
/** Missing/revoked credentials deny; no tokens/configuration are created. @complexity O(1), <=100 entries. */
export function createMemoryFederationCredential(required: { entries?: readonly { connectionId: string; credentialReference: string }[] }): MemoryCredential {
  const references = new Map<string, string>();
  const port: MemoryCredential = {
    put(input) {
      const parsed = parseBoundary({ schema: idSchema, input: input.credentialReference });
      if (!parsed.ok) return parsed;
      if (!references.has(input.connectionId) && references.size >= 100) return failure({ code: "limit_exceeded", message: "Credential capacity exceeded" });
      references.set(input.connectionId, parsed.value);
      return success({ value: undefined });
    },
    revoke(input) { references.delete(input.connectionId); },
    async authorizeUse(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Credential use cancelled" });
      const credentialReference = references.get(input.connectionId);
      if (!credentialReference) return failure({ code: "forbidden", message: "Credential use denied" });
      return success({ value: { credentialReference } });
    },
  };
  for (const entry of required.entries ?? []) port.put(entry);
  return port;
}
/** Explicit server-owned test classification; nothing is inferred from the tool name. */
export interface MemoryPermissionGate extends FederatedToolPermissionGate {
  put(required: { toolName: string; effects: readonly EffectCategory[] }): Outcome<void>;
  revoke(required: { toolName: string }): void;
}
/** Classify admitted configured tools; unknown tools fail closed. @complexity O(e), e<=10. */
export function createMemoryFederatedToolPermissionGate(required: { entries?: readonly { toolName: string; effects: readonly EffectCategory[] }[] }): MemoryPermissionGate {
  const effects = new Map<string, readonly EffectCategory[]>();
  const port: MemoryPermissionGate = {
    put(input) {
      if (effects.size >= 1000 && !effects.has(input.toolName)) return failure({ code: "limit_exceeded", message: "Effect capacity exceeded" });
      if (input.effects.length === 0 || input.effects.length > 10) return failure({ code: "invalid_input", message: "Effects required" });
      effects.set(input.toolName, [...input.effects]);
      return success({ value: undefined });
    },
    revoke(input) { effects.delete(input.toolName); },
    async assess(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Assessment cancelled" });
      const categories = effects.get(input.call.toolName);
      if (!categories) return failure({ code: "forbidden", message: "Unknown tool denied" });
      return parseBoundary({ schema: effectEnvelopeSchema, input: { operationId: input.call.operationId, connectionId: input.call.connectionId, argumentsDigest: input.call.argumentsDigest, effects: categories, accountId: null, moneyExposure: null, requiredLimit: null } });
    },
  };
  for (const entry of required.entries ?? []) port.put(entry);
  return port;
}
/** Safety confirmation simulator records independent frozen cards; no callback means no approval. */
export interface MemoryConfirmation extends FederatedCallConfirmation {
  cards(required: Record<string, never>): readonly Invocation[];
}
/**
 * Inject an explicit owner-response simulator; factories never approve on their own.
 * @example createMemoryFederatedCallConfirmation({ approve: async ({ call }) => repoApproval(call) })
 * @complexity O(n) snapshot per card; <=1000 retained cards.
 */
export function createMemoryFederatedCallConfirmation(required: { approve?: (required: Invocation, optional?: CallOptions) => Promise<Outcome<{ readonly approvalId: string }>> }): MemoryConfirmation {
  const cards: Invocation[] = [];
  return {
    cards() { return [...cards]; },
    async confirm(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Confirmation cancelled" });
      if (!required.approve) return failure({ code: "forbidden", message: "Owner confirmation required" });
      if (cards.length >= 1000) return failure({ code: "limit_exceeded", message: "Confirmation capacity exceeded" });
      const call = freezeCall({ call: input.call });
      if (!call.ok) return call;
      const snapshot = snapshotJson({ value: { context: input.context, call: call.value }, maxBytes: 75000 });
      if (!snapshot.ok) return snapshot;
      const card = snapshot.value as Invocation;
      cards.push(card);
      return required.approve(card, options);
    },
  };
}
/** Immutable approval repository test controls; revoke replaces a record rather than mutating a card. */
export interface MemoryApprovalRepo extends ExternalMcpToolApprovalRepoPort {
  put(required: { approval: FederatedApproval }): Outcome<void>;
  revoke(required: { operationId: string }): void;
}
/** Exact scoped records; expiry is checked by host using its injected clock. @complexity O(n), bounded. */
export function createMemoryExternalMcpToolApprovalRepo(required: { entries?: readonly FederatedApproval[] }): MemoryApprovalRepo {
  const approvals = new Map<string, FederatedApproval>();
  const port: MemoryApprovalRepo = {
    put(input) {
      const parsed = parseJson({ schema: approvalSchema, input: input.approval, maxBytes: 75000 });
      if (!parsed.ok) return parsed;
      if (approvals.has(parsed.value.call.operationId)) return failure({ code: "conflict", message: "Approval is immutable" });
      if (approvals.size >= 1000) return failure({ code: "limit_exceeded", message: "Approval capacity exceeded" });
      approvals.set(parsed.value.call.operationId, parsed.value);
      return success({ value: undefined });
    },
    revoke(input) {
      const approval = approvals.get(input.operationId);
      if (approval) approvals.set(input.operationId, { ...approval, revoked: true });
    },
    async get(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Approval lookup cancelled" });
      const approval = approvals.get(input.operationId);
      if (!approval) return failure({ code: "forbidden", message: "Approval missing" });
      if (!sameScope({ context: input.context, connection: { scope: approval.context.scope } })) return failure({ code: "forbidden", message: "Approval scope mismatch" });
      return parseJson({ schema: approvalSchema, input: approval, maxBytes: 75000 });
    },
  };
  for (const approval of required.entries ?? []) port.put({ approval });
  return port;
}

/** Explicit single-use test grants; never a production durable permit store. */
export type MemoryDispatchGrant = Invocation & { readonly permitId: string };
export interface MemoryDispatchGate extends FederatedDispatchGatePort {
  grant(required: { grant: MemoryDispatchGrant }): Outcome<void>;
  revoke(required: { operationId: string }): void;
}

function checkGrant(required: { grants: Map<string, MemoryDispatchGrant>; consumed: Set<string>; input: Invocation; options?: CallOptions }): Outcome<MemoryDispatchGrant> {
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Dispatch cancelled" });
  const grant = required.grants.get(required.input.call.operationId);
  if (!grant) return failure({ code: "forbidden", message: "Dispatch authority missing" });
  if (required.consumed.has(required.input.call.operationId)) return failure({ code: "conflict", message: "Operation already consumed" });
  const left = snapshotJson({ value: { context: grant.context, call: grant.call }, maxBytes: 75000 });
  const right = snapshotJson({ value: required.input, maxBytes: 75000 });
  if (!left.ok || !right.ok) return failure({ code: "invalid_input", message: "Dispatch binding invalid" });
  if (JSON.stringify(left.value) !== JSON.stringify(right.value)) return failure({ code: "forbidden", message: "Dispatch binding mismatch" });
  return success({ value: grant });
}

/** Consume before callback handoff. Revocation is visible via the final synchronous fence probe.
 * @complexity O(n) binding check, <=1000 grants. No retry/reset of consumed operations.
 */
export function createMemoryFederatedDispatchGate(required: { entries?: readonly MemoryDispatchGrant[] }): MemoryDispatchGate {
  const grants = new Map<string, MemoryDispatchGrant>();
  const consumed = new Set<string>();
  const port: MemoryDispatchGate = {
    grant(input) {
      if (grants.has(input.grant.call.operationId) || consumed.has(input.grant.call.operationId)) return failure({ code: "conflict", message: "Operation authority immutable" });
      if (grants.size >= 1000) return failure({ code: "limit_exceeded", message: "Dispatch capacity exceeded" });
      const frozen = snapshotJson({ value: input.grant, maxBytes: 75000 });
      if (!frozen.ok) return frozen;
      grants.set(input.grant.call.operationId, frozen.value as MemoryDispatchGrant);
      return success({ value: undefined });
    },
    revoke(input) { grants.delete(input.operationId); },
    async authorize(input, options) {
      const grant = checkGrant({ grants, consumed, input: { context: input.context, call: input.call }, options });
      if (!grant.ok) return grant;
      return success({ value: { permitId: grant.value.permitId } });
    },
    async dispatch(input, options) {
      const grant = checkGrant({ grants, consumed, input: { context: input.context, call: input.call }, options });
      if (!grant.ok) return grant;
      consumed.add(input.call.operationId);
      return input.execute({ isCurrent: () => grants.get(input.call.operationId) === grant.value });
    },
  };
  for (const grant of required.entries ?? []) port.grant({ grant });
  return port;
}
/** Append-only redacted audit test double; entries expose snapshots, never mutable storage. */
export interface MemoryAudit extends FederationAuditPort {
  entries(required: Record<string, never>): readonly { context: CallContext; operationId: string; outcome: string }[];
}
/** Audit capacity failure is explicit, never deletion or overwrite. @complexity O(n) copy, bounded. */
export function createMemoryFederationAudit(required: { maxEntries?: number }): MemoryAudit {
  const records: { context: CallContext; operationId: string; outcome: string }[] = [];
  return {
    entries() { return [...records]; },
    async record(input) {
      if (records.length >= (required.maxEntries ?? 2000)) return failure({ code: "limit_exceeded", message: "Audit capacity exceeded" });
      const parsed = snapshotJson({ value: input, maxBytes: 8192 });
      if (!parsed.ok) return parsed;
      records.push(parsed.value as typeof input);
      return success({ value: undefined });
    },
  };
}
/** Captured outbound DTOs contain opaque references only and preserve operation/trace identity. */
export interface MemoryMcpTransport extends McpTransportPort {
  calls(required: Record<string, never>): readonly Omit<Parameters<McpTransportPort["invoke"]>[0], "dispatchFence">[];
  disposals(required: Record<string, never>): readonly string[];
}
/**
 * Configured test transport uses the same result validator as the Jini adapters. Missing responder
 * fails explicitly. Dispose drops a simulated session; the next call may reconnect, without replay.
 * @complexity O(n) snapshot; <=1000 captured calls/disposals. No network or processes.
 */
export function createMemoryMcpTransport(required: { respond?: (required: Parameters<McpTransportPort["invoke"]>[0], optional?: CallOptions) => Promise<Outcome<ExternalToolResult>> }): MemoryMcpTransport {
  const calls: Omit<Parameters<McpTransportPort["invoke"]>[0], "dispatchFence">[] = [];
  const disposals: string[] = [];
  return {
    calls() { return [...calls]; },
    disposals() { return [...disposals]; },
    async invoke(input, options) {
      if (options?.signal?.aborted) return failure({ code: "cancelled", message: "Transport cancelled" });
      if (!required.respond) return failure({ code: "unavailable", message: "Test responder missing" });
      if (calls.length >= 1000) return failure({ code: "limit_exceeded", message: "Transport capture capacity exceeded" });
      const parsed = validateOutbound(input);
      if (!parsed.ok) return parsed;
      const outbound = parsed.value;
      if (!input.dispatchFence?.isCurrent()) return failure({ code: "forbidden", message: "Dispatch fence revoked" });
      calls.push(outbound);
      const result = await respondSafely({ respond: required.respond, outbound: { ...outbound, dispatchFence: input.dispatchFence }, options });
      if (!result.ok) return result;
      return validateResult({ input: result.value, operationId: input.call.operationId, maxBytes: 262144, maxContent: 100 });
    },
    async dispose(input) {
      if (disposals.length >= 1000) return failure({ code: "limit_exceeded", message: "Disposal capture capacity exceeded" });
      disposals.push(input.connectionId);
      return success({ value: undefined });
    },
  };
}

/** Narrow simulator ABI wrapper matches transport uncertainty after handoff. */
async function respondSafely(required: { respond: NonNullable<Parameters<typeof createMemoryMcpTransport>[0]["respond"]>; outbound: Parameters<McpTransportPort["invoke"]>[0]; options?: CallOptions }): Promise<Outcome<ExternalToolResult>> {
  try { return await required.respond(required.outbound, required.options); }
  catch { return success({ value: { operationId: required.outbound.call.operationId, status: "unknown", content: [] } }); }
}

/** Redacted bounded observation double; diagnostics have no authority and may drop at capacity. */
export interface MemoryFederationObserver extends FederationObserverPort {
  entries(required: Record<string, never>): readonly ObserverEvent[];
}

/** Retain independent event snapshots, up to 1000; malformed diagnostics are discarded.
 * @example createMemoryFederationObserver({}).entries({})
 * @complexity O(n) bounded event copying; O(e) entries copy, e<=1000.
 */
export function createMemoryFederationObserver(required: Record<string, never>): MemoryFederationObserver {
  const records: ObserverEvent[] = [];
  return {
    entries() { return [...records]; },
    observe(input) {
      if (records.length >= 1000) return;
      const event = { operation: input.operation, outcome: input.outcome, correlationId: input.correlationId,
        traceId: input.traceId, ...(input.runId === undefined ? {} : { runId: input.runId }) };
      const copied = snapshotJson({ value: event, maxBytes: 4096 });
      if (copied.ok) records.push(copied.value as ObserverEvent);
    },
  };
}
