/** Synthetic completion evidence only; no authenticated provider compatibility claim. */
import { describe, expect, it } from "vitest";
import { createCreativeService, createSqlCreativeRepo } from "../index.js";
import type { GenerationCompletion, GenerationStatus } from "../index.js";
import { failure } from "../src/rules.js";
import { completedStatus, context, generationRequest, intentFor, otherContext, serviceFixture, value } from "./support/fixtures.js";
import { sqliteFixture } from "./support/sqlite.js";

/** Reach an unknown outcome through the public dispatch/refresh lifecycle, with a durable handle. */
async function unknownGeneration(required: { fixture: ReturnType<typeof serviceFixture> }): Promise<GenerationStatus> {
  const f = required.fixture;
  value({ outcome: await f.service.requestGeneration({ context, request: f.request }) });
  value({ outcome: await f.service.dispatchGeneration({ context, generationId: f.request.operationId }) });
  const dispatched = value({ outcome: await f.repo.get({ context, generationId: f.request.operationId }) });
  f.generation.setStatus({ context, status: completedStatus({ status: dispatched, unknown: true }) });
  return value({ outcome: await f.service.refreshJob({ context, generationId: f.request.operationId }) });
}
function completion(required: { status: GenerationStatus }): GenerationCompletion {
  return { asyncOperationId: required.status.asyncOperationId!, providerJobId: "vendor-job",
    output: { kind: "bytes", result: { bytesBase64: Buffer.from("verified late image").toString("base64"), providerNote: "fixture" } } };
}

