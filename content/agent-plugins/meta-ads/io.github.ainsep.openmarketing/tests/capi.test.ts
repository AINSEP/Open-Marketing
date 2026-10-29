import { describe, expect, it } from "vitest";
import { mapMetaIdentifiers } from "../src/index.js";
import { decodeMetaCapiAcknowledgement } from "../src/capi.js";
import type { MetaCapiRequest } from "../src/capi.js";
import { capiFixture, configuration, contactsHashes, conversion } from "./capi-fixtures.js";
import { now } from "./fixtures.js";

describe("typed Meta CAPI backend", () => {
  it("passes contacts digests unchanged and keeps occurrence time, never the subject ID", async () => {
    const f = capiFixture();
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "delivered", diagnostics: { accepted: true, processed: null, attributed: null, observedAt: now } } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ endpoint: "https://graph.facebook.com/v26.0/987/events", init: { method: "POST", redirect: "error" } });
    expect(f.calls[0].payload.data[0].user_data).not.toHaveProperty("gclid");
    expect(f.authorityCalls[0]).toMatchObject({ deliveryId: "durable-delivery" });
    expect(f.calls[0].payload).toEqual({ data: [{ event_name: "CompleteRegistration", event_time: Math.floor((now - 1000) / 1000), event_id: "stable-event", action_source: "website", event_source_url: "https://example.com/signup", user_data: { em: [contactsHashes.email], ph: [contactsHashes.phone_digits], client_user_agent: "FixtureBrowser", fbp: "fb.1.1234567890.1234" } }] });
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("never-export-implicitly");
    expect(JSON.stringify(f.calls[0].payload)).not.toContain("Alice@");
  });
  it("does not double-hash explicit 64-hex input; leaves approved click/IP/UA data unhashed", () => {
    const hash = "a".repeat(64);
    expect(mapMetaIdentifiers({ input: { email: hash, phone: contactsHashes.phone, phone_digits: hash, external_id: hash, client_ip_address: "192.0.2.1", client_user_agent: "CasePreserved", event_source_url: "https://example.com/trial", fbc: "fb.1.1234567890.fixture-click" } })).toEqual({ ok: true, value: { sourceUrl: "https://example.com/trial", userData: { em: [hash], ph: [hash], external_id: [hash], client_ip_address: "192.0.2.1", client_user_agent: "CasePreserved", fbc: "fb.1.1234567890.fixture-click" } } });
  });
  it("maps only an explicit contacts external digest, without inventing email or phone", () => {
    expect(mapMetaIdentifiers({ input: { external_id: contactsHashes.external_id, client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup" } })).toEqual({ ok: true, value: { sourceUrl: "https://example.com/signup", userData: { external_id: [contactsHashes.external_id], client_user_agent: "FixtureBrowser" } } });
  });
  it("requires a match identifier beyond user agent and source URL", () => {
    expect(mapMetaIdentifiers({ input: { client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("ignores the plus-form phone digest as a match identifier", () => {
    expect(mapMetaIdentifiers({ input: { phone: contactsHashes.phone, client_user_agent: "FixtureBrowser", event_source_url: "https://example.com/signup" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
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
    expect(f.authorityCalls[0].payload).toEqual(f.calls[0].payload);
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
  it.each(["email", "phone", "phone_digits", "external_id"])("rejects raw, uppercase or malformed %s alongside otherwise valid identifiers", async key => {
    for (const value of ["Alice@Example.com", "+1 (415) 555-1234", "raw-subject", "A".repeat(64), "a".repeat(63), "a".repeat(65), " " + contactsHashes.email]) {
      const f = capiFixture();
      const identifiers = { ...conversion.event.identifiers, [key]: value };
      expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(f.authorityCalls).toHaveLength(0);
      expect(f.calls).toHaveLength(0);
    }
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
    expect(f.authorityCalls[0].deliveryId).toBe(conversion.deliveryId);
  });
  it("keeps the durable operation key stable across caller-owned attempts", async () => {
    const f = capiFixture();
    await f.backend.deliver(conversion);
    await f.backend.deliver(conversion);
    expect(f.authorityCalls.map(call => call.deliveryId)).toEqual([conversion.deliveryId, conversion.deliveryId]);
    expect(f.calls[1].payload).toEqual(f.calls[0].payload);
  });
  it("fails closed if the authority boundary throws before handoff", async () => {
    const f = capiFixture(); f.state.authorityFailure = true;
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "unavailable" } });
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
  it("denies an ungranted definition before authority", async () => {
    const f = capiFixture();
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, definitionId: "other-definition" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.authorityCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { ...conversion.grant, revoked: true },
    { ...conversion.grant, expiresAt: now },
    { ...conversion.grant, accountId: "999" },
    { ...conversion.grant, purpose: "another-purpose" },
    { ...conversion.grant, destination: "other-dataset" },
    { ...conversion.grant, scope: { ownerId: "foreign", workspaceId: "workspace" } },
    { ...conversion.grant, definitionIds: ["other-definition"] },
  ])("rejects stale or mismatched measurement grants before egress", async grant => {
    const f = capiFixture();
    expect((await f.backend.deliver({ ...conversion, grant })).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it.each([
    { ...conversion.event.identifiers, email: "invalid" },
    { ...conversion.event.identifiers, phone: "123" },
    { ...conversion.event.identifiers, event_source_url: "https://user:secret@example.com" },
  ])("denies the entire conversion on invalid supported identifier fields", async identifiers => {
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
    expect((await f.backend.deliver(input as MetaCapiRequest)).ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
  it.each([{ events_received: 0 }, { events_received: 2 }, { events_received: 1, unknown: "secret" }, { events_received: "1" }, null])("does not treat partial or invalid ACKs as delivery", input => {
    expect(decodeMetaCapiAcknowledgement({ input })).toEqual({ ok: true, value: { status: "unknown" } });
  });
  it("captures plugin configuration before an await can change the dataset", async () => {
    const config = structuredClone(configuration);
    const f = capiFixture({ configuration: config }); config.settings.conversionConfiguration = { datasetId: "999" };
    expect((await f.backend.deliver(conversion)).ok).toBe(true);
    expect(f.calls[0].endpoint).toBe("https://graph.facebook.com/v26.0/987/events");
  });
  it("refuses contacts-only identifiers without inventing website metadata", async () => {
    const f = capiFixture();
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers: { email: contactsHashes.email, phone_digits: contactsHashes.phone_digits } } })).toMatchObject({ ok: false, error: { code: "invalid_input", message: "Meta website event not sent: missing required client_user_agent or event_source_url" } });
    expect(f.calls).toHaveLength(0);
    expect(f.state.credentialCalls).toBe(0);
  });
  it.each(["qualified", "won", "custom", "constructor"])("refuses unsupported %s even when granted", async definitionId => {
    const f = capiFixture();
    expect(await f.backend.deliver({ ...conversion, grant: { ...conversion.grant, definitionIds: [definitionId] }, event: { ...conversion.event, definitionId } })).toMatchObject({ ok: false, error: { code: "invalid_input", message: expect.stringContaining("Meta conversion not sent:") } });
    expect(f.calls).toHaveLength(0);
    expect(f.state.credentialCalls).toBe(0);
  });
  it("maps trial and currency minor units without adding consent/test metadata", async () => {
    const f = capiFixture();
    await f.backend.deliver({ ...conversion, grant: { ...conversion.grant, definitionIds: ["trial"] }, event: { ...conversion.event, definitionId: "trial", value: { currency: "USD", minorUnits: 1234 } } });
    expect(f.calls[0].payload.data[0]).toMatchObject({ event_name: "StartTrial", custom_data: { value: 12.34, currency: "USD" } });
    expect(f.calls[0].payload).not.toHaveProperty("test_event_code");
    expect(f.calls[0].payload.data[0]).not.toHaveProperty("opt_out");
  });
  it("reconciles without credentials, authority or fetch", async () => {
    const f = capiFixture();
    expect(await f.backend.reconcile(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.state.credentialCalls).toBe(0);
    expect(f.authorityCalls).toHaveLength(0);
    expect(f.calls).toHaveLength(0);
  });
  it("redacts credential failures before any POST", async () => {
    const f = capiFixture(); f.state.credentialFailure = true;
    const result = await f.backend.deliver(conversion);
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(JSON.stringify(result)).not.toContain("fixture-token-secret");
    expect(f.calls).toHaveLength(0);
  });
  it("does not attach diagnostics to a malformed ACK", async () => {
    const f = capiFixture(); f.state.outcome = "unknown";
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(1);
  });
  it.each(["before", "credentials"])("cancellation at %s prevents POST", async phase => {
    const f = capiFixture(); const controller = new AbortController();
    if (phase === "before") controller.abort();
    else f.state.abortAtCredential = controller;
    expect(await f.backend.deliver(conversion, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.calls).toHaveLength(0);
  });
  it.each([{}, { datasetId: "not-numeric" }, { datasetId: "987", admitted: true }])("rejects malformed conversion settings without effects", async conversionConfiguration => {
    const f = capiFixture({ configuration: { ...configuration, settings: { conversionConfiguration } } });
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.state.credentialCalls).toBe(0);
    expect(f.calls).toHaveLength(0);
  });
});
