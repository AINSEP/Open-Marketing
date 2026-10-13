import { describe, expect, it } from "vitest";
import { decimalToMinor, decodeMetaSpendSnapshot } from "../src/reporting.js";
import type { MetaAccountMetadata, MetaReportQuery } from "../src/reporting.js";
import { now } from "./fixtures.js";

const query: MetaReportQuery = { accountId: "123", since: "2026-10-01", until: "2026-10-01", window: { start: Date.parse("2026-10-01T00:00:00Z"), end: Date.parse("2026-10-02T00:00:00Z") }, currency: "USD", timezone: "UTC", attributionWindow: "7d_click" };
const metadata: MetaAccountMetadata = { accountId: "123", currency: "USD", minorUnitExponent: 2, timezone: "UTC", evidenceId: "host-account-evidence", observedAt: now - 1000, expiresAt: now + 1000 };
const row = { account_id: "123", spend: "12.34", account_currency: "USD", date_start: "2026-10-01", date_stop: "2026-10-01" };
const input = { input: { data: [row] }, query, metadata, snapshotId: "snapshot", retrievedAt: now };

describe("Meta reporting and reconciliation evidence", () => {
  it("decodes platform spend to exact money with explicit account/period/attribution metadata", () => {
    expect(decodeMetaSpendSnapshot(input)).toEqual({ ok: true, value: { snapshotId: "snapshot", accountId: "123", spend: { currency: "USD", minorUnits: 1234 }, window: query.window, timezone: "UTC", attributionWindow: "7d_click", retrievedAt: now } });
  });
  it("preserves append-only restatement lineage without editing the earlier snapshot", () => {
    expect(decodeMetaSpendSnapshot({ ...input, snapshotId: "restated", restatementOf: "snapshot", input: { data: [{ ...row, spend: "13.00" }] } })).toMatchObject({ ok: true, value: { snapshotId: "restated", restatementOf: "snapshot", spend: { minorUnits: 1300 } } });
    expect(row.spend).toBe("12.34");
  });
  it.each([
    { data: [row, row] },
    { data: [row, { ...row, account_currency: "EUR" }] },
    { data: [{ ...row, account_id: "999" }] },
    { data: [{ ...row, date_stop: "2026-10-02" }] },
    { data: [{ ...row, actions: [{ action_type: "complete_registration", value: "100" }] }] },
  ])("rejects duplicated breakdowns, mixed currencies, foreign periods and platform-attributed totals", raw => {
    expect(decodeMetaSpendSnapshot({ ...input, input: raw }).ok).toBe(false);
  });
  it("rejects expired account evidence or a timezone mismatch", () => {
    expect(decodeMetaSpendSnapshot({ ...input, metadata: { ...metadata, expiresAt: now } })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(decodeMetaSpendSnapshot({ ...input, metadata: { ...metadata, timezone: "America/Los_Angeles" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("matches inclusive Meta dates to a DST-short local day", () => {
    const dstQuery = { ...query, since: "2026-03-08", until: "2026-03-08", timezone: "America/Los_Angeles", window: { start: Date.parse("2026-03-08T08:00:00Z"), end: Date.parse("2026-03-09T07:00:00Z") } };
    const result = decodeMetaSpendSnapshot({ ...input, query: dstQuery, metadata: { ...metadata, timezone: dstQuery.timezone }, input: { data: [{ ...row, date_start: "2026-03-08", date_stop: "2026-03-08" }] } });
    expect(result).toMatchObject({ ok: true, value: { window: dstQuery.window, timezone: "America/Los_Angeles" } });
  });
  it("rejects non-midnight half-open boundaries", () => {
    expect(decodeMetaSpendSnapshot({ ...input, query: { ...query, window: { ...query.window, end: query.window.end - 1 } } }).ok).toBe(false);
  });
  it.each([
    { amount: "0", exponent: 2, expected: 0 },
    { amount: "12.34", exponent: 2, expected: 1234 },
    { amount: "12", exponent: 0, expected: 12 },
    { amount: "12.345", exponent: 3, expected: 12345 },
    { amount: "90071992547409.91", exponent: 2, expected: Number.MAX_SAFE_INTEGER },
  ])("converts zero, normal, zero/three decimal and exact safe-bound money", value => {
    expect(decimalToMinor({ amount: value.amount, exponent: value.exponent })).toEqual({ ok: true, value: value.expected });
  });
  it.each([{ amount: "12.345", exponent: 2 }, { amount: "90071992547409.92", exponent: 2 }, { amount: "-1", exponent: 2 }, { amount: "1e3", exponent: 2 }])("rejects precision loss, overflow and non-decimal spend", value => {
    expect(decimalToMinor(value).ok).toBe(false);
  });
});
