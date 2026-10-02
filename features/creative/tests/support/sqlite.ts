import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { createSqlCreativeRepo, createTransactionalCreativeJob } from "../../index.js";
import type { CreativeSqlDatabase, CreativeSqlSession, CreativeJobTransaction, CreativeTransactionalEnqueue } from "../../index.js";
import { failure, success } from "../../src/rules.js";

/** Native SQLite exists ONLY in this ephemeral fixture; source adapters use the injected query port. */
export function sqliteFixture(required: Record<string, never>) {
  const native = new Database(":memory:");
  native.exec(readFileSync(new URL("../../migrations/0001_creative.sql", import.meta.url), "utf8"));
  native.exec("CREATE TABLE fixture_jobs_outbox (operation_key TEXT PRIMARY KEY, digest TEXT NOT NULL, generation_id TEXT NOT NULL)");
  const session: CreativeSqlSession = {
    async query(input) { return native.prepare(input.sql).all(...input.parameters); },
    async execute(input) { return { changes: native.prepare(input.sql).run(...input.parameters).changes }; },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const database: CreativeSqlDatabase = {
    async transaction(input) {
      const previous = tail;
      let release = () => {};
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;
      native.exec("BEGIN IMMEDIATE");
      try {
        const result = await input.run({ session });
        native.exec(result.ok ? "COMMIT" : "ROLLBACK");
        return result;
      } catch (error) { native.exec("ROLLBACK"); throw error; }
      finally { release(); }
    },
  };
  const repo = createSqlCreativeRepo({ database });
  let rejectEnqueue = false;
  const transaction: CreativeJobTransaction = input => database.transaction({ run: async scope => {
    const transactionDatabase: CreativeSqlDatabase = { async transaction(input) { return input.run(scope); } };
    const transactionalRepo = createSqlCreativeRepo({ database: transactionDatabase });
    const enqueue: CreativeTransactionalEnqueue = async job => {
      if (rejectEnqueue) return failure({ code: "unavailable", message: "Scripted SQL outbox failure" });
      const operationKey = JSON.stringify([job.context.scope.ownerId, job.context.scope.workspaceId, job.operationId]);
      const rows = native.prepare("SELECT digest FROM fixture_jobs_outbox WHERE operation_key = ?").all(operationKey) as { digest: string }[];
      if (rows[0] !== undefined && rows[0].digest !== job.argumentsDigest) return failure({ code: "conflict", message: "Outbox digest conflict" });
      native.prepare("INSERT INTO fixture_jobs_outbox (operation_key, digest, generation_id) VALUES (?, ?, ?) ON CONFLICT (operation_key) DO NOTHING").run(operationKey, job.argumentsDigest, job.generationId);
      return success({ value: { jobId: operationKey } });
    };
    return input.run({ repo: transactionalRepo, enqueue });
  } });
  const jobs = createTransactionalCreativeJob({ transaction });
  return { native, database, repo, jobs, close() { native.close(); }, failEnqueue(input: { reject: boolean }) { rejectEnqueue = input.reject; } };
}
