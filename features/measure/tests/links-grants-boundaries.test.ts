import { describe, expect, it } from "vitest";
import { createMemoryTrackedLink, createSqlMeasurementGrant, createSqlTrackedLink } from "../index.js";
import { prepareTrackedLink, validateTrackedDestination } from "../src/links/links.js";
import { scopeKey } from "../src/rules.js";
import { context, createIds, grant, scope, serviceContext } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

const origin = "https://shop.example";
const baseUrl = "https://om.example/l/";
const request = { destinationUrl: origin + "/signup", campaignId: "campaign", utm: {} };
const policy = { allowedOrigins: [origin] };

describe("tracked destination policy", () => {
  it.each([
    ["", "invalid_input"], ["not a URL", "invalid_input"], [origin + "/?a=1&a=2", "invalid_input"],
    [origin + "/?" + Array.from({ length: 25 }, (_, index) => "utm_term_" + index + "=1").join("&"), "limit_exceeded"],
    [origin + "/?email=person", "forbidden"], ["http://shop.example/", "forbidden"], ["https://other.example/", "forbidden"],
  ])("refuses %s", (url, code) => {
    expect(validateTrackedDestination({ url, ...policy })).toMatchObject({ ok: false, error: { code } });
  });
  it("accepts UTM keys and explicitly admitted keys only", () => {
    expect(validateTrackedDestination({ url: origin + "/?utm_source=a&click_id=b", ...policy, allowedQueryKeys: ["click_id"] })).toMatchObject({ ok: true });
    expect(validateTrackedDestination({ url: origin + "/?click_id=b", ...policy })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("prepareTrackedLink", () => {
  const prepare = (override: Partial<Parameters<typeof prepareTrackedLink>[0]>) => prepareTrackedLink({ linkId: "link-1", request, baseUrl, ...policy, ...override });
  it("encodes the ID under a base with or without a trailing slash", () => {
    expect(prepare({})).toMatchObject({ ok: true, value: { url: "https://om.example/l/link-1" } });
    expect(prepare({ baseUrl: "https://om.example/l" })).toMatchObject({ ok: true, value: { url: "https://om.example/l/link-1" } });
  });
  it.each([
    [{ linkId: "" }, "invalid_input"], [{ request: { ...request, campaignId: "" } }, "invalid_input"],
    [{ baseUrl: undefined }, "unavailable"], [{ baseUrl: "http://om.example/l/" }, "invalid_input"],
    [{ baseUrl: "https://om.example/l/?x=1" }, "invalid_input"], [{ baseUrl: "not a url" }, "invalid_input"],
    [{ request: { ...request, destinationUrl: "https://other.example/" } }, "forbidden"],
  ] as const)("refuses %j", (change, code) => {
    expect(prepare(change as Partial<Parameters<typeof prepareTrackedLink>[0]>)).toMatchObject({ ok: false, error: { code } });
  });
  it("re-validates after the UTM merge so merging cannot exceed the query bound", () => {
    const keys = Array.from({ length: 24 }, (_, index) => "k" + index);
    const destinationUrl = origin + "/?" + keys.map(key => key + "=1").join("&");
    expect(prepare({ request: { ...request, destinationUrl }, allowedQueryKeys: keys })).toMatchObject({ ok: true });
    expect(prepare({ request: { ...request, destinationUrl, utm: { utm_source: "x" } }, allowedQueryKeys: keys })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
});

describe("memory and SQL tracked-link failure paths", () => {
  const build = (name: "memory" | "sql", override: { ids?: ReturnType<typeof createIds>; maxRecords?: number; origins?: string[]; database?: ReturnType<typeof createSqlFixture>["database"] } = {}) => {
    const ids = override.ids ?? createIds({ prefix: "link" });
    const allowedOrigins = override.origins ?? [origin];
    return name === "memory" ? createMemoryTrackedLink({ ids, baseUrl, allowedOrigins, maxRecords: override.maxRecords })
      : createSqlTrackedLink({ ids, baseUrl, allowedOrigins, database: override.database ?? createSqlFixture({}).database });
  };
  it.each(["memory", "sql"] as const)("%s rejects malformed context, request, ID output and unadmitted destinations", async name => {
    const port = build(name);
    expect(await port.create({ context: {} as typeof context, request })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.create({ context, request: { ...request, campaignId: "" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.create({ context, request: { ...request, destinationUrl: "https://other.example/" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await build(name, { ids: { next: () => "" } }).create({ context, request })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.resolve!({ context: {} as typeof context, linkId: "link-1" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.resolve!({ context, linkId: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.resolve!({ context, linkId: "missing" })).toMatchObject({ ok: false, error: { code: "unavailable", message: "Tracked link not found" } });
  });
  it.each(["memory", "sql"] as const)("%s refuses a colliding generated ID instead of overwriting the stored destination", async name => {
    const port = build(name, { ids: { next: () => "same" } });
    const first = await port.create({ context, request });
    expect(first.ok).toBe(true);
    expect(await port.create({ context, request: { ...request, destinationUrl: origin + "/other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await port.resolve!({ context, linkId: "same" })).toEqual(first);
  });
  it("memory enforces its storage bound", async () => {
    const port = build("memory", { maxRecords: 1 });
    expect((await port.create({ context, request })).ok).toBe(true);
    expect(await port.create({ context, request })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
  it("SQL re-applies destination policy and rejects corrupt stored rows on resolve", async () => {
    const fixture = createSqlFixture({});
    const created = await build("sql", { database: fixture.database }).create({ context, request });
    expect(created.ok).toBe(true);
    const narrowed = build("sql", { database: fixture.database, origins: ["https://different.example"] });
    expect(await narrowed.resolve!({ context, linkId: "link-1" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    fixture.handle.prepare("UPDATE measure_tracked_link SET link_json=? WHERE link_id=?").run(JSON.stringify({ linkId: "link-1", url: "x" }), "link-1");
    expect(await build("sql", { database: fixture.database }).resolve!({ context, linkId: "link-1" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});

describe("SQL measurement grant boundaries", () => {
  const key = scopeKey({ scope });
  const setup = () => {
    const fixture = createSqlFixture({});
    const port = createSqlMeasurementGrant({ database: fixture.database, clock: { now: () => 500 } });
    const put = (id: string, json: string, revokedAt: number | null = null) => fixture.handle.prepare("INSERT INTO measure_grant (scope_key,grant_id,grant_json,created_at,revoked_at) VALUES (?,?,?,?,?)").run(key, id, json, 1, revokedAt);
    return { fixture, port, put };
  };
  it("rejects malformed inputs before touching the database", async () => {
    const { port } = setup();
    expect(await port.list({ context, query: { limit: 0 } } as never)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.current({ context: { ...serviceContext, serviceId: "" }, grantId: "grant-1" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.grant({ context, grant: { ...grant, grantId: "" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await port.revoke({ context, grantId: "" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("pages scoped grants with a keyset cursor and marks revoked rows", async () => {
    const { port } = setup();
    for (const grantId of ["grant-a", "grant-b", "grant-c"]) expect((await port.grant({ context, grant: { ...grant, grantId } })).ok).toBe(true);
    await port.revoke({ context, grantId: "grant-b" });
    const first = await port.list({ context, query: { limit: 2 } });
    expect(first).toMatchObject({ ok: true, value: { items: [{ grantId: "grant-a", revoked: false }, { grantId: "grant-b", revoked: true }], cursor: "grant-b" } });
    expect(await port.list({ context, query: { limit: 2, cursor: "grant-b" } })).toMatchObject({ ok: true, value: { items: [{ grantId: "grant-c" }], cursor: null } });
  });
  it.each([
    ["a grant bound to a different ID", (id: string) => JSON.stringify({ ...grant, grantId: "grant-other" }), "forbidden", false],
    ["unparseable JSON", () => "{not json", "invalid_input", true],
    ["a stored revoked flag", () => JSON.stringify({ ...grant, revoked: true }), "invalid_input", true],
    ["a grant from another scope", () => JSON.stringify({ ...grant, scope: { ...scope, workspaceId: "other" } }), "forbidden", true],
    ["a structurally invalid grant", () => JSON.stringify({ kind: "measurement" }), "invalid_input", true],
  ])("fails closed on %s in storage", async (_label, json, code, listRejects) => {
    const { port, put } = setup();
    put("grant-1", json("grant-1"));
    expect(await port.current({ context: serviceContext, grantId: "grant-1" })).toMatchObject({ ok: false, error: { code } });
    // list decodes the same row; only the per-ID binding check lives in the single-grant read path.
    if (listRejects) expect(await port.list({ context, query: { limit: 5 } })).toMatchObject({ ok: false });
    expect(await port.revoke({ context, grantId: "grant-1" })).toMatchObject({ ok: false });
  });
  it("a stored row that disagrees with a conflicting concurrent grant ID is not silently adopted", async () => {
    const { port, put } = setup();
    put("grant-1", JSON.stringify({ ...grant, definitionIds: ["other"] }));
    expect(await port.grant({ context, grant })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
