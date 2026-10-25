import { describe, expect, it } from "vitest";
import { invocation } from "../fixtures.js";
import type { Fixture, FixtureOptions } from "../fixtures.js";

/** Shared broker/dispatch assertions. Named second consumer is the integrator's
 * apps/server/tests/agent-plugin-backends.test.ts; host consumption is pending, not claimed proven.
 */
export function dispatchSuite(required: { name: string; makeFixture: (options?: FixtureOptions) => Fixture }): void {
  describe(required.name + " Kakao read contract", () => {
    it("discovers accounts with an owned connection before account binding", async () => {
      const f = required.makeFixture({ configuration: { accountId: null } });
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { operationId: "operation", data: { number: 0, totalPages: 2 } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://apis.moment.kakao.com/openapi/v4/adAccounts/pages?page=0&size=10");
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } });
      expect(f.calls[0].init.headers).not.toHaveProperty("adAccountId");
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: null }]);
    });
    it("denies unadmitted calls before credentials or egress", async () => {
      const f = required.makeFixture({ configuration: { admitted: false } });
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("requires scope and a bound account for campaigns", async () => {
      const f = required.makeFixture({ configuration: { accountId: null } });
      expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns" } }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const input = { ...invocation(), context: { ...invocation().context, scope: { ownerId: "foreign", workspaceId: "workspace" } } };
      expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke({ ...input, context: { ...input.context, scope: { ownerId: "owner", workspaceId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("returns no token/provider additions and observes correlation IDs", async () => {
      const f = required.makeFixture({ response: () => Response.json({ ...{ content: [{ id: 123, name: "Fixture", config: "ON", token: "synthetic-secret" }], number: 0, page: 0, size: 10, totalElements: 1, totalPages: 1 }, token: "synthetic-secret" }) }); const result = await f.adapter.invoke(invocation());
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations).toEqual([{ operation: "kakao-ads.list_accounts", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
  });
}
