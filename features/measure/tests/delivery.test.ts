import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import { createConversionDispatcher, createConversionDeliveryAdapter, createMemoryConversionDelivery, createMemoryConversionVerification, createMemoryConversionDeliveryState, createMemoryMeasurementGrant, createMemoryMeasurementShareability, createMemoryMeasureAudit, createSqlConversionDeliveryState, createSqlMeasureRepo, leadOutcomeInputSchema, conversionDiagnosticsSchema } from "../index.js";
import type { ConversionInput, MeasureGrant, ResolvedConversionInput, ConversionIdentifiersPort, ConversionDeliveryPort, ConversionDeliveryStatePort, ConversionVerificationPort, MeasureAuditPort } from "../index.js";
import { consent, createIdentifiers, event, grant, leadOutcomes, leadOutcomeGrant, resolvedEvent, scope, serviceContext, source } from "./fixtures.js";
import { createSqlFixture } from "./sql-fixture.js";

const lookupChanges: readonly Partial<Pick<ResolvedConversionInput, "subjectId" | "identifierDigests" | "identifiers">>[] = [
  { subjectId: "wrong-subject" },
  { identifierDigests: { click_id: "b".repeat(64) } },
  { identifiers: {} },
  { identifiers: { click_id: "click-1", email: "extra" } },
];

