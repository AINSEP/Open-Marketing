import type { ObserverEvent } from "@open-marketing/contracts";
import { describe, expect, it } from "vitest";
import { createWorkspaceService, createMemoryWorkspaceRepo, createMemoryIdentity, createMemoryWorkspaceObserver } from "../index.js";
import type { CallContext, IdentityPort, WorkspaceRepoPort } from "../index.js";
import { binding, ownerScope, connections, createIds, otherScope, sessions, unwrap, workspaces } from "./fixtures.js";

function createHarness(required: { identity?: IdentityPort; repo?: WorkspaceRepoPort } = {}) {
  let now = 100;
  const identity = required.identity ?? createMemoryIdentity({ sessions });
  const storage = createMemoryWorkspaceRepo({ workspaces, connections });
  const repo = required.repo ?? storage;
  const events: ObserverEvent[] = [];
  const service = createWorkspaceService({ repo, identity, ids: createIds({}), clock: { now() { return now; } } }, { observer: createMemoryWorkspaceObserver({ events }) });
  return { service, identity, repo, storage, events, setNow(input: { value: number }) { now = input.value; } };
}
async function resolve(required: { service: ReturnType<typeof createWorkspaceService> }): Promise<CallContext> {
  return unwrap({ result: await required.service.resolveContext({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId }) });
}

describe("WorkspaceService authenticated account scope", () => {
  it("resolves a valid owner and binds an owned account without account approval", async () => {
    const harness = createHarness({});
    const context = await resolve(harness);
    expect(await harness.service.bindAccount({ context, binding })).toEqual({ ok: true, value: binding });
    expect(harness.events.at(-1)).toEqual({ operation: "workspaces.bindAccount", outcome: "succeeded", correlationId: context.correlationId, traceId: context.traceId });
  });
  it("forged/copied/cross-instance contexts cannot become authority", async () => {
    const harness = createHarness({});
    const context = await resolve(harness);
    const copy = structuredClone(context);
    expect(await harness.service.bindAccount({ context: copy, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const other = createHarness({});
    expect(await other.service.bindAccount({ context, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await harness.service.bindAccount({ context: { ...copy, scope: otherScope, principal: { kind: "owner", ownerId: "owner-b" } }, binding: { ...binding, scope: otherScope } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await harness.storage.find({ context: copy, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: null });
  });
  it("mutating issued owner/workspace/principal/trace values fails closed", async () => {
    const harness = createHarness({});
    const context = await resolve(harness);
    context.scope.workspaceId = otherScope.workspaceId;
    expect(await harness.service.bindAccount({ context, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const next = await resolve(harness);
    next.principal = { kind: "agent", agentInstanceId: "agent", runId: "run" };
    expect(await harness.service.bindAccount({ context: next, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const trace = await resolve(harness); trace.traceId = "forged-trace";
    expect(await harness.service.bindAccount({ context: trace, binding })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("identity failure preserves trace context without disclosing a session", async () => {
    const harness = createHarness({ identity: { async verify() { return { ok: false, error: { code: "unauthenticated", message: "Session revoked", retryable: false } }; } } });
    expect(await harness.service.resolveContext({ session: { sessionId: "secret-session" }, workspaceId: ownerScope.workspaceId })).toEqual({ ok: false, error: { code: "unauthenticated", message: "Session revoked", retryable: false } });
    expect(harness.events).toEqual([{ operation: "workspaces.resolveContext", outcome: "unauthenticated", correlationId: "00000000-0000-4000-8000-000000000001", traceId: "00000000-0000-4000-8000-000000000002" }]);
    expect(JSON.stringify(harness.events)).not.toContain("secret-session");
  });
  it("thrown identity errors become typed unavailable and malformed output is rejected", async () => {
    const throwing = createHarness({ identity: { async verify() { throw new Error("secret-provider-error"); } } });
    expect(await throwing.service.resolveContext({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(throwing.events)).not.toContain("secret-provider-error");
    const malformed = createHarness({ identity: { async verify() { return { ok: true, value: { ownerId: "", sessionId: "session-a" } }; } } });
    expect(await malformed.service.resolveContext({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const mismatch = createHarness({ identity: { async verify() { return { ok: true, value: { ownerId: "owner-a", sessionId: "wrong-session" } }; } } });
    expect(await mismatch.service.resolveContext({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  });
  it("revocation after resolution prevents binding and retains resolution trace", async () => {
    const identity = createMemoryIdentity({ sessions });
    const harness = createHarness({ identity });
    const context = await resolve(harness);
    identity.revoke({ sessionId: "session-a" });
    expect(await harness.service.bindAccount({ context, binding })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(harness.events.at(-1)).toEqual({ operation: "workspaces.bindAccount", outcome: "unauthenticated", correlationId: context.correlationId, traceId: context.traceId });
  });
  it("context expires exactly at five minutes and fails on clock rollback", async () => {
    const harness = createHarness({});
    const context = await resolve(harness);
    harness.setNow({ value: 300_100 });
    expect(await harness.service.bindAccount({ context, binding })).toMatchObject({ ok: false, error: { code: "expired" } });
    harness.setNow({ value: 99 });
    expect(await harness.service.bindAccount({ context, binding })).toMatchObject({ ok: false, error: { code: "expired" } });
    harness.setNow({ value: 300_099 });
    expect(await harness.service.bindAccount({ context, binding })).toEqual({ ok: true, value: binding });
  });
  it("repo cannot return a mismatched binding as success", async () => {
    const identity = createMemoryIdentity({ sessions });
    const base = createMemoryWorkspaceRepo({ workspaces, connections });
    const wrongBinding = createHarness({ identity, repo: { ...base, async bind() { return { ok: true, value: { ...binding, scope: otherScope } }; } } });
    const context = await resolve(wrongBinding);
    expect(await wrongBinding.service.bindAccount({ context, binding })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("cancellation after a completed write does not hide its successful outcome", async () => {
    const controller = new AbortController();
    const identity = createMemoryIdentity({ sessions });
    const repo = createMemoryWorkspaceRepo({ workspaces, connections });
    const harness = createHarness({ identity, repo: { ...repo, async bind(input, options) {
      const result = await repo.bind(input, options);
      controller.abort();
      return result;
    } } });
    const context = await resolve(harness);
    expect(await harness.service.bindAccount({ context, binding }, { signal: controller.signal })).toEqual({ ok: true, value: binding });
    expect(await repo.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
  });
  it("verifies identity once on resolution, rechecks on bind, and denies another owner's workspace", async () => {
    let calls = 0;
    const identity = createMemoryIdentity({ sessions });
    const harness = createHarness({ identity: { verify(input, options) { calls += 1; return identity.verify(input, options); } } });
    const context = await resolve(harness);
    expect(calls).toBe(1);
    expect(await harness.service.bindAccount({ context, binding })).toEqual({ ok: true, value: binding });
    expect(calls).toBe(2);
    expect(await harness.service.resolveContext({ session: { sessionId: "session-a" }, workspaceId: otherScope.workspaceId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("extra identity claims and oversized IDs are rejected before any authority call", async () => {
    let calls = 0;
    const harness = createHarness({ identity: { async verify() { calls += 1; return { ok: true, value: sessions[0] }; } } });
    expect(await harness.service.resolveContext({ session: { sessionId: "x".repeat(257) }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await harness.service.resolveContext({ session: { sessionId: "session-a", ownerId: "owner-b" }, workspaceId: ownerScope.workspaceId } as Parameters<typeof harness.service.resolveContext>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calls).toBe(0);
  });
});
