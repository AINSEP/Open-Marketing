import { afterEach, describe, it, expect } from "vitest";
import { CreativeRepoPortSuite, CreativeJobPortSuite } from "./port-suites.js";
import { sqliteFixture } from "../support/sqlite.js";
import { context, intentFor, value } from "../support/fixtures.js";
import { costFor } from "../support/cost.js";
import { createSqlCreativeRepo } from "../../index.js";

const fixtures: ReturnType<typeof sqliteFixture>[] = [];
/** Tracks native fixture handles for deterministic disposal after every test. */
function createFixture() {
  const fixture = sqliteFixture({});
  fixtures.push(fixture);
  return fixture;
}
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });
CreativeRepoPortSuite({ create: () => createFixture().repo });
CreativeJobPortSuite({ create: () => { const fixture = createFixture(); return { port: fixture.jobs, repo: fixture.repo }; } });

describe("SQL durability and transaction boundaries", () => {
  it("rolls back intent when outbox enqueue fails", async () => {
    const fixture = createFixture();
    fixture.failEnqueue({ reject: true });
    const intent = intentFor();
    expect(await fixture.jobs.enqueue({ context, operationId: intent.request.operationId, argumentsDigest: intent.request.argumentsDigest, intent })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM creative_generation_request").get()).toEqual({ count: 0 });
    expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM fixture_jobs_outbox").get()).toEqual({ count: 0 });
  });
  it("preserves restart state and stores a duplicate observation only once", async () => {
    const fixture = createFixture();
    const status = value({ outcome: await fixture.repo.save({ context, status: intentFor() }) });
    const cost = costFor({ status });
    value({ outcome: await fixture.repo.appendCost({ context, cost }) });
    value({ outcome: await fixture.repo.appendCost({ context, cost }) });
    const restarted = createSqlCreativeRepo({ database: fixture.database });
    expect(value({ outcome: await restarted.get({ context, generationId: status.generationId }) })).toEqual(status);
    expect(fixture.native.prepare("SELECT COUNT(*) AS count FROM creative_generation_cost_observation").get()).toEqual({ count: 1 });
  });
  it("maps driver exceptions and corrupt rows to typed failures", async () => {
    const fixture = createFixture();
    const status = intentFor();
    value({ outcome: await fixture.repo.save({ context, status }) });
    fixture.native.prepare("UPDATE creative_generation_request SET status_json = ?").run("{corrupt");
    expect(await fixture.repo.get({ context, generationId: status.generationId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const failing = createSqlCreativeRepo({ database: { async transaction() { throw new Error("private driver detail"); } } });
    expect(await failing.get({ context, generationId: status.generationId })).toEqual({ ok: false, error: { code: "unavailable", message: "Creative persistence unavailable", retryable: true } });
  });
});
