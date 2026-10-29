import { describe, expect, it } from "vitest";
import { invocation } from "../fixtures.js";
import type { Fixture } from "../fixtures.js";

/** Shared acceptance for fixture and future server binding: real request bytes and typed results.
 * @example dispatchSuite({ name: "server binding", makeFixture: makeHostFixture })
 */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name + " LINE reads/auth contract", () => {
    it("reads exactly one bound campaign page and emits correlated observations", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { status: "succeeded", data: { items: [{ id: "456", name: "Fixture campaign", configuredStatus: "PAUSED" }], nextPage: null } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://ads.line.me/api/v3/adaccounts/123/campaigns?page=1&size=100");
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error" });
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "123" }]);
      expect(f.observations).toEqual([{ operation: "line-ads.list_campaigns", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
    it("leaves admission to host guarded fetch", async () => {
      const f = required.makeFixture(); f.state.admitted = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } });
      expect(f.calls).toEqual([]); expect(f.credentialCalls).toHaveLength(1);
    });
    it("rejects foreign scope and cancellation before credentials", async () => {
      const f = required.makeFixture(), input = invocation();
      expect(await f.adapter.invoke({ ...input, context: { ...input.context, scope: { ...input.context.scope, ownerId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const controller = new AbortController(); controller.abort();
      expect(await f.adapter.invoke(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
    });
    it("requires account binding except for account discovery", async () => {
      const f = required.makeFixture(); f.binding.accountId = null;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
    });
  });
}
