import { describe, expect, it } from "vitest";
import { digest } from "../src/boundary.js";
import { encodeCommand } from "../src/commands.js";
import { decodeMetaHierarchy, decodeMetaLimit } from "../src/readback.js";
import { mapMetaHaltStop } from "../src/stop.js";
import { hierarchy, now, pluginDigest } from "./fixtures.js";

describe("closed Meta payloads", () => {
  it.each([
    { kind: "create-campaign", name: "fixture", objective: "OUTCOME_TRAFFIC", specialAdCategories: [] },
    { kind: "create-adset", name: "fixture", campaignId: "456", targeting: { countries: ["US"], age_min: 18, age_max: 65 }, billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: 1000 },
    { kind: "create-ad", name: "fixture", adsetId: "457", creativeId: "777" },
  ])("all delivery entities create explicitly PAUSED", command => {
    const result = encodeCommand({ input: command, accountId: "123" });
    expect(result).toMatchObject({ ok: true, value: { arguments: { status: "PAUSED" } } });
  });
  it.each([
    { kind: "set-account-cap", amountMinor: 10000 },
    { kind: "set-campaign-cap", campaignId: "456", amountMinor: 0 },
    { kind: "set-campaign-cap", campaignId: "456", amountMinor: 10000, accountSpendCap: 50000 },
    { kind: "pause", entityId: "456", entityType: "campaign", status: "ACTIVE" },
    { kind: "read-entities", entityIds: ["456", "456"] },
  ])("denies unsupported, removal, inflated and duplicate controls", input => {
    expect(encodeCommand({ input, accountId: "123" }).ok).toBe(false);
  });
  it("encodes caps in minor-unit strings, without guessing account-cap major-unit semantics", () => {
    expect(encodeCommand({ input: { kind: "set-campaign-cap", campaignId: "456", amountMinor: 10000 }, accountId: "123" })).toMatchObject({ ok: true, value: { effects: ["ad_spend"], arguments: { spend_cap: "10000" } } });
  });
});

