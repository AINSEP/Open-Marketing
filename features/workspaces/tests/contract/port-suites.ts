import type { ObserverEvent } from "@open-marketing/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountBindingLookupPort, ClockPort, MemoryIdentity, WorkspaceObserverPort } from "../../index.js";
import type { RepositoryHarness } from "../fixtures.js";
import { binding, missingWorkspaceId, otherScope, ownerScope, secondScope, resolveOwner, unwrap } from "../fixtures.js";

/** Shared behavioral suite: both adapters must enforce the same ownership, uniqueness and isolation. */
export function WorkspaceRepoPortSuite(required: { create: () => RepositoryHarness }) {
  describe("WorkspaceRepoPort behavioral contract", () => {
    let harness: RepositoryHarness;
    beforeEach(() => { harness = required.create(); });
    afterEach(() => { harness.dispose(); });
    it("valid owner resolves and binds owned account", async () => {
      const context = await resolveOwner({ repo: harness.repo });
      expect(context.scope).toEqual(ownerScope);
      expect(context.principal).toEqual({ kind: "owner", ownerId: ownerScope.ownerId });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.find({ context, externalAccountId: binding.externalAccountId })).toEqual({ ok: true, value: binding });
    });
    it("unknown sessions and other-owner/missing workspaces fail", async () => {
      expect(await harness.repo.resolve({ session: { sessionId: "unknown" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
      expect(await harness.repo.resolve({ session: { sessionId: "session-a" }, workspaceId: otherScope.workspaceId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.resolve({ session: { sessionId: "session-a" }, workspaceId: missingWorkspaceId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("forged principal/scope and other-owner connection cannot create bindings", async () => {
      const context = await resolveOwner({ repo: harness.repo });
      expect(await harness.repo.bind({ context: { ...context, principal: { kind: "owner", ownerId: "owner-b" } }, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, scope: otherScope } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, connectionId: "connection-b" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await harness.repo.find({ context, externalAccountId: binding.externalAccountId })).toEqual({ ok: true, value: null });
    });
    it("exact replay succeeds; both conflicting identity keys reject and preserve the winner", async () => {
      const context = await resolveOwner({ repo: harness.repo });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.bind({ context, binding: { ...binding, id: "new-id" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, externalAccountId: "new-account" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.bind({ context, binding: { ...binding, connectionId: "connection-a2" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await harness.repo.find({ context, externalAccountId: binding.externalAccountId })).toEqual({ ok: true, value: binding });
      expect(await harness.repo.find({ context, externalAccountId: "new-account" })).toEqual({ ok: true, value: null });
    });
    it("same vendor account ID and binding ID remain independent across owner/workspace scopes", async () => {
      const context = await resolveOwner({ repo: harness.repo });
      const other = unwrap({ result: await harness.repo.resolve({ session: { sessionId: "session-b" }, workspaceId: otherScope.workspaceId }) });
      const second = unwrap({ result: await harness.repo.resolve({ session: { sessionId: "session-a" }, workspaceId: secondScope.workspaceId }) });
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
      const context = await resolveOwner({ repo: harness.repo });
      const results = await Promise.all([harness.repo.bind({ context, binding }), harness.repo.bind({ context, binding: { ...binding, id: "competing-id", connectionId: "connection-a2" } })]);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toMatchObject([{ ok: false, error: { code: "conflict" } }]);
      const winner = results.find(result => result.ok);
      expect(await harness.repo.find({ context, externalAccountId: "vendor-42" })).toEqual(winner);
    });
    it("pre-cancelled writes have no effects and boundary schemas reject claim injection", async () => {
      const context = await resolveOwner({ repo: harness.repo });
      const controller = new AbortController(); controller.abort();
      expect(await harness.repo.bind({ context, binding }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(await harness.repo.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
      expect(await harness.repo.resolve({ session: { sessionId: "session-a", ownerId: "owner-b" }, workspaceId: ownerScope.workspaceId } as Parameters<typeof harness.repo.resolve>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("input/output mutations cannot change persisted ownership or account keys", async () => {
      const context = await resolveOwner({ repo: harness.repo });
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
      const context = await resolveOwner({ repo: harness.repo });
      expect(await harness.lookup.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      expect(await harness.lookup.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
      const other = unwrap({ result: await harness.repo.resolve({ session: { sessionId: "session-b" }, workspaceId: otherScope.workspaceId }) });
      expect(await harness.lookup.find({ context: other, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
      expect(await harness.lookup.find({ context: { ...context, principal: { kind: "agent", agentInstanceId: "agent", runId: "run" } }, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
  });
}

/** Observer double suite: all trace fields survive and later mutation cannot rewrite events. */
export function WorkspaceObserverPortSuite(required: { create: (input: { events: ObserverEvent[] }) => WorkspaceObserverPort }) {
  it("preserves immutable observation snapshots", () => {
    const events: ObserverEvent[] = [];
    const observer = required.create({ events });
    const event = { operation: "workspaces.bindAccount", outcome: "forbidden", correlationId: "correlation", traceId: "trace", runId: "run" };
    observer.observe(event); event.traceId = "changed";
    expect(events).toEqual([{ operation: "workspaces.bindAccount", outcome: "forbidden", correlationId: "correlation", traceId: "trace", runId: "run" }]);
  });
}
