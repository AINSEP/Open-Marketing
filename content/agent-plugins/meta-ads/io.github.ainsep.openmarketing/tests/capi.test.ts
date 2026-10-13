import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeMetaIdentifiers } from "../src/capi-normalization.js";
import { decodeMetaCapiAcknowledgement } from "../src/capi.js";
import { capiFixture, configuration, conversion } from "./capi-fixtures.js";
import { now } from "./fixtures.js";

describe("typed Meta CAPI backend", () => {
  it("normalizes and hashes consented identifiers and keeps occurrence time, never the subject ID", async () => {
    const f = capiFixture();
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ operationId: "durable-delivery", connectionId: "connection", endpoint: "https://graph.facebook.com/v25.0/987/events", timeoutMs: 15000, context: conversion.context });
    expect(f.calls[0].payload).toEqual({ data: [{ event_name: "CompleteRegistration", event_time: Math.floor((now - 1000) / 1000), event_id: "stable-event", action_source: "website", event_source_url: "https://example.com/signup", user_data: { em: [createHash("sha256").update("alice@example.com").digest("hex")], ph: [createHash("sha256").update("14155552671").digest("hex")], client_user_agent: "FixtureBrowser", fbp: "fb.1.1234567890.1234" } }] });
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("never-export-implicitly");
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("Alice@");
  });
  it("does not double-hash explicit 64-hex input; leaves approved click/IP/UA data unhashed", () => {
    const hash = "a".repeat(64);
    expect(normalizeMetaIdentifiers({ input: { email: hash, phone: hash, external_id: hash, client_ip_address: "192.0.2.1", client_user_agent: "CasePreserved", event_source_url: "https://example.com/trial", fbc: "fb.1.1234567890.fixture-click" } })).toEqual({ ok: true, value: { sourceUrl: "https://example.com/trial", userData: { em: [hash], ph: [hash], external_id: [hash], client_ip_address: "192.0.2.1", client_user_agent: "CasePreserved", fbc: "fb.1.1234567890.fixture-click" } } });
  });
  it("keeps the same vendor dedupe identity across explicit delivery attempts", async () => {
    const f = capiFixture();
    await f.backend.deliver(conversion);
    await f.backend.deliver({ ...conversion, deliveryId: "another-durable-attempt" });
    expect(f.calls.map(call => [call.payload.data[0].event_name, call.payload.data[0].event_id])).toEqual([["CompleteRegistration", "stable-event"], ["CompleteRegistration", "stable-event"]]);
  });
  it("an unknown POST is not retried or resent by reconciliation", async () => {
    const f = capiFixture(); f.state.outcome = "throw";
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await f.backend.reconcile(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.state.sends).toBe(1);
  });
  it("withdrawal after enqueue prevents all egress at dispatch", async () => {
    const f = capiFixture(); f.state.consent = false;
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
  });
  it("a final consent fence prevents egress even with an earlier valid grant", async () => {
    const f = capiFixture(); f.state.current = false;
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
  });
  it.each(["local-sandbox", "read-only"] as const)("denies production conversion in %s mode", async mode => {
    const f = capiFixture({ configuration: { ...configuration, mode } });
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { ...conversion.grant, revoked: true },
    { ...conversion.grant, expiresAt: now },
    { ...conversion.grant, accountId: "999" },
    { ...conversion.grant, purpose: "another-purpose" },
    { ...conversion.grant, destination: "other-dataset" },
    { ...conversion.grant, scope: { ownerId: "foreign", workspaceId: "workspace" } },
    { ...conversion.grant, eventTypes: ["trial" as const] },
  ])("rejects stale or mismatched measurement grants before egress", async grant => {
    const f = capiFixture();
    expect((await f.backend.deliver({ ...conversion, grant })).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { ...conversion.event.identifiers, email: "invalid" },
    { ...conversion.event.identifiers, phone: "123" },
    { ...conversion.event.identifiers, unsupported_pii: "secret" },
    { ...conversion.event.identifiers, event_source_url: "https://user:secret@example.com" },
  ])("denies the entire conversion on invalid or unsupported identifier fields", async identifiers => {
    const f = capiFixture();
    expect((await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers } })).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it.each([now + 1, now - 604800001])("rejects future or too-old occurrence time", async occurredAt => {
    const f = capiFixture();
    expect((await f.backend.deliver({ ...conversion, event: { ...conversion.event, occurredAt } })).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it("refuses a missing durable delivery ID", async () => {
    const f = capiFixture(); const { deliveryId: _deliveryId, ...input } = conversion;
    expect((await f.backend.deliver(input)).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it.each([{ events_received: 0 }, { events_received: 2 }, { events_received: 1, unknown: "secret" }, { events_received: "1" }, null])("does not treat partial or invalid ACKs as delivery", input => {
    expect(decodeMetaCapiAcknowledgement({ input })).toEqual({ ok: true, value: { status: "unknown" } });
  });
  it("captures plugin configuration before an await can change dataset/version", async () => {
    const config = { ...configuration };
    const f = capiFixture({ configuration: config }); config.pixelId = "999";
    expect((await f.backend.deliver(conversion)).ok).toBe(true);
    expect(f.calls[0].endpoint).toBe("https://graph.facebook.com/v25.0/987/events");
  });
});
