import { callContextSchema, idSchema, parseBoundary } from "@open-marketing/contracts";
import type { CallContext, CallOptions, ClockPort, Outcome } from "@open-marketing/contracts";
import type {
  FederationConnectionRepoPort, McpTransportPort, FederationCredentialPort,
  FederatedToolPermissionGate, FederatedCallConfirmation, ExternalMcpToolApprovalRepoPort,
  FederatedDispatchGatePort, FederationAuditPort, ToolRegistryPort, FederationObserverPort,
} from "./ports.js";
import type { ExternalToolCall, ExternalToolResult, FederationHost, ReloadReceipt } from "./types.js";
import { admitCall, isReadOnly } from "./admission.js";
import { snapshotJson } from "./json.js";
import { boundary, failure, success } from "./outcomes.js";
import { connectionSchema, freezeCall, parseJson, sameScope, validateApproval, validateResult } from "./validation.js";

/** Required server ports. Composition owns implementations and durable authority. */
export type FederationHostDependencies = {
  connections: FederationConnectionRepoPort;
  transport: McpTransportPort;
  credentials: FederationCredentialPort;
  permissionGate: FederatedToolPermissionGate;
  confirmation: FederatedCallConfirmation;
  approvalRepo: ExternalMcpToolApprovalRepoPort;
  dispatchGate: FederatedDispatchGatePort;
  audit: FederationAuditPort;
  registry: ToolRegistryPort;
  clock: ClockPort;
};
type Invocation = { context: CallContext; call: ExternalToolCall };
type Workflow = { dependencies: FederationHostDependencies; invocation: Invocation; current: () => boolean; observer?: FederationObserverPort };

/** Missing even one gate fails closed at invocation, rather than throwing or granting authority. */
function hasDependencies(required: { dependencies: FederationHostDependencies }): boolean {
  const d = required.dependencies;
  const methods = [d?.connections?.get, d?.transport?.invoke, d?.transport?.dispose,
    d?.credentials?.authorizeUse, d?.permissionGate?.assess, d?.confirmation?.confirm,
    d?.approvalRepo?.get, d?.dispatchGate?.authorize, d?.dispatchGate?.dispatch,
    d?.audit?.record, d?.registry?.resolve, d?.registry?.invalidate, d?.clock?.now];
  return methods.every(method => typeof method === "function");
}

/** Parse context and freeze it independently of the caller; no effects before validation. */
function parseInvocation(required: { invocation: Invocation }): Outcome<Invocation> {
  if (!required.invocation || typeof required.invocation !== "object") return failure({ code: "invalid_input", message: "Invocation object required" });
  const context = parseJson({ schema: callContextSchema, input: required.invocation.context, maxBytes: 4096 });
  if (!context.ok) return context;
  const call = freezeCall({ call: required.invocation.call });
  if (!call.ok) return call;
  const frozen = snapshotJson({ value: context.value, maxBytes: 4096 });
  if (!frozen.ok) return frozen;
  return success({ value: { context: frozen.value as CallContext, call: call.value } });
}

/** Observers are best-effort diagnostics; required audit is a separate fail-closed boundary. */
function observe(required: { workflow: Workflow; outcome: string }): void {
  try {
    required.workflow.observer?.observe({ operation: "federation.invoke", outcome: required.outcome, correlationId: required.workflow.invocation.context.correlationId, traceId: required.workflow.invocation.context.traceId, runId: required.workflow.invocation.context.runId });
  } catch {
    // Diagnostics cannot turn a dispatched operation into an apparent retryable failure.
  }
}

/** Confirm once per non-read operation; IDs alone never constitute authority. */
async function confirmCall(required: { workflow: Workflow }, optional?: CallOptions): Promise<Outcome<string | null>> {
  const { dependencies, invocation } = required.workflow;
  const admitted = await admitCall({ dependencies, ...invocation }, optional);
  if (!admitted.ok) return admitted;
  if (isReadOnly({ admission: admitted.value })) return success({ value: null });
  const confirmation = await boundary({ perform: () => dependencies.confirmation.confirm(invocation, optional) });
  if (!confirmation.ok) return confirmation;
  const validId = parseBoundary({ schema: idSchema, input: confirmation.value.approvalId });
  if (!validId.ok) return validId;
  return success({ value: validId.value });
}

