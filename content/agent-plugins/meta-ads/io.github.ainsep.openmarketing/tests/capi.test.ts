import { describe, expect, it } from "vitest";
import { mapMetaIdentifiers } from "../src/index.js";
import { decodeMetaCapiAcknowledgement } from "../src/capi.js";
import type { MetaCapiRequest } from "../src/capi.js";
import { capiFixture, configuration, contactsHashes, conversion } from "./capi-fixtures.js";
import { now } from "./fixtures.js";

describe("typed Meta CAPI backend", () => {
  it("passes contacts digests unchanged and keeps occurrence time, never the subject ID", async () => {
    const f = capiFixture();
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ operationId: "durable-delivery", connectionId: "connection", endpoint: "https://graph.facebook.com/v25.0/987/events", timeoutMs: 15000, context: conversion.context });
    expect(f.calls[0].payload).toEqual({ data: [{ event_name: "CompleteRegistration", event_time: Math.floor((now - 1000) / 1000), event_id: "stable-event", action_source: "website", event_source_url: "https://example.com/signup", user_data: { em: [contactsHashes.email], ph: [contactsHashes.phone], client_user_agent: "FixtureBrowser", fbp: "fb.1.1234567890.1234" } }] });
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("never-export-implicitly");
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("Alice@");
  });
  it("does not double-hash explicit 64-hex input; leaves approved click/IP/UA data unhashed", () => {
    const hash = "a".repeat(64);
    expect(mapMetaIdentifiers({ input: { email: hash, phone: hash, external_id: hash, client_ip_address: "192.0.2.1", client_user_agent: "CasePreserved", event_source_url: "https://example.com/trial", fbc: "fb.1.1234567890.fixture-click" } })).toEqual({ ok: true, value: { sourceUrl: "https://example.com/trial", userData: { em: [hash], ph: [hash], external_id: [hash], client_ip_address: "192.0.2.1", client_user_agent: "CasePreserved", fbc: "fb.1.1234567890.fixture-click" } } });
  });
  it("maps only an explicit contacts external digest, without inventing email or phone", () => {
    expect(mapMetaIdentifiers({ input: { external_id: contactsHashes.external_id, client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup" } })).toEqual({ ok: true, value: { sourceUrl: "https://example.com/signup", userData: { external_id: [contactsHashes.external_id], client_user_agent: "FixtureBrowser" } } });
  });
  it("requires a match identifier beyond user agent and source URL", () => {
    expect(mapMetaIdentifiers({ input: { client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("uses captured click milliseconds for fbc and exposes the exact payload to authority", async () => {
    const f = capiFixture();
    const clickTime = String(now - 10000);
    const input = { ...conversion, event: { ...conversion.event, identifiers: { ...conversion.event.identifiers, fbclid: "fixture-click", click_time_ms: clickTime } } };
    expect((await f.backend.deliver(input)).ok).toBe(true);
    expect(f.calls[0].payload.data[0].user_data.fbc).toBe(`fb.1.${clickTime}.fixture-click`);
    expect(f.calls[0].payload.data[0].user_data).not.toHaveProperty("fbclid");
    expect(f.calls[0].payload.data[0].user_data).not.toHaveProperty("click_time_ms");
    expect(f.authorityCalls[0]).toMatchObject({ event: input.event, deliveryId: "durable-delivery", payload: f.calls[0].payload });
    expect(f.authorityCalls[0].payload).toBe(f.calls[0].payload);
  });
  it("accepts click time equal to occurrence and preserves a matching supplied fbc", async () => {
    const f = capiFixture();
    const clickTime = String(conversion.event.occurredAt);
    const fbc = `fb.1.${clickTime}.fixture-click`;
    expect((await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers: { ...conversion.event.identifiers, fbclid: "fixture-click", click_time_ms: clickTime, fbc } } })).ok).toBe(true);
    expect(f.calls[0].payload.data[0].user_data.fbc).toBe(fbc);
  });
  it("supports paired click attribution as the match identifier without contact digests", () => {
    expect(mapMetaIdentifiers({ input: { fbclid: "fixture-click", click_time_ms: "1234567890000", client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup" } })).toEqual({ ok: true, value: { sourceUrl: "https://example.com/signup", userData: { fbc: "fb.1.1234567890000.fixture-click", client_user_agent: "FixtureBrowser" } } });
  });
  it.each([
    { fbclid: "fixture-click" },
    { click_time_ms: String(now - 10000) },
    { fbclid: "fixture-click", click_time_ms: "-1" },
    { fbclid: "fixture-click", click_time_ms: "1.5" },
    { fbclid: "fixture-click", click_time_ms: "01" },
    { fbclid: "fixture-click", click_time_ms: "9007199254740992" },
    { fbclid: "fixture-click", click_time_ms: String(conversion.event.occurredAt + 1) },
    { fbclid: "a".repeat(221), click_time_ms: String(now - 10000) },
    { fbclid: "bad.click", click_time_ms: String(now - 10000) },
    { fbclid: "fixture-click", click_time_ms: String(now - 10000), fbc: `fb.1.${now - 10000}.different-click` },
  ])("rejects invalid or contradictory attribution atomically", async attribution => {
    const f = capiFixture();
    const identifiers = { ...conversion.event.identifiers, ...attribution } as Record<string, string>;
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.authorityCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
  it.each(["email", "phone", "external_id"])("rejects raw, uppercase or malformed %s alongside otherwise valid identifiers", async key => {
    for (const value of ["Alice@Example.com", "+1 (415) 555-1234", "raw-subject", "A".repeat(64), "a".repeat(63), "a".repeat(65), " " + contactsHashes.email]) {
      const f = capiFixture();
      const identifiers = { ...conversion.event.identifiers, [key]: value };
      expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(f.authorityCalls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    }
  });
  it("puts the test code at the root and consent fields on the event, preserving false and zero", async () => {
    const f = capiFixture();
    const consent = { opt_out: false, data_processing_options: ["LDU"] as const, data_processing_options_country: 0, data_processing_options_state: 0 };
    expect((await f.backend.deliver({ ...conversion, test: { eventCode: "TEST123" }, consent })).ok).toBe(true);
    expect(f.calls[0].payload).toMatchObject({ test_event_code: "TEST123", data: [{ ...consent, event_id: conversion.event.eventId }] });
    expect(f.calls[0].payload.data[0]).not.toHaveProperty("test_event_code");
    expect(f.calls[0].payload.data[0].user_data).not.toHaveProperty("opt_out");
    expect(f.authorityCalls[0].payload).toEqual(f.calls[0].payload);
  });
  it("copies explicit opt_out and empty processing options without inventing regional fields", async () => {
    const f = capiFixture();
    expect((await f.backend.deliver({ ...conversion, consent: { opt_out: true, data_processing_options: [] } })).ok).toBe(true);
    const event = f.calls[0].payload.data[0];
    expect(event.opt_out).toBe(true);
    expect(event.data_processing_options).toEqual([]);
    expect(event).not.toHaveProperty("data_processing_options_country");
    expect(event).not.toHaveProperty("data_processing_options_state");
    expect(f.calls[0].payload).not.toHaveProperty("test_event_code");
  });
  it.each([
    { test: {} }, { test: { eventCode: "" } }, { test: { eventCode: "  " } },
    { test: { eventCode: "a".repeat(257) } }, { test: { eventCode: 1 } }, { test: { eventCode: "TEST123", authorize: true } },
    { consent: { opt_out: "false" } }, { consent: { data_processing_options: ["unknown"] } },
    { consent: { data_processing_options: ["LDU", "LDU"] } }, { consent: { data_processing_options_country: -1 } },
    { consent: { data_processing_options_state: 1.5 } }, { consent: { data_processing_options_country: Number.MAX_SAFE_INTEGER + 1 } },
    { consent: { granted: true } },
  ])("rejects malformed test/consent metadata before authority or egress", async metadata => {
    const f = capiFixture();
    expect(await f.backend.deliver({ ...conversion, ...metadata } as MetaCapiRequest)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.authorityCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
  it("copies neither test nor consent defaults into a normal trial event", async () => {
    const f = capiFixture();
    expect((await f.backend.deliver({ ...conversion, event: { ...conversion.event, eventType: "trial" } })).ok).toBe(true);
    expect(f.calls[0].payload).toEqual({ data: [{ event_name: "StartTrial", event_time: Math.floor(conversion.event.occurredAt / 1000), event_id: conversion.event.eventId, action_source: "website", event_source_url: "https://example.com/signup", user_data: { em: [contactsHashes.email], ph: [contactsHashes.phone], fbp: conversion.event.identifiers.fbp, client_user_agent: "FixtureBrowser" } }] });
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
  it.each(["timeout", "unknown"] as const)("reconciles %s without a second POST", async outcome => {
    const f = capiFixture(); f.state.outcome = outcome;
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await f.backend.reconcile(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.authorityCalls).toHaveLength(1);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].operationId).toBe(conversion.deliveryId);
  });
  it("keeps the durable operation key stable across caller-owned attempts", async () => {
    const f = capiFixture();
    await f.backend.deliver(conversion);
    await f.backend.deliver(conversion);
    expect(f.calls.map(call => call.operationId)).toEqual([conversion.deliveryId, conversion.deliveryId]);
    expect(f.calls[1].payload).toEqual(f.calls[0].payload);
  });
  it("returns unavailable before egress when version/dataset admission is unverified, even for tests", async () => {
    const f = capiFixture(); f.state.admitted = false;
    expect(await f.backend.deliver({ ...conversion, test: { eventCode: "TEST123" } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.calls).toHaveLength(0);
  });
  it("fails closed if the authority boundary throws before handoff", async () => {
    const f = capiFixture(); f.state.authorityFailure = true;
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(f.calls).toHaveLength(0);
  });
  it("test code and opt_out fields cannot replace current consent", async () => {
    const f = capiFixture(); f.state.consent = false;
    expect(await f.backend.deliver({ ...conversion, test: { eventCode: "TEST123" }, consent: { opt_out: false, data_processing_options: [] } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
  });
  it.each(["email", "fbclid", "click_time_ms", "fbc", "em"])("requires authority consent for original and assembled %s keys", async key => {
    const f = capiFixture(); f.state.deniedIdentifierKeys = [key];
    const identifiers = { ...conversion.event.identifiers, fbclid: "fixture-click", click_time_ms: String(now - 10000) };
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(0);
  });
  it("withdrawal during credential resolution prevents POST after the earlier authority check", async () => {
    const f = capiFixture(); f.state.withdrawAtEgress = true;
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.state.sends).toBe(0);
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
