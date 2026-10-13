import { describe, expect, it } from "vitest";
import { createFederationHost, createMemoryFederationAudit, createMemoryFederationObserver, createMemoryMcpTransport } from "../index.js";
import type { FederationHostDependencies } from "../index.js";
import { call, context, harness, value } from "./fixtures/domain.js";

describe("Federation host fail-closed edges", () => {
  it.each(["write", "destructive", "ad_spend", "generation", "halt_stop", "conversion"] as const)("requires an exact card for admitted %s calls", async effect => {
    const system = await harness({ effects: [effect] });
    expect((await system.host.invoke(system.invocation)).ok).toBe(true);
    expect(system.dependencies.confirmation.cards({})).toHaveLength(1);
    expect(system.memoryTransport.calls({})).toHaveLength(1);
  });

  it("empty classification never becomes an admitted read", async () => {
    const system = await harness({ effects: [] });
    expect(await system.host.invoke(system.invocation)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(system.dependencies.confirmation.cards({})).toHaveLength(0);
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("returns a typed failure for a malformed invocation before effects", async () => {
    const system = await harness({});
    const invocation = null as unknown as Parameters<typeof system.host.invoke>[0];
    expect(await system.host.invoke(invocation)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(system.memoryTransport.calls({})).toHaveLength(0);
    expect(system.dependencies.confirmation.cards({})).toHaveLength(0);
  });

  it("approval scope comparison is independent of object key order", async () => {
    const system = await harness({ effects: ["write"] });
    expect((await system.host.invoke(system.invocation)).ok).toBe(true);
    const reordered = { ...context, scope: { workspaceId: "workspace", ownerId: "owner" } };
    expect((await system.dependencies.approvalRepo.get({ context: reordered, operationId: "operation" })).ok).toBe(true);
  });
  it.each(["connections", "transport", "credentials", "permissionGate", "confirmation", "approvalRepo", "dispatchGate", "audit", "registry", "clock"] as const)("denies a missing %s port before egress", async name => {
    const system = await harness({});
    const dependencies = { ...system.dependencies, [name]: undefined } as unknown as FederationHostDependencies;
    const host = createFederationHost(dependencies);
    expect(await host.invoke(system.invocation)).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("preserves unknown outcomes for tools with an output schema", async () => {
    const system = await harness({});
    const other = call({ operationId: "unknown-operation", query: "unknown" });
    value({ outcome: system.dependencies.dispatchGate.grant({ grant: { context, call: other, permitId: "unknown-permit" } }) });
    expect(await system.host.invoke({ context, call: other })).toEqual({ ok: true, value: { operationId: "unknown-operation", status: "unknown", content: [] } });
    expect(system.memoryTransport.calls({})).toHaveLength(1);
    expect((await system.host.invoke({ context, call: other })).ok).toBe(false);
    expect(system.memoryTransport.calls({})).toHaveLength(1);
  });

  it("does not require success content for an explicitly failed execution", async () => {
    const transport = createMemoryMcpTransport({ respond: async input => ({ ok: true, value: { operationId: input.call.operationId, status: "failed", content: [{ type: "text", text: "Tool refused the request" }] } }) });
    const system = await harness({ transport });
    expect(await system.host.invoke(system.invocation)).toEqual({ ok: true, value: { operationId: "operation", status: "failed", content: [{ type: "text", text: "Tool refused the request" }] } });
  });

  it("caller mutation during confirmation cannot change the card or outbound call", async () => {
    const system = await harness({ effects: ["write"] });
    const original = system.invocation.call.arguments as Record<string, unknown>;
    const confirm = system.dependencies.confirmation.confirm;
    system.dependencies.confirmation.confirm = async (input, options) => {
      original.query = "tampered";
      expect(Object.isFrozen(input.call.arguments)).toBe(true);
      return confirm(input, options);
    };
    expect((await system.host.invoke(system.invocation)).ok).toBe(true);
    expect(system.dependencies.confirmation.cards({})[0].call.arguments).toEqual({ query: "hello" });
    expect(system.memoryTransport.calls({})[0].call.arguments).toEqual({ query: "hello" });
  });

  it("denies an expired approval at dispatch using the injected clock", async () => {
    const system = await harness({ effects: ["write"] });
    system.dependencies.clock.now = () => 1000;
    expect(await system.host.invoke(system.invocation)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("denies implementation drift after confirmation", async () => {
    const system = await harness({ effects: ["write"] });
    const confirm = system.dependencies.confirmation.confirm;
    system.dependencies.confirmation.confirm = async (input, options) => {
      const result = await confirm(input, options);
      const connection = value({ outcome: await system.dependencies.connections.get({ context, connectionId: "fixture" }) });
      value({ outcome: system.dependencies.connections.put({ connection: { ...connection, pluginDigest: "b".repeat(64) } }) });
      return result;
    };
    expect(await system.host.invoke(system.invocation)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("denies revoked safety classification after confirmation", async () => {
    const system = await harness({ effects: ["write"] });
    const confirm = system.dependencies.confirmation.confirm;
    system.dependencies.confirmation.confirm = async (input, options) => {
      const result = await confirm(input, options);
      system.dependencies.permissionGate.revoke({ toolName: input.call.toolName });
      return result;
    };
    expect((await system.host.invoke(system.invocation)).ok).toBe(false);
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("denies authority revoked during broker lookup at the final transport fence", async () => {
    const system = await harness({});
    const authorize = system.dependencies.credentials.authorizeUse;
    system.dependencies.credentials.authorizeUse = async (input, options) => {
      const result = await authorize(input, options);
      system.dependencies.dispatchGate.revoke({ operationId: input.operationId });
      return result;
    };
    expect((await system.host.invoke(system.invocation)).ok).toBe(false);
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("intent audit failure denies egress", async () => {
    const system = await harness({});
    const audit = createMemoryFederationAudit({ maxEntries: 0 });
    const host = createFederationHost({ ...system.dependencies, audit });
    expect(await host.invoke(system.invocation)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(system.memoryTransport.calls({})).toHaveLength(0);
  });

  it("completion audit failure maps the dispatched result to unknown and prevents replay", async () => {
    const system = await harness({});
    const audit = createMemoryFederationAudit({ maxEntries: 1 });
    const host = createFederationHost({ ...system.dependencies, audit });
    expect(await host.invoke(system.invocation)).toEqual({ ok: true, value: { operationId: "operation", status: "unknown", content: [] } });
    expect(audit.entries({})).toHaveLength(1);
    expect(system.memoryTransport.calls({})).toHaveLength(1);
    expect((await host.invoke(system.invocation)).ok).toBe(false);
    expect(system.memoryTransport.calls({})).toHaveLength(1);
  });

  it("rejects schema-invalid successful output", async () => {
    const transport = createMemoryMcpTransport({ respond: async input => ({ ok: true, value: { operationId: input.call.operationId, status: "succeeded", content: [{ type: "json", data: { echo: 42 } }] } }) });
    const system = await harness({ transport });
    expect(await system.host.invoke(system.invocation)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(transport.calls({})).toHaveLength(1);
  });

  it("foreign-scope reload cannot invalidate the catalog", async () => {
    const system = await harness({});
    expect((await system.host.reload({ context: { ...context, scope: { ...context.scope, ownerId: "other" } }, connectionId: "fixture" })).ok).toBe(false);
    expect((await system.dependencies.registry.resolve({ name: system.tool.name })).ok).toBe(true);
    expect(system.memoryTransport.disposals({})).toHaveLength(0);
  });

  it("emits redacted trace observations and tolerates diagnostic failures", async () => {
    const system = await harness({});
    const observer = createMemoryFederationObserver({});
    const host = createFederationHost(system.dependencies, { observer });
    expect((await host.invoke(system.invocation)).ok).toBe(true);
    expect(observer.entries({})).toEqual([{ operation: "federation.invoke", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    const next = call({ operationId: "next" });
    value({ outcome: system.dependencies.dispatchGate.grant({ grant: { context, call: next, permitId: "next-permit" } }) });
    const broken = createFederationHost(system.dependencies, { observer: { observe() { throw new Error("secret diagnostic error"); } } });
    expect((await broken.invoke({ context, call: next })).ok).toBe(true);
  });
});
