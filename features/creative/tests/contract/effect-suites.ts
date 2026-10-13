import { describe, it, expect } from "vitest";
import type { CreativeAssetPort, CreativeJobPort, CreativeRepoPort, CreativeSpendPort, CreativeAuditPort, CreativeObserverPort } from "../../index.js";
import { context, otherContext, generationRequest, intentFor, quoteFor, value } from "../support/fixtures.js";
import { costFor } from "../support/cost.js";
import { provenance } from "../../src/rules.js";

/** Stable media/cost/provenance identities across adapter retries. */
export function CreativeAssetPortSuite(required: { create: () => CreativeAssetPort }) {
  describe("CreativeAssetPort behavior", () => {
    it("deduplicates bytes and refuses different output", async () => {
      const port = required.create();
      const status = intentFor();
      const input = { context, generationId: status.generationId, operationId: status.request.operationId, output: { kind: "bytes" as const, result: { bytesBase64: "aW1hZ2U=", providerNote: "fixture" } }, provenance: provenance({ status }) };
      const first = value({ outcome: await port.import(input) });
      expect(value({ outcome: await port.import(input) })).toEqual(first);
      expect(await port.import({ ...input, output: { kind: "bytes", result: { bytesBase64: "b3RoZXI=", providerNote: "fixture" } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("records cost and provenance even without an asset", async () => {
      const port = required.create();
      const status = intentFor();
      const evidence = provenance({ status });
      expect(await port.recordProvenance({ context, provenance: evidence })).toEqual({ ok: true, value: undefined });
      expect(await port.recordProvenance({ context, provenance: evidence })).toEqual({ ok: true, value: undefined });
      expect(await port.recordProvenance({ context, provenance: { ...evidence, prompt: "replacement" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const cost = costFor({ status });
      expect(await port.recordCost({ context, cost })).toEqual({ ok: true, value: undefined });
      expect(await port.recordCost({ context, cost: { ...cost, amount: { minorUnits: 900, currency: "USD" } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
  });
}
/** Shared double/transactional-adapter behavior for the ONE outbox. */
export function CreativeJobPortSuite(required: { create: () => { port: CreativeJobPort; repo: CreativeRepoPort } }) {
  describe("CreativeJobPort behavior", () => {
    it("saves original intent and returns a stable job identity", async () => {
      const { port, repo } = required.create();
      const intent = intentFor();
      const input = { context, operationId: intent.request.operationId, argumentsDigest: intent.request.argumentsDigest, intent };
      const first = value({ outcome: await port.enqueue(input) });
      expect(value({ outcome: await port.enqueue(input) })).toEqual(first);
      expect(value({ outcome: await repo.get({ context, generationId: intent.generationId }) }).request).toEqual(intent.request);
      expect(await port.enqueue({ ...input, argumentsDigest: "c".repeat(64) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const changed = intentFor({ request: generationRequest({ prompt: "changed" }) });
      expect(await port.enqueue({ ...input, intent: changed, argumentsDigest: changed.request.argumentsDigest })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
  });
}
/** Scripted safety decisions must still bind reservations and immutable scoped settlements. */
export function CreativeSpendPortSuite(required: { create: () => CreativeSpendPort }) {
  describe("CreativeSpendPort behavior", () => {
    it("binds assessment/reservation and deduplicates settlement", async () => {
      const port = required.create();
      const request = generationRequest();
      const quote = quoteFor({ request });
      expect(await port.assess({ context, request, quote })).toMatchObject({ ok: true, value: { quoteId: quote.quoteId } });
      let reservationId = "";
      const dispatched = await port.withDispatch({ context, request, quote, dispatch: async input => { reservationId = input.reservationId; return { ok: true, value: "submitted" }; } });
      expect(dispatched).toEqual({ ok: true, value: "submitted" });
      expect(reservationId.length).toBeGreaterThan(0);
      const cost = costFor({ status: intentFor() });
      expect(await port.settle({ context, reservationId, cost })).toEqual({ ok: true, value: undefined });
      expect(await port.settle({ context, reservationId, cost })).toEqual({ ok: true, value: undefined });
      expect(await port.settle({ context: otherContext, reservationId, cost })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
  });
}
/** Audit adapter accepts complete trace context and reports failures explicitly. */
export function CreativeAuditPortSuite(required: { create: () => CreativeAuditPort }) {
  describe("CreativeAuditPort behavior", () => {
    it("records lifecycle outcomes", async () => {
      expect(await required.create().record({ context, operationId: "generation", outcome: "creative.dispatchGeneration:ok" })).toEqual({ ok: true, value: undefined });
    });
  });
}
/** Passive observer has no asynchronous authority effects. */
export function CreativeObserverPortSuite(required: { create: () => CreativeObserverPort }) {
  describe("CreativeObserverPort behavior", () => {
    it("accepts correlation, trace and run identity", () => {
      expect(required.create().observe({ operation: "creative.refreshJob", outcome: "ok", correlationId: context.correlationId, traceId: context.traceId, runId: context.runId })).toBeUndefined();
    });
  });
}
