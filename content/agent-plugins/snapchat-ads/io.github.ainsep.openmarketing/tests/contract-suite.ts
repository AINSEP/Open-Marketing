import { describe, expect, it } from "vitest";
import type { EffectEnvelope, ObserverEvent } from "@open-marketing/contracts";
import type { SnapchatAdsAdapter, SnapchatInvocation } from "../src/index.js";
/** Integrator must supply the real composition adapter to this same suite, with synthetic fetch. */
export interface ReadFixture {
  adapter: SnapchatAdsAdapter;
  input: SnapchatInvocation;
  calls: { url: string; init: RequestInit }[];
  credentialCalls: unknown[];
  effects: EffectEnvelope[];
  observations: ObserverEvent[];
  state: { admitted: boolean };
}
/** Shared public behavior probes for the memory host and future server composition binding. */
export function dispatchSuite(required: { name: string; makeFixture: () => ReadFixture }): void {
  describe(required.name + " Snapchat read authority", () => {
    it("returns one projected owned page through the one read policy", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(f.input)).toMatchObject({ ok: true, value: { status: "succeeded", observedState: "unknown", data: { items: [{ name: "Fixture campaign", status: "PAUSED" }], nextCursor: null } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toMatch(/^https:\/\/adsapi.snapchat.com\/v1\/adaccounts\/[a-f0-9-]+\/campaigns\?limit=100$/);
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
      expect(f.effects[0]).toMatchObject({ effects: ["read"], operationId: f.input.operationId, moneyExposure: null, requiredLimit: null });
      expect(f.credentialCalls).toHaveLength(1);
    });
    it("denies revoked admission at dispatch", async () => {
      const f = required.makeFixture(); f.state.admitted = false;
      expect(await f.adapter.invoke(f.input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0);
    });
    it("rejects foreign scope and pre-cancellation before credentials", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke({ ...f.input, context: { ...f.input.context, scope: { ownerId: "foreign", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke(f.input, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("keeps tokens and raw response additions out of results and telemetry", async () => {
      const f = required.makeFixture(); const result = await f.adapter.invoke(f.input);
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations).toContainEqual({ operation: "snapchat-ads.list_campaigns", outcome: "succeeded", correlationId: f.input.context.correlationId, traceId: f.input.context.traceId, runId: f.input.context.runId });
    });
  });
}
