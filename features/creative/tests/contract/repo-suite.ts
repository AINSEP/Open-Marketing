import { describe, it, expect } from "vitest";
import type { CreativeRepoPort } from "../../index.js";
import { context, otherContext, generationRequest, intentFor, value } from "../support/fixtures.js";
import { costFor } from "../support/cost.js";

/** Shared memory/SQL assertions protect durable intent, CAS, scope and append-only money. */
export function CreativeRepoPortSuite(required: { create: () => CreativeRepoPort }) {
  describe("CreativeRepoPort behavior", () => {
    it("stores snapshots and isolates workspaces", async () => {
      const port = required.create();
      const original = value({ outcome: await port.save({ context, status: intentFor() }) });
      expect(original.revision).toBe(0);
      const read = value({ outcome: await port.get({ context, generationId: original.generationId }) });
      (read.assetIds as string[]).push("tampered");
      expect(value({ outcome: await port.get({ context, generationId: original.generationId }) }).assetIds).toEqual([]);
      expect(await port.get({ context: otherContext, generationId: original.generationId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
    it("rejects stale revisions and changes to original evidence", async () => {
      const port = required.create();
      const original = value({ outcome: await port.save({ context, status: intentFor() }) });
      const current = value({ outcome: await port.save({ context, status: { ...original, state: "running" } }) });
      expect(current.revision).toBe(1);
      expect(await port.save({ context, status: original })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const quote = { ...current.quote, quoteId: "replacement" };
      expect(await port.save({ context, status: { ...current, quote, approval: { ...current.approval, quoteId: quote.quoteId } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const request = generationRequest({ prompt: "replacement" });
      expect(await port.save({ context, status: { ...current, request, quote: { ...current.quote, argumentsDigest: request.argumentsDigest } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.save({ context, status: { ...current, approval: { ...current.approval, kind: "exact_spend" } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("claims concurrent dispatch exactly once", async () => {
      const port = required.create();
      const status = value({ outcome: await port.save({ context, status: intentFor() }) });
      const claims = await Promise.all([port.claimDispatch({ context, generationId: status.generationId }), port.claimDispatch({ context, generationId: status.generationId })]);
      expect(claims.map(outcome => value({ outcome }).claimed).sort()).toEqual([false, true]);
      expect(value({ outcome: await port.get({ context, generationId: status.generationId }) }).dispatchState).toBe("dispatching");
    });
    it("preserves reservations, operation identity and cancellation", async () => {
      const port = required.create();
      const status = value({ outcome: await port.save({ context, status: { ...intentFor(), reservationId: "reservation", asyncOperationId: "async", dispatchState: "submitted" } }) });
      expect(await port.save({ context, status: { ...status, reservationId: null } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.save({ context, status: { ...status, asyncOperationId: "other" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.save({ context, status: { ...status, dispatchState: "queued" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const cancelled = value({ outcome: await port.save({ context, status: { ...status, state: "cancelled" } }) });
      expect(await port.save({ context, status: { ...cancelled, state: "pending" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(value({ outcome: await port.claimDispatch({ context, generationId: status.generationId }) }).claimed).toBe(false);
    });
    it("pages lexically without leaking another workspace", async () => {
      const port = required.create();
      for (const operationId of ["c", "a", "b"]) value({ outcome: await port.save({ context, status: intentFor({ request: generationRequest({ operationId }) }) }) });
      value({ outcome: await port.save({ context: otherContext, status: intentFor({ request: generationRequest({ operationId: "aa" }) }) }) });
      const first = value({ outcome: await port.list({ context, limit: 2 }) });
      expect(first.items.map(item => item.generationId)).toEqual(["a", "b"]);
      expect(first.cursor).toBe("b");
      const second = value({ outcome: await port.list({ context, limit: 2, cursor: first.cursor ?? undefined }) });
      expect(second.items.map(item => item.generationId)).toEqual(["c"]);
      expect(second.cursor).toBeNull();
      expect(await port.list({ context, limit: 101 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
    it("deduplicates charges, appends corrections and refuses rewritten identities", async () => {
      const port = required.create();
      const status = value({ outcome: await port.save({ context, status: intentFor() }) });
      const cost = costFor({ status });
      expect(await port.appendCost({ context, cost })).toEqual({ ok: true, value: undefined });
      expect(await port.appendCost({ context, cost })).toEqual({ ok: true, value: undefined });
      expect(await port.appendCost({ context, cost: { ...cost, amount: { minorUnits: 999, currency: "USD" } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const correction = { ...cost, observationId: "correction", kind: "correction" as const, correctionOf: cost.observationId, amount: { minorUnits: 50, currency: "USD" } };
      expect(await port.appendCost({ context, cost: correction })).toEqual({ ok: true, value: undefined });
      expect(await port.appendCost({ context, cost: { ...correction, observationId: "missing-link", correctionOf: "missing" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.appendCost({ context: otherContext, cost })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
  });
}
