import { describe, expect, it } from "vitest";
import { createFakeClock } from "@open-marketing/om-clock";
import type { Outcome } from "@open-marketing/contracts";
import { ConversionDeliveryPortSuite, PlatformReportingPortSuite, ConversionSourceAuthenticationPortSuite, MeasurementShareabilityPortSuite } from "./port-suites.js";
import { CONVERSION_EVENT_CAPABILITY, createConversionDeliveryAdapter, createPlatformReportingAdapter, createConversionSourceAuthenticationAdapter, createMeasurementShareabilityAdapter, createMemoryConversionDelivery, createMemoryPlatformReporting, createMemoryConversionSourceAuthentication } from "../../index.js";
import { context, event, resolvedEvent, grant, query, serviceContext, snapshot, source } from "../fixtures.js";
type EvidenceLoader = Parameters<typeof createMeasurementShareabilityAdapter>[0]["loadEvidence"];
type Evidence = Extract<Awaited<ReturnType<EvidenceLoader>>, { ok: true }>["value"];
/** Caller-owned evidence includes exact identifier coverage before policy evaluates consent. */
function currentEvidence(required: Partial<Evidence> = {}): Evidence {
  return { policy: { consents: [{ scope: "destination", target: event.destination, purpose: event.purpose, status: "granted", start: 100, end: 1000 }], suppressions: [], holdout: false },
    lineage: [{ subject: { scope: context.scope, subjectId: event.subjectId }, erasure: "none" }], ...required };
}
ConversionDeliveryPortSuite({ create: () => createConversionDeliveryAdapter({ capability: createMemoryConversionDelivery({}) }) });
PlatformReportingPortSuite({ create: () => createPlatformReportingAdapter({ capability: createMemoryPlatformReporting({ snapshot }) }) });
ConversionSourceAuthenticationPortSuite({ create: () => createConversionSourceAuthenticationAdapter({ capability: createMemoryConversionSourceAuthentication({ sources: [source] }) }) });
MeasurementShareabilityPortSuite({ create: () => createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence(input) {
  const evidence = currentEvidence();
  if (Object.keys(input.event.identifierDigests).join() !== "click_id") evidence.policy = { ...evidence.policy, consents: [] };
  return { ok: true, value: evidence };
} }) });

