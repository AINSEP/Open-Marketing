import { describe, expect, it } from "vitest";
import { conversionRequest, invocation } from "../fixtures.js";
import type { CapiFixture, Fixture } from "../fixtures.js";

/** Register this suite with a real host fixture during integration; no live vendor transport. */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name + " Pinterest authority contract", () => {
    it("reads one page with explicit continuation and source fields stripped", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation())).toEqual({ ok: true, value: { operationId: "operation", status: "succeeded", observedState: "unknown", data: { items: [{ id: "123", name: "Fixture", currency: "GBP", time_zone: "Europe/London" }], nextPageToken: "next+/=" } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://api.pinterest.com/v5/ad_accounts?page_size=100");
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } });
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "123" }]);
      expect(f.effects[0]).toMatchObject({ effects: ["read"], operationId: "operation", moneyExposure: null, requiredLimit: null });
    });
    it("refuses revoked authority after a previous successful call", async () => {
      const f = required.makeFixture(); expect((await f.adapter.invoke(invocation())).ok).toBe(true);
      f.state.current = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(1);
    });
    it("rejects foreign scope and cancellation before broker access", async () => {
      const f = required.makeFixture(), input = invocation();
      expect(await f.adapter.invoke({ ...input, context: { ...input.context, scope: { ownerId: "foreign", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke(input, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("records context IDs without exposing tokens", async () => {
      const f = required.makeFixture(), result = await f.adapter.invoke(invocation());
      expect(f.observations).toEqual([{ operation: "pinterest-ads.list_accounts", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
    });
  });
}

/** Shared acceptance of the new measurement authority port; inject memory or real server fixtures. */
export function conversionAuthoritySuite(required: { name: string; makeFixture: (input?: { credentialHook?: () => void }) => CapiFixture }): void {
  describe(required.name + " Pinterest measurement authority", () => {
    it("claims the exact event/payload once; a second call cannot send", async () => {
      const f = required.makeFixture();
      expect(await f.backend.deliver(conversionRequest)).toEqual({ ok: true, value: { status: "delivered" } });
      expect(f.dispatches[0]).toMatchObject({ deliveryId: "delivery", event: { eventId: "event" }, payload: { data: [{ event_id: "event", action_source: "web" }] } });
      expect((await f.backend.deliver(conversionRequest)).ok).toBe(false); expect(f.calls).toHaveLength(1);
    });
    it("withdraws consent after token lookup and before POST", async () => {
      const f = required.makeFixture({ credentialHook: () => { f.state.current = false; } });
      expect(await f.backend.deliver(conversionRequest)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.state.credentials).toBe(1); expect(f.calls).toHaveLength(0);
    });
  });
}
