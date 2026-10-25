import { describe, expect, it } from "vitest";
import { invocation, reportCommand } from "../fixtures.js";
import type { Fixture } from "../fixtures.js";
/** Shared acceptance cases: memory now, server gateway adapter after integrator wiring. */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name, () => {
    it("denies unadmitted reads before credentials/network", async () => {
      const f = required.makeFixture(); f.state.admitted = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
    });
    it("rechecks revocation during access-token resolution", async () => {
      const f = required.makeFixture(); f.state.hook = () => { f.state.admitted = false; };
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toEqual([]); expect(f.credentials).toEqual(["connection"]);
    });
    it("rechecks revocation during developer-token resolution before network access", async () => {
      const f = required.makeFixture();
      f.state.hook = input => { if (input.connectionId === "developer-token.microsoft-ads") f.state.admitted = false; };
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentials).toEqual(["connection", "developer-token.microsoft-ads"]);
      expect(f.calls).toEqual([]); expect(f.downloads).toEqual([]);
    });
    it.each(["admitted", "bound"] as const)("rechecks %s through the gateway before report download", async authority => {
      const f = required.makeFixture();
      f.state.responses = [{ ReportRequestId: "report-id" }, { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://reports.example/report.zip" } }];
      f.state.gatewayHook = input => { if (input.request.method === "GET") f.state[authority] = false; };
      expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(2); expect(f.dispatches).toHaveLength(3);
      expect(f.credentials).toEqual(["connection", "developer-token.microsoft-ads", "connection", "developer-token.microsoft-ads"]);
      expect(f.downloads).toEqual([]); expect(f.state.archiveReads).toBe(0);
    });
    it.each(["admitted", "bound"] as const)("rejects a report when %s is revoked inside the guarded download", async authority => {
      const f = required.makeFixture();
      f.state.responses = [{ ReportRequestId: "report-id" }, { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: "https://reports.example/report.zip" } }];
      f.state.downloadHook = () => { f.state[authority] = false; };
      expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.dispatches).toHaveLength(3); expect(f.downloads).toHaveLength(1);
      expect(f.state.archiveReads).toBe(0);
    });
    it("uses fixed scoped REST headers and strips provider secrets", async () => {
      const f = required.makeFixture(); const result = await f.adapter.invoke(invocation());
      expect(result).toMatchObject({ ok: true, value: { data: { accountId: "123", campaignType: "Search", items: [{ Id: "456", Name: "Fixture", Status: "Paused" }] } } });
      expect(f.calls[0].url).toBe("https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/Campaigns/QueryByAccountId");
      expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ AccountId: 123, CampaignType: "Search" });
      expect(f.calls[0].init).toMatchObject({ redirect: "error", headers: { CustomerAccountId: "123", CustomerId: "234", Authorization: "Bearer synthetic-secret", DeveloperToken: "synthetic-secret" } });
      expect(f.credentials).toEqual(["connection", "developer-token.microsoft-ads"]);
      expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations[0]).toMatchObject({ correlationId: "correlation", traceId: "trace", runId: "run" });
    });
  });
}