/** Recheck current immutable approval immediately inside the dispatch authority fence. */
async function recheckApproval(required: { workflow: Workflow; approvalId: string | null }, optional?: CallOptions): Promise<Outcome<void>> {
  if (required.approvalId === null) return success({ value: undefined });
  const { dependencies, invocation } = required.workflow;
  const approval = await boundary({ perform: () => dependencies.approvalRepo.get({ context: invocation.context, operationId: invocation.call.operationId }, optional) });
  if (!approval.ok) return approval;
  const now = dependencies.clock.now({});
  if (!Number.isSafeInteger(now) || now < 0) return failure({ code: "unavailable", message: "Invalid server clock" });
  const checked = validateApproval({ approval: approval.value, ...invocation, approvalId: required.approvalId, now });
  if (!checked.ok) return checked;
  return success({ value: undefined });
}

function dispatchReady(required: { workflow: Workflow; options?: CallOptions }): Outcome<void> {
  if (required.options?.signal?.aborted) return failure({ code: "cancelled", message: "Call cancelled before dispatch" });
  if (!required.workflow.current()) return failure({ code: "conflict", message: "Connection reloaded during invocation" });
  return success({ value: undefined });
}

/**
 * Executed under the injected gate's authority fence: current admission, approval and credential
 * checks precede handoff. Never retry an unknown outcome; result validation is after egress.
 * @complexity Bounded JSON/schema work plus constant sequential port calls.
 */
