import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { CampaignSqlPort } from "../../index.js";
import { createSqlCampaignRepo } from "../../index.js";
import { CampaignRepoPortSuite } from "../contract/port-suites.js";
import { context, draft, value } from "../fixtures.js";

const handles: Database.Database[] = [];
afterEach(() => { handles.splice(0).forEach(database => database.close()); });
/** Test-only SQLite binding implements the same query shape as the removable Jini db shim. */
function sqliteFixture(required: { database: Database.Database }): CampaignSqlPort {
  return {
    async query<Row extends Record<string, unknown>>(input: { text: string; values?: unknown[] }) {
      const statement = required.database.prepare(input.text);
      const parameters = Object.fromEntries((input.values ?? []).map((entry, index) => [String(index + 1), entry]));
      if (statement.reader) {
        const rows = statement.all(parameters) as Row[];
        return { rows, rowCount: rows.length };
      }
      return { rows: [] as Row[], rowCount: statement.run(parameters).changes };
    },
  };
}
function createSqlFixture() {
  const database = new Database(":memory:");
  handles.push(database);
  database.pragma("foreign_keys = ON");
  database.exec(readFileSync(new URL("../../migrations/0001_campaigns.sql", import.meta.url), "utf8"));
  const db = sqliteFixture({ database });
  return { database, db, repo: createSqlCampaignRepo({ db }) };
}
CampaignRepoPortSuite({ create: () => createSqlFixture().repo });

describe("SQL boundary/restart", () => {
  it("reads the same campaign and proposal after replacing the repository instance", async () => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    const second = createSqlCampaignRepo({ db: first.db });
    expect(value({ outcome: await second.get({ context, campaignId: saved.campaignId }) })?.draft).toEqual(draft);
  });
  it("rejects corrupted persisted JSON and maps driver throws without exposing details", async () => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    first.database.prepare("UPDATE campaign SET record_json=? WHERE campaign_id=?").run("{invalid", saved.campaignId);
    expect(await first.repo.get({ context, campaignId: saved.campaignId })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const unavailable = createSqlCampaignRepo({ db: { async query() { throw new Error("private database detail"); } } });
    expect(await unavailable.get({ context, campaignId: saved.campaignId })).toEqual({ ok: false, error: { code: "unavailable", message: "Campaign SQL unavailable", retryable: false } });
  });
  it("appends observations without overwriting earlier evidence", async () => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    const base = { campaignId: saved.campaignId, providerReference: "provider" };
    value({ outcome: await first.repo.observe({ context, state: { ...base, state: "unknown", observedAt: 900 } }) });
    value({ outcome: await first.repo.observe({ context, state: { ...base, state: "paused", observedAt: 901 } }) });
    const rows = first.database.prepare("SELECT observation_json FROM campaign_revision ORDER BY revision").all() as { observation_json: string }[];
    expect(rows.map(row => JSON.parse(row.observation_json).state)).toEqual(["unknown", "paused"]);
  });
});