describe("status/cap readback", () => {
  const read = { input: hierarchy, accountId: "123", expectedEntityIds: ["456", "457", "458"], observedAt: now };
  it("proves PAUSED only for the entire configured hierarchy", () => {
    expect(decodeMetaHierarchy(read)).toMatchObject({ ok: true, value: { state: "paused", complete: true, hierarchy: [{ entityId: "456", state: "paused" }, { entityId: "457", state: "paused" }, { entityId: "458", state: "paused" }] } });
  });
  it("an inherited effective pause cannot hide an ACTIVE child", () => {
    const input = { ...hierarchy, entities: hierarchy.entities.map(row => row.id === "458" ? { ...row, configured_status: "ACTIVE" } : row) };
    expect(decodeMetaHierarchy({ ...read, input })).toMatchObject({ ok: true, value: { state: "unknown" } });
  });
  it("a configured pause cannot hide an inconsistent ACTIVE effective state", () => {
    const input = { ...hierarchy, entities: hierarchy.entities.map(row => row.id === "458" ? { ...row, effective_status: "ACTIVE" } : row) };
    expect(decodeMetaHierarchy({ ...read, input })).toMatchObject({ ok: true, value: { state: "unknown" } });
  });
  it("incomplete creation and unknown activation reconcile as unknown with no inferred success", () => {
    expect(decodeMetaHierarchy({ ...read, input: { complete: false, entities: [hierarchy.entities[0]] } })).toMatchObject({ ok: true, value: { state: "unknown", complete: false } });
  });
  it("requires every requested entity to be ACTIVE before confirming activation", () => {
    const input = { ...hierarchy, entities: hierarchy.entities.map(row => ({ ...row, configured_status: "ACTIVE", effective_status: "ACTIVE" })) };
    expect(decodeMetaHierarchy({ ...read, input })).toMatchObject({ ok: true, value: { state: "active" } });
  });
  it.each([
    { ...hierarchy, entities: [hierarchy.entities[0], hierarchy.entities[0], hierarchy.entities[2]] },
    { ...hierarchy, entities: hierarchy.entities.map(row => ({ ...row, account_id: "999" })) },
    { ...hierarchy, entities: [...hierarchy.entities, { ...hierarchy.entities[0], id: "999" }] },
  ])("denies duplicate, foreign and unsolicited readback rows", input => {
    expect(decodeMetaHierarchy({ ...read, input }).ok).toBe(false);
  });
  const metadata = { accountId: "123", currency: "USD", minorUnitExponent: 2, timezone: "UTC", evidenceId: "account-evidence", observedAt: now - 1000, expiresAt: now + 1000 };
  const cap = { input: hierarchy, metadata, accountId: "123", entityId: "456", control: "campaign_cap" as const, currency: "USD", expectedMinor: 10000, observedAt: now };
  it("labels a matching campaign cap cumulative rather than hard daily", () => {
    expect(decodeMetaLimit(cap)).toEqual({ ok: true, value: { entityId: "456", amount: { currency: "USD", minorUnits: 10000 }, semantics: "cumulative_cap", observedAt: now } });
  });
  it("never promotes daily budget readback to a hard limit", () => {
    expect(decodeMetaLimit({ ...cap, control: "daily_budget", expectedMinor: 1000 })).toMatchObject({ ok: true, value: { semantics: "average_budget" } });
  });
  it("denies a cap readback differing by even one minor unit", () => {
    expect(decodeMetaLimit({ ...cap, expectedMinor: 9999 })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("denies unsupported controls and ambiguous duplicate cap evidence", () => {
    expect(decodeMetaLimit({ ...cap, control: "account_cap" as "campaign_cap" }).ok).toBe(false);
    expect(decodeMetaLimit({ ...cap, input: { ...hierarchy, entities: [hierarchy.entities[0], hierarchy.entities[0]] } }).ok).toBe(false);
  });
  it("requires current account evidence before interpreting cap currency", () => {
    expect(decodeMetaLimit({ ...cap, currency: "EUR" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(decodeMetaLimit({ ...cap, metadata: { ...metadata, expiresAt: now } })).toMatchObject({ ok: false, error: { code: "expired" } });
  });
});

describe("halt stop-only mapping", () => {
  const argumentsDigest = digest({ value: { adAccountId: "123", entityIds: ["456", "457"], action: "stop" } });
  const request = { operationId: "stop-operation", scope: { ownerId: "owner", workspaceId: "workspace" }, connectionId: "connection", adAccountId: "123", entityIds: ["456", "457"], action: "stop", haltId: "halt", haltEpoch: 1, pluginDigest, bindingId: "binding", argumentsDigest };
  const permit = { kind: "halt-stop", request, expiresAt: now + 1000 };
  const effect = { operationId: request.operationId, connectionId: request.connectionId, accountId: request.adAccountId, effects: ["halt_stop"], argumentsDigest, moneyExposure: null, requiredLimit: null };
  const input = { permit, effect, pluginDigest, bindingId: "binding", now };
  it("maps a typed backend stop to PAUSED-only calls", () => {
    expect(mapMetaHaltStop(input)).toEqual({ ok: true, value: { bindingId: "binding", calls: [
      { entityId: "456", arguments: { ad_account_id: "123", entity_id: "456", status: "PAUSED" } },
      { entityId: "457", arguments: { ad_account_id: "123", entity_id: "457", status: "PAUSED" } },
    ] } });
  });
  it.each([{ effects: ["ad_spend"] }, { effects: ["write"] }, { effects: ["read"] }, { effects: ["halt_stop", "ad_spend"] }, { effects: ["conversion"] }])("rejects non-stop or compound effects", ({ effects }) => {
    expect(mapMetaHaltStop({ ...input, effect: { ...effect, effects } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("rejects budget/activation inflation and a changed entity set", () => {
    expect(mapMetaHaltStop({ ...input, permit: { ...permit, request: { ...request, status: "ACTIVE" } } }).ok).toBe(false);
    expect(mapMetaHaltStop({ ...input, permit: { ...permit, request: { ...request, entityIds: ["999"] } } })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("rejects expired permits and wrong implementation pins", () => {
    expect(mapMetaHaltStop({ ...input, now: permit.expiresAt })).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(mapMetaHaltStop({ ...input, pluginDigest: "c".repeat(64) })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
