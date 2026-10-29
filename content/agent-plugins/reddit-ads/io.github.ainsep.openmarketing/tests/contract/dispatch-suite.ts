import { describe, expect, it } from "vitest";
import { businessId, invocation, reportCommand, reportPage } from "../fixtures.js";
import type { Fixture } from "../fixtures.js";

/** Integrator must run this same public-behavior suite against the real server binding. */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name + " Reddit dispatch", () => {

    it("binds credentials and projects one business page without secret metadata", async () => {
      const f = required.makeFixture();
      const result = await f.adapter.invoke(invocation());
      expect(result).toMatchObject({ ok: true, value: { data: { businesses: [{ id: businessId, name: "Fixture business" }], incomplete: false, nextPageToken: null } } });
      expect(f.calls).toHaveLength(1); expect(f.calls[0].url).toBe("https://ads-api.reddit.com/api/v3/me/businesses?page.size=100");
      expect(f.calls[0].init).toMatchObject({ method: "GET", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } });
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "a2_fixture" }]);
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations).toContainEqual({ operation: "reddit-ads.read", outcome: "succeeded", correlationId: "correlation", traceId: "trace", runId: "run" });
    });
    it("denies foreign scope and pre-cancellation without credential or fetch calls", async () => {
      const f = required.makeFixture(), input = invocation();
      input.context.scope.ownerId = "foreign";
      expect(await f.adapter.invoke(input)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke(invocation(), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("sends a report POST as one read with fixed fields and exact UTC timestamps", async () => {
      const f = required.makeFixture(); f.state.body = reportPage();
      expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { rows: [{ spendMicros: "123456789", impressions: 100, clicks: 3 }] } } });
      expect(f.calls).toHaveLength(1); expect(f.calls[0].init.method).toBe("POST");
      expect(f.calls[0].url).toBe("https://ads-api.reddit.com/api/v3/ad_accounts/a2_fixture/reports?page.size=100");
      expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ data: { breakdowns: ["AD_ACCOUNT_ID"], fields: ["SPEND", "IMPRESSIONS", "CLICKS"], starts_at: "2026-10-23T00:00:00Z", ends_at: "2026-10-24T00:00:00Z", time_zone_id: "UTC" } });
    });
    it("requests both account and campaign breakdowns for a campaign report", async () => {
      const f = required.makeFixture();
      f.state.body = reportPage({ metrics: [{ account_id: "a2_fixture", campaign_id: "579922433862993631", spend: 0, impressions: 0, clicks: 0 }] });
      expect(await f.adapter.invoke(invocation({ command: { ...reportCommand, pivot: "CAMPAIGN" } }))).toMatchObject({ ok: true, value: { data: { rows: [{ entityId: "579922433862993631", spendMicros: "0" }] } } });
      expect(f.calls).toHaveLength(1); expect(f.calls[0].init.method).toBe("POST");
      expect(JSON.parse(String(f.calls[0].init.body))).toMatchObject({ data: { breakdowns: ["AD_ACCOUNT_ID", "CAMPAIGN_ID"] } });
    });
  });
}
