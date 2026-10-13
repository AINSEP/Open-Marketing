import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { createConversionDispatcher, createMemoryConversionDelivery, createMemoryConversionVerification, createMemoryConversionDeliveryState, createMemoryMeasurementGrant, createMemoryMeasurementShareability, createMemoryMeasureAudit, createSqlConversionDeliveryState } from "../index.js";
import type { ResolvedConversionInput, ConversionIdentifiersPort, ConversionDeliveryPort, ConversionDeliveryStatePort, ConversionVerificationPort, MeasureAuditPort } from "../index.js";
import { consent, createIdentifiers, event, grant, resolvedEvent, scope, serviceContext } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

const lookupChanges: readonly Partial<Pick<ResolvedConversionInput, "subjectId" | "identifierDigests" | "identifiers">>[] = [
  { subjectId: "wrong-subject" },
  { identifierDigests: { click_id: "b".repeat(64) } },
  { identifiers: {} },
  { identifiers: { click_id: "click-1", email: "extra" } },
];

function fixture(required: { identifiers?: ConversionIdentifiersPort; ledger?: ConversionDeliveryStatePort; verification?: ConversionVerificationPort; delivery?: ConversionDeliveryPort; audit?: MeasureAuditPort; runtimeMode?: "production-server" | "local-sandbox" | "read-only" }) {
  const clock = createFakeClock({ initial: 300 });
  const policy = createMemoryMeasurementShareability({ clock, evidence: [consent] });
  const grants = createMemoryMeasurementGrant({ grants: [grant] });
  const delivery = required.delivery ?? createMemoryConversionDelivery({});
  const ledger = required.ledger ?? createMemoryConversionDeliveryState({});
  const audit = required.audit ?? createMemoryMeasureAudit({});
  const input = { context: serviceContext, event, grant, deliveryId: "delivery-1" };
  const verification = required.verification ?? createMemoryConversionVerification({ events: [{ scope, event }] });
  const dependencies = { identifiers: required.identifiers ?? createIdentifiers({}), clock, verification, policy, grants, delivery, ledger, audit, runtimeMode: required.runtimeMode ?? "production-server" as const, payloadSchema: "om.conversion" };
  return { ...dependencies, input, dispatcher: createConversionDispatcher(dependencies) };
}
/** Worker acceptance runs against both durable SQLite and memory claim boundaries. */
function workerSuite(required: { createLedger: () => ConversionDeliveryStatePort }) {
  it("persists evidence even when cancellation arrives during delivery", async () => {
    const ledger = required.createLedger();
    const controller = new AbortController();
    let sends = 0;
    const delivery: ConversionDeliveryPort = { async deliver() { sends++; controller.abort(); return { ok: true, value: { status: "delivered" } }; } };
    const f = fixture({ ledger, delivery });
    expect(await f.dispatcher.dispatch(f.input, { signal: controller.signal })).toEqual({ ok: true, value: { status: "delivered" } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(sends).toBe(1);
  });
  it("simultaneous workers perform one send and preserve uncertainty", async () => {
    const delivery = createMemoryConversionDelivery({ status: "unknown" });
    const f = fixture({ ledger: required.createLedger(), delivery });
    const outcomes = await Promise.all([f.dispatcher.dispatch(f.input), f.dispatcher.dispatch(f.input)]);
    expect(outcomes.every(outcome => outcome.ok && outcome.value.status === "unknown")).toBe(true);
    expect(delivery.calls({})).toBe(1);
  });
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
  it.each(["forbidden", "unavailable"] as const)("lookup %s prevents claims and egress", async code => {
    const delivery = createMemoryConversionDelivery({});
    const ledger = createMemoryConversionDeliveryState({});
    const identifiers: ConversionIdentifiersPort = { async identifiersFor() { return { ok: false, error: { code, message: "Identifiers unavailable", retryable: false } }; } };
    const f = fixture({ identifiers, delivery, ledger });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code } });
    expect(delivery.calls({})).toBe(0);
    expect(ledger.history({})).toHaveLength(0);
  });
  it("erasure after enqueue prevents both a fresh send and reconciliation", async () => {
    const identifiers = createIdentifiers({});
    const delivery = createMemoryConversionDelivery({ status: "unknown", reconcileStatus: "delivered" });
    const f = fixture({ identifiers, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    identifiers.replace({ event: null });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await fixture({ identifiers, delivery }).dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(1);
  });
  it.each(lookupChanges)("denies mismatched lookup evidence: %j", async change => {
    const evidence = { subjectId: event.subjectId, identifierDigests: event.identifierDigests, identifiers: resolvedEvent.identifiers, ...change };
    const identifiers: ConversionIdentifiersPort = { async identifiersFor() { return { ok: true, value: evidence }; } };
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ identifiers, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("malformed lookup evidence is rejected without exposing raw values", async () => {
    const identifiers: ConversionIdentifiersPort = { async identifiersFor() { return { ok: true, value: { subjectId: event.subjectId, identifiers: { click_id: "secret-click" }, identifierDigests: { click_id: "secret-click" } } }; } };
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ identifiers, delivery });
    const outcome = await f.dispatcher.dispatch(f.input);
    expect(outcome).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(JSON.stringify(outcome)).not.toContain("secret-click");
    expect(delivery.calls({})).toBe(0);
  });
  it("lookup throws are contained and redacted", async () => {
    const identifiers: ConversionIdentifiersPort = { async identifiersFor() { throw new Error("secret-lookup-value"); } };
    const delivery = createMemoryConversionDelivery({});
    const outcome = await fixture({ identifiers, delivery }).dispatcher.dispatch({ context: serviceContext, event, grant, deliveryId: "lookup-throw" });
    expect(outcome).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(outcome)).not.toContain("secret-lookup-value");
    expect(delivery.calls({})).toBe(0);
  });
  it("sends resolved identifiers transiently and keeps immutable evidence digest-only", async () => {
    const ledger = createMemoryConversionDeliveryState({});
    const audit = createMemoryMeasureAudit({});
    const inputEvent = { ...event, value: { minorUnits: 1999, currency: "USD" }, orderRef: "order-1" };
    let sent: Parameters<ConversionDeliveryPort["deliver"]>[0] | undefined;
    const delivery: ConversionDeliveryPort = { async deliver(input) { sent = input; return { ok: true, value: { status: "delivered" } }; } };
    const verification = createMemoryConversionVerification({ events: [{ scope, event: inputEvent }] });
    const f = fixture({ delivery, ledger, audit, verification });
    expect(await f.dispatcher.dispatch({ ...f.input, event: inputEvent })).toMatchObject({ ok: true });
    expect(sent).toEqual({ ...f.input, event: { ...inputEvent, identifiers: resolvedEvent.identifiers } });
    expect(f.input.event).not.toHaveProperty("identifiers");
    expect(ledger.history({})).toHaveLength(2);
    for (const record of ledger.history({})) {
      expect(record).toMatchObject({ subjectId: event.subjectId, eventId: event.eventId });
      expect(record.identity).toMatch(/^[a-f0-9]{64}$/);
      expect(record).not.toHaveProperty("identifiers");
    }
    expect(JSON.stringify([ledger.history({}), audit.inspect({})])).not.toContain(resolvedEvent.identifiers.click_id);
  });
  it.each(["consent", "grant"])("rechecks %s changed during identifier lookup", async gate => {
    const current = createIdentifiers({});
    let revoke: () => void = () => undefined;
    const identifiers: ConversionIdentifiersPort = { async identifiersFor(input) { revoke(); return current.identifiersFor(input); } };
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ identifiers, delivery });
    revoke = () => {
      if (gate === "consent") f.policy.replace({ evidence: [{ ...consent, withdrawn: true }] });
      else f.grants.replace({ grants: [{ ...grant, revoked: true }] });
    };
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("matches digest key order and uses current identifiers for reconciliation", async () => {
    const committed = { ...event, identifierDigests: { click_id: "a".repeat(64), email_hash: "b".repeat(64) } };
    const identifiers = createIdentifiers({ event: { ...committed, identifierDigests: { email_hash: "b".repeat(64), click_id: "a".repeat(64) }, identifiers: { email_hash: "hashed-email", click_id: "click-1" } } });
    let reconciled: Parameters<ConversionDeliveryPort["deliver"]>[0] | undefined;
    const backend = createMemoryConversionDelivery({ status: "unknown", reconcileStatus: "delivered" });
    const delivery: ConversionDeliveryPort = { deliver: backend.deliver, async reconcile(input) { reconciled = input; return backend.reconcile!(input); } };
    const f = fixture({ identifiers, delivery, verification: createMemoryConversionVerification({ events: [{ scope, event: committed }] }) });
    f.policy.replace({ evidence: [{ ...consent, identifierKeys: ["click_id", "email_hash"] }] });
    const input = { ...f.input, event: committed };
    expect(await f.dispatcher.dispatch(input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    identifiers.replace({ event: { ...committed, identifiers: { click_id: "current-click", email_hash: "hashed-email" } } });
    expect(await f.dispatcher.dispatch({ ...input, context: { ...serviceContext, traceId: "retry-trace" } })).toMatchObject({ ok: true, value: { status: "delivered" } });
    expect(reconciled?.event.identifiers.click_id).toBe("current-click");
    expect(backend.calls({})).toBe(1);
  });
  it("requires a definition-bound grant and rejects identifier-bearing worker input", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ delivery });
    f.grants.replace({ grants: [{ ...grant, definitionIds: ["purchase"] }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await f.dispatcher.dispatch({ ...f.input, event: resolvedEvent })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(delivery.calls({})).toBe(0);
  });
  it.each([{ definitionIds: [] }, { definitionIds: Array.from({ length: 17 }, (_, index) => "definition-" + index) }])("rejects unbounded or empty definition authority: %j", async ({ definitionIds }) => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ delivery });
    expect(await f.dispatcher.dispatch({ ...f.input, grant: { ...grant, definitionIds } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("uncommitted events never acquire authority or reach egress", async () => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ delivery });
    expect(await f.dispatcher.dispatch({ ...f.input, event: { ...event, eventId: "invented" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("rejects tainted ledger claims without egress", async () => {
    const delivery = createMemoryConversionDelivery({});
    const ledger: ConversionDeliveryStatePort = {
      async begin(input) { return { ok: true, value: { acquired: true, record: { ...input.record, identity: "f".repeat(64) } } }; },
      async append(input) { return { ok: true, value: input.record }; },
    };
    const f = fixture({ delivery, ledger });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(delivery.calls({})).toBe(0);
  });
  it.each(["local-sandbox", "read-only"] as const)("denies production egress in %s", async runtimeMode => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ runtimeMode, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("rechecks consent after the last asynchronous audit boundary", async () => {
    const delivery = createMemoryConversionDelivery({});
    let withdraw: () => void = () => undefined;
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
    expect(JSON.stringify(records)).not.toContain(resolvedEvent.identifiers.click_id);
  });
  it("rejects a reused delivery ID with a different committed event", async () => {
    const verification = createMemoryConversionVerification({ events: [{ scope, event }, { scope, event: { ...event, occurredAt: 101 } }] });
    const f = fixture({ verification });
    await f.dispatcher.dispatch(f.input);
    expect(await f.dispatcher.dispatch({ ...f.input, event: { ...event, occurredAt: 101 } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
});
