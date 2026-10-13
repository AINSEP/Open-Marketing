import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { GenerationCapabilityPortSuite } from "./port-suites.js";
import { jiniFixture } from "../support/jini.js";
import { context, NOW, generationRequest, intentFor, value } from "../support/fixtures.js";
import { scopedKey } from "../../src/rules.js";
import { createJiniGenerationCapability } from "../../index.js";

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); });
GenerationCapabilityPortSuite({ create: async () => {
  const fixture = jiniFixture();
  const status = value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
  return { ...fixture, status };
} });

/** Exercises published algorithms and captured transport output, not a runtime-function mock. */
describe("Jini 0.4.2 runtime integration", () => {
  it("submits original prompt/model once and polls after a capability restart", async () => {
    const fixture = jiniFixture();
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
    const receipt = value({ outcome: await fixture.port.generate({ context, generationId: fixture.request.operationId, request: fixture.request, quote: intentFor().quote }) });
    expect(receipt.asyncOperationId).toBe(fixture.operationId);
    expect(fixture.calls).toEqual([{ method: "POST", url: "https://fixture.invalid/generate", body: JSON.stringify({ prompt: fixture.request.prompt, model: fixture.request.model }) }]);
    const restarted = createJiniGenerationCapability({ runtime: fixture.runtime, host: fixture.host, repo: fixture.repo, clock: fixture.clock });
    expect(await restarted.recover({ context })).toMatchObject({ ok: true, value: { unknownCrashGap: 0 } });
    expect(await restarted.pollDue({ context, request: { leaseOwner: "new-worker", leaseMs: 1000, limit: 1 } })).toMatchObject({ ok: true, value: { claimed: 1, completed: 1 } });
    const status = value({ outcome: await restarted.status({ context, generationId: fixture.request.operationId }) });
    expect(status.state).toBe("succeeded");
    expect(status.providerJobId).toBe("vendor-job");
    expect(fixture.calls.map(call => call.method)).toEqual(["POST", "GET"]);
  });
  it("supports inline success without a second generation", async () => {
    const fixture = jiniFixture({ inline: true });
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
    expect(await fixture.port.generate({ context, generationId: fixture.request.operationId, request: fixture.request, quote: intentFor().quote })).toMatchObject({ ok: true, value: { status: "succeeded" } });
    expect(await fixture.port.generate({ context, generationId: fixture.request.operationId, request: fixture.request, quote: intentFor().quote })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(fixture.calls).toHaveLength(1);
  });
  it("maps a possibly billed submit timeout to unknown and retains reservation", async () => {
    const fixture = jiniFixture({ failSubmit: true });
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
    value({ outcome: await fixture.port.generate({ context, generationId: fixture.request.operationId, request: fixture.request, quote: intentFor().quote }) });
    const status = value({ outcome: await fixture.port.status({ context, generationId: fixture.request.operationId }) });
    expect(status.state).toBe("unknown");
    expect(status.reservationId).toBe("reservation");
    expect(fixture.calls).toHaveLength(1);
  });
  it("reports crash gaps without automatically resubmitting, even for an idempotent adapter", async () => {
    const fixture = jiniFixture({ idempotent: true });
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation", asyncOperationId: fixture.operationId } }) });
    await fixture.store.create({ id: fixture.operationId, providerId: "fixture-provider", routeKey: "fixture-route", ownerRef: scopedKey({ context, id: fixture.request.operationId }), maxAttempts: 3, deadlineAt: NOW + 60_000 }, { nextPollAt: NOW });
    expect(await fixture.port.recover({ context })).toMatchObject({ ok: true, value: { resubmittable: [fixture.operationId] } });
    expect(fixture.calls).toEqual([]);
  });
  it("marks a non-idempotent crash gap unknown", async () => {
    const fixture = jiniFixture();
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation", asyncOperationId: fixture.operationId } }) });
    await fixture.store.create({ id: fixture.operationId, providerId: "fixture-provider", routeKey: "fixture-route", ownerRef: scopedKey({ context, id: fixture.request.operationId }), maxAttempts: 3, deadlineAt: NOW + 60_000 }, { nextPollAt: NOW });
    expect(await fixture.port.recover({ context })).toMatchObject({ ok: true, value: { unknownCrashGap: 1, resubmittable: [] } });
    expect(value({ outcome: await fixture.port.status({ context, generationId: fixture.request.operationId }) }).state).toBe("unknown");
    expect(fixture.calls).toEqual([]);
  });
  it("deadline and attempt exhaustion retain unknown exposure without another vendor call", async () => {
    for (const exhaustion of ["deadline", "attempts"]) {
      const fixture = jiniFixture();
      value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "submitted", reservationId: "reservation", asyncOperationId: fixture.operationId } }) });
      await fixture.store.create({ id: fixture.operationId, providerId: "fixture-provider", routeKey: "fixture-route", ownerRef: scopedKey({ context, id: fixture.request.operationId }), maxAttempts: 1, deadlineAt: NOW + 60_000 }, { status: "polling", state: { jobId: "vendor-job" }, nextPollAt: NOW });
      if (exhaustion === "deadline") fixture.setNow({ now: NOW + 60_000 });
      else await fixture.store.update({ id: fixture.operationId, patch: { attempts: 1 } });
      value({ outcome: await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } }) });
      expect(value({ outcome: await fixture.port.status({ context, generationId: fixture.request.operationId }) })).toMatchObject({ state: "unknown", reservationId: "reservation" });
      expect(fixture.calls).toEqual([]);
    }
  });
  it("refuses a provider operation from another owner before polling/import", async () => {
    const fixture = jiniFixture();
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "submitted", reservationId: "reservation", asyncOperationId: fixture.operationId } }) });
    await fixture.store.create({ id: fixture.operationId, providerId: "fixture-provider", routeKey: "fixture-route", ownerRef: JSON.stringify(["another-owner", "workspace", fixture.request.operationId]), maxAttempts: 3, deadlineAt: NOW + 60_000 }, { status: "polling", state: { jobId: "vendor-job" }, nextPollAt: NOW });
    expect(await fixture.port.status({ context, generationId: fixture.request.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } })).toMatchObject({ ok: true, value: { claimed: 0 } });
    expect(fixture.calls).toEqual([]);
  });
  it("does not poll locally cancelled work or construct a fallback HTTP client", async () => {
    const fixture = jiniFixture();
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
    value({ outcome: await fixture.port.generate({ context, generationId: fixture.request.operationId, request: fixture.request, quote: intentFor().quote }) });
    value({ outcome: await fixture.port.cancel({ context, generationId: fixture.request.operationId }) });
    expect(await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } })).toMatchObject({ ok: true, value: { claimed: 0 } });
    expect(fixture.calls.map(call => call.method)).toEqual(["POST"]);
    const unguarded = jiniFixture({ noHttpClient: true });
    expect(await unguarded.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(unguarded.calls).toEqual([]);
  });
  it("a cancelled row cannot starve another due operation", async () => {
    const fixture = jiniFixture();
    value({ outcome: await fixture.repo.save({ context, status: { ...intentFor(), dispatchState: "dispatching", reservationId: "reservation" } }) });
    value({ outcome: await fixture.port.generate({ context, generationId: fixture.request.operationId, request: fixture.request, quote: intentFor().quote }) });
    value({ outcome: await fixture.port.cancel({ context, generationId: fixture.request.operationId }) });
    const second = intentFor({ request: generationRequest({ operationId: "second" }) });
    value({ outcome: await fixture.repo.save({ context, status: { ...second, dispatchState: "submitted", reservationId: "second-reservation", asyncOperationId: "second-async" } }) });
    await fixture.store.create({ id: "second-async", providerId: "fixture-provider", routeKey: "fixture-route", ownerRef: scopedKey({ context, id: "second" }), maxAttempts: 3, deadlineAt: NOW + 60_000 }, { status: "polling", state: { jobId: "second-job" }, nextPollAt: NOW });
    await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } });
    expect((await fixture.store.get({ id: fixture.operationId }))?.nextPollAt).toBe(Number.MAX_SAFE_INTEGER);
    expect(await fixture.port.pollDue({ context, request: { leaseOwner: "worker", leaseMs: 1000, limit: 1 } })).toMatchObject({ ok: true, value: { claimed: 1, completed: 1 } });
    expect(fixture.calls.map(call => call.method)).toEqual(["POST", "GET"]);
  });
});