for (const adapter of ["memory", "sql"] as const) describe("verified late completion / " + adapter, () => {
  for (const mode of ["outcome", "throw"] as const) it("continues recovery and pagination after an import " + mode, async () => {
    const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
    const f = serviceFixture(sql ? { repo: sql.repo, jobs: sql.jobs } : {});
    try {
      for (const operationId of ["a-failed", "b-healthy"]) {
        const status = completedStatus({ status: intentFor({ request: generationRequest({ operationId }) }) });
        value({ outcome: await f.repo.save({ context, status }) });
      }
      const assets = { ...f.assets, async import(input: Parameters<typeof f.assets.import>[0]) {
        if (input.generationId !== "a-failed") return f.assets.import(input);
        if (mode === "throw") throw new Error("Opaque storage rejection");
        return failure<{ assetId: string }>({ code: "unavailable", message: "Storage unavailable" });
      } };
      const service = createCreativeService({ ...f, assets }, { observer: f.observer });
      expect(await service.recover({ context })).toMatchObject({ ok: true });
      expect(value({ outcome: await f.repo.get({ context, generationId: "a-failed" }) }).assetIds).toEqual([]);
      expect(value({ outcome: await f.repo.get({ context, generationId: "b-healthy" }) }).assetIds).toHaveLength(1);
      const request = { leaseOwner: "worker", leaseMs: 1000, limit: 1 };
      const first = value({ outcome: await service.pollDue({ context, request }) });
      expect(first.reconcileCursor).toBe("a-failed");
      const second = value({ outcome: await service.pollDue({ context, request: { ...request, cursor: first.reconcileCursor! } }) });
      expect(second.reconcileCursor).toBeNull();
      expect(f.observer.events).toContainEqual(expect.objectContaining({ operation: "creative.reconcileGeneration", outcome: "unavailable", traceId: context.traceId }));
      expect(f.generation.calls.filter(call => call.operation === "generate")).toHaveLength(0);
    } finally { sql?.close(); }
  });
  it("persists late output, deduplicates completion, and survives restart/revocation without resubmit", async () => {
    const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
    const f = serviceFixture(sql ? { repo: sql.repo, jobs: sql.jobs } : {});
    try {
      const unknown = await unknownGeneration({ fixture: f });
      const input = { context, generationId: unknown.generationId, completion: completion({ status: unknown }) };
      const first = value({ outcome: await f.service.ingestVerifiedCompletion(input) });
      const duplicate = value({ outcome: await f.service.ingestVerifiedCompletion(input) });
      expect(duplicate.assetIds).toEqual(first.assetIds);
      expect(duplicate.assetIds).toHaveLength(1);
      expect(duplicate.operation).toEqual(unknown.operation);
      expect(duplicate.state).toBe("succeeded");
      expect(duplicate.reservationId).toBe(unknown.reservationId);
      const repo = sql ? createSqlCreativeRepo({ database: sql.database }) : f.repo;
      let providerReads = 0;
      const generation = { ...f.generation, async status() { providerReads += 1; return failure<GenerationStatus>({ code: "forbidden", message: "Admission revoked" }); } };
      const restarted = createCreativeService({ ...f, repo, generation });
      const refreshed = value({ outcome: await restarted.refreshJob({ context, generationId: unknown.generationId }) });
      expect(refreshed.verifiedCompletion).toEqual(input.completion);
      expect(refreshed.state).toBe("succeeded");
      expect(refreshed.assetIds).toEqual(first.assetIds);
      expect(refreshed.operation).toEqual(unknown.operation);
      expect(providerReads).toBe(0);
      expect(f.assets.imports.size).toBe(1);
      expect(f.generation.calls.filter(call => call.operation === "generate")).toHaveLength(1);
    } finally { sql?.close(); }
  });
  it("retries only asset import after a persistence failure, retaining verified output", async () => {
    const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
    const f = serviceFixture(sql ? { repo: sql.repo, jobs: sql.jobs } : {});
    try {
      const unknown = await unknownGeneration({ fixture: f });
      let rejectImport = true;
      const assets = { ...f.assets, async import(input: Parameters<typeof f.assets.import>[0]) {
        if (rejectImport) return failure<{ assetId: string }>({ code: "unavailable", message: "Local storage unavailable" });
        return f.assets.import(input);
      } };
      const service = createCreativeService({ ...f, assets });
      const input = { context, generationId: unknown.generationId, completion: completion({ status: unknown }) };
      expect(await service.ingestVerifiedCompletion(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(value({ outcome: await f.repo.get(input) }).verifiedCompletion).toEqual(input.completion);
      rejectImport = false;
      const repo = sql ? createSqlCreativeRepo({ database: sql.database }) : f.repo;
      const restarted = createCreativeService({ ...f, repo, assets });
      expect(await restarted.refreshJob(input)).toMatchObject({ ok: true, value: { state: "succeeded", assetIds: [expect.any(String)] } });
      expect(f.generation.calls.filter(call => call.operation === "generate")).toHaveLength(1);
      expect(f.assets.imports.size).toBe(1);
      expect(await restarted.ingestVerifiedCompletion({ ...input, completion: { ...input.completion,
        output: { kind: "bytes", result: { bytesBase64: "Y2hhbmdlZA==", providerNote: "changed" } } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    } finally { sql?.close(); }
  });
  it("keeps local cancellation and Jini history when verified output arrives late", async () => {
    const sql = adapter === "sql" ? sqliteFixture({}) : undefined;
    const f = serviceFixture(sql ? { repo: sql.repo, jobs: sql.jobs } : {});
    try {
      const unknown = await unknownGeneration({ fixture: f });
      value({ outcome: await f.service.cancelGeneration({ context, generationId: unknown.generationId }) });
      const result = value({ outcome: await f.service.ingestVerifiedCompletion({ context, generationId: unknown.generationId, completion: completion({ status: unknown }) }) });
      expect(result.state).toBe("cancelled");
      expect(result.operation).toEqual(unknown.operation);
      expect(result.assetIds).toHaveLength(1);
      expect(result.reservationId).toBe(unknown.reservationId);
      expect(f.safety.reservations.size).toBe(1);
    } finally { sql?.close(); }
  });
});

describe("late completion boundary", () => {
  it("rechecks capability admission before retrying a verified URL import", async () => {
    const f = serviceFixture();
    const unknown = await unknownGeneration({ fixture: f });
    let imports = 0;
    const assets = { ...f.assets, async import() { imports++;
      return failure<{ assetId: string }>({ code: "unavailable", message: "Storage unavailable" });
    } };
    const input = { context, generationId: unknown.generationId, completion: { ...completion({ status: unknown }),
      output: { kind: "url" as const, sourceUrl: "https://fixture.invalid/image.png", expectedDigest: "a".repeat(64) } } };
    expect(await createCreativeService({ ...f, assets }).ingestVerifiedCompletion(input)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const generation = { ...f.generation, async status() { return failure<GenerationStatus>({ code: "forbidden", message: "Admission revoked" }); } };
    const restarted = createCreativeService({ ...f, generation, assets });
    expect(await restarted.refreshJob(input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(imports).toBe(1);
    expect(value({ outcome: await f.repo.get(input) }).verifiedCompletion).toEqual(input.completion);
  });
  it("rejects foreign scope, non-worker callers and mismatched operation/job identities before import", async () => {
    const f = serviceFixture();
    const unknown = await unknownGeneration({ fixture: f });
    const input = { context, generationId: unknown.generationId, completion: completion({ status: unknown }) };
    expect(await f.service.ingestVerifiedCompletion({ ...input, context: otherContext })).toMatchObject({ ok: false });
    expect(await f.service.ingestVerifiedCompletion({ ...input, context: { ...context, principal: { kind: "owner", ownerId: context.scope.ownerId } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    for (const changed of [{ asyncOperationId: "other" }, { providerJobId: "other" }]) {
      expect(await f.service.ingestVerifiedCompletion({ ...input, completion: { ...input.completion, ...changed } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    }
    expect(f.assets.imports.size).toBe(0);
    expect(value({ outcome: await f.repo.get(input) }).state).toBe("unknown");
  });
  it("refuses an unknown outcome without a provider handle instead of matching by prompt", async () => {
    const f = serviceFixture();
    const unknown = await unknownGeneration({ fixture: f });
    value({ outcome: await f.repo.save({ context, status: { ...unknown, providerJobId: null, operation: { ...unknown.operation!, state: null } } }) });
    expect(await f.service.ingestVerifiedCompletion({ context, generationId: unknown.generationId, completion: completion({ status: unknown }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.assets.imports.size).toBe(0);
    expect(f.generation.calls.filter(call => call.operation === "generate")).toHaveLength(1);
  });
  it("rejects malformed completion without touching persistence or asset effects", async () => {
    const f = serviceFixture();
    for (const bytesBase64 of ["not base64!", ""]) {
      expect(await f.service.ingestVerifiedCompletion({ context, generationId: "uncreated", completion: { asyncOperationId: "async", providerJobId: "job",
        output: { kind: "bytes", result: { bytesBase64, providerNote: "fixture" } } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(f.generation.calls).toEqual([]);
    expect(f.assets.imports.size).toBe(0);
  });
});
