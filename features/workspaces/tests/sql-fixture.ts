import type Database from "better-sqlite3";
import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import { createMemoryIdentity, createSqlWorkspaceRepo, createSqlAccountBindingLookup } from "../index.js";
import type { WorkspaceSqlDatabase } from "../index.js";
import { connections, createIds, sessions, workspaces } from "./fixtures.js";

/** Workspace seeds over the shared checked SQLite fixture; callers dispose after awaited work. */
export function createSqlHarness(required: Record<string, never>): {
  repo: ReturnType<typeof createSqlWorkspaceRepo>;
  db: WorkspaceSqlDatabase;
  lookup: ReturnType<typeof createSqlAccountBindingLookup>;
  database: Database.Database;
  dispose(): void;
} {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../migrations/0001_workspaces.sql", import.meta.url), "utf8")] });
  const database = fixture.native;
  for (const scope of workspaces) database.prepare("INSERT INTO workspace (owner_id, workspace_id) VALUES (?, ?)").run(scope.ownerId, scope.workspaceId);
  for (const connection of connections) database.prepare("INSERT INTO workspace_connection_scope (owner_id, workspace_id, connection_id) VALUES (?, ?, ?)").run(connection.scope.ownerId, connection.scope.workspaceId, connection.connectionId);
  const db = fixture.database;
  const repo = createSqlWorkspaceRepo({ db, identity: createMemoryIdentity({ sessions }), ids: createIds({}) });
  return { repo, db, lookup: createSqlAccountBindingLookup({ repo }), database, dispose: fixture.close };
}
