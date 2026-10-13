import { describe, expect, it } from "vitest";
import { createMemoryIdentity, createMemoryWorkspaceRepo, createMemoryAccountBindingLookup, createSqlAccountBindingLookup, createSqlWorkspaceRepo, createWorkspaceService, createWorkspaceRecord } from "../index.js";
import type { WorkspaceSqlDatabase } from "../index.js";
import { binding, ownerScope, otherScope, connections, createIds, resolveOwner, sessions, unwrap, workspaces } from "./fixtures.js";
import { createSqlHarness } from "./sql-fixture.js";

describe("adapter failure boundaries", () => {
  it("empty doubles fail explicitly and cannot grant authority", async () => {
    expect(await createMemoryIdentity({}).verify({ session: { sessionId: "missing" } })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(await createMemoryWorkspaceRepo({}).resolve({ session: { sessionId: "missing" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await createMemoryWorkspaceRepo({}).resolve({ session: { sessionId: "missing" }, workspaceId: "missing" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const context = { scope: binding.scope, principal: { kind: "owner" as const, ownerId: binding.scope.ownerId }, correlationId: "correlation", traceId: "trace" };
    expect(await createMemoryAccountBindingLookup({}).find({ context, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("lookup adapters map thrown and malformed injected responses to typed failures", async () => {
    const context = { scope: binding.scope, principal: { kind: "owner" as const, ownerId: binding.scope.ownerId }, correlationId: "c", traceId: "t" };
    const throwing = { async find(): Promise<never> { throw new Error("secret-adapter-error"); } };
    expect(await createMemoryAccountBindingLookup({ repo: throwing }).find({ context, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await createSqlAccountBindingLookup({ repo: throwing }).find({ context, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const malformed = { async find() { return { ok: true as const, value: { ...binding, externalAccountId: "" } }; } };
    expect(await createMemoryAccountBindingLookup({ repo: malformed }).find({ context, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await createSqlAccountBindingLookup({ repo: malformed }).find({ context, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("invalid and duplicated seed configuration is rejected", () => {
    expect(() => createMemoryIdentity({ sessions: [sessions[0], sessions[0]] })).toThrow("Duplicate identity session seed");
    expect(() => createMemoryWorkspaceRepo({ workspaces: [workspaces[0], workspaces[0]] })).toThrow("Duplicate workspace seed");
    expect(() => createMemoryWorkspaceRepo({ connections })).toThrow("Connection workspace missing");
    expect(() => createMemoryWorkspaceRepo({ workspaces, connections, bindings: [{ ...binding, connectionId: "missing" }] })).toThrow("Invalid account binding seed");
    expect(() => createMemoryIdentity({ sessions: [{ ownerId: "owner-a", sessionId: "x".repeat(257) }] })).toThrow();
  });
  it("identity expiration has no hidden clock fallback", async () => {
    const session = { ownerId: "owner-a", sessionId: "expires", expiresAt: 100 };
    expect(await createMemoryIdentity({ sessions: [session] }).verify({ session: { sessionId: "expires" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const badClock = createMemoryIdentity({ sessions: [session], clock: { now() { throw new Error("clock-failed"); } } });
    expect(await badClock.verify({ session: { sessionId: "expires" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("SQL exceptions and malformed database rows return typed unavailable", async () => {
    const db: WorkspaceSqlDatabase = { async query() { throw new Error("secret-db-detail"); }, async transaction({ run }) { return run(this); } };
    const repo = createSqlWorkspaceRepo({ db, identity: createMemoryIdentity({ sessions }), ids: createIds({}) });
    expect(await repo.resolve({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const malformed: WorkspaceSqlDatabase = { async query() { return { rows: [{ found: "unexpected" }] }; }, async transaction({ run }) { return run(this); } };
    const invalid = createSqlWorkspaceRepo({ db: malformed, identity: createMemoryIdentity({ sessions }), ids: createIds({}) });
    expect(await invalid.resolve({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const context = { scope: binding.scope, principal: { kind: "owner" as const, ownerId: binding.scope.ownerId }, correlationId: "c", traceId: "t" };
    expect(await repo.bind({ context, binding })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await repo.find({ context, externalAccountId: "vendor-42" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("SQL foreign keys prevent assigning an account to an unowned connection", () => {
    const harness = createSqlHarness({});
    try {
      expect(() => harness.database.prepare("INSERT INTO workspace_account_binding (id, owner_id, workspace_id, connection_id, external_account_id) VALUES (?, ?, ?, ?, ?)").run("forged", "owner-a", ownerScope.workspaceId, "connection-b", "vendor-42")).toThrow();
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM workspace_account_binding").get()).toEqual({ count: 0 });
    } finally { harness.dispose(); }
  });
  it("SQL account identity contains full scope and stores suspicious IDs as literal data", async () => {
    const harness = createSqlHarness({});
    try {
      const context = await resolveOwner({ repo: harness.repo });
      const literal = { ...binding, externalAccountId: "x'; DROP TABLE workspace; --" };
      expect(await harness.repo.bind({ context, binding: literal })).toEqual({ ok: true, value: literal });
      expect(await harness.repo.find({ context, externalAccountId: literal.externalAccountId })).toEqual({ ok: true, value: literal });
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM workspace").get()).toEqual({ count: 3 });
    } finally { harness.dispose(); }
  });
  it("reconstructing the SQL adapter preserves persisted bindings", async () => {
    const harness = createSqlHarness({});
    try {
      const context = await resolveOwner({ repo: harness.repo });
      expect(await harness.repo.bind({ context, binding })).toEqual({ ok: true, value: binding });
      const rebuilt = createSqlWorkspaceRepo({ db: harness.db, identity: createMemoryIdentity({ sessions }), ids: createIds({}) });
      const restoredContext = await resolveOwner({ repo: rebuilt });
      expect(await rebuilt.find({ context: restoredContext, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
    } finally { harness.dispose(); }
  });
  it("observer errors cannot turn a committed write into a failure", async () => {
    const identity = createMemoryIdentity({ sessions });
    const repo = createMemoryWorkspaceRepo({ identity, ids: createIds({}), workspaces, connections });
    const service = createWorkspaceService({ repo, identity, ids: createIds({}), clock: { now() { return 10; } } }, { observer: { observe() { throw new Error("observer-down"); } } });
    const context = unwrap({ result: await service.resolveContext({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId }) });
    expect(await service.bindAccount({ context, binding })).toEqual({ ok: true, value: binding });
    expect(await repo.find({ context, externalAccountId: "vendor-42" })).toEqual({ ok: true, value: binding });
  });
});

describe("global workspace identity", () => {
  it("generates canonical UUIDs using only the injected port", () => {
    const ids = createIds({});
    expect(createWorkspaceRecord({ ownerId: "owner-a", ids })).toEqual({ ok: true, value: { ownerId: "owner-a", workspaceId: "00000000-0000-4000-8000-000000000001" } });
    expect(createWorkspaceRecord({ ownerId: "owner-b", ids })).toEqual({ ok: true, value: { ownerId: "owner-b", workspaceId: "00000000-0000-4000-8000-000000000002" } });
    expect(createWorkspaceRecord({ ownerId: "owner-a", ids: { next() { return ownerScope.workspaceId.toUpperCase(); } } })).toEqual({ ok: true, value: ownerScope });
  });
  it("rejects invalid IDs and owner input and maps ID-port failures", () => {
    expect(createWorkspaceRecord({ ownerId: "owner-a", ids: { next() { return "workspace-a"; } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(createWorkspaceRecord({ ownerId: "", ids: { next() { throw new Error("must not call"); } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(createWorkspaceRecord({ ownerId: "owner-a", ids: { next() { throw new Error("port unavailable"); } } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("rejects cross-owner UUID reuse including casing aliases in memory and SQL", () => {
    expect(() => createMemoryWorkspaceRepo({ workspaces: [ownerScope, { ownerId: "owner-b", workspaceId: ownerScope.workspaceId.toUpperCase() }] })).toThrow("Duplicate workspace seed");
    expect(() => createMemoryWorkspaceRepo({ workspaces: [{ ...ownerScope, workspaceId: "old-id" }] })).toThrow();
    const harness = createSqlHarness({});
    try {
      expect(() => harness.database.prepare("INSERT INTO workspace (owner_id, workspace_id) VALUES (?, ?)").run("owner-b", ownerScope.workspaceId)).toThrow();
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM workspace").get()).toEqual({ count: 3 });
    } finally { harness.dispose(); }
  });
  it("canonicalizes resolution UUIDs and rejects legacy literals before lookup", async () => {
    const harness = createSqlHarness({});
    try {
      expect(await harness.repo.resolve({ session: { sessionId: "session-a" }, workspaceId: ownerScope.workspaceId.toUpperCase() })).toMatchObject({ ok: true, value: { scope: ownerScope } });
      expect(await harness.repo.resolve({ session: { sessionId: "session-a" }, workspaceId: "old-id" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    } finally { harness.dispose(); }
  });
});