function fixture(required: { event?: ConversionInput; grant?: MeasureGrant; identifiers?: ConversionIdentifiersPort; ledger?: ConversionDeliveryStatePort; verification?: ConversionVerificationPort; delivery?: ConversionDeliveryPort; audit?: MeasureAuditPort; runtimeMode?: "production-server" | "local-sandbox" | "read-only" }) {
  const clock = createFakeClock({ initial: 300 });
  const policy = createMemoryMeasurementShareability({ clock, evidence: [consent] });
  const grants = createMemoryMeasurementGrant({ grants: [required.grant ?? grant] });
  const delivery = required.delivery ?? createMemoryConversionDelivery({});
  const ledger = required.ledger ?? createMemoryConversionDeliveryState({});
  const audit = required.audit ?? createMemoryMeasureAudit({});
  const input = { context: serviceContext, event: required.event ?? event, grant: required.grant ?? grant, deliveryId: "delivery-1" };
  const verification = required.verification ?? createMemoryConversionVerification({ events: [{ scope, event: input.event }] });
  const dependencies = { identifiers: required.identifiers ?? createIdentifiers({}), clock, verification, policy, grants, delivery, ledger, audit, runtimeMode: required.runtimeMode ?? "production-server" as const, payloadSchema: "om.conversion" };
  return { ...dependencies, input, dispatcher: createConversionDispatcher(dependencies) };
}
/** Worker acceptance runs against both durable SQLite and memory claim boundaries. */
function workerSuite(required: { createLedger: () => ConversionDeliveryStatePort }) {
  it("refreshes a saved receipt after dispatcher restart without resolving identifiers or sending", async () => {
    const ledger = required.createLedger();
    const accepted = { accepted: true, processed: null, attributed: null, observedAt: 300 };
    const processed = { ...accepted, processed: true, observedAt: 301 };
    const initial = fixture({ ledger, delivery: { async deliver() { return { ok: true, value: { status: "delivered", receiptId: "receipt-1", diagnostics: accepted } }; } } });
    expect(await initial.dispatcher.dispatch(initial.input)).toMatchObject({ ok: true, value: { receiptId: "receipt-1" } });
    let reads = 0;
    const capability: ConversionDeliveryPort = {
      async deliver() { throw new Error("Readback cannot send"); },
      async reconcile(input) {
        reads++;
        expect(input.receiptId).toBe("receipt-1");
        expect(input.event).not.toHaveProperty("identifiers");
        return { ok: true, value: { status: "delivered", diagnostics: processed } };
      },
    };
    const restarted = fixture({ ledger, delivery: createConversionDeliveryAdapter({ capability }), identifiers: { async identifiersFor() { throw new Error("Readback cannot resolve identifiers"); } } });
    expect(await restarted.dispatcher.reconcile(restarted.input)).toEqual({ ok: true, value: { status: "delivered", receiptId: "receipt-1", diagnostics: processed } });
    expect(reads).toBe(1);
    expect(await ledger.read({ context: serviceContext, deliveryId: restarted.input.deliveryId })).toMatchObject({ ok: true, value: { receiptId: "receipt-1", diagnostics: processed } });
  });
  it.each(["failure", "throw", "unknown"] as const)("retains sent evidence without appending after a %s readback", async response => {
    const ledger = required.createLedger();
    const accepted = { accepted: true, processed: null, attributed: null, observedAt: 300 };
    let appends = 0;
    const counted: ConversionDeliveryStatePort = { ...ledger, async append(input, options) { appends++; return ledger.append(input, options); } };
    const f = fixture({ ledger: counted, delivery: {
      async deliver() { return { ok: true, value: { status: "delivered", receiptId: "receipt-1", diagnostics: accepted } }; },
      async reconcile() {
        if (response === "throw") throw new Error("fixture secret");
        if (response === "failure") return { ok: false, error: { code: "unavailable", message: "fixture secret", retryable: false } };
        return { ok: true, value: { status: "unknown" } };
      },
    } });
    const sent = await f.dispatcher.dispatch(f.input);
    const saved = await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId });
    expect(await f.dispatcher.reconcile(f.input)).toEqual(sent);
    expect(appends).toBe(1);
    expect(await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toEqual(saved);
  });
  it.each(["delivered", "unknown"] as const)("does not read back %s without an accepted receipt", async status => {
    let reads = 0;
    const f = fixture({ ledger: required.createLedger(), delivery: {
      async deliver() { return { ok: true, value: { status } }; },
      async reconcile() { reads++; throw new Error("Receipt is required"); },
    } });
    const original = await f.dispatcher.dispatch(f.input);
    expect(await f.dispatcher.reconcile(f.input)).toEqual(original);
    expect(reads).toBe(0);
  });
  it("rejects receipt refresh against a changed event identity before calling the port", async () => {
    let reads = 0;
    const f = fixture({ ledger: required.createLedger(), delivery: {
      async deliver() { return { ok: true, value: { status: "delivered", receiptId: "receipt-1" } }; },
      async reconcile() { reads++; return { ok: true, value: { status: "delivered" } }; },
    } });
    await f.dispatcher.dispatch(f.input);
    expect(await f.dispatcher.reconcile({ ...f.input, event: { ...f.input.event, subjectId: "different" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(reads).toBe(0);
  });
  it("persists a fresh final-gate refusal and returns it on duplicate without calling delivery", async () => {
    const delivery = createMemoryConversionDelivery({});
    let refuse = () => {};
    const audit: MeasureAuditPort = { async record() { refuse(); return { ok: true, value: undefined }; } };
    const f = fixture({ ledger: required.createLedger(), delivery, audit });
    refuse = () => f.policy.replace({ evidence: [{ ...consent, withdrawn: true }] });
    const expected = { ok: true, value: { status: "not_sent", reason: "forbidden" } };
    expect(await f.dispatcher.dispatch(f.input)).toEqual(expected);
    expect(await f.ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toMatchObject(expected);
    f.policy.replace({ evidence: [consent] });
    expect(await f.dispatcher.dispatch(f.input)).toEqual(expected);
    expect(delivery.calls({})).toBe(0);
  });
  it("does not reclassify an earlier uncertain send when final reconciliation gates refuse", async () => {
    const f = fixture({ ledger: required.createLedger(), delivery: createMemoryConversionDelivery({ status: "unknown" }) });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    const previous = await f.ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId });
    const audit: MeasureAuditPort = { async record() { f.policy.replace({ evidence: [] }); return { ok: true, value: undefined }; } };
    const dispatcher = createConversionDispatcher({ ...f, audit });
    expect(await dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await f.ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toEqual(previous);
  });
  it("returns ledger diagnostics and audits when another reconcile appends newer evidence", async () => {
    const ledger = required.createLedger();
    const audit = createMemoryMeasureAudit({});
    const diagnostics = { accepted: true, processed: null, attributed: null, observedAt: 299 };
    const newer = { ...diagnostics, processed: true, observedAt: 301 };
    let sends = 0;
    const delivery: ConversionDeliveryPort = {
      async deliver() { sends++; return { ok: true, value: { status: "unknown", diagnostics } }; },
      async reconcile(input) {
        const current = await ledger.read({ context: input.context, deliveryId: input.deliveryId });
        if (!current.ok || !current.value) throw new Error("Expected a delivery claim");
        expect(await ledger.append({ context: input.context, record: { ...current.value, diagnostics: newer } })).toMatchObject({ ok: true });
        return { ok: true, value: { status: "delivered", diagnostics: { ...diagnostics, observedAt: 300 } } };
      },
    };
    const f = fixture({ ledger, delivery, audit });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "unknown", diagnostics } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered", diagnostics: newer } });
    expect(await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toMatchObject({ ok: true, value: { status: "delivered", diagnostics: newer } });
    expect(audit.inspect({}).at(-1)).toMatchObject({ operationId: f.input.deliveryId, outcome: "reconcile_delivered" });
    expect(sends).toBe(1);
  });
  it.each([
    { processed: false, observedAt: 301 },
    { processed: null, observedAt: 301 },
    { processed: true, observedAt: 299 },
  ])("records delivery despite disagreeing reconciliation diagnostics without sending again: %j", async change => {
    const diagnostics = { accepted: true, processed: true, attributed: null, observedAt: 300 };
    let sends = 0;
    const delivery: ConversionDeliveryPort = {
      async deliver() { sends++; return { ok: true, value: { status: "unknown", diagnostics } }; },
      async reconcile() { return { ok: true, value: { status: "delivered", diagnostics: { ...diagnostics, ...change } } }; },
    };
    const f = fixture({ ledger: required.createLedger(), delivery });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "unknown", diagnostics } });
    const merged = { ...diagnostics, observedAt: Math.max(diagnostics.observedAt, change.observedAt) };
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered", diagnostics: merged } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered", diagnostics: merged } });
    expect(await f.ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toMatchObject({ ok: true, value: { status: "delivered", diagnostics: merged } });
    expect(sends).toBe(1);
  });
  it.each(leadOutcomes)("delivers $definitionId once with explicit vendor stages", async event => {
    const diagnostics = { accepted: true, processed: null, attributed: false, observedAt: 300 };
    const delivery = createConversionDeliveryAdapter({ capability: createMemoryConversionDelivery({ diagnostics }) });
    const ledger = required.createLedger();
    const f = fixture({ event, grant: leadOutcomeGrant, ledger, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered", diagnostics } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered", diagnostics } });
    expect(await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toMatchObject({ ok: true, value: { diagnostics } });
  });
  it.each(leadOutcomes)("retains grant and consent gates for $definitionId", async event => {
    const delivery = createMemoryConversionDelivery({});
    const f = fixture({ event, grant: leadOutcomeGrant, ledger: required.createLedger(), delivery });
    f.grants.replace({ grants: [grant] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.grants.replace({ grants: [leadOutcomeGrant] });
    f.policy.replace({ evidence: [{ ...consent, withdrawn: true }] });
    expect(await f.dispatcher.dispatch(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it.each(["absent", "malformed"])("keeps diagnostics across %s reconciliation and later processing evidence", async response => {
    const diagnostics = { accepted: true, processed: null, attributed: null, observedAt: 300 };
    const processed = { ...diagnostics, processed: true, observedAt: 301 };
    let sends = 0;
    let reconciliations = 0;
    const delivery: ConversionDeliveryPort = {
      async deliver() { sends++; return { ok: true, value: { status: "unknown", diagnostics } }; },
      async reconcile() {
        reconciliations++;
        if (reconciliations > 1) return { ok: true, value: { status: "delivered", diagnostics: processed } };
        if (response === "malformed") return { ok: true, value: { status: "delivered", diagnostics: { ...diagnostics, observedAt: -1 } } };
        return { ok: true, value: { status: "unknown" } };
      },
    };
    const ledger = required.createLedger();
    const f = fixture({ event: leadOutcomes[0], grant: leadOutcomeGrant, ledger, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "unknown", diagnostics } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "unknown", diagnostics } });
    expect(await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toMatchObject({ ok: true, value: { diagnostics } });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "delivered", diagnostics: processed } });
    expect(sends).toBe(1);
  });
  it("treats malformed diagnostic output as unknown without inventing acceptance", async () => {
    const delivery: ConversionDeliveryPort = { async deliver() { return { ok: true, value: { status: "delivered", diagnostics: { accepted: true, processed: true, attributed: true, observedAt: -1 } } }; } };
    const ledger = required.createLedger();
    const f = fixture({ ledger, delivery });
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId })).toMatchObject({ ok: true, value: { status: "unknown" } });
    const result = await ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId });
    if (result.ok) expect(result.value?.diagnostics).toBeUndefined();
  });
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
    const evidence = await f.ledger.read({ context: serviceContext, deliveryId: f.input.deliveryId });
    expect(evidence.ok).toBe(true);
    if (evidence.ok) expect(evidence.value?.diagnostics).toBeUndefined();
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
it("retains receipt and processing evidence when the SQL ledger adapter is recreated", async () => {
  const sql = createSqlFixture({});
  const first = fixture({ ledger: createSqlConversionDeliveryState({ database: sql.database }), delivery: {
    async deliver() { return { ok: true, value: { status: "delivered", receiptId: "durable-receipt" } }; },
  } });
  expect(await first.dispatcher.dispatch(first.input)).toMatchObject({ ok: true, value: { receiptId: "durable-receipt" } });
  const restarted = fixture({ ledger: createSqlConversionDeliveryState({ database: sql.database }), identifiers: { async identifiersFor() { throw new Error("No identifiers during restart readback"); } }, delivery: {
    async deliver() { throw new Error("No resend"); },
    async reconcile(input) {
      expect(input.receiptId).toBe("durable-receipt");
      return { ok: true, value: { status: "delivered", diagnostics: { accepted: true, processed: true, attributed: null, observedAt: 301 } } };
    },
  } });
  expect(await restarted.dispatcher.reconcile(restarted.input)).toMatchObject({ ok: true, value: { receiptId: "durable-receipt", diagnostics: { processed: true } } });
  const third = createSqlConversionDeliveryState({ database: sql.database });
  expect(await third.read({ context: serviceContext, deliveryId: first.input.deliveryId })).toMatchObject({ ok: true, value: { receiptId: "durable-receipt", diagnostics: { processed: true } } });
});
describe("lead outcome conversion intents", () => {
  it("keeps seeded fixture diagnostics detached through retries and reconciliation", async () => {
    const diagnostics = { accepted: true, processed: null, attributed: null, observedAt: 300 };
    const processed = { ...diagnostics, processed: true, observedAt: 301 };
    const delivery = createMemoryConversionDelivery({ status: "unknown", diagnostics, reconcileStatus: "delivered", reconcileDiagnostics: processed });
    const input = { context: serviceContext, event: resolvedEvent, grant, deliveryId: "fixture-diagnostics" };
    const first = await delivery.deliver(input);
    expect(first).toEqual({ ok: true, value: { status: "unknown", diagnostics } });
    if (first.ok && first.value.status !== "not_sent") Object.assign(first.value.diagnostics ?? {}, { accepted: false });
    expect(await delivery.deliver(input)).toEqual({ ok: true, value: { status: "unknown", diagnostics } });
    expect(await delivery.reconcile!(input)).toEqual({ ok: true, value: { status: "delivered", diagnostics: processed } });
    expect(delivery.calls({})).toBe(1);
  });
  it("restricts intent definitions and keeps vendor stages explicit and bounded", () => {
    for (const { eventId: _unused, ...event } of leadOutcomes) expect(leadOutcomeInputSchema.safeParse({ source, leadId: "lead-1", event }).success).toBe(true);
    const { eventId: _unused, ...signup } = event;
    const { eventId: _derived, ...outcome } = leadOutcomes[0]!;
    expect(leadOutcomeInputSchema.safeParse({ source, leadId: "lead-1", event: signup }).success).toBe(false);
    expect(leadOutcomeInputSchema.safeParse({ source, leadId: "lead-1", event: leadOutcomes[0] }).success).toBe(false);
    expect(leadOutcomeInputSchema.safeParse({ source, leadId: "lead-1", event: { ...outcome, identifiers: resolvedEvent.identifiers } }).success).toBe(false);
    const diagnostics = { accepted: null, processed: null, attributed: null, observedAt: 300 };
    expect(conversionDiagnosticsSchema.safeParse(diagnostics).success).toBe(true);
    expect(conversionDiagnosticsSchema.safeParse({ ...diagnostics, accepted: "true" }).success).toBe(false);
    expect(conversionDiagnosticsSchema.safeParse({ ...diagnostics, token: "private" }).success).toBe(false);
    expect(conversionDiagnosticsSchema.safeParse({ accepted: true }).success).toBe(false);
  });
  it.each(leadOutcomes)("rolls back $definitionId intent when atomic enqueue fails", async event => {
    const f = createSqlFixture({});
    const repo = createSqlMeasureRepo({ database: f.database, jobs: f.jobs });
    f.failNextEnqueue();
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.counts()).toEqual({ events: 0, jobs: 0 });
    expect(await repo.appendConversion({ source, event })).toMatchObject({ ok: true, value: { status: "accepted" } });
    expect(f.counts()).toEqual({ events: 1, jobs: 1 });
  });
});
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
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "not_sent", reason: "forbidden" } });
    expect(delivery.calls({})).toBe(0);
  });
  it("matches digest key order and uses current identifiers for reconciliation", async () => {
    const committed = { ...event, identifierDigests: { click_id: "a".repeat(64), email_hash: "b".repeat(64) } };
    const identifiers = createIdentifiers({ event: { ...committed, identifierDigests: { email_hash: "b".repeat(64), click_id: "a".repeat(64) }, identifiers: { email_hash: "hashed-email", click_id: "click-1" } } });
    let reconciled: Parameters<NonNullable<ConversionDeliveryPort["reconcile"]>>[0] | undefined;
    const backend = createMemoryConversionDelivery({ status: "unknown", reconcileStatus: "delivered" });
    const delivery: ConversionDeliveryPort = { deliver: backend.deliver, async reconcile(input) { reconciled = input; return backend.reconcile!(input); } };
    const f = fixture({ identifiers, delivery, verification: createMemoryConversionVerification({ events: [{ scope, event: committed }] }) });
    f.policy.replace({ evidence: [{ ...consent, identifierKeys: ["click_id", "email_hash"] }] });
    const input = { ...f.input, event: committed };
    expect(await f.dispatcher.dispatch(input)).toMatchObject({ ok: true, value: { status: "unknown" } });
    identifiers.replace({ event: { ...committed, identifiers: { click_id: "current-click", email_hash: "hashed-email" } } });
    expect(await f.dispatcher.dispatch({ ...input, context: { ...serviceContext, traceId: "retry-trace" } })).toMatchObject({ ok: true, value: { status: "delivered" } });
    expect(reconciled?.event.identifiers?.click_id).toBe("current-click");
    expect(backend.calls({})).toBe(1);
  });
  const legacy = { ...event, eventId: "legacy-commit", identifierDigests: { email: "e".repeat(64), phone: "b".repeat(64) } };
  const superset = { email: "e".repeat(64), phone: "b".repeat(64), phone_digits: "d".repeat(64), client_user_agent: "c".repeat(64), event_source_url: "f".repeat(64) };
  const supersetIdentifiers = { email: "hashed-email", phone: "hashed-phone", phone_digits: "hashed-digits", client_user_agent: "Fixture/1.0", event_source_url: "https://site.example/landing" };
  it("dispatches a legacy {email, phone} commit once with the resolved superset, without changing the committed identity", async () => {
    let sent: Parameters<ConversionDeliveryPort["deliver"]>[0] | undefined;
    let sends = 0;
    const delivery: ConversionDeliveryPort = { async deliver(input) { sends++; sent = input; return { ok: true, value: { status: "delivered" } }; } };
    const ledger = createMemoryConversionDeliveryState({});
    const identifiers = createIdentifiers({ event: { ...legacy, identifierDigests: superset, identifiers: supersetIdentifiers } });
    const f = fixture({ identifiers, delivery, ledger, verification: createMemoryConversionVerification({ events: [{ scope, event: legacy }] }) });
    f.policy.replace({ evidence: [{ ...consent, identifierKeys: ["email", "phone"] }] });
    const input = { ...f.input, event: legacy };
    expect(await f.dispatcher.dispatch(input)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(await f.dispatcher.dispatch(input)).toMatchObject({ ok: true, value: { status: "delivered" } });
    expect(sends).toBe(1);
    expect(sent?.event.identifiers).toEqual(supersetIdentifiers);
    expect(sent?.event.identifierDigests).toEqual(superset);
    expect(input.event.identifierDigests).toEqual({ email: "e".repeat(64), phone: "b".repeat(64) });
    expect(JSON.stringify(ledger.history({}))).not.toContain("Fixture/1.0");
  });
  it.each([
    { name: "changed committed digest", digests: { ...superset, phone: "1".repeat(64) } },
    { name: "missing committed key", digests: { email: "e".repeat(64), phone_digits: "d".repeat(64) } },
  ])("refuses a legacy commit with a $name", async ({ digests }) => {
    const delivery = createMemoryConversionDelivery({});
    const identifiers = createIdentifiers({ event: { ...legacy, identifierDigests: digests, identifiers: Object.fromEntries(Object.keys(digests).map(key => [key, "value-" + key])) } });
    const f = fixture({ identifiers, delivery, verification: createMemoryConversionVerification({ events: [{ scope, event: legacy }] }) });
    f.policy.replace({ evidence: [{ ...consent, identifierKeys: ["email", "phone"] }] });
    expect(await f.dispatcher.dispatch({ ...f.input, event: legacy })).toMatchObject({ ok: false, error: { code: "forbidden", message: "Identifier evidence does not match the committed event" } });
    expect(delivery.calls({})).toBe(0);
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
      async read() { return { ok: true, value: null }; },
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
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "not_sent", reason: "forbidden" } });
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
    expect(await f.dispatcher.dispatch(f.input)).toEqual({ ok: true, value: { status: "not_sent", reason: "unavailable" } });
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