describe("current dispatch policy bridge", () => {
  it("reloads evidence and injected time on every assessment", async () => {
    const clock = createFakeClock({ initial: 300 });
    let evidence = currentEvidence();
    const inputs: unknown[] = [];
    const port = createMeasurementShareabilityAdapter({ clock, async loadEvidence(input, options) {
      inputs.push({ input, signal: options?.signal }); return { ok: true, value: evidence };
    } });
    const controller = new AbortController();
    expect(await port.assess({ context, event }, { signal: controller.signal })).toEqual({ ok: true, value: { allowed: true } });
    expect(inputs).toEqual([{ input: { context, event }, signal: controller.signal }]);
    evidence = currentEvidence({ policy: { ...evidence.policy, consents: [{ ...evidence.policy.consents[0], status: "withdrawn" }] } });
    expect(await port.assess({ context, event })).toEqual({ ok: true, value: { allowed: false, reason: "consent_withdrawn" } });
    evidence = currentEvidence();
    clock.advance({ milliseconds: 700 });
    expect(await port.assess({ context, event })).toEqual({ ok: true, value: { allowed: false, reason: "consent_missing" } });
  });
  it.each(["pending", "erased"] as const)("denies %s erasure anywhere in the merge lineage", async erasure => {
    const evidence = currentEvidence();
    evidence.lineage = [...evidence.lineage, { subject: { scope: context.scope, subjectId: "alias" }, erasure }];
    const port = createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence() { return { ok: true, value: evidence }; } });
    expect(await port.assess({ context, event })).toEqual({ ok: true, value: { allowed: false, reason: erasure === "pending" ? "erasure_pending" : "erased" } });
  });
  it("keeps processing suppression effective after its window ends", async () => {
    const evidence = currentEvidence();
    evidence.policy = { ...evidence.policy, suppressions: [{ channel: "om.processing", start: 0, end: 1 }] };
    const port = createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence() { return { ok: true, value: evidence }; } });
    expect(await port.assess({ context, event })).toEqual({ ok: true, value: { allowed: false, reason: "suppressed" } });
  });
  it.each([{ lineage: [] }, { lineage: [{ subject: { scope: context.scope, subjectId: "wrong-subject" }, erasure: "none" as const }] },
    { lineage: [{ subject: { scope: { ...context.scope, workspaceId: "foreign" }, subjectId: event.subjectId }, erasure: "none" as const }] }])("denies incomplete or foreign lineage: %j", async ({ lineage }) => {
    const port = createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence() { return { ok: true, value: currentEvidence({ lineage }) }; } });
    expect(await port.assess({ context, event })).toEqual({ ok: true, value: { allowed: false, reason: "invalid_input" } });
  });
  it("propagates evidence failures and redacts dependency throws", async () => {
    const unavailable: Outcome<Evidence> = { ok: false, error: { code: "unavailable", message: "Current evidence unavailable", retryable: false } };
    const port = createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence() { return unavailable; } });
    expect(await port.assess({ context, event })).toEqual(unavailable);
    const throwing = createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence() { throw new Error("private-evidence"); } });
    const result = await throwing.assess({ context, event });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("private-evidence");
  });
  it("rejects malformed requests and cancelled calls before loading evidence", async () => {
    let loads = 0;
    const port = createMeasurementShareabilityAdapter({ clock: createFakeClock({ initial: 300 }), async loadEvidence() { loads++; return { ok: true, value: currentEvidence() }; } });
    expect(await port.assess({ context, event: { ...event, subjectId: "" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const controller = new AbortController(); controller.abort();
    expect(await port.assess({ context, event }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(loads).toBe(0);
  });
});
describe("tainted local capability output", () => {
  it("forwards the worker trace to the delivery capability without an agent session", async () => {
    const traces: string[] = [];
    const delivery = createConversionDeliveryAdapter({ capability: { async deliver(input) {
      traces.push(input.context.traceId);
      return { ok: true, value: { status: "delivered" } };
    } } });
    expect(await delivery.deliver({ context: serviceContext, event: resolvedEvent, grant, deliveryId: "traced-delivery" })).toEqual({ ok: true, value: { status: "delivered" } });
    expect(traces).toEqual([serviceContext.traceId]);
  });
  it("names the generic conversion event capability", () => {
    expect(CONVERSION_EVENT_CAPABILITY).toBe("conversion.event.v1");
  });
  it("rejects identifier key mismatches before invoking a capability", async () => {
    let calls = 0;
    const port = createConversionDeliveryAdapter({ capability: { async deliver() { calls++; return { ok: true, value: { status: "delivered" } }; } } });
    expect(await port.deliver({ context: serviceContext, event: { ...resolvedEvent, identifiers: { email: "uncommitted" } }, grant, deliveryId: "mismatch" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(calls).toBe(0);
  });
  it("returns typed failures for thrown capability errors without leaking their text", async () => {
    const port = createPlatformReportingAdapter({ capability: { async snapshot() { throw new Error("vendor-token-secret"); } } });
    const result = await port.snapshot({ context, query });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("vendor-token-secret");
  });
  it("malformed reconciliation input never reaches a local capability", async () => {
    let calls = 0;
    const port = createConversionDeliveryAdapter({ capability: {
      async deliver() { return { ok: true, value: { status: "delivered" } }; },
      async reconcile() { calls++; return { ok: true, value: { status: "delivered" } }; },
    } });
    expect(await port.reconcile!({ context: serviceContext, event: { ...resolvedEvent, occurredAt: -1 }, grant, deliveryId: "delivery" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(calls).toBe(0);
  });
  it("observer failure cannot convert a completed delivery into a retry", async () => {
    const port = createConversionDeliveryAdapter({ capability: createMemoryConversionDelivery({}) }, { observer: { observe() { throw new Error("observer unavailable"); } } });
    expect(await port.deliver({ context: serviceContext, event: resolvedEvent, grant, deliveryId: "observed" })).toEqual({ ok: true, value: { status: "delivered" } });
  });
  it("rejects platform-attributed totals rather than silently summing them", async () => {
    const port = createPlatformReportingAdapter({ capability: { async snapshot() { return { ok: true, value: { ...snapshot, platformConversions: 500, otherPlatformConversions: 300 } }; } } });
    expect(await port.snapshot({ context, query })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("rejects extra egress authority and unknown schemas", async () => {
    const port = createConversionDeliveryAdapter({ capability: { async deliver() { return { ok: true, value: { status: "delivered", arbitraryExport: true } }; } } });
    expect(await port.deliver({ context: serviceContext, event: resolvedEvent, grant, deliveryId: "delivery" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
});
