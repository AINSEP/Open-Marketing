import { expect, it } from "vitest";
import { commandSchema } from "../src/index.js";
import { decodeReport } from "../src/reporting.js";
import { campaignPage, fixture, invocation, now, report } from "./fixtures.js";

it("encodes one campaign page and an opaque continuation without following links", async () => {
  const f = fixture({ response: () => Response.json({ ...campaignPage, next: "https://untrusted.invalid" }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns", pageSize: 1, pageToken: "next+/=" } }))).toMatchObject({ ok: true, value: { data: { items: campaignPage.items, nextPageToken: null } } });
  expect(f.calls[0].url).toBe("https://api.pinterest.com/v5/ad_accounts/123/campaigns?page_size=1&bookmark=next%2B%2F%3D"); expect(f.calls).toHaveLength(1);
});
it("refuses a mixed-account campaign page", async () => {
  const f = fixture({ response: () => Response.json({ items: [...campaignPage.items, { id: "789", ad_account_id: "999", status: "PAUSED" }] }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "list_campaigns" } }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
});
// Synthetic codec cases preserve projection coverage; they establish no vendor date semantics.
it("projects exact microunits and missing metrics in the dormant report decoder", () => {
  const result = decodeReport({ input: [{ AD_ACCOUNT_ID: "123", DATE: "2026-10-20", SPEND_IN_MICRO_DOLLAR: 1234567, TOTAL_CLICKTHROUGH: null, unknown: "discard" }], command: report, accountId: "123", currency: "GBP", retrievedAt: now });
  expect(result).toMatchObject({ ok: true, value: { source: "pinterest", currency: "GBP", timezone: "UTC", granularity: "DAY", spendUnit: "advertiser_currency_microunits", vendorDateParameters: { start_date: "2026-10-20", end_date: "2026-10-21" }, rows: [{ AD_ACCOUNT_ID: "123", DATE: "2026-10-20", SPEND_IN_MICRO_DOLLAR: 1234567, TOTAL_CLICKTHROUGH: null }] } });
  expect(JSON.stringify(result)).not.toContain("TOTAL_IMPRESSION"); expect(JSON.stringify(result)).not.toContain("discard");
});
it("preserves absent campaign rows in the dormant decoder", () => {
  expect(decodeReport({ input: [], command: { ...report, level: "CAMPAIGN", campaignIds: ["456"] }, accountId: "123", currency: "GBP", retrievedAt: now })).toMatchObject({ ok: true, value: { rows: [] } });
});
it("decodes requested campaign rows and refuses an unrequested campaign", () => {
  const command = { ...report, level: "CAMPAIGN" as const, campaignIds: ["456"] };
  expect(decodeReport({ input: [{ DATE: "2026-10-20", CAMPAIGN_ID: "456", TOTAL_IMPRESSION: 12 }], command, accountId: "123", currency: "GBP", retrievedAt: now })).toMatchObject({ ok: true, value: { rows: [{ DATE: "2026-10-20", CAMPAIGN_ID: "456", TOTAL_IMPRESSION: 12 }] } });
  expect(decodeReport({ input: [{ DATE: "2026-10-20", CAMPAIGN_ID: "789" }], command, accountId: "123", currency: "GBP", retrievedAt: now })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it.each([
  { rows: [{ DATE: "2026-10-20", AD_ACCOUNT_ID: "999" }] },
  { rows: [{ DATE: "2026-10-19", AD_ACCOUNT_ID: "123" }] },
  { rows: [{ DATE: "2026-10-20", AD_ACCOUNT_ID: "123", SPEND_IN_MICRO_DOLLAR: 9007199254740992 }] },
  { rows: [{ DATE: "2026-10-20", AD_ACCOUNT_ID: "123" }, { DATE: "2026-10-20", AD_ACCOUNT_ID: "123" }] },
])("rejects foreign/date/precision/duplicate report rows in the dormant decoder", ({ rows }) => {
  expect(decodeReport({ input: rows, command: report, accountId: "123", currency: "GBP", retrievedAt: now })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it.each([
  { ...report }, // Ordinary end date and same-day requests remain unavailable.
  { ...report, endDate: report.startDate },
  { ...report, level: "CAMPAIGN" as const, campaignIds: ["456"] },
  { ...report, startDate: "2026-07-26", endDate: "2026-10-23" }, // Exactly 90 candidate UTC dates.
  { ...report, startDate: "2026-07-26", endDate: "2026-07-27" }, // Exact OM 90-day lookback boundary.
])("fails closed on unverified report dates before any I/O", async command => {
  const f = fixture({ deadline: () => { throw new Error("Report must not create a deadline"); } });
  expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "unavailable", retryable: false } });
  expect(f.credentialCalls).toHaveLength(0); expect(f.effects).toHaveLength(0); expect(f.calls).toHaveLength(0);
});
it.each([
  { ...report, startDate: "2026-07-26", endDate: "2026-10-24" }, // 91 candidate dates exceeds the local cap.
  { ...report, startDate: "2026-07-25", endDate: "2026-07-26" }, // One day beyond the local lookback cap.
])("retains local OM date caps without claiming vendor semantics", async command => {
  const f = fixture(); expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
});
it.each([{ ...report, startDate: "2026-10-22" }, { ...report, endDate: "2026-10-25" }, { ...report, startDate: "2026-01-01" }, { ...report, startDate: "2026-10-20T12:00:00Z" }])("refuses unsupported windows before broker lookup", async command => {
  const f = fixture(); expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentialCalls).toHaveLength(0);
});
it("rejects inflated commands and enforces collection bounds", () => {
  for (const command of [{ kind: "activate" }, { kind: "list_accounts", status: "ACTIVE" }, { kind: "list_accounts", pageSize: 101 }, { ...report, level: "CAMPAIGN", campaignIds: ["456", "456"] }, { ...report, level: "CAMPAIGN", campaignIds: Array.from({ length: 101 }, (_, index) => String(index + 1)) }]) expect(commandSchema.safeParse(command).success).toBe(false);
});
