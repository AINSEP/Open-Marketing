import { describe, expect, it } from "vitest";
import type { Fixture } from "../fixtures.js";

/** Two consumers: plugin fixture and integrator host adapter. Assert receipts and real request bytes. */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name + " Apple reads dispatch contract", () => {
    it("discovers accounts without an org header, retaining scoped credential lookup", async () => {
      const f = required.makeFixture(); f.dependencies.configuration.accountId = null;
      expect(await f.invoke()).toMatchObject({ ok: true, value: { data: { items: [{ orgId: "123", orgName: "Fixture org" }] } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]).toMatchObject({ url: "https://api.searchads.apple.com/api/v5/acls", init: { method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } } });
      expect(new Headers(f.calls[0].init.headers).has("X-AP-Context")).toBe(false);
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: null }]);
    });
    it("does no credential lookup or egress while unadmitted", async () => {
      const f = required.makeFixture(); f.state.admitted = false;
      expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
    });
    it("rechecks admission after credentials resolve", async () => {
      const f = required.makeFixture(); f.state.credentialHook = () => { f.state.admitted = false; };
      expect(await f.invoke()).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentialCalls).toHaveLength(1); expect(f.calls).toEqual([]);
    });
    it("requires an account for campaigns and rejects unsupported writes", async () => {
      const f = required.makeFixture(); f.dependencies.configuration.accountId = null;
      expect(await f.invoke({ command: { kind: "list_campaigns" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.invoke({ command: { kind: "activate", campaignId: "456" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
    });
    it("keeps secrets out of receipts and emits existing context identifiers", async () => {
      const f = required.makeFixture(); const result = await f.invoke();
      expect(result.ok).toBe(true);
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations).toEqual([{ operation: "apple-search-ads.list_accounts", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
  });
}
