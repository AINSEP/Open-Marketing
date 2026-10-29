import type { ObserverPort } from "@open-marketing/contracts";
import { describe, it, expect } from "vitest";
import type {
  FederationConnectionRepoPort, McpTransportPort, FederationCredentialPort, FederatedToolPermissionGate,
  FederatedCallConfirmation, ExternalMcpToolApprovalRepoPort, FederatedDispatchGatePort, FederationAuditPort, ToolRegistryPort,
} from "../../index.js";
import { context, call, connection, descriptor, echoResult } from "../fixtures/domain.js";

/** Shared behavioral suite; create supplies the configured fixture connection. */
export function FederationConnectionRepoPortSuite(required: { create: () => FederationConnectionRepoPort }) {
  describe("FederationConnectionRepoPort", () => {
    it("returns only a scoped connection", async () => {
      const port = required.create();
      expect(await port.get({ context, connectionId: "fixture" })).toEqual({ ok: true, value: connection });
      expect((await port.get({ context: { ...context, scope: { ...context.scope, ownerId: "other" } }, connectionId: "fixture" })).ok).toBe(false);
    });
    it("denies unknown connections and cancellation", async () => {
      const port = required.create();
      expect((await port.get({ context, connectionId: "unknown" })).ok).toBe(false);
      expect((await port.get({ context, connectionId: "fixture" }, { signal: AbortSignal.abort() })).ok).toBe(false);
    });
  });
}
export type TransportFixture = { port: McpTransportPort; cleanup: () => Promise<void> };

/** Cleanup is guaranteed for memory, real HTTP and child-process stdio transports alike. */
async function transportCase(required: { create: () => Promise<TransportFixture>; assert: (required: { port: McpTransportPort }) => Promise<void> }): Promise<void> {
  const fixture = await required.create();
  try { await required.assert({ port: fixture.port }); }
  finally { await fixture.cleanup(); }
}

/** The SAME transport suite runs against memory and real local HTTP/stdio fixtures. */
export function McpTransportPortSuite(required: { name: string; create: () => Promise<TransportFixture> }) {
  describe(`McpTransportPort (${required.name})`, () => {
    it("preserves exact arguments, stable operation ID and all trace IDs at the remote tool", async () => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        const request = call({});
        const result = await port.invoke({ context, call: request, credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } });
        expect(result).toEqual({ ok: true, value: echoResult({ call: request, context }) });
      } });
    });
    it("rejects a bad digest before egress", async () => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        const result = await port.invoke({ context, call: { ...call({}), argumentsDigest: "0".repeat(64) }, credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } });
        expect(result.ok).toBe(false);
      } });
    });
    it("denies cancellation before handoff", async () => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        expect((await port.invoke({ context, call: call({}), credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } }, { signal: AbortSignal.abort() })).ok).toBe(false);
      } });
    });
    it("denies a revoked dispatch fence before handoff", async () => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        const result = await port.invoke({ context, call: call({}), credentialReference: "broker-reference", dispatchFence: { isCurrent: () => false } });
        expect(result.ok).toBe(false);
      } });
    });
    it.each(["tainted", "oversized", "invalid"])("rejects %s MCP results", async query => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        const result = await port.invoke({ context, call: call({ query }), credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.retryable).toBe(false);
      } });
    });
    it("maps uncertain non-idempotent outcomes without retrying", async () => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        const result = await port.invoke({ context, call: call({ query: "unknown" }), credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } });
        expect(result).toEqual({ ok: true, value: { operationId: "operation", status: "unknown", content: [] } });
      } });
    });
    it("disposes idempotently and reconnects on a distinct operation", async () => {
      await transportCase({ create: required.create, assert: async ({ port }) => {
        expect((await port.invoke({ context, call: call({}), credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } })).ok).toBe(true);
        expect(await port.dispose({ connectionId: "fixture" })).toEqual({ ok: true, value: undefined });
        expect(await port.dispose({ connectionId: "fixture" })).toEqual({ ok: true, value: undefined });
        const request = call({ operationId: "next-operation" });
        expect(await port.invoke({ context, call: request, credentialReference: "broker-reference", dispatchFence: { isCurrent: () => true } })).toEqual({ ok: true, value: echoResult({ context, call: request }) });
      } });
    });
  });
}

