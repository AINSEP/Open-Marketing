import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createMemoryIdentity, createSqlWorkspaceRepo, createSqlAccountBindingLookup } from "../index.js";
import type { WorkspaceSqlDatabase, WorkspaceSqlSession } from "../index.js";
import { connections, createIds, sessions, workspaces } from "./fixtures.js";

/** Test-only real SQLite driver wrapper: mirrors the server's serialized DB-shaped port.
 * Foreign better-sqlite3 ABIs stay in this fixture, never in production feature code.
 */
export function createSqlHarness(required: Record<string, never>): {
  repo: ReturnType<typeof createSqlWorkspaceRepo>;
  db: WorkspaceSqlDatabase;
  lookup: ReturnType<typeof createSqlAccountBindingLookup>;
  database: Database.Database;
  dispose(): void;
} {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(readFileSync(new URL("../migrations/0001_workspaces.sql", import.meta.url), "utf8"));
  for (const scope of workspaces) database.prepare("INSERT INTO workspace (owner_id, workspace_id) VALUES (?, ?)").run(scope.ownerId, scope.workspaceId);
  for (const connection of connections) database.prepare("INSERT INTO workspace_connection_scope (owner_id, workspace_id, connection_id) VALUES (?, ?, ?)").run(connection.scope.ownerId, connection.scope.workspaceId, connection.connectionId);
  const session: WorkspaceSqlSession = {
    async query({ text, values = [] }) {
      // Production shim uses the same portable numbered-placeholder convention.
      const statement = database.prepare(text.replace(/\$\d+/g, "?"));
      if (statement.reader) return { rows: statement.all(...values) };
      statement.run(...values);
      return { rows: [] };
    },
  };
  let transactionTail: Promise<unknown> = Promise.resolve();
  const db: WorkspaceSqlDatabase = {
    ...session,
    async transaction({ run }) {
      const result = transactionTail.then(async () => {
        database.exec("BEGIN IMMEDIATE");
        try {
          const value = await run(session);
          database.exec("COMMIT");
          return value;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      });
      transactionTail = result.catch(() => undefined);
      return result;
    },
  };
  const repo = createSqlWorkspaceRepo({ db, identity: createMemoryIdentity({ sessions }), ids: createIds({}) });
  return { repo, db, lookup: createSqlAccountBindingLookup({ repo }), database, dispose() { database.close(); } };
}
