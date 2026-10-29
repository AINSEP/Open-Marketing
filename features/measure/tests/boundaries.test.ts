import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { createMemoryMeasureRepo, createMemoryTrackedLink, createMemoryMeasurementShareability, createMemoryConversionVerification, createSqlTrackedLink } from "../index.js";
import { consent, context, event, scope, source } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

describe("bounded measurement adapters", () => {
  it.each([NaN, Infinity, -1, 100001])("invalid storage limit %s cannot disable the bound", async maxRecords => {
    const repo = createMemoryMeasureRepo({ maxRecords });
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(repo.inspect({ scope }).events).toHaveLength(0);
  });
  it("an invalid ID output cannot invent a successful job", async () => {
    const repo = createMemoryMeasureRepo({ ids: { next() { return ""; } } });
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(repo.inspect({ scope }).jobs).toHaveLength(0);
  });
  it("ID-generator exceptions produce redacted failures without a partial commit", async () => {
    const repo = createMemoryMeasureRepo({ ids: { next() { throw new Error("id-provider-secret"); } } });
    const result = await repo.appendConversion({ source, event });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("id-provider-secret");
    expect(repo.inspect({ scope }).events).toHaveLength(0);
  });
  it.each([".", ".."])("memory and SQL links reject dot path ID %s", async linkId => {
    const configuration = { ids: { next() { return linkId; } }, baseUrl: "https://om.example/l/", allowedOrigins: ["https://shop.example"] };
    const memory = createMemoryTrackedLink(configuration);
    const sql = createSqlTrackedLink({ ...configuration, database: createSqlFixture({}).database });
    const input = { context, request: { destinationUrl: "https://shop.example/signup", campaignId: "campaign", utm: {} } };
    expect(await memory.create(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await sql.create(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("expired or withdrawn consent cannot be replaced by another matching grant", async () => {
    const clock = createFakeClock({ initial: 300 });
    const port = createMemoryMeasurementShareability({ clock, evidence: [{ ...consent, expiresAt: 300 }] });
    expect(await port.assess({ context, event })).toMatchObject({ ok: true, value: { allowed: false } });
    port.replace({ evidence: [consent, { ...consent, withdrawn: true }] });
    expect(await port.assess({ context, event })).toMatchObject({ ok: true, value: { allowed: false } });
  });
  it("phone consent evidence also covers a phone_digits commit, and withdrawal still wins", async () => {
    const clock = createFakeClock({ initial: 300 });
    const committed = { ...event, identifierDigests: { phone: "b".repeat(64), phone_digits: "d".repeat(64) } };
    const port = createMemoryMeasurementShareability({ clock, evidence: [{ ...consent, identifierKeys: ["phone"] }] });
    expect(await port.assess({ context, event: committed })).toMatchObject({ ok: true, value: { allowed: true } });
    port.replace({ evidence: [{ ...consent, identifierKeys: ["email"] }] });
    expect(await port.assess({ context, event: { ...event, identifierDigests: { phone_digits: "d".repeat(64) } } })).toMatchObject({ ok: true, value: { allowed: false } });
    port.replace({ evidence: [{ ...consent, identifierKeys: ["phone"] }, { ...consent, identifierKeys: ["phone"], withdrawn: true }] });
    expect(await port.assess({ context, event: committed })).toMatchObject({ ok: true, value: { allowed: false } });
  });
  it("empty committed-inbox fixtures deny verification", async () => {
    const port = createMemoryConversionVerification({});
    const serviceContext = { scope, serviceId: "worker", correlationId: "c", traceId: "t" };
    expect(await port.verify({ context: serviceContext, event })).toEqual({ ok: true, value: { verified: false } });
  });
});
