import type Database from "better-sqlite3";
import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import { afterEach } from "vitest";
import type { MeasureSqlDatabase, MeasureTransactionalJobPort } from "../index.js";
import { eventIdentity, scopeKey } from "../src/rules.js";
import { createIds } from "./fixtures.js";
const handles: Database.Database[] = [];
afterEach(() => { handles.splice(0).forEach(handle => handle.close()); });

/** Real local SQLite fixture; the narrow driver wrapper is test-only. The amended
 * initial schema (including subject indexes) is applied exclusively to :memory:.
 * The ID-only fixture outbox represents the external jobs owner. */
export interface SqlFixture {
  database: MeasureSqlDatabase;
  jobs: MeasureTransactionalJobPort;
  handle: Database.Database;
  failNextInboxInsert(): void;
  failNextEnqueue(): void;
  counts(): { events: number; jobs: number };
}

export function createSqlFixture(required: Record<string, never>): SqlFixture {
  let failInsert = false;
  let failEnqueue = false;
  const fixture = createSqliteFixture({ migrations: [
    readFileSync(new URL("../migrations/0001_measure.sql", import.meta.url), "utf8"),
    readFileSync(new URL("../migrations/0002_attribution_account.sql", import.meta.url), "utf8"),
    "CREATE TABLE fixture_jobs (scope_key TEXT NOT NULL, source_id TEXT NOT NULL, event_id TEXT NOT NULL, job_id TEXT NOT NULL, identity TEXT NOT NULL, context_json TEXT NOT NULL, PRIMARY KEY(scope_key,source_id,event_id))",
  ] }, { beforeQuery(input) {
    if (failInsert && input.text.startsWith("INSERT INTO measure_conversion_event")) { failInsert = false; throw new Error("Injected inbox insert failure"); }
  } });
  const { native: handle, database } = fixture;
  handles.push(handle);
  const ids = createIds({ prefix: "sql-job" });
  const jobs: MeasureTransactionalJobPort = {
    async enqueue(input) {
      if (failEnqueue) { failEnqueue = false; return { ok: false, error: { code: "unavailable", message: "Injected enqueue failure", retryable: false } }; }
      const values = [scopeKey({ scope: input.source.scope }), input.source.sourceId, input.event.eventId];
      const previous = await input.transaction.query({ text: "SELECT job_id,identity FROM fixture_jobs WHERE scope_key=$1 AND source_id=$2 AND event_id=$3", values });
      const identity = eventIdentity({ event: input.event });
      const row = previous.rows[0];
      if (row && row.identity !== identity) return { ok: false, error: { code: "conflict", message: "Conflicting outbox identity", retryable: false } };
      if (row) return { ok: true, value: { jobId: String(row.job_id) } };
      const jobId = ids.next({});
      await input.transaction.query({ text: "INSERT INTO fixture_jobs (scope_key,source_id,event_id,job_id,identity,context_json) VALUES ($1,$2,$3,$4,$5,$6)", values: [...values, jobId, identity, JSON.stringify(input.context)] });
      return { ok: true, value: { jobId } };
    },
  };
  return {
    database, jobs, handle,
    failNextInboxInsert() { failInsert = true; },
    failNextEnqueue() { failEnqueue = true; },
    counts() { return { events: Number((handle.prepare("SELECT COUNT(*) AS count FROM measure_conversion_event").get() as { count: number }).count), jobs: Number((handle.prepare("SELECT COUNT(*) AS count FROM fixture_jobs").get() as { count: number }).count) }; },
  };
}
