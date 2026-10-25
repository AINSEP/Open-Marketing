import { describe, it, expect } from "vitest";
import { createHttpStudioApi, createSampleStudioApi } from "../src/shared/api/index.js";
import type { StudioApiPort, StudioRuntime } from "../src/shared/api/index.js";
import { testRuntime } from "./support/runtime.js";

/** Reusable contract suite; j22 should apply it to the HTTP adapter using a recorded server fixture. */
function studioApiContract(required: { name: string; create: (input: { runtime: StudioRuntime }) => StudioApiPort }) {
  describe(required.name, () => {
    it("supplies enriched domain evidence consistently on repeated snapshot reads", async () => {
      const host = testRuntime(); const api = required.create({ runtime: host.runtime });
      const first = await api.snapshot({}); const second = await api.snapshot({});
      expect(first.ok).toBe(true); expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) throw new Error("Fixture snapshot unavailable");
      expect(first.value.pages).toBeDefined(); expect(second.value.pages).toEqual(first.value.pages);
      expect(first.value.pages?.creative.generations.find(item => item.id === "generate-unknown")).toMatchObject({ status: "unknown", actual: null });
      expect(first.value.pages?.campaigns.drafts.find(item => item.id === "discovery")).toMatchObject({ status: "paused", review: "blocked" });
      expect(first.value.pages?.operations.reports.find(item => item.id === "report-platform")).toMatchObject({ source: "platform_report", cac: null });
    });
    it("acknowledges exact card identity/digest, denies forged broad grants, and deduplicates identical choices", async () => {
      const host = testRuntime(); const api = required.create({ runtime: host.runtime }); const snapshot = await api.snapshot({});
      expect(snapshot.ok).toBe(true); if (!snapshot.ok) return;
      const card = snapshot.value.cards.find(card => card.classification === "spend"); expect(card).toBeDefined(); if (!card) return;
      const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as const };
      expect(await api.approve({ response: { ...response, argumentsDigest: "d".repeat(64) } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await api.approve({ response: { ...response, choice: "always_allow" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await api.approve({ response })).toEqual({ ok: true, value: { status: "recorded" } });
      expect(await api.approve({ response })).toEqual({ ok: true, value: { status: "recorded" } });
      expect(await api.approve({ response: { ...response, choice: "cancel" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      host.advance({ ms: 900000 });
      expect(await api.approve({ response })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
  });
}
studioApiContract({ name: "sample StudioApiPort", create: createSampleStudioApi });

it('reads bounded operation evidence and rejects a different operation or secret-bearing output', async () => {
  const host = testRuntime();
  for (const value of [
    { status: 'completed', operationId: 'other', output: {} },
    { status: 'completed', operationId: 'expected', output: { clientSecret: 'private-fixture' } },
    { status: 'completed', operationId: 'expected', output: { note: 'x'.repeat(262144) } },
  ]) {
    const api = createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: async () => Response.json({ ok: true, value }) });
    expect((await api.operation!({ operationId: 'expected' })).ok).toBe(false);
  }
  const api = createHttpStudioApi({ runtime: host.runtime, baseUrl: 'http://fixture.test', observer: { observe() {} }, fetch: async url => {
    expect(new URL(String(url)).pathname).toBe('/api/tools/operations/expected');
    return Response.json({ ok: true, value: { status: 'unknown', operationId: 'expected', error: { code: 'unavailable', message: 'Reconcile first', retryable: false } } });
  } });
  expect(await api.operation!({ operationId: 'expected' })).toMatchObject({ ok: true, value: { status: 'unknown', operationId: 'expected' } });
  expect(host.pending()).toBe(0);
});
