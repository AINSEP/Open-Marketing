import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import { createSqlCreativeRepo, createTransactionalCreativeJob } from "../../index.js";
import type { CreativeJobTransaction, CreativeTransactionalEnqueue } from "../../index.js";
import { failure, success } from "../../src/rules.js";

/** Native SQLite exists ONLY in this ephemeral fixture; source adapters use the injected query port. */
export function sqliteFixture(required: Record<string, never>) {
  const fixture = createSqliteFixture({ migrations: [
    readFileSync(new URL("../../migrations/0001_creative.sql", import.meta.url), "utf8"),
    "CREATE TABLE fixture_jobs_outbox (operation_key TEXT PRIMARY KEY, digest TEXT NOT NULL, generation_id TEXT NOT NULL)",
  ] });
  const { native, database } = fixture;
  const repo = createSqlCreativeRepo({ database });
  let rejectEnqueue = false;
  const transaction: CreativeJobTransaction = input => database.transaction({ work: async ({ session }) => {
    const transactionalRepo = createSqlCreativeRepo({ database: session });
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
  return { native, database, repo, jobs, close: fixture.close, failEnqueue(input: { reject: boolean }) { rejectEnqueue = input.reject; } };
}
