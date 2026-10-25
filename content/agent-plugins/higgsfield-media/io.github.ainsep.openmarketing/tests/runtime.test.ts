import { describe, expect, it } from "vitest";
import { createInMemoryAsyncOperationStore } from "@jini-ai/integrations/media-providers";
import { createHiggsfieldRuntimeBinding, startOperation, pollDueOperations, recoverAfterRestart, HiggsfieldBoundaryError, MAX_PROVIDER_BYTES } from "../src/index.js";
import { completeData, failedData, fixture, intent, NOW, pendingData, renderContext, terminalReasons, value } from "./fixtures.js";

/** Actual Jini runtime over a fake, server-owned federation/media boundary; no vendor egress. */
async function runtimeFixture(required: { maxAttempts?: number; deadlineMs?: number } = {}) {
  const f = fixture();
  const runtime = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
  const store = createInMemoryAsyncOperationStore();
  const deps = { store, signer: runtime.signer, httpClient: runtime.httpClient, clock: () => f.dependencies.clock.now({}), newId: () => "async-op", persistRetryDelaysMs: [] };
  const receipt = await startOperation({ ...deps, adapter: runtime.adapter, ctx: renderContext, providerId: "higgsfield", routeKey: "image-generation.v1", ownerRef: "scoped-owner" }, {
    maxAttempts: required.maxAttempts ?? 3, deadlineMs: required.deadlineMs ?? 60000, graceMs: 0,
  });
  value({ outcome: await runtime.awaitHandoff() });
  const poll = () => pollDueOperations({ ...deps, adapters: () => runtime.adapter, resolveContext: () => renderContext, leaseOwner: "worker", leaseMs: 30000 }, { limit: 1 });
  return { ...f, runtime, store, deps, receipt, poll };
}