/** Diagnostics preserve operation/trace identity as independent redacted snapshots. */
export function FederationObserverPortSuite(required: { create: () => ObserverPort; read: (required: { port: ObserverPort }) => readonly unknown[] }): void {
  describe("FederationObserverPort", () => {
    it("retains independent observations in order", () => {
      const port = required.create();
      const event = { operation: "federation.invoke", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" };
      port.observe(event);
      event.outcome = "unknown";
      port.observe(event);
      expect(required.read({ port })).toEqual([{ ...event, outcome: "succeeded" }, event]);
    });
  });
}

/** Configured reference, never secret material, is the credential boundary's only success payload. */
export function FederationCredentialPortSuite(required: { create: () => FederationCredentialPort }) {
  describe("FederationCredentialPort", () => {
    it("returns only an opaque reference and denies unknown connections", async () => {
      const port = required.create();
      expect(await port.authorizeUse({ context, connectionId: "fixture", operationId: "operation" })).toEqual({ ok: true, value: { credentialReference: "broker-reference" } });
      expect((await port.authorizeUse({ context, connectionId: "unknown", operationId: "operation" })).ok).toBe(false);
    });
  });
}
export function FederatedToolPermissionGateSuite(required: { create: () => FederatedToolPermissionGate }) {
  describe("FederatedToolPermissionGate", () => {
    it("binds read classification to the actual operation and digest", async () => {
      const request = call({});
      const result = await required.create().assess({ context, call: request });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ operationId: request.operationId, connectionId: request.connectionId, argumentsDigest: request.argumentsDigest, effects: ["read"] });
    });
    it("denies unknown tools", async () => {
      expect((await required.create().assess({ context, call: { ...call({}), toolName: "io.github.ainsep.openmarketing.fixture.unknown" } })).ok).toBe(false);
    });
  });
}
export function FederatedCallConfirmationSuite(required: { create: () => FederatedCallConfirmation }) {
  describe("FederatedCallConfirmation", () => {
    it("returns the explicit exact-card approval response", async () => {
      expect(await required.create().confirm({ context, call: call({}) })).toEqual({ ok: true, value: { approvalId: "approval" } });
    });
    it("does not approve malformed arguments", async () => {
      expect((await required.create().confirm({ context, call: { ...call({}), arguments: { query: "changed" } } })).ok).toBe(false);
    });
  });
}
export function ExternalMcpToolApprovalRepoPortSuite(required: { create: () => ExternalMcpToolApprovalRepoPort }) {
  describe("ExternalMcpToolApprovalRepoPort", () => {
    it("returns the entire immutable binding", async () => {
      const result = await required.create().get({ context, operationId: "operation" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toMatchObject({ approvalId: "approval", context, call: call({}), argumentsDigest: call({}).argumentsDigest });
    });
    it("denies absent and foreign-scope approvals", async () => {
      const port = required.create();
      expect((await port.get({ context, operationId: "other" })).ok).toBe(false);
      expect((await port.get({ context: { ...context, scope: { ...context.scope, ownerId: "other" } }, operationId: "operation" })).ok).toBe(false);
    });
  });
}
export function FederatedDispatchGatePortSuite(required: { create: () => FederatedDispatchGatePort }) {
  describe("FederatedDispatchGatePort", () => {
    it("single-use operation permits cannot dispatch twice", async () => {
      const port = required.create();
      let dispatches = 0;
      const invocation = { context, call: call({}), execute: async () => { dispatches += 1; return { ok: true as const, value: echoResult({ context, call: call({}) }) }; } };
      expect((await port.authorize(invocation)).ok).toBe(true);
      expect((await port.dispatch(invocation)).ok).toBe(true);
      expect((await port.dispatch(invocation)).ok).toBe(false);
      expect(dispatches).toBe(1);
    });
    it("denies changed arguments and unknown operations without executing", async () => {
      const port = required.create();
      let dispatches = 0;
      const execute = async () => { dispatches += 1; return { ok: true as const, value: echoResult({ context, call: call({}) }) }; };
      expect((await port.dispatch({ context, call: call({ query: "other" }), execute })).ok).toBe(false);
      expect((await port.dispatch({ context, call: call({ operationId: "other" }), execute })).ok).toBe(false);
      expect(dispatches).toBe(0);
    });
  });
}
export function FederationAuditPortSuite(required: { create: () => FederationAuditPort; read: (required: { port: FederationAuditPort }) => readonly unknown[] }) {
  describe("FederationAuditPort", () => {
    it("appends evidence with operation and trace context without overwriting", async () => {
      const port = required.create();
      expect((await port.record({ context, operationId: "operation", outcome: "dispatch_requested" })).ok).toBe(true);
      expect((await port.record({ context, operationId: "operation", outcome: "unknown" })).ok).toBe(true);
      expect(required.read({ port })).toEqual([{ context, operationId: "operation", outcome: "dispatch_requested" }, { context, operationId: "operation", outcome: "unknown" }]);
    });
  });
}
export function ToolRegistryPortSuite(required: { create: () => ToolRegistryPort }) {
  describe("ToolRegistryPort", () => {
    it("rejects collisions and supports unregister/reset", async () => {
      const port = required.create();
      const tool = descriptor({});
      expect((await port.register({ descriptor: tool })).ok).toBe(true);
      expect((await port.register({ descriptor: tool })).ok).toBe(false);
      expect(await port.resolve({ name: tool.name })).toEqual({ ok: true, value: tool });
      await port.unregister({ name: tool.name });
      expect((await port.resolve({ name: tool.name })).ok).toBe(false);
      expect((await port.register({ descriptor: tool })).ok).toBe(true);
      await port.reset({});
      expect((await port.resolve({ name: tool.name })).ok).toBe(false);
      expect((await port.register({ descriptor: tool })).ok).toBe(true);
    });
    it("disposal is terminal and idempotent", async () => {
      const port = required.create();
      await port.register({ descriptor: descriptor({}) });
      expect((await port.dispose({})).ok).toBe(true);
      expect((await port.dispose({})).ok).toBe(true);
      expect((await port.register({ descriptor: descriptor({}) })).ok).toBe(false);
      expect((await port.reset({})).ok).toBe(false);
    });
    it("invalidates one connection without deleting another", async () => {
      const port = required.create();
      const tool = descriptor({});
      const other = { ...tool, name: "io.github.ainsep.openmarketing.other.echo", connectionId: "other" };
      await port.register({ descriptor: tool });
      await port.register({ descriptor: other });
      await port.invalidate({ connectionId: "fixture" });
      expect((await port.resolve({ name: tool.name })).ok).toBe(false);
      expect((await port.resolve({ name: other.name })).ok).toBe(true);
    });
  });
}
