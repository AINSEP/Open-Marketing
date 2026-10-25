import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { amazonAdsTools, commandSchema } from "../src/index.js";
import { campaign, completedReport, credential, fixture, invocation, memoryFixture, now, profile, report, reportId, requestReport, row } from "./fixtures.js";
import { dispatchSuite } from "./contract/dispatch-suite.js";

dispatchSuite({ name: "memory account boundary", makeFixture: memoryFixture });
dispatchSuite({ name: "real transport account boundary", makeFixture: fixture });

describe("Amazon R1", () => {
  it("ships inert manifests with matching tool effects and source fingerprints", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
    const capabilities = JSON.parse(readFileSync(new URL("../capabilities.json", import.meta.url), "utf8"));
    const hash = createHash("sha256").update(readFileSync(new URL("../src/commands.ts", import.meta.url))).update(readFileSync(new URL("../src/reporting.ts", import.meta.url))).digest("hex");
    const deploymentHash = createHash("sha256").update(readFileSync(new URL("../src/campaign-translation.ts", import.meta.url))).update(readFileSync(new URL("../src/campaign-deployment.ts", import.meta.url))).digest("hex");
    expect(manifest.extensions["io.github.ainsep.openmarketing"]).toMatchObject({ enabled: false, admitted: false, capabilities: capabilities.capabilities });
    expect(capabilities.capabilities.every((entry: { capabilityId: string; schemaFingerprint: string }) => entry.schemaFingerprint === (entry.capabilityId === "campaign.create-draft.v1" ? deploymentHash : hash))).toBe(true);
    expect(capabilities.deployment).toMatchObject({ create: "deployCampaignPaused", read: "readCampaignDeployment", planSchema: "campaignDeploymentPlanSchema", admitted: false });
    expect(capabilities.deployment.unavailableReason).toContain("calendar boundaries unverified");
    expect(capabilities.tools.map((tool: { name: string; effects: string[] }) => [tool.name, tool.effects[0]])).toEqual(amazonAdsTools.map(tool => [tool.name, tool.effect]));
    expect(commandSchema.safeParse({ kind: "activate", campaignId: "456" }).success).toBe(false);
  });
  it("denies before credentials and network, including cancellation and foreign scope", async () => {
    const f = fixture(); f.state.admitted = false;
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    f.state.admitted = true;
    const abort = new AbortController(); abort.abort();
    expect(await f.adapter.invoke(invocation(), { signal: abort.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await f.adapter.invoke({ ...invocation(), context: { ...invocation().context, scope: { ownerId: "other", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.state.credentialCalls).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it("permits account-free discovery but denies scoped reads without a profile", async () => {
    const f = fixture({ accountId: null });
    expect((await f.adapter.invoke(invocation())).ok).toBe(true);
    expect(new Headers(f.calls[0]!.init.headers).has("Amazon-Advertising-API-Scope")).toBe(false);
    expect(await f.adapter.invoke(invocation({ command: { kind: "get_report", reportId } }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["SP", "SB"] as const)("maps %s campaign reads with scoped headers and one page", async adProduct => {
    const f = fixture({ response: () => Response.json({ campaigns: [campaign], nextToken: "next-page", injectedSecret: credential.accessToken }) });
    const result = await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", adProduct, maxResults: 1, nextToken: "previous-page" } }));
    expect(result).toMatchObject({ ok: true, value: { data: { items: [campaign], nextToken: "next-page" } } });
    expect(f.calls[0]!.url).toBe("https://advertising-api.amazon.com" + (adProduct === "SP" ? "/sp/campaigns/list" : "/sb/v4/campaigns/list"));
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ maxResults: 1, nextToken: "previous-page" });
    expect(new Headers(f.calls[0]!.init.headers).get("Amazon-Advertising-API-Scope")).toBe("123");
    expect(JSON.stringify({ result, observations: f.observations })).not.toContain(credential.accessToken);
  });
  it.each([{ items: [profile, profile] }, { items: [profile, { ...profile, profileId: Number.MAX_SAFE_INTEGER + 1 }] }, { items: [profile, { profileId: "456" }] }])("rejects a whole duplicate or partial-invalid profile batch", async ({ items }) => {
    const f = fixture({ response: () => Response.json(items) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
  });
  it("preserves a mixed campaign page with an open-ended campaign", async () => {
    const openEnded = { ...campaign, campaignId: "457", endDate: null };
    const f = fixture({ response: () => Response.json({ campaigns: [campaign, openEnded], nextToken: null }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", adProduct: "SP" } }))).toMatchObject({ ok: true, value: { data: { items: [campaign, openEnded], nextToken: null } } });
    expect(f.calls).toHaveLength(1);
  });
  it.each([{ ...credential, expiresAt: now }, { ...credential, region: "EU" }, { ...credential, accessToken: "bad\nheader" }, { ...credential, refreshToken: "unexpected" }])("rejects expired, wrong-region and malformed sealed credentials", async input => {
    const f = fixture({ credential: input });
    expect((await f.adapter.invoke(invocation())).ok).toBe(false); expect(f.calls).toHaveLength(0);
  });
  it("rechecks admission and host authority after awaited credential access", async () => {
    const f = fixture({ credentialHook: () => { f.state.admitted = false; } });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toHaveLength(0);
    const g = fixture({ credentialHook: () => { g.state.authority = false; } });
    expect(await g.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "unavailable" } }); expect(g.calls).toHaveLength(0);
  });
  it.each([401, 403, 429, 500, 207])("never retries HTTP %s or exposes vendor errors", async status => {
    const f = fixture({ response: () => Response.json({ secret: credential.accessToken }, { status }) });
    const result = await f.adapter.invoke(invocation());
    expect(result.ok).toBe(false); expect(f.calls).toHaveLength(1); expect(JSON.stringify(result)).not.toContain(credential.accessToken);
  });
  it("requests an ordinary write preset, then exposes only safe status metadata", async () => {
    const f = fixture({ response: () => Response.json(report) });
    expect(await f.adapter.invoke(invocation({ command: requestReport }))).toMatchObject({ ok: true, value: { status: "acknowledged", data: { reportId } } });
    const { filters: _filters, ...configuration } = report.configuration;
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ startDate: requestReport.startDate, endDate: requestReport.endDate, configuration });
    expect(amazonAdsTools.find(tool => tool.name === "request_report")!.effect).toBe("write");
  });
  it("keeps uncertain report requests unknown without retries", async () => {
    const f = fixture({ response: () => { throw new Error(credential.accessToken); } });
    expect(await f.adapter.invoke(invocation({ command: requestReport }))).toEqual({ ok: true, value: { operationId: "operation", status: "unknown", observedState: "unknown", data: null } });
    expect(f.calls).toHaveLength(1);
  });
  it.each([500, 207])("keeps HTTP %s report writes unknown with exactly one request", async status => {
    const f = fixture({ response: () => Response.json({ secret: credential.accessToken }, { status }) });
    expect(await f.adapter.invoke(invocation({ command: requestReport }))).toEqual({ ok: true, value: { operationId: "operation", status: "unknown", observedState: "unknown", data: null } });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.init.method).toBe("POST");
    expect(JSON.stringify(f.observations)).not.toContain(credential.accessToken);
  });
  it.each(["deadline", "caller"])("propagates %s cancellation through the injected request signal", async source => {
    const f = fixture(); const caller = new AbortController();
    expect((await f.adapter.invoke(invocation(), { signal: caller.signal })).ok).toBe(true);
    expect(f.deadlines.map(deadline => deadline.timeoutMs)).toEqual([15000]);
    expect(f.calls[0]!.init.signal!.aborted).toBe(false);
    (source === "deadline" ? f.deadlines[0]!.controller : caller).abort();
    expect(f.calls[0]!.init.signal!.aborted).toBe(true);
  });
  it("downloads only by scoped report ID without forwarding Ads auth or exposing signed locations", async () => {
    const f = fixture({ response: ({ index }) => index === 1 ? Response.json(completedReport) : new Response(gzipSync(JSON.stringify([{ ...row, rawSecret: credential.accessToken }]))) });
    const result = await f.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }));
    expect(result).toMatchObject({ ok: true, value: { data: { reportId, rows: [row] } } });
    expect(f.calls).toHaveLength(2); expect(f.calls[1]!.init).toMatchObject({ redirect: "error", credentials: "omit" });
    expect(f.deadlines.map(deadline => deadline.timeoutMs)).toEqual([15000, 15000]);
    expect(f.calls[0]!.init.signal).toBe(f.deadlines[0]!.controller.signal);
    expect(f.calls[1]!.init.signal).toBe(f.deadlines[1]!.controller.signal);
    expect(new Headers(f.calls[1]!.init.headers).has("Authorization")).toBe(false);
    expect(JSON.stringify({ result, observations: f.observations })).not.toMatch(/fixture-token|fixture-location-secret|offline-report-storage/);
  });
  it.each([
    "offline-report-storage-eu-west-1-prod.s3.amazonaws.com",
    "offline-report-storage-unverified-prod.s3.amazonaws.com",
    "offline-report-storage-us-east-1-prod.s3.us-east-1.amazonaws.com",
    "offline-report-storage-us-east-1-prod.s3.unverified.amazonaws.com",
    "offline-report-storage-us-east-1-prod.s3.amazonaws.com.example.com",
  ])("denies unverified storage host %s before storage egress", async host => {
    const f = fixture({ response: () => Response.json({ ...completedReport, url: `https://${host}/fixture.gz?signature=fixture-location-secret` }) });
    const result = await f.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }));
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify({ result, observations: f.observations })).not.toContain("fixture-location-secret");
  });
  it.each([{ ...completedReport, url: "http://127.0.0.1/" }, { ...completedReport, url: "https://example.com/file.gz" }, { ...completedReport, reportId: "22222222-2222-4222-8222-222222222222" }, { ...completedReport, urlExpiresAt: new Date(now).toISOString() }, { ...completedReport, configuration: { ...report.configuration, columns: ["secret"] } }])("refuses invalid status locations/identity/schema before storage", async body => {
    const f = fixture({ response: () => Response.json(body) });
    expect((await f.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }))).ok).toBe(false); expect(f.calls).toHaveLength(1);
  });
  it.each([Buffer.from("bad gzip"), gzipSync("x".repeat(8388609)), gzipSync(JSON.stringify(Array(10001).fill(row))), gzipSync(JSON.stringify([row, { ...row, date: "2026-09-30" }]))])("rejects bad or oversized gzip/rows atomically", async bytes => {
    const f = fixture({ response: ({ index }) => index === 1 ? Response.json(completedReport) : new Response(bytes) });
    expect((await f.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }))).ok).toBe(false);
  });
  it("caps streamed ordinary responses without trusting Content-Length", async () => {
    const f = fixture({ response: () => new Response("x".repeat(1048577), { headers: { "Content-Length": "1" } }) });
    expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  });
  it("requests and downloads the SB purchased-product preset without spend metrics", async () => {
    const configuration = { adProduct: "SPONSORED_BRANDS", groupBy: ["purchasedAsin"], columns: ["adGroupName", "campaignName", "purchasedAsin", "productName", "sales14d", "orders14d", "date"], reportTypeId: "sbPurchasedProduct", timeUnit: "DAILY", format: "GZIP_JSON" };
    const sb = { campaignName: "Fixture campaign", adGroupName: "Fixture group", purchasedAsin: "B012345678", productName: "Fixture product", date: "2026-10-01", sales14d: 4.5, orders14d: 1 };
    const f = fixture({ response: ({ index }) => index < 3 ? Response.json({ ...completedReport, configuration }) : new Response(gzipSync(JSON.stringify([sb]))) });
    expect(await f.adapter.invoke(invocation({ command: { ...requestReport, preset: "sbPurchasedProduct" } }))).toMatchObject({ ok: true, value: { status: "acknowledged" } });
    expect(JSON.parse(String(f.calls[0]!.init.body)).configuration).toEqual(configuration);
    expect(await f.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }))).toMatchObject({ ok: true, value: { data: { rows: [sb] } } });
    expect(f.calls).toHaveLength(3);
  });
  it("returns status without locations and refuses pending downloads", async () => {
    const f = fixture({ response: () => Response.json(report) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "get_report", reportId } }))).toMatchObject({ ok: true, value: { data: { reportId, status: "PENDING" } } });
    expect(await f.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.calls).toHaveLength(2);
  });
  it("refuses unsupported lifecycle states and admission revoked after status", async () => {
    const f = fixture({ response: () => Response.json({ ...report, status: "PROCESSING" }) });
    expect(await f.adapter.invoke(invocation({ command: { kind: "get_report", reportId } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    const g = fixture({ response: () => { g.state.admitted = false; return Response.json(completedReport); } });
    expect(await g.adapter.invoke(invocation({ command: { kind: "download_report", reportId } }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(g.calls).toHaveLength(1);
  });
  it.each([{ kind: "list_campaigns", adProduct: "SP", maxResults: 101 }, { ...requestReport, startDate: "2026-02-30" }, { ...requestReport, endDate: "2026-11-01" }, { kind: "download_report", reportId, url: "https://example.com" }])("rejects out-of-bound commands before credentials", async command => {
    const f = fixture(); expect(commandSchema.safeParse(command).success).toBe(false);
    expect(await f.adapter.invoke(invocation({ command: command as never }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.state.credentialCalls).toBe(0);
  });
});