describe("Higgsfield async image via released Jini runtime", () => {
  it.each(terminalReasons)("stores a distinct %s error without refunding or fetching an asset", async reason => {
    const f = await runtimeFixture();
    f.setStatus({ status: { ...failedData, status: reason } });
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ failed: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "failed", error: { code: "HIGGSFIELD_JOB_" + reason.toUpperCase(), message: "Higgsfield job " + reason + "; charge may remain" } });
    expect([...f.observations.values()].map(item => item.kind)).toEqual(["estimated", "actual"]);
    expect(f.references).toHaveLength(0);
    expect(f.calls.map(item => item.call.toolName.split(".").at(-1))).toEqual(["generate_image", "job_status"]);
  });
  it("restores the original binding after restart and only polls the persisted handle", async () => {
    const f = await runtimeFixture();
    const restored = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    expect(await recoverAfterRestart({ ...f.deps, adapters: () => restored.adapter }, { now: NOW + 1000 })).toMatchObject({ unknownCrashGap: 0, resubmittable: [] });
    f.setNow({ now: NOW + 2000 });
    expect(await pollDueOperations({ ...f.deps, signer: restored.signer, adapters: () => restored.adapter, resolveContext: () => renderContext, leaseOwner: "restarted-worker", leaseMs: 30000 }, { limit: 1, httpClient: restored.httpClient })).toMatchObject({ completed: 1 });
    expect(f.calls.map(item => item.call.toolName.split(".").at(-1))).toEqual(["generate_image", "job_status"]);
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "succeeded" });
  });
  it("reads an owned unknown handle without rewriting terminal Jini history or resubmitting", async () => {
    const f = await runtimeFixture({ deadlineMs: 1000 });
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ unknown: 1 });
    const original = await f.store.get({ id: "async-op" });
    expect(original).toMatchObject({ status: "unknown", state: { jobId: "fixture-job" } });
    const restored = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const wire = restored.adapter.buildPollRequest({ ctx: renderContext, state: { jobId: "fixture-job" } });
    const result = await restored.httpClient.send({ request: { method: "POST", url: wire.url, headers: {}, body: String(wire.init.body), timeoutMs: 15000 } });
    expect(JSON.parse(result.bodyText)).toMatchObject({ structuredContent: { jobId: "fixture-job", status: "completed" } });
    expect(f.calls.map(item => item.call.toolName.split(".").at(-1))).toEqual(["generate_image", "job_status"]);
    expect(await f.store.get({ id: "async-op" })).toEqual(original);
    expect(f.references).toHaveLength(0);
    expect(await f.poll()).toMatchObject({ claimed: 0 });
  });
  it("refuses missing or unowned recovery handles before any federation call", async () => {
    const f = fixture();
    const runtime = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    expect(() => runtime.adapter.buildPollRequest({ ctx: renderContext, state: {} })).toThrow(HiggsfieldBoundaryError);
    const wire = runtime.adapter.buildPollRequest({ ctx: renderContext, state: { jobId: "unowned-job" } });
    await expect(runtime.httpClient.send({ request: { method: "POST", url: wire.url, headers: {}, body: String(wire.init.body), timeoutMs: 15000 } })).rejects.toMatchObject({ code: "forbidden" });
    expect(f.calls).toHaveLength(0);
  });
  it("persists a provider job, polls one tick, imports bytes and deduplicates charge observations", async () => {
    const f = await runtimeFixture();
    expect(f.receipt).toMatchObject({ done: false, operationId: "async-op" });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "polling", state: { jobId: "fixture-job" }, result: null });
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ claimed: 1, completed: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "succeeded", state: { jobId: "fixture-job" }, result: { bytesBase64: Buffer.from("fixture-png").toString("base64") } });
    expect(f.references).toEqual([{ provider: "higgsfield", providerJobId: "fixture-job", operationId: intent.operationId, sourceUrl: completeData.resources[0].uri, mimeType: "image/png" }]);
    expect([...f.observations.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "estimated", operationId: "op", providerJobId: "fixture-job", amount: { minorUnits: 25, currency: "USD" }, providerChargeEvidenceId: null }),
      expect.objectContaining({ kind: "actual", operationId: "op", providerJobId: "fixture-job", amount: { minorUnits: 25, currency: "USD" }, providerChargeEvidenceId: "fixture-charge" }),
    ]));
    expect(await f.poll()).toMatchObject({ claimed: 0 });
    expect(f.calls).toHaveLength(2);
    expect(JSON.stringify(await f.store.get({ id: "async-op" }))).not.toContain("signature");
    expect(JSON.stringify(f.events)).not.toContain(intent.prompt);
  });
  it("caps forever-pending polling without generating again or claiming a refund", async () => {
    const f = await runtimeFixture({ maxAttempts: 1 });
    f.setStatus({ status: pendingData });
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ pending: 1 });
    f.setNow({ now: NOW + 4000 });
    expect(await f.poll()).toMatchObject({ failed: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "failed", error: { code: "ATTEMPTS_EXHAUSTED" } });
    expect(f.calls.filter(call => call.call.toolName.endsWith("generate_image"))).toHaveLength(1);
    expect(f.calls.filter(call => call.call.toolName.endsWith("job_status"))).toHaveLength(1);
    expect(f.references).toHaveLength(0);
    expect([...f.observations.values()].map(observation => observation.kind)).toEqual(["estimated"]);
  });
  it("deadline/restart recovery stays unknown and never resubmits non-idempotent generation", async () => {
    const f = await runtimeFixture({ deadlineMs: 1000 });
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ unknown: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "unknown", error: { code: "DEADLINE_EXPIRED" } });
    expect(f.calls).toHaveLength(1);
    await f.store.create({ id: "crash-gap", providerId: "higgsfield", routeKey: "image-generation.v1", ownerRef: "scoped-owner", maxAttempts: 2, deadlineAt: NOW + 60000 });
    expect(await recoverAfterRestart({ ...f.deps, adapters: () => f.runtime.adapter }, { now: NOW + 1000 })).toMatchObject({ unknownCrashGap: 1, resubmittable: [] });
    expect(await f.store.get({ id: "crash-gap" })).toMatchObject({ status: "unknown" });
    expect(f.calls).toHaveLength(1);
  });
  it("records a charged failure with no asset and no fallback generation", async () => {
    const f = await runtimeFixture();
    f.setStatus({ status: failedData });
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ failed: 1 });
    expect([...f.observations.values()]).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "actual", amount: { minorUnits: 25, currency: "USD" } })]));
    expect(f.references).toHaveLength(0);
    expect(f.calls).toHaveLength(2);
  });
  it("deduplicates pending charge evidence and retains rejected charge changes until the attempt cap", async () => {
    const f = await runtimeFixture();
    f.setStatus({ status: { ...pendingData, charge: completeData.charge } });
    f.setNow({ now: NOW + 2000 });
    await f.poll();
    f.setNow({ now: NOW + 4000 });
    await f.poll();
    expect(f.observations.size).toBe(2);
    f.setStatus({ status: { ...pendingData, charge: { ...completeData.charge, credits_exact: 2 } } });
    f.setNow({ now: NOW + 6000 });
    expect(await f.poll()).toMatchObject({ pending: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "polling", error: { message: "Higgsfield operation refused; reconcile possible charge" } });
    expect(f.observations.size).toBe(2);
    expect([...f.observations.values()].find(observation => observation.kind === "actual")?.amount.minorUnits).toBe(25);
    f.setNow({ now: NOW + 11000 });
    expect(await f.poll()).toMatchObject({ failed: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "failed", error: { code: "ATTEMPTS_EXHAUSTED" } });
    expect(f.calls.filter(call => call.call.toolName.endsWith("generate_image"))).toHaveLength(1);
  });
  it("revocation prevents status egress and keeps the job handle for reconciliation", async () => {
    const f = await runtimeFixture();
    f.revoke();
    f.setNow({ now: NOW + 2000 });
    expect(await f.poll()).toMatchObject({ pending: 1 });
    expect(f.calls).toHaveLength(1);
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "polling", error: { message: "Higgsfield operation refused; reconcile possible charge" }, state: { jobId: "fixture-job" }, result: null });
    f.setNow({ now: NOW + 60000 });
    expect(await f.poll()).toMatchObject({ unknown: 1 });
    expect(await f.store.get({ id: "async-op" })).toMatchObject({ status: "unknown", state: { jobId: "fixture-job" }, result: null });
    expect(f.calls).toHaveLength(1);
  });
  it("keeps parser errors sanitized and bounds streamed metadata before JSON parsing", async () => {
    const f = fixture();
    const runtime = value({ outcome: createHiggsfieldRuntimeBinding({ dependencies: f.dependencies }) });
    const request = runtime.adapter.buildSubmitRequest({ ctx: renderContext });
    await expect(runtime.adapter.parseSubmitResponse({ ctx: renderContext, request, resp: new Response("x".repeat(MAX_PROVIDER_BYTES + 1)) })).rejects.toMatchObject({ name: "HiggsfieldBoundaryError", code: "limit_exceeded" });
    await expect(runtime.adapter.parseSubmitResponse({ ctx: renderContext, request, resp: new Response("secret-token-fixture", { status: 503 }) })).rejects.toBeInstanceOf(HiggsfieldBoundaryError);
  });
});
