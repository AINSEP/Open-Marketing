import type Database from "better-sqlite3";
import { createSqliteFixture } from "@open-marketing/om-db/testing";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createSqlCampaignRepo } from "../../index.js";
import { CampaignRepoPortSuite } from "../contract/port-suites.js";
import { context, draft, proposal, value } from "../fixtures.js";

const handles: Database.Database[] = [];
afterEach(() => { handles.splice(0).forEach(database => database.close()); });
/** Campaign-owned migration over the shared checked SQLite query adapter. */
function createSqlFixture() {
  const fixture = createSqliteFixture({ migrations: [readFileSync(new URL("../../migrations/0001_campaigns.sql", import.meta.url), "utf8")] });
  handles.push(fixture.native);
  return { database: fixture.native, db: fixture.database, repo: createSqlCampaignRepo({ db: fixture.database }) };
}
CampaignRepoPortSuite({ create: () => createSqlFixture().repo });

describe("SQL boundary/restart", () => {
  it("restores neutral JSON after repository replacement and rejects substituted identity", async () => {
    const first = createSqlFixture();
    const campaign = { schemaVersion: 2 as const, operationId: 'local', name: 'Traffic', objective: 'traffic' as const, schedule: { window: { start: 1000, end: 5000 }, timezone: 'UTC' }, audience: { countries: ['US'] }, ads: [{ creativeId: 'asset', destinationUrl: 'https://example.test/landing' }], creativeDigest: 'a'.repeat(64), targets: [{ pluginId: 'meta-ads', connectionId: 'connection', accountId: '123', dailyBudget: { minorUnits: 500, currency: 'USD' }, expectedExposure: { minorUnits: 2000, currency: 'USD' } }] };
    const saved = value({ outcome: await first.repo.saveNeutral({ context, campaign }) });
    const reopened = createSqlCampaignRepo({ db: first.db });
    expect(value({ outcome: await reopened.getNeutral({ context, campaignId: saved.campaignId }) })).toEqual(saved);
    first.database.prepare('UPDATE campaign SET record_json=? WHERE campaign_id=?').run(JSON.stringify({ ...saved, campaign: { ...campaign, operationId: 'substituted' } }), saved.campaignId);
    expect(await reopened.getNeutral({ context, campaignId: saved.campaignId })).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
  it("reads the same campaign and proposal after replacing the repository instance", async () => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    const exact = proposal({ campaignId: saved.campaignId });
    value({ outcome: await first.repo.saveProposal({ context, proposal: exact }) });
    const second = createSqlCampaignRepo({ db: first.db });
    expect(value({ outcome: await second.get({ context, campaignId: saved.campaignId }) })?.draft).toEqual(draft);
    expect(value({ outcome: await second.getProposal({ context, operationId: "launch-1" }) })).toEqual(exact);
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
  it("rejects schema-valid observation evidence for another campaign", async () => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    const state = { campaignId: saved.campaignId, state: "paused" as const, observedAt: 900, providerReference: "provider" };
    value({ outcome: await first.repo.observe({ context, state }) });
    first.database.prepare("UPDATE campaign_revision SET observation_json=? WHERE campaign_id=?").run(JSON.stringify({ ...state, campaignId: "foreign" }), saved.campaignId);
    expect(await first.repo.get({ context, campaignId: saved.campaignId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("rejects schema-valid record content with a substituted creation operation", async () => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    const record = value({ outcome: await first.repo.get({ context, campaignId: saved.campaignId }) });
    if (!record) throw new Error("saved record missing");
    const changed = { ...record, draft: { ...record.draft, operationId: "different-creation" } };
    first.database.prepare("UPDATE campaign SET record_json=? WHERE campaign_id=?").run(JSON.stringify(changed), saved.campaignId);
    expect(await first.repo.get({ context, campaignId: saved.campaignId })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it.each(["operation", "exposure"] as const)("rejects a stored proposal's substituted %s", async (kind) => {
    const first = createSqlFixture();
    const saved = value({ outcome: await first.repo.save({ context, draft }) });
    const exact = proposal({ campaignId: saved.campaignId });
    value({ outcome: await first.repo.saveProposal({ context, proposal: exact }) });
    const operation = { ...exact.operations[0] };
    if (kind === "operation") operation.operationId = "different-launch";
    else operation.moneyExposure = { amount: { minorUnits: 9999, currency: "USD" }, window: exact.arguments.flight.window };
    first.database.prepare("UPDATE campaign_launch_proposal SET proposal_json=? WHERE operation_id=?").run(JSON.stringify({ ...exact, operations: [operation] }), "launch-1");
    expect(await first.repo.getProposal({ context, operationId: "launch-1" })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