async function dispatchCurrent(required: { workflow: Workflow; approvalId: string | null }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>> {
  const { workflow } = required;
  const { dependencies, invocation } = workflow;
  const admitted = await admitCall({ dependencies, ...invocation }, optional);
  if (!admitted.ok) return admitted;
  if (required.approvalId === null && !isReadOnly({ admission: admitted.value })) return failure({ code: "forbidden", message: "Tool effects changed after admission" });
  const approved = await recheckApproval(required, optional);
  if (!approved.ok) return approved;
  const credential = await boundary({ perform: () => dependencies.credentials.authorizeUse({ context: invocation.context, connectionId: invocation.call.connectionId, operationId: invocation.call.operationId }, optional) });
  if (!credential.ok) return credential;
  const reference = parseBoundary({ schema: idSchema, input: credential.value.credentialReference });
  if (!reference.ok) return reference;
  const ready = dispatchReady({ workflow, options: optional });
  if (!ready.ok) return ready;
  const result = await boundary({ perform: () => dependencies.transport.invoke({ ...invocation, credentialReference: reference.value, dispatchFence: { isCurrent: workflow.current } }, optional) });
  if (!result.ok) return result;
  return validateResult({ input: result.value, operationId: invocation.call.operationId, maxBytes: 262144, maxContent: 100, outputSchema: admitted.value.descriptor.outputSchema });
}

/** Append intent before egress; audit completion failures map dispatched outcomes to unknown. */
async function runAudited(required: { workflow: Workflow; approvalId: string | null }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>> {
  const { dependencies, invocation } = required.workflow;
  const preflight = await boundary({ perform: () => dependencies.dispatchGate.authorize(invocation, optional) });
  if (!preflight.ok) return preflight;
  const started = await boundary({ perform: () => dependencies.audit.record({ context: invocation.context, operationId: invocation.call.operationId, outcome: "dispatch_requested" }, optional) });
  if (!started.ok) return started;
  const result = await boundary({ perform: () => dependencies.dispatchGate.dispatch({ ...invocation, execute: fence => dispatchCurrent({ ...required, workflow: { ...required.workflow, current: () => required.workflow.current() && fence.isCurrent() } }, optional) }, optional) });
  const outcome = result.ok ? result.value.status : result.error.code;
  const audited = await boundary({ perform: () => dependencies.audit.record({ context: invocation.context, operationId: invocation.call.operationId, outcome }, optional) });
  if (!audited.ok) return success({ value: { operationId: invocation.call.operationId, status: "unknown", content: [] } });
  return result;
}

/** Record pre-dispatch denials as well; no raw errors or arguments enter observation/audit. */
async function runInvocation(required: { workflow: Workflow }, optional?: CallOptions): Promise<Outcome<ExternalToolResult>> {
  const ready = dispatchReady({ workflow: required.workflow, options: optional });
  if (!ready.ok) return ready;
  const confirmed = await confirmCall(required, optional);
  if (!confirmed.ok) {
    await boundary({ perform: () => required.workflow.dependencies.audit.record({ context: required.workflow.invocation.context, operationId: required.workflow.invocation.call.operationId, outcome: confirmed.error.code }, optional) });
    observe({ workflow: required.workflow, outcome: confirmed.error.code });
    return confirmed;
  }
  const result = await runAudited({ ...required, approvalId: confirmed.value }, optional);
  observe({ workflow: required.workflow, outcome: result.ok ? result.value.status : result.error.code });
  return result;
}

/**
 * Inert gateway factory. Inject all server effects; admitted reads skip cards and other effects
 * require exact current confirmation. Reload invalidates catalog and fences pending invocations.
 * @returns Host returning redacted typed failures; no startup, automatic replay or live spend.
 * @example createFederationHost({ connections, transport, credentials, permissionGate, confirmation, approvalRepo, dispatchGate, audit, registry, clock })
 * @complexity O(1) construction; bounded JSON/schema work per call, <=100 tracked connections.
 */
export function createFederationHost(required: FederationHostDependencies, optional?: { observer?: FederationObserverPort }): FederationHost {
  const revisions = new Map<string, number>();
  return {
    async invoke(input, options) {
      if (!hasDependencies({ dependencies: required })) return failure({ code: "forbidden", message: "Required federation gate missing" });
      const parsed = parseInvocation({ invocation: input });
      if (!parsed.ok) return parsed;
      const revision = revisions.get(parsed.value.call.connectionId) ?? 0;
      const workflow: Workflow = { dependencies: required, invocation: parsed.value, observer: optional?.observer, current: () => (revisions.get(parsed.value.call.connectionId) ?? 0) === revision };
      return boundary({ perform: () => runInvocation({ workflow }, options) });
    },
    async reload(input, options) {
      if (!hasDependencies({ dependencies: required })) return failure({ code: "forbidden", message: "Required federation gate missing" });
      const context = parseJson({ schema: callContextSchema, input: input.context, maxBytes: 4096 });
      if (!context.ok) return context;
      const connectionId = parseBoundary({ schema: idSchema, input: input.connectionId });
      if (!connectionId.ok) return connectionId;
      return reloadConnection({ dependencies: required, context: context.value, connectionId: connectionId.value, revisions }, options);
    },
  };
}

/** Verify lookup binding, then mark revision before catalog/session effects so pending calls are fenced.
 * @returns Typed lookup/cleanup failure or revision receipt. @complexity O(1) revision update, <=100 keys.
 */
async function reloadConnection(required: { dependencies: FederationHostDependencies; context: CallContext; connectionId: string; revisions: Map<string, number> }, optional?: CallOptions): Promise<Outcome<ReloadReceipt>> {
  if (!required.revisions.has(required.connectionId) && required.revisions.size >= 100) return failure({ code: "limit_exceeded", message: "Reload connection limit exceeded" });
  const found = await boundary({ perform: () => required.dependencies.connections.get({ context: required.context, connectionId: required.connectionId }, optional) });
  if (!found.ok) return found;
  const connection = parseJson({ schema: connectionSchema, input: found.value, maxBytes: 4096 });
  if (!connection.ok) return connection;
  if (!sameScope({ context: required.context, connection: connection.value }) || connection.value.connectionId !== required.connectionId) return failure({ code: "forbidden", message: "Connection binding mismatch" });
  if (!required.revisions.has(required.connectionId) && required.revisions.size >= 100) return failure({ code: "limit_exceeded", message: "Reload connection limit exceeded" });
  const revision = (required.revisions.get(required.connectionId) ?? 0) + 1;
  required.revisions.set(required.connectionId, revision);
  const invalidated = await boundary({ perform: () => required.dependencies.registry.invalidate({ connectionId: required.connectionId }, optional) });
  if (!invalidated.ok) return invalidated;
  const disposed = await boundary({ perform: () => required.dependencies.transport.dispose({ connectionId: required.connectionId }, optional) });
  if (!disposed.ok) return disposed;
  return success({ value: { connectionId: required.connectionId, revision } });
}
