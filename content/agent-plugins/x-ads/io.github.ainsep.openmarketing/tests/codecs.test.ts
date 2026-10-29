import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commandSchema, campaignStatus, reportMetrics } from "../src/index.js";
import { fixture, metricsFixture, context, now, report } from "./fixtures.js";

describe("closed X commands and OAuth signing", () => {
  it.each([{ ...report, kind: "capability_daily" }, { kind: "capability_entities", resource: "campaign" }, { kind: "capability_active", entity: "CAMPAIGN", window: report.window }])("keeps private read commands out of the public invoke boundary", async command => {
    const f = fixture();
    expect(commandSchema.safeParse(command).success).toBe(false);
    expect(await f.invoke({ command: command as typeof report })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("signs filtered IDs and active-window ISO query values with an independent HMAC oracle", async () => {
    const f = metricsFixture(), connection = { connectionId: "connection", accountId: "abc1" };
    await campaignStatus({ dependencies: f.dependencies, context, connection, input: { vendorCampaignIds: ["camp1", "missing"] } });
    const oauth = "oauth_consumer_key=consumer&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=" + Math.floor(now / 1000) + "&oauth_token=token&oauth_version=1.0";
    const normalized = "campaign_ids=camp1%2Cmissing&count=100&" + oauth + "&with_deleted=true&with_draft=true";
    const base = "GET&https%3A%2F%2Fads-api.x.com%2F12%2Faccounts%2Fabc1%2Fcampaigns&" + encodeURIComponent(normalized);
    const signature = createHmac("sha1", "consumer-secret&token-secret").update(base).digest("base64");
    expect(new Headers(f.calls[0].init.headers).get("Authorization")).toContain('oauth_signature="' + encodeURIComponent(signature) + '"');
    const active = metricsFixture();
    await reportMetrics({ dependencies: active.dependencies, context, connection, input: { grain: "campaign", days: { start: "2026-10-20", end: "2026-10-22" } } });
    const activeNormalized = "end_time=2026-10-22T00%3A00%3A00.000Z&entity=CAMPAIGN&" + oauth + "&start_time=2026-10-20T00%3A00%3A00.000Z";
    const activeBase = "GET&https%3A%2F%2Fads-api.x.com%2F12%2Fstats%2Faccounts%2Fabc1%2Factive_entities&" + encodeURIComponent(activeNormalized);
    const activeSignature = createHmac("sha1", "consumer-secret&token-secret").update(activeBase).digest("base64");
    expect(new Headers(active.calls[1].init.headers).get("Authorization")).toContain('oauth_signature="' + encodeURIComponent(activeSignature) + '"');
  });
  it.each([{ kind: "activate" }, { kind: "list_accounts", count: 101 }, { kind: "list_accounts", url: "https://example.com" }, { ...report, entityIds: ["camp1", "camp1"] }, { ...report, entityIds: Array.from({ length: 21 }, (_, index) => "id" + index) }, { ...report, window: { start: now + 1, end: now + 3600000 } }, { ...report, window: { start: now, end: now + 604800001 } }])("rejects unsupported/oversized input before credentials", async command => {
    expect(commandSchema.safeParse(command).success).toBe(false);
    const f = fixture();
    // The runtime boundary must also reject invalid callers that bypass the static type.
    expect(await f.invoke({ command: command as typeof report })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it("signs the exact GET query using injected time/nonce (independent HMAC oracle)", async () => {
    const f = fixture(); await f.invoke();
    const normalized = "count=100&oauth_consumer_key=consumer&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=" + Math.floor(now / 1000) + "&oauth_token=token&oauth_version=1.0";
    const base = "GET&https%3A%2F%2Fads-api.x.com%2F12%2Faccounts&" + encodeURIComponent(normalized);
    const signature = createHmac("sha1", "consumer-secret&token-secret").update(base).digest("base64");
    const header = new Headers(f.calls[0].init.headers).get("Authorization");
    expect(header).toContain('oauth_signature="' + encodeURIComponent(signature) + '"'); expect(header).toContain('oauth_nonce="nonce"'); expect(header).toContain('oauth_timestamp="' + Math.floor(now / 1000) + '"');
    expect(header).not.toContain("consumer-secret"); expect(header).not.toContain("token-secret");
  });
  it("denies a foreign ACCOUNT report before credential access", async () => {
    const f = fixture(); expect(await f.invoke({ command: { ...report, entity: "ACCOUNT", entityIds: ["other"] } })).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.credentialCalls).toEqual([]);
  });
});
