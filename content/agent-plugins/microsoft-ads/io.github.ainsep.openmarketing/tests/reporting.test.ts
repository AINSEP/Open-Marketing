import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { invocation, reportCommand, reportFixture, tsv } from "./fixtures.js";
it.each([false, true])("submits once, downloads without credentials and preserves fractional conversions/zeros", async quoted => {
  const f = reportFixture(); if (quoted) f.state.text = tsv.trimEnd().split("\n").map(line => line.split("\t").map(cell => '"' + cell + '"').join("\t")).join("\n");
  const result = await f.adapter.invoke(invocation({ command: reportCommand }));
  expect(result).toMatchObject({ ok: true, value: { data: { availability: "reported", timezone: "UTC", rows: [{ spend: "12.3400", impressions: "0", conversions: "0.50" }] } } });
  expect(f.calls).toHaveLength(2); expect(f.downloads).toEqual([{ url: "https://reports.example/report.zip", maxBytes: 2097152 }]);
  const downloadRequest = { url: "https://reports.example/report.zip", method: "GET" };
  expect(f.dispatches).toHaveLength(3);
  expect(f.dispatches[2]).toMatchObject({ context: invocation().context, configuration: f.dependencies.configuration, operation: "report", request: downloadRequest,
    effect: { operationId: "operation", connectionId: "connection", accountId: "123", effects: ["read"], argumentsDigest: createHash("sha256").update(JSON.stringify(downloadRequest)).digest("hex"), moneyExposure: null, requiredLimit: null } });
  expect(f.dispatches[2].request).toEqual(downloadRequest);
  expect(JSON.parse(String(f.calls[0].init.body))).toMatchObject({ ReportRequest: { Format: "Tsv", Aggregation: "Daily", Scope: { AccountIds: [123] }, Time: { CustomDateRangeStart: { Year: 2026, Month: 10, Day: 12 }, CustomDateRangeEnd: { Day: 12 } } } });
});
it("stops at the 60-second deadline between polls without another RPC or download", async () => {
  const f = reportFixture();
  f.state.responses[1] = { ReportRequestStatus: { Status: "Pending" } };
  f.state.waitExtraMilliseconds = 55000;
  expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(f.timeouts.map(timeout => timeout.milliseconds)).toEqual([60000, 15000, 15000]);
  expect(f.timeouts[0].controller.signal.aborted).toBe(true);
  expect(f.calls).toHaveLength(2); expect(f.state.waits).toBe(1);
  expect(f.downloads).toEqual([]); expect(f.state.archiveReads).toBe(0);
});
it("does not start a download when the deadline expires while waiting for the gateway", async () => {
  const f = reportFixture();
  f.state.gatewayHook = input => { if (input.request.method === "GET") f.advanceTime({ milliseconds: 60000 }); };
  expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(f.dispatches).toHaveLength(3); expect(f.downloads).toEqual([]);
  expect(f.state.archiveReads).toBe(0);
});
it.each([{ milliseconds: 59999, ok: true }, { milliseconds: 60000, ok: false }])("applies the total deadline during download at $milliseconds milliseconds", async ({ milliseconds, ok }) => {
  const f = reportFixture();
  f.state.downloadHook = () => f.advanceTime({ milliseconds });
  const result = await f.adapter.invoke(invocation({ command: reportCommand }));
  if (ok) expect(result).toMatchObject({ ok: true, value: { data: { availability: "reported" } } });
  else expect(result).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(f.dispatches).toHaveLength(3); expect(f.downloads).toHaveLength(1);
  expect(f.state.archiveReads).toBe(ok ? 1 : 0);
});
it("distinguishes no-data and six exhausted polls without resubmission", async () => {
  const f = reportFixture(); f.state.responses[1] = { ReportRequestStatus: { Status: "Success", ReportDownloadUrl: null } };
  expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: true, value: { data: { availability: "no_data", rows: [] } } });
  expect(f.downloads).toEqual([]);
  f.calls.length = 0; f.state.responses = [{ ReportRequestId: "job" }, ...Array.from({ length: 6 }, () => ({ ReportRequestStatus: { Status: "Pending" } }))];
  expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false, error: { code: "expired" } });
  expect(f.calls).toHaveLength(7); expect(f.state.waits).toBe(5);
});
it.each([tsv.replace("123\t", "999\t"), tsv + tsv.split("\n")[1] + "\n", tsv.replace("2026-10-12", "2026-10-13"), tsv.replace("12.3400", '"12.34'), tsv.replace("USD", "EUR")])("rejects tainted rows atomically", async text => {
  const f = reportFixture(); f.state.text = text;
  expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false });
});
it.each([{ files: 2 }, { compressed: 2097153 }, { expanded: 8388609 }, { declared: 8388609 }, { path: "../report.tsv" }, { kind: "symlink" }, { text: tsv.split("\n")[0] + "\n" + (tsv.split("\n")[1] + "\n").repeat(10001) }])("bounds archives and rows", async changed => {
  const f = reportFixture(); Object.assign(f.state, changed);
  expect(await f.adapter.invoke(invocation({ command: reportCommand }))).toMatchObject({ ok: false });
});
