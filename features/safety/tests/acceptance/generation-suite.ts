import { describe, expect, it } from "vitest";
import { approve, context, createHarness, generationRequest, NOW, unwrap } from "../fixtures.js";
import type { EffectRequest, FrozenDispatchRequest, GenerationReservation, SafetyService } from "../../index.js";
import type { Harness } from "../fixtures.js";
/** Reserve through the real approval and dispatch path; no test fabricates authority. */
async function reserve(required: { harness: Harness; service: SafetyService; request: EffectRequest; choice?: "allow" | "always_allow" | "allow_chat" }): Promise<GenerationReservation> {
 const dispatch = await approve(required);
 return unwrap({ outcome: await required.service.reserveGeneration({ context, authorization: { ...required.request.generation!, dispatch } }) });
}
/** Generation safety/accounting acceptance shared across memory and SQL. */
export function generationSuite(required: { backend: "memory" | "sql" }) {
 describe(`${required.backend} generation acceptance`, () => {
  it("reads the owner-local default setting through the public service", async () => {
   const harness = createHarness(required);
   expect(await harness.service().getGenerationAllowance({ context })).toMatchObject({ ok: true, value: { amount: { minorUnits: 1000, currency: "USD" }, dayTimezone: "America/Los_Angeles", revision: 0 } });
   harness.close();
  });
  it("under allowance offers Always allow; above/unknown/expired never does", async () => {
   const harness = createHarness(required);
   const under = generationRequest({ amount: 1000 });
   const above = generationRequest({ amount: 1001, operationId: "above" });
   const unknown = generationRequest({ status: "unknown", operationId: "unknown" });
   const expired = generationRequest({ operationId: "expired", now: NOW - 86_400_001 });
   const service = harness.service({ requests: [under, above, unknown, expired] });
   expect(unwrap({ outcome: await service.prepareApproval({ context, request: under }) }).allowedChoices).toEqual(["allow", "allow_chat", "always_allow", "cancel"]);
   expect(unwrap({ outcome: await service.prepareApproval({ context, request: above }) }).allowedChoices).toEqual(["allow", "cancel"]);
   expect(unwrap({ outcome: await service.prepareApproval({ context, request: unknown }) }).allowedChoices).toEqual(["allow", "cancel"]);
   expect(unwrap({ outcome: await service.prepareApproval({ context, request: expired }) }).allowedChoices).toEqual(["allow", "cancel"]);
   harness.close();
  });
  it("concurrent normal-grant reservations cannot oversubscribe allowance", async () => {
   const harness = createHarness(required);
   const first = generationRequest({ operationId: "first" });
   const second = generationRequest({ operationId: "second" });
   const service = harness.service({ requests: [first, second] });
   const a = await approve({ harness, service, request: first, choice: "always_allow" });
   const b = await approve({ harness, service, request: second, choice: "always_allow" });
   const outcomes = await Promise.all([service.reserveGeneration({ context, authorization: { ...first.generation, dispatch: a } }), service.reserveGeneration({ context, authorization: { ...second.generation, dispatch: b } })]);
   expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
   expect(await service.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true });
   harness.close();
  });
  it("persistent generation grant applies to a future matching tool but never waives above-allowance spend", async () => {
   const harness = createHarness(required);
   const first = generationRequest({ operationId: "first", amount: 300 });
   const second = generationRequest({ operationId: "second", amount: 300 });
   const above = generationRequest({ operationId: "above", amount: 800 });
   const service = harness.service({ requests: [first, second, above] });
   const a = await approve({ harness, service, request: first, choice: "always_allow" });
   unwrap({ outcome: await service.reserveGeneration({ context, authorization: { ...first.generation, dispatch: a } }) });
   const b = { ...second, approvalId: a.approvalId, policyRevision: 0 };
   expect((await service.reserveGeneration({ context, authorization: { ...second.generation, dispatch: b } })).ok).toBe(true);
   const broad = { ...above, approvalId: a.approvalId, policyRevision: 0 };
   expect((await service.reserveGeneration({ context, authorization: { ...above.generation, dispatch: broad } })).ok).toBe(false);
   harness.close();
  });
  it("over allowance requires an exact spend card, unknown without upper bound cannot dispatch", async () => {
   const harness = createHarness(required);
   const above = generationRequest({ amount: 1200 });
   const unknown = generationRequest({ operationId: "unknown", status: "unknown" });
   const unknownUnbounded = { ...unknown, generation: { ...unknown.generation, quote: { ...unknown.generation.quote, estimated: null, upperBound: null } } };
   const service = harness.service({ requests: [above, unknownUnbounded] });
   expect((await reserve({ harness, service, request: above })).amount.minorUnits).toBe(1200);
   const dispatch = await approve({ harness, service, request: unknownUnbounded });
   expect((await service.reserveGeneration({ context, authorization: { ...unknownUnbounded.generation, dispatch } })).ok).toBe(false);
   harness.close();
  });
  it("local midnight, unresolved timeout and late cost settlement preserve accounting", async () => {
   const beforeMidnight = Date.parse("2026-10-02T06:59:00Z");
   const afterMidnight = Date.parse("2026-10-02T07:01:00Z");
   const harness = createHarness({ ...required, now: beforeMidnight });
   const first = generationRequest({ amount: 600, now: beforeMidnight });
   const service = harness.service({ requests: [first] });
   const reservation = await reserve({ harness, service, request: first });
   expect(reservation.dispatchDay).toBe("America/Los_Angeles:2026-10-01");
   harness.time.setNow({ now: afterMidnight });
   const second = generationRequest({ amount: 600, operationId: "next-day", now: afterMidnight });
   const later = harness.service({ requests: [second] });
   expect(await later.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { kind: "exact_spend", dispatchDay: "America/Los_Angeles:2026-10-02" } });
   const settlement = { reservationId: reservation.reservationId, observationId: "charge", actual: { minorUnits: 500, currency: "USD" } };
   const backend = { scope: context.scope, serviceId: "cost-observer", correlationId: "late-cost", traceId: "trace" };
   unwrap({ outcome: await later.settleGeneration({ context: backend, settlement }) });
   expect(await later.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { kind: "normal_write" } });
   unwrap({ outcome: await later.settleGeneration({ context: backend, settlement }) });
   expect((await later.settleGeneration({ context: backend, settlement: { ...settlement, actual: { minorUnits: 200, currency: "USD" } } })).ok).toBe(false);
   harness.close();
  });
  it("UTC midnight does not reset the owner's local allowance", async () => {
   const before = Date.parse("2026-10-01T23:59:00Z");
   const harness = createHarness({ ...required, now: before });
   const first = generationRequest({ amount: 600, now: before });
   await reserve({ harness, service: harness.service({ requests: [first] }), request: first });
   harness.time.setNow({ now: Date.parse("2026-10-02T00:01:00Z") });
   const second = generationRequest({ operationId: "later", amount: 600, now: harness.time.clock.now({}) });
   expect(await harness.repo.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { kind: "exact_spend", dispatchDay: "America/Los_Angeles:2026-10-01" } });
   harness.close();
  });
  it("timezone change becomes effective only at next old-zone rollover", async () => {
   const harness = createHarness(required);
   const service = harness.service({ requests: [generationRequest()] });
   const setting = unwrap({ outcome: await harness.repo.getGenerationAllowance({ context }) });
   unwrap({ outcome: await service.setGenerationAllowance({ context, settings: { ...setting, dayTimezone: "Asia/Tokyo" } }) });
   expect(await harness.repo.assessGeneration({ context, ...generationRequest().generation })).toMatchObject({ ok: true, value: { dispatchDay: "America/Los_Angeles:2026-10-01", allowanceRevision: 1 } });
   harness.time.setNow({ now: Date.parse("2026-10-02T07:00:00Z") });
   const next = generationRequest({ now: harness.time.clock.now({}) });
   expect(await harness.repo.assessGeneration({ context, ...next.generation })).toMatchObject({ ok: true, value: { dispatchDay: "Asia/Tokyo:2026-10-02" } });
   harness.close();
  });
  it("settings decrease retains reservations and invalidates normal approval classification", async () => {
   const harness = createHarness(required);
   const first = generationRequest({ operationId: "first", amount: 400 });
   const second = generationRequest({ operationId: "second", amount: 400 });
   const service = harness.service({ requests: [first, second] });
   await reserve({ harness, service, request: first });
   const approved = await approve({ harness, service, request: second });
   const settings = unwrap({ outcome: await harness.repo.getGenerationAllowance({ context }) });
   unwrap({ outcome: await service.setGenerationAllowance({ context, settings: { ...settings, amount: { minorUnits: 500, currency: "USD" } } }) });
   expect(await service.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { kind: "exact_spend", allowanceRevision: 1 } });
   expect((await service.reserveGeneration({ context, authorization: { ...second.generation, dispatch: approved } })).ok).toBe(false);
   harness.close();
  });
  it("quote/configuration drift and forged cost provenance need new authority", async () => {
   const harness = createHarness(required);
   const original = generationRequest();
   const changed = { ...original, generation: { ...original.generation, quote: { ...original.generation.quote, upperBound: { minorUnits: 800, currency: "USD" } } } };
   const service = harness.service({ requests: [original, changed] });
   const approved = await approve({ harness, service, request: original });
   const tampered: FrozenDispatchRequest = { ...changed, approvalId: approved.approvalId, policyRevision: 0 };
   expect((await service.reserveGeneration({ context, authorization: { ...changed.generation, dispatch: tampered } })).ok).toBe(false);
   const forged = { ...original.generation.quote, pricingEvidenceId: "forged" };
   expect((await service.assessGeneration({ context, request: original.generation.request, quote: forged })).ok).toBe(false);
   harness.close();
  });
  it("append-only corrections conserve totals; excess charges block delegated generation", async () => {
   const harness = createHarness(required);
   const first = generationRequest({ amount: 600 });
   const service = harness.service({ requests: [first] });
   const reservation = await reserve({ harness, service, request: first });
   const backend = { scope: context.scope, serviceId: "cost-observer", correlationId: "cost", traceId: "trace" };
   const settlement = { reservationId: reservation.reservationId, observationId: "first-charge", actual: { minorUnits: 500, currency: "USD" } };
   unwrap({ outcome: await service.settleGeneration({ context: backend, settlement }) });
   expect((await service.settleGeneration({ context: backend, settlement: { ...settlement, observationId: "bad-unlinked" } })).ok).toBe(false);
   unwrap({ outcome: await service.settleGeneration({ context: backend, settlement: { ...settlement, observationId: "correction", correctsObservationId: "first-charge", actual: { minorUnits: 550, currency: "USD" } } }) });
   expect(await harness.repo.assessGeneration({ context, ...generationRequest({ amount: 500, operationId: "next" }).generation })).toMatchObject({ ok: true, value: { kind: "exact_spend" } });
   unwrap({ outcome: await service.settleGeneration({ context: backend, settlement: { ...settlement, observationId: "overcharge", correctsObservationId: "correction", actual: { minorUnits: 700, currency: "USD" } } }) });
   expect(await harness.repo.assessGeneration({ context, ...generationRequest({ amount: 1, operationId: "next" }).generation })).toMatchObject({ ok: true, value: { kind: "denied" } });
   harness.close();
  });
  it("unknown or stale quotes with no supported bounds never create unlimited authority", async () => {
   const harness = createHarness(required);
   const first = generationRequest({ now: NOW - 86_400_001 });
   const service = harness.service({ requests: [first] });
   const dispatch = await approve({ harness, service, request: first });
   expect((await service.reserveGeneration({ context, authorization: { ...first.generation, dispatch } })).ok).toBe(false);
   harness.close();
  });
  it("DST rollover uses actual local midnight on the 25-hour day", async () => {
   const before = Date.parse("2026-11-01T07:30:00Z");
   const harness = createHarness({ ...required, now: before });
   const first = generationRequest({ now: before, amount: 800 });
   await reserve({ harness, service: harness.service({ requests: [first] }), request: first });
   harness.time.setNow({ now: Date.parse("2026-11-02T07:30:00Z") });
   const second = generationRequest({ now: harness.time.clock.now({}), operationId: "later", amount: 300 });
   expect(await harness.repo.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { dispatchDay: "America/Los_Angeles:2026-11-01", kind: "exact_spend" } });
   harness.close();
  });
 });
}
