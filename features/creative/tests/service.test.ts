import { describe, it, expect } from "vitest";
import { createCreativeService, createMemoryGenerationCapability, createMemoryCreativeRepo } from "../index.js";
import type { GenerationStatus, MemoryCreativeRepo, CreativeSpendPort } from "../index.js";
import { context, otherContext, NOW, generationRequest, intentFor, serviceFixture, completedStatus, value } from "./support/fixtures.js";
import { costFor } from "./support/cost.js";
import { evidenceId, failure } from "../src/rules.js";

/** Drive the public queue/dispatch seam and assert durable outputs, never an agent session. */
async function dispatchFixture(required: { fixture: ReturnType<typeof serviceFixture> }): Promise<GenerationStatus> {
  const fixture = required.fixture;
  value({ outcome: await fixture.service.requestGeneration({ context, request: fixture.request }) });
  value({ outcome: await fixture.service.dispatchGeneration({ context, generationId: fixture.request.operationId }) });
  return value({ outcome: await fixture.repo.get({ context, generationId: fixture.request.operationId }) });
}

describe("Creative lifecycle acceptance", () => {
  it("constructs an inert service", () => {
    const dependencies = new Proxy({} as Parameters<typeof createCreativeService>[0], { get() { throw new Error("construction accessed a dependency"); } });
    expect(() => createCreativeService(dependencies)).not.toThrow();
  });
  it("queues durably and dispatches independently of an agent session", async () => {
    const fixture = serviceFixture();
    const receipt = value({ outcome: await fixture.service.requestGeneration({ context, request: fixture.request }) });
    expect(receipt).toEqual({ generationId: fixture.request.operationId, operationId: fixture.request.operationId, asyncOperationId: null, status: "pending" });
    expect(fixture.generation.calls.map(call => call.operation)).toEqual(["quote"]);
    const restarted = createCreativeService(fixture);
    expect(await restarted.dispatchGeneration({ context, generationId: receipt.generationId })).toMatchObject({ ok: true, value: { asyncOperationId: expect.any(String) } });
    const stored = value({ outcome: await fixture.repo.get({ context, generationId: receipt.generationId }) });
    expect(stored.request).toEqual(fixture.request);
    expect(stored.quote).toEqual(fixture.quote);
    expect(stored.reservationId).toEqual(expect.any(String));
    expect(stored.dispatchState).toBe("submitted");
  });
  it("concurrent duplicate requests/dispatches issue one generation", async () => {
    const fixture = serviceFixture();
    const receipts = await Promise.all([fixture.service.requestGeneration({ context, request: fixture.request }), fixture.service.requestGeneration({ context, request: fixture.request })]);
    expect(receipts.map(outcome => value({ outcome }).generationId)).toEqual(["generation", "generation"]);
    const dispatched = await Promise.all([fixture.service.dispatchGeneration({ context, generationId: "generation" }), fixture.service.dispatchGeneration({ context, generationId: "generation" })]);
    expect(dispatched.filter(outcome => outcome.ok)).toHaveLength(1);
    expect(fixture.generation.calls.filter(call => call.operation === "generate")).toHaveLength(1);
    expect(fixture.safety.reservations.size).toBe(1);
    expect(await fixture.service.dispatchGeneration({ context, generationId: "generation" })).toMatchObject({ ok: true });
    expect(fixture.generation.calls.filter(call => call.operation === "generate")).toHaveLength(1);
  });
  it("changed arguments or digest cannot reuse an original operation", async () => {
    const fixture = serviceFixture();
    value({ outcome: await fixture.service.requestGeneration({ context, request: fixture.request }) });
    expect(await fixture.service.requestGeneration({ context, request: generationRequest({ prompt: "changed" }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await fixture.service.requestGeneration({ context, request: { ...fixture.request, argumentsDigest: "c".repeat(64) } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fixture.generation.calls.map(call => call.operation)).toEqual(["quote"]);
  });
  it("passes under/over/unknown pricing assessments through safety unchanged", async () => {
    for (const scenario of [{ kind: "normal_write" as const, unknownQuote: false }, { kind: "exact_spend" as const, unknownQuote: false }, { kind: "exact_spend" as const, unknownQuote: true }]) {
      const fixture = serviceFixture(scenario);
      value({ outcome: await fixture.service.requestGeneration({ context, request: fixture.request }) });
      const status = value({ outcome: await fixture.repo.get({ context, generationId: fixture.request.operationId }) });
      expect(status.approval.kind).toBe(scenario.kind);
      expect(status.quote.status).toBe(scenario.unknownQuote ? "unknown" : "known");
      expect(status.approval.quoteId).toBe(status.quote.quoteId);
      expect(status.reservationId).toBeNull();
    }
  });
  it("rechecks authority at dispatch even after a normal-write assessment", async () => {
    const fixture = serviceFixture({ dispatchAllowed: false });
    value({ outcome: await fixture.service.requestGeneration({ context, request: fixture.request }) });
    expect(await fixture.service.dispatchGeneration({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.generation.calls.filter(call => call.operation === "generate")).toEqual([]);
    expect(value({ outcome: await fixture.repo.get({ context, generationId: fixture.request.operationId }) })).toMatchObject({ dispatchState: "queued", reservationId: null });
  });
  it("expired quote prevents transport and denied safety prevents enqueue", async () => {
    const fixture = serviceFixture();
    const generation = createMemoryGenerationCapability({ repo: fixture.repo, quote: { ...fixture.quote, expiresAt: NOW + 100 } });
    const service = createCreativeService({ ...fixture, generation });
    value({ outcome: await service.requestGeneration({ context, request: fixture.request }) });
    fixture.setNow({ now: NOW + 101 });
    expect(await service.dispatchGeneration({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(generation.calls.filter(call => call.operation === "generate")).toEqual([]);
    const denied = serviceFixture({ kind: "denied" });
    expect(await denied.service.requestGeneration({ context, request: denied.request })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(value({ outcome: await denied.repo.list({ context, limit: 1 }) }).items).toEqual([]);
  });
  it("records a possible submit charge as unknown and never blindly resubmits", async () => {
    const fixture = serviceFixture();
    let submits = 0;
    const generation = { ...fixture.generation, async generate() { submits += 1; return failure<never>({ code: "unavailable", message: "Transport timed out after possible charge" }); } };
    const service = createCreativeService({ ...fixture, generation });
    value({ outcome: await service.requestGeneration({ context, request: fixture.request }) });
    expect(await service.dispatchGeneration({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const status = value({ outcome: await fixture.repo.get({ context, generationId: fixture.request.operationId }) });
    expect(status.state).toBe("unknown");
    expect(status.reservationId).toEqual(expect.any(String));
    expect(await service.dispatchGeneration({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(submits).toBe(1);
    expect(fixture.safety.reservations.size).toBe(1);
  });
  it("imports output once and settles observed cost once across refresh retries", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    fixture.generation.setStatus({ context, status: completedStatus({ status, minorUnits: 125 }) });
    const first = value({ outcome: await fixture.service.refreshJob({ context, generationId: status.generationId }) });
    const second = value({ outcome: await fixture.service.refreshJob({ context, generationId: status.generationId }) });
    expect(second.assetIds).toEqual(first.assetIds);
    expect(second.assetIds).toHaveLength(1);
    expect(fixture.assets.imports.size).toBe(1);
    expect(fixture.assets.costs.size).toBe(1);
    expect(fixture.safety.settlements.size).toBe(1);
    expect((fixture.repo as MemoryCreativeRepo).costObservations({ context, generationId: status.generationId })).toHaveLength(1);
  });
  it("failed generation records costs and provenance without an asset", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    fixture.generation.setStatus({ context, status: completedStatus({ status, failed: true, minorUnits: 70 }) });
    expect(await fixture.service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: true, value: { state: "failed", assetIds: [] } });
    expect(fixture.assets.costs.size).toBe(1);
    expect(fixture.assets.provenance.size).toBe(1);
    expect(fixture.safety.settlements.size).toBe(1);
    expect(fixture.safety.reservations.size).toBe(1);
  });
  it("cancellation retains exposure and records a late charge/output", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    value({ outcome: await fixture.service.cancelGeneration({ context, generationId: status.generationId }) });
    fixture.generation.setStatus({ context, status: completedStatus({ status, minorUnits: 100 }) });
    const refreshed = value({ outcome: await fixture.service.refreshJob({ context, generationId: status.generationId }) });
    expect(refreshed.state).toBe("cancelled");
    expect(refreshed.reservationId).toBe(status.reservationId);
    expect(refreshed.assetIds).toHaveLength(1);
    expect(fixture.safety.reservations.size).toBe(1);
    expect(fixture.safety.settlements.size).toBe(1);
  });
  it("queued cancellation prevents any dispatch", async () => {
    const fixture = serviceFixture();
    value({ outcome: await fixture.service.requestGeneration({ context, request: fixture.request }) });
    const cancelled = value({ outcome: await fixture.service.cancelGeneration({ context, generationId: fixture.request.operationId }) });
    expect(cancelled.reservationId).toBeNull();
    expect(await fixture.service.dispatchGeneration({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.generation.calls.map(call => call.operation)).toEqual(["quote"]);
  });
  it("restores statuses and reconciliation after service restart", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    fixture.generation.setStatus({ context, status: completedStatus({ status, minorUnits: 100 }) });
    const restarted = createCreativeService(fixture);
    expect(await restarted.recover({ context })).toMatchObject({ ok: true });
    expect(value({ outcome: await fixture.repo.get({ context, generationId: status.generationId }) })).toMatchObject({ state: "succeeded", assetIds: [expect.any(String)] });
    expect(fixture.assets.imports.size).toBe(1);
  });
  it("keeps worker reconciliation bounded and returns a cursor for the next tick", async () => {
    const fixture = serviceFixture();
    for (const operationId of ["a", "b", "c"]) value({ outcome: await fixture.repo.save({ context, status: intentFor({ request: generationRequest({ operationId }) }) }) });
    const first = value({ outcome: await fixture.service.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 2 } }) });
    expect(first.reconcileCursor).toBe("b");
    expect(await fixture.service.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 2, cursor: first.reconcileCursor ?? undefined } })).toMatchObject({ ok: true, value: { reconcileCursor: null } });
    expect(await fixture.service.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 101 } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.generation.calls.map(call => call.operation)).toEqual(["pollDue", "pollDue"]);
  });
  it("returns connect/install guidance when no capability is present", async () => {
    const fixture = serviceFixture();
    const service = createCreativeService({ ...fixture, generation: createMemoryGenerationCapability({}) });
    expect(await service.requestGeneration({ context, request: fixture.request })).toMatchObject({ ok: false, error: { code: "unavailable", message: expect.stringMatching(/connect or install/i) } });
    expect(value({ outcome: await fixture.repo.list({ context, limit: 1 }) }).items).toEqual([]);
  });
  it("propagates trace context to audit and observer without logging the prompt", async () => {
    const fixture = serviceFixture();
    await dispatchFixture({ fixture });
    expect(fixture.audit.events).toHaveLength(2);
    expect(fixture.audit.events[1].context).toEqual(context);
    expect(fixture.observer.events[1]).toMatchObject({ operation: "creative.dispatchGeneration", outcome: "ok", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId });
    expect(JSON.stringify(fixture.audit.events)).not.toContain(fixture.request.prompt);
  });
});

describe("Creative reconciliation regressions (written, not run)", () => {
  it("a cancellation racing reservation persistence prevents generation", async () => {
    const fixture = serviceFixture();
    const safety: CreativeSpendPort = { ...fixture.safety, async withDispatch(input) {
      return fixture.safety.withDispatch({ ...input, dispatch: async args => {
        const status = value({ outcome: await fixture.repo.get({ context, generationId: fixture.request.operationId }) });
        value({ outcome: await fixture.repo.save({ context, status: { ...status, state: "cancelled" } }) });
        return input.dispatch(args);
      } });
    } };
    const service = createCreativeService({ ...fixture, safety });
    value({ outcome: await service.requestGeneration({ context, request: fixture.request }) });
    expect(await service.dispatchGeneration({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fixture.generation.calls.filter(call => call.operation === "generate")).toEqual([]);
    expect(value({ outcome: await fixture.repo.get({ context, generationId: fixture.request.operationId }) }).state).toBe("cancelled");
  });
  it("records an actual charge even when the provider also supplies estimates", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    const estimate = { ...costFor({ status }), kind: "estimated" as const, observationId: "estimate" };
    fixture.generation.setStatus({ context, status: { ...completedStatus({ status, minorUnits: 140 }), costs: [estimate] } });
    value({ outcome: await fixture.service.refreshJob({ context, generationId: status.generationId }) });
    expect(fixture.assets.costs.size).toBe(2);
    expect(fixture.safety.settlements.size).toBe(1);
    const actualId = evidenceId({ generationId: status.generationId, kind: "actual" });
    expect([...fixture.safety.settlements.values()]).toEqual([{ observationId: actualId, generationId: status.generationId, operationId: status.request.operationId, amount: { minorUnits: 140, currency: "USD" }, kind: "actual" }]);
  });
  it("rejects a mixed generation cost batch before any projection or ledger write", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    const valid = costFor({ status });
    const invalid = { ...valid, observationId: "wrong", generationId: "another" };
    fixture.generation.setStatus({ context, status: { ...completedStatus({ status }), costs: [valid, invalid] } });
    expect(await fixture.service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(value({ outcome: await fixture.repo.get({ context, generationId: status.generationId }) })).toEqual(status);
    expect(fixture.assets.costs.size).toBe(0);
    expect(fixture.safety.settlements.size).toBe(0);
  });
  it("rejects conflicting observation identities before side effects", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    const cost = costFor({ status });
    fixture.generation.setStatus({ context, status: { ...completedStatus({ status }), costs: [cost, { ...cost, amount: { minorUnits: 200, currency: "USD" } }] } });
    expect(await fixture.service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fixture.assets.costs.size).toBe(0);
    expect(fixture.safety.settlements.size).toBe(0);
  });
  it("cannot rewrite an already projected charge using an actualCost-only response", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    fixture.generation.setStatus({ context, status: completedStatus({ status, minorUnits: 100 }) });
    const settled = value({ outcome: await fixture.service.refreshJob({ context, generationId: status.generationId }) });
    fixture.generation.setStatus({ context, status: { ...completedStatus({ status: settled, minorUnits: 200 }), costs: [] } });
    expect(await fixture.service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value({ outcome: await fixture.repo.get({ context, generationId: status.generationId }) })).toEqual(settled);
    expect([...fixture.assets.costs.values()].map(cost => cost.amount.minorUnits)).toEqual([100]);
    expect(fixture.safety.settlements.size).toBe(1);
  });
  it("rejects forged operation ownership without importing assets", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    const completed = completedStatus({ status });
    if (completed.operation === null) throw new Error("fixture operation missing");
    fixture.generation.setStatus({ context, status: { ...completed, operation: { ...completed.operation, ownerRef: JSON.stringify([otherContext.scope.ownerId, otherContext.scope.workspaceId, status.generationId]) } } });
    expect(await fixture.service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.assets.imports.size).toBe(0);
  });
  it("settlement/import retries recover a partial media failure without duplicate charges", async () => {
    const fixture = serviceFixture();
    const status = await dispatchFixture({ fixture });
    fixture.generation.setStatus({ context, status: completedStatus({ status, minorUnits: 100 }) });
    let fail = true;
    const assets = { ...fixture.assets, async import(input: Parameters<typeof fixture.assets.import>[0]) { return fail ? failure<never>({ code: "unavailable", message: "Media temporarily unavailable" }) : fixture.assets.import(input); } };
    const service = createCreativeService({ ...fixture, assets });
    expect(await service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    fail = false;
    expect(await service.refreshJob({ context, generationId: status.generationId })).toMatchObject({ ok: true });
    expect(fixture.assets.imports.size).toBe(1);
    expect(fixture.assets.costs.size).toBe(1);
    expect(fixture.safety.settlements.size).toBe(1);
  });
  it("keeps unresolved reservation state across a shared-memory repository restart", async () => {
    const state = { statuses: new Map(), costs: new Map() };
    const fixture = serviceFixture({ repo: createMemoryCreativeRepo({ state }) });
    const status = await dispatchFixture({ fixture });
    fixture.generation.setStatus({ context, status: completedStatus({ status, unknown: true }) });
    value({ outcome: await fixture.service.refreshJob({ context, generationId: status.generationId }) });
    const restarted = createMemoryCreativeRepo({ state });
    expect(value({ outcome: await restarted.get({ context, generationId: status.generationId }) })).toMatchObject({ state: "unknown", reservationId: status.reservationId });
    expect(fixture.safety.reservations.size).toBe(1);
  });
});
