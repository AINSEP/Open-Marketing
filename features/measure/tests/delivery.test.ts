import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { createConversionDispatcher, createMemoryConversionDelivery, createMemoryConversionDeliveryState, createMemoryMeasurementGrant, createMemoryMeasurementShareability, createMemoryMeasureAudit, createSqlConversionDeliveryState } from "../index.js";
import type { ConversionDeliveryPort, ConversionDeliveryStatePort, MeasureAuditPort } from "../index.js";
import { consent, event, grant, serviceContext } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

function fixture(required: { ledger?: ConversionDeliveryStatePort; delivery?: ConversionDeliveryPort; audit?: MeasureAuditPort; runtimeMode?: "production-server" | "local-sandbox" | "read-only" }) {
  const clock = createFakeClock({ initial: 300 });
  const policy = createMemoryMeasurementShareability({ clock, evidence: [consent] });
  const grants = createMemoryMeasurementGrant({ grants: [grant] });
  const delivery = required.delivery ?? createMemoryConversionDelivery({});
  const ledger = required.ledger ?? createMemoryConversionDeliveryState({});
  const audit = required.audit ?? createMemoryMeasureAudit({});
  const input = { context: serviceContext, event, grant, deliveryId: "delivery-1" };
  const dependencies = { clock, policy, grants, delivery, ledger, audit, runtimeMode: required.runtimeMode ?? "production-server" as const, payloadSchema: "om.conversion" };
  return { ...dependencies, input, dispatcher: createConversionDispatcher(dependencies) };
}
/** Worker acceptance runs against both durable SQLite and memory claim boundaries. */
function workerSuite(required: { createLedger: () => ConversionDeliveryStatePort }) {
  it("delivers without any agent/studio session and retries keep identity", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ ledger: required.createLedger(), delivery });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(await f.dispatcher.dispatch({ ...f.input, context: { ...serviceContext, traceId: "retry-trace" } })).toEqual({ ok: true, value: { status: "delivered" } });
    expect(delivery.calls({})).toBe(1);
  });
  it("unknown outcomes reconcile under the same ID without a resend", async () => {
    const delivery = createMemoryConversionDelivery({ status: "unknown", reconcileStatus: "delivered" });
    const f = fixture({ ledger: required.createLedger(), delivery });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(delivery.calls({})).toBe(1);
  });
  it("withdrawal after ingestion prevents dispatch", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ ledger: required.createLedger(), delivery });
    f.policy.replace({ evidence: [{ ...consent, withdrawn: true }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("a stale/interrupted claim reconciles and never sends again", async () => {
    const delivery = createMemoryConversionDelivery({});
    const ledger = required.createLedger();
    const f = fixture({ ledger, delivery: { async deliver() { throw new Error("Lost response after possible charge"); } } });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    const restarted = fixture({ ledger, delivery });
    expect(await restarted.dispatcher.dispatch(restarted.input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(delivery.calls({})).toBe(0);
  });
}
describe("memory server conversion worker", () => workerSuite({ createLedger: () => createMemoryConversionDeliveryState({}) }));
describe("SQL server conversion worker", () => workerSuite({ createLedger: () => createSqlConversionDeliveryState({ database: createSqlFixture({}).database }) }));
describe("dispatch security", () => {
  it.each(["local-sandbox", "read-only"] as const)("denies production egress in %s", async runtimeMode => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ runtimeMode, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("rechecks consent after the last asynchronous audit boundary", async () => {
    const delivery = createMemoryConversionDelivery({});
    let withdraw = () => undefined;
    const audit: MeasureAuditPort = { async record() { withdraw(); return { ok: true, value: undefined }; } };
    const f = fixture({ audit, delivery });
    withdraw = () => f.policy.replace({ evidence: [{ ...consent, withdrawn: true }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("revoked or expired grants cannot confer authority", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ delivery });
    f.grants.replace({ grants: [{ ...grant, revoked: true }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.grants.replace({ grants: [{ ...grant, expiresAt: 300 }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("grant changes cannot borrow original account authority", async () => {
    const f = fixture({});
    f.grants.replace({ grants: [{ ...grant, accountId: "other-account" }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("cannot extend a measurement grant to campaign mutation, export or MCP", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ delivery });
    for (const field of ["campaignMutation", "arbitraryExport", "mcp"]) {
      expect(await f.dispatcher.dispatch({ ...f.input, grant: { ...grant, [field]: true } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(delivery.calls({})).toBe(0);
  });
  it("audit failure prevents egress", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ delivery, audit: { async record() { return { ok: false, error: { code: "unavailable", message: "audit down", retryable: false } }; } } });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("records egress audit/trace without identifier values", async () => {
    const audit = createMemoryMeasureAudit({});
    const f = fixture({ audit });
    await f.dispatcher.dispatch(f.input);
    const records = audit.inspect({});
    expect(records.map(record => record.outcome)).toEqual(["dispatch_pending", "dispatch_delivered"]);
    expect(records[0].context.traceId).toBe(serviceContext.traceId);
    expect(JSON.stringify(records)).not.toContain(event.subjectId);
    expect(JSON.stringify(records)).not.toContain(event.identifiers.click_id);
  });
  it("rejects a reused delivery ID with a changed event", async () => {
    const f = fixture({});
    await f.dispatcher.dispatch(f.input);
    expect(await f.dispatcher.dispatch({ ...f.input, event: { ...event, occurredAt: 101 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
