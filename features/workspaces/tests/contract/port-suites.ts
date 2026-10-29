import type { ObserverEvent, ObserverPort } from "@open-marketing/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountBindingLookupPort, ClockPort, MemoryIdentity } from "../../index.js";
import type { RepositoryHarness } from "../fixtures.js";
import { binding, missingWorkspaceId, otherScope, ownerScope, secondScope, ownerContext, unwrap } from "../fixtures.js";

/** Shared behavioral suite: both adapters must enforce the same ownership, uniqueness and isolation. */
export function WorkspaceRepoPortSuite(required: { create: () => RepositoryHarness }) {
  describe("WorkspaceRepoPort behavioral contract", () => {
    let harness: RepositoryHarness;
    beforeEach(() => { harness = required.create(); });
    afterEach(() => { harness.dispose(); });
    it("binds owned accounts in a trusted owner context", async () => {
      const context = ownerContext({ scope: ownerScope });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.find({ context, externalAccountId: binding.externalAccountId })).toEqual({ ok: true, value: binding });
    });
    it("checks scoped existence and rejects injected scope claims", async () => {
      expect(await harness.repo.hasWorkspace({ scope: ownerScope })).toEqual({ ok: true, value: true });
      expect(await harness.repo.hasWorkspace({ scope: { ownerId: "owner-a", workspaceId: otherScope.workspaceId } })).toEqual({ ok: true, value: false });
      expect(await harness.repo.hasWorkspace({ scope: { ...ownerScope, workspaceId: missingWorkspaceId } })).toEqual({ ok: true, value: false });
      expect(await harness.repo.hasWorkspace({ scope: { ...ownerScope, extra: 1 } } as Parameters<typeof harness.repo.hasWorkspace>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("forged principal/scope and other-owner connection cannot create bindings", async () => {
      const context = ownerContext({ scope: ownerScope });
      expect(await harness.repo.bind({ context: { ...context, principal: { kind: "owner", ownerId: "owner-b" } }, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, scope: otherScope } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, connectionId: "connection-b" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.find({ context, externalAccountId: binding.externalAccountId })).toEqual({ ok: true, value: null });
    });
    it("exact replay succeeds; both conflicting identity keys reject and preserve the winner", async () => {
      const context = ownerContext({ scope: ownerScope });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.bind({ context, binding: { ...binding, id: "new-id" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, externalAccountId: "new-account" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, connectionId: "connection-a2" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.find({ context, externalAccountId: binding.externalAccountId })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.find({ context, externalAccountId: "new-account" })).toEqual({ ok: true, value: null });
    });
    it("same vendor account ID and binding ID remain independent across owner/workspace scopes", async () => {
      const context = ownerContext({ scope: ownerScope });
      const other = ownerContext({ scope: otherScope });
      const second = ownerContext({ scope: secondScope });
      const otherBinding = { ...binding, scope: otherScope, connectionId: "connection-b" };
      const secondBinding = { ...binding, scope: secondScope, connectionId: "connection-second" };
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.bind({ context: other, binding: otherBinding })).toEqual({ ok: true, value: otherBinding });
      expect(await harness.repo.bind({ context: second, binding: secondBinding })).toEqual({ ok: true, value: secondBinding });
      expect(await harness.repo.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.find({ context: other, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: otherBinding });
      expect(await harness.repo.find({ context: second, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: secondBinding });
    });
    it("concurrent conflicting binds have one winner and no overwrite", async () => {
      const context = ownerContext({ scope: ownerScope });
      const results = await Promise.all([harness.repo.bind({ context, binding }), harness.repo.bind({ context, binding: { ...binding, id: "competing-id", connectionId: "connection-a2" } })]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toMatchObject([{ ok: false, error: { code: "conflict" } }]);
      const winner = results.find(result => result.ok);
      expect(await harness.repo.find({ context, externalAccountId: "vendor-42" })).toEqual(winner);
    });
    it("pre-cancelled writes have no effects", async () => {
      const context = ownerContext({ scope: ownerScope });
      const controller = new AbortController(); controller.abort();
      expect(await harness.repo.bind({ context, binding }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await harness.repo.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
    });
    it("input/output mutations cannot change persisted ownership or account keys", async () => {
      const context = ownerContext({ scope: ownerScope });
      const input = { ...binding, scope: { ...binding.scope } };
      const saved = unwrap({ result: await harness.repo.bind({ context, binding: input }) });
      input.externalAccountId = "changed-input"; saved.scope.ownerId = "changed-output";
      expect(await harness.repo.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.find({ context, externalAccountId: "changed-input" })).toEqual({ ok: true, value: null });
    });
  });
}

/** Shared identity suite applies to the double and the future integrator-owned Jini adapter. */
export function IdentityPortSuite(required: { create: (input: { clock: ClockPort }) => MemoryIdentity }) {
  describe("IdentityPort behavioral contract", () => {
    it("verifies valid sessions and rejects missing/revoked/expired sessions", async () => {
      let now = 10;
      const port = required.create({ clock: { now() { return now; } } });
      expect(await port.verify({ session: { sessionId: "session-a" } })).toEqual({ ok: true, value: { ownerId: "owner-a", sessionId: "session-a" } });
      expect(await port.verify({ session: { sessionId: "missing" } })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      port.revoke({ sessionId: "session-a" });
      expect(await port.verify({ session: { sessionId: "session-a" } })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      now = 100;
      expect(await port.verify({ session: { sessionId: "expiring" } })).toMatchObject({ ok: false, error: { code: "expired" } });
    });
    it("rejects invalid references and preserves cancellation", async () => {
      const port = required.create({ clock: { now() { return 10; } } });
      expect(await port.verify({ session: { sessionId: "" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const controller = new AbortController(); controller.abort();
      expect(await port.verify({ session: { sessionId: "session-a" } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
  });
}

/** Lookup adapter suite uses the same repository fixture so writes and reads share authority state. */
export function AccountBindingLookupPortSuite(required: { create: () => RepositoryHarness & { lookup: AccountBindingLookupPort } }) {
  describe("AccountBindingLookupPort behavioral contract", () => {
    let harness: RepositoryHarness & { lookup: AccountBindingLookupPort };
    beforeEach(() => { harness = required.create(); });
    afterEach(() => { harness.dispose(); });
    it("finds current bindings only in the requested scope and rejects inconsistent principals", async () => {
      const context = ownerContext({ scope: ownerScope });
      expect(await harness.lookup.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.lookup.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
      const other = ownerContext({ scope: otherScope });
      expect(await harness.lookup.find({ context: other, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
      expect(await harness.lookup.find({ context: { ...context, principal: { kind: "agent", agentInstanceId: "agent", runId: "run" } }, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("lists empty and ordered binding pages without duplicates or an exact-limit cursor", async () => {
      const context = ownerContext({ scope: ownerScope });
      expect(await harness.repo.listAccountBindings({ context, query: { limit: 2 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
      const bindings = [binding, { ...binding, id: "binding-b", externalAccountId: "account-b" }, { ...binding, id: "binding-c", externalAccountId: "account-c" }];
      for (const value of [bindings[2], bindings[0], bindings[1]]) {
        expect(await harness.repo.bind({ context, binding: value })).toEqual({ ok: true, value });
      }
      const first = unwrap({ result: await harness.repo.listAccountBindings({ context, query: { limit: 2 } }) });
      expect(first).toEqual({ items: bindings.slice(0, 2), cursor: "binding-b" });
      const next = unwrap({ result: await harness.repo.listAccountBindings({ context, query: { limit: 2, cursor: first.cursor ?? undefined } }) });
      expect(next).toEqual({ items: [bindings[2]], cursor: null });
      expect(new Set([...first.items, ...next.items].map(item => item.id)).size).toBe(3);
      expect(await harness.repo.listAccountBindings({ context, query: { limit: 3 } })).toEqual({ ok: true, value: { items: bindings, cursor: null } });
    });
    it("isolates listing scope and rejects agents, missing workspaces, invalid bounds and cancellation", async () => {
      const context = ownerContext({ scope: ownerScope });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.listAccountBindings({ context: ownerContext({ scope: otherScope }), query: { limit: 2 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
      expect(await harness.repo.listAccountBindings({ context: ownerContext({ scope: secondScope }), query: { limit: 2 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
      const agentContext = { ...context, principal: { kind: "agent" as const, agentInstanceId: "agent", runId: "run" } };
      expect(await harness.repo.listAccountBindings({ context: agentContext, query: { limit: 2 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const missingContext = ownerContext({ scope: { ...ownerScope, workspaceId: missingWorkspaceId } });
      expect(await harness.repo.listAccountBindings({ context: missingContext, query: { limit: 2 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.listAccountBindings({ context, query: { limit: 0 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await harness.repo.listAccountBindings({ context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const controller = new AbortController(); controller.abort();
      expect(await harness.repo.listAccountBindings({ context, query: { limit: 2 } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    });
  });
}

/** Observer double suite: all trace fields survive and later mutation cannot rewrite events. */
export function WorkspaceObserverPortSuite(required: { create: (input: { events: ObserverEvent[] }) => ObserverPort }) {
  it("preserves immutable observation snapshots", () => {
    const events: ObserverEvent[] = [];
    const observer = required.create({ events });
    const event = { operation: "workspaces.bindAccount", outcome: "forbidden", correlationId: "correlation", traceId: "trace", runId: "run" };
    observer.observe(event); event.traceId = "changed";
    expect(events).toEqual([{ operation: "workspaces.bindAccount", outcome: "forbidden", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  });
}
