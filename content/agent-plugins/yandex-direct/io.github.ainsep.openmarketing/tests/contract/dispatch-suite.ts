import { describe, expect, it } from "vitest";
import type { Fixture } from "../fixtures.js";
import { invocation } from "../fixtures.js";

/** Same acceptance suite for synthetic and eventual server-bound policy/credential adapters. */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name + " Yandex dispatch", () => {
    it("uses one read-classified account-bound get with exact page bytes", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { status: "succeeded", data: { items: [{ Id: "456", Status: "DRAFT" }] } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://api.direct.yandex.com/json/v501/campaigns");
      expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ method: "get", params: { SelectionCriteria: {}, FieldNames: ["Id", "Name", "Type", "State", "Status"], Page: { Limit: 100, Offset: 0 } } });
      expect(new Headers(f.calls[0].init.headers).get("Client-Login")).toBe("fixture-login");
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "123" }]);
      expect(f.effects[0]).toMatchObject({ accountId: "123", effects: ["read"], moneyExposure: null, requiredLimit: null });
      expect(f.calls[0].init.redirect).toBe("error");
      expect(f.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    });
    it("unadmitted discovery, listing and reporting access neither credentials nor network", async () => {
      const f = required.makeFixture(); f.state.admitted = false;
      for (const command of [{ kind: "list_accounts", view: "agency" }, { kind: "list_accounts", view: "connected" }, { kind: "list_campaigns" }, { kind: "report", view: "account", dateFrom: "2026-10-01", dateTo: "2026-10-01" }] as const) {
        expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
      }
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("rejects scope inflation and pre-cancellation before credentials", async () => {
      const f = required.makeFixture(); const input = invocation();
      expect(await f.adapter.invoke({ ...input, context: { ...input.context, scope: { ownerId: "foreign", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke(input, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("denies current authority and redacts token data from receipts and observations", async () => {
      const f = required.makeFixture(); f.state.authorized = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0);
      f.state.authorized = true;
      const result = await f.adapter.invoke(invocation());
      expect(result.ok).toBe(true);
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations.at(-1)).toEqual({ operation: "yandex-direct.list_campaigns", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" });
    });
  });
}
