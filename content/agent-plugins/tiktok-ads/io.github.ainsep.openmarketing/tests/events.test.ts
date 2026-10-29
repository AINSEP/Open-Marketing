import { describe, expect, it } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import { createConversionDelivery } from "../src/index.js";
import type { TikTokEventsPayload, TikTokEventsRequest } from "../src/index.js";
import { binding, clock, context, conversion, eventsConfiguration, eventsFixture, fixture, grant, now, request, serviceContext } from "./fixtures.js";

const delivered = { ok: true, value: { status: "delivered", diagnostics: { accepted: true, processed: null, attributed: null, observedAt: now } } };

describe("TikTok Events contract", () => {
  it("maps signup digests, occurrence milliseconds to Unix seconds, original ID and required web page", async () => {
    const f = eventsFixture();
    expect(await f.backend.deliver(conversion)).toEqual(delivered);
    expect(f.payloads).toEqual([{ event_source: "web", event_source_id: "fixture-pixel", data: [{ event: "CompleteRegistration", event_time: 1791849598, event_id: "shared-event", user: { email: "b".repeat(64), phone: "c".repeat(64), external_id: "d".repeat(64) }, page: { url: "https://example.com/signup" } }] }]);
    expect(f.egress.sent).toHaveLength(1);
    expect(f.egress.credentialCalls).toEqual([{ context: serviceContext, connectionId: "connection", accountId: "123" }]);
    expect(f.observations).toEqual([
      { operation: "tiktok-ads.http", outcome: "received", correlationId: "correlation", traceId: "trace" },
      { operation: "tiktok-ads.events", outcome: "delivered", correlationId: "correlation", traceId: "trace" },
    ]);
  });
  it("maps trial without hashing a digest again or leaking subject IDs", async () => {
    const f = eventsFixture(); const input: TikTokEventsRequest = { ...conversion, grant: { ...grant, definitionIds: ["trial"] }, event: { ...conversion.event, definitionId: "trial", identifiers: { external_id: "d".repeat(64), event_source_url: "https://example.com/trial" } } };
    expect(await f.backend.deliver(input)).toEqual(delivered);
    expect(f.payloads[0].data[0]).toEqual({ event: "StartTrial", event_time: 1791849598, event_id: "shared-event", user: { external_id: "d".repeat(64) }, page: { url: "https://example.com/trial" } });
    expect(JSON.stringify(f.payloads)).not.toContain('"subject"');
  });
  it("never sends duplicate delivery or browser/server event claims", async () => {
    const f = eventsFixture();
    expect((await f.backend.deliver(conversion)).ok).toBe(true);
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.backend.deliver({ ...conversion, deliveryId: "different-delivery" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, eventId: "different-event" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.egress.sent).toHaveLength(1);
  });
  it("fails closed on consent withdrawn after the event was queued", async () => {
    const f = eventsFixture(); f.state.consent = false;
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.egress.credentialCalls).toHaveLength(0); expect(f.egress.sent).toHaveLength(0);
  });
  it.each(["consent", "current"] as const)("rechecks %s withdrawn during asynchronous token lookup", async field => {
    const f = eventsFixture(); f.egress.state.onAccess = () => { f.state[field] = false; };
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.egress.credentialCalls).toHaveLength(1); expect(f.egress.sent).toHaveLength(0);
  });
  it.each([{ data: {} }, { code: 0 }, { code: 0, data: [] }, { code: 1, data: {} }, { code: "0", data: {} }])("keeps malformed/nonzero receipt unknown with no resend", async body => {
    const f = eventsFixture(); f.egress.state.body = body;
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await f.backend.reconcile(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.egress.sent).toHaveLength(1); expect(f.payloads).toHaveLength(1);
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.egress.sent).toHaveLength(1);
  });
  it("keeps authority receipt loss after send unknown and distinguishes a pre-send authority exception", async () => {
    const f = eventsFixture(); f.state.throwAfterSend = true;
    expect(await f.backend.deliver(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.egress.sent).toHaveLength(1);
    const before = eventsFixture(); before.state.throwBeforeSend = true;
    expect(await before.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(before.egress.sent).toHaveLength(0);
    expect(JSON.stringify(f.observations)).not.toContain("fixture-token");
  });
  it("reconciliation stays unknown without consulting credentials/authority or resending", async () => {
    const f = eventsFixture();
    expect(await f.backend.reconcile(conversion)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.payloads).toHaveLength(0); expect(f.egress.sent).toHaveLength(0); expect(f.egress.credentialCalls).toHaveLength(0);
  });
  it("cancels before authority and egress", async () => {
    const f = eventsFixture(); const controller = new AbortController(); controller.abort();
    expect(await f.backend.deliver(conversion, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.payloads).toHaveLength(0); expect(f.egress.sent).toHaveLength(0);
  });
});

describe("Events boundary failures", () => {
  it("creates the real factory from server configuration and projects only TikTok identifiers", async () => {
    const e = fixture({ kind: "fetch", body: { code: 0, data: {} } });
    const configuration = pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: binding.pluginDigest, settings: { conversionConfiguration: { pixelId: "fixture-pixel" } } });
    const event = { ...conversion.event, identifiers: { email: "b".repeat(64), phone: "c".repeat(64), phone_digits: "2".repeat(64), fbc: "fb.1.fixture", gclid: "fixture-click", event_source_url: "https://example.com/signup" } };
    const backend = createConversionDelivery({ configuration, fetch: e.fetch, credentials: { access: (input, options) => e.credentials.access({ ...input, context: serviceContext }, options) }, clock, observer: { observe: () => undefined }, wait: async () => ({ ok: true, value: undefined }), authority: { dispatch: input => {
      expect(input.event).toEqual(event);
      expect(input.event.identifierDigests).toEqual(conversion.event.identifierDigests);
      return input.execute({ isCurrent: () => true });
    } } });
    expect(e.credentialCalls).toHaveLength(0);
    expect(e.fetchCalls).toHaveLength(0);
    expect(await backend.deliver({ ...conversion, event })).toEqual(delivered);
    expect(e.fetchCalls).toHaveLength(1);
    expect(e.credentialCalls).toHaveLength(1);
    expect(e.fetchCalls[0]).toMatchObject({ url: "https://business-api.tiktok.com/open_api/v1.3/event/track/", init: { method: "POST" } });
    const payload = JSON.parse(String(e.fetchCalls[0].init?.body)) as TikTokEventsPayload;
    expect(payload.data[0].user).toEqual({ email: event.identifiers.email, phone: event.identifiers.phone });
    expect(payload.data[0]).not.toHaveProperty("properties");
  });
  it("strips an unrelated identifier without dropping the supported email", async () => {
    const f = eventsFixture();
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers: { email: "b".repeat(64), ip: "127.0.0.1", event_source_url: "https://example.com/signup" } } })).toEqual(delivered);
    expect(f.payloads[0].data[0].user).toEqual({ email: "b".repeat(64) });
    expect(f.egress.fetchCalls).toHaveLength(1);
  });
  it("refuses a missing page URL before authority, credentials or fetch", async () => {
    const f = eventsFixture();
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, identifiers: { email: "b".repeat(64) } } })).toMatchObject({ ok: false, error: { code: "invalid_input", message: "TikTok web event not sent: missing event_source_url or a supported identifier" } });
    expect(f.payloads).toHaveLength(0);
    expect(f.egress.credentialCalls).toHaveLength(0);
    expect(f.egress.fetchCalls).toHaveLength(0);
  });
  it.each(["qualified", "constructor"])("refuses the granted unsupported definition %s without egress", async definitionId => {
    const f = eventsFixture();
    expect(await f.backend.deliver({ ...conversion, grant: { ...grant, definitionIds: [definitionId] }, event: { ...conversion.event, definitionId } })).toMatchObject({ ok: false, error: { code: "invalid_input", message: "TikTok conversion not sent: no supported TikTok event for this definition" } });
    expect(f.payloads).toHaveLength(0);
    expect(f.egress.credentialCalls).toHaveLength(0);
    expect(f.egress.fetchCalls).toHaveLength(0);
  });
  it.each([
    { currency: "USD", minorUnits: 1234, expected: 12.34 },
    { currency: "JPY", minorUnits: 500, expected: 500 },
    { currency: "KWD", minorUnits: 1234, expected: 1.234 },
  ])("maps $currency minor units into Events properties", async ({ currency, minorUnits, expected }) => {
    const f = eventsFixture();
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, value: { currency, minorUnits } } })).toEqual(delivered);
    const payload = JSON.parse(String(f.egress.fetchCalls[0].init?.body)) as TikTokEventsPayload;
    expect(payload.data[0].properties).toEqual({ value: expected, currency });
    expect(f.egress.fetchCalls).toHaveLength(1);
  });
  it("refuses missing conversion settings on delivery and reconciliation without calls", async () => {
    const f = eventsFixture({ configuration: { ...eventsConfiguration, settings: {} } });
    expect(await f.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await f.backend.reconcile(conversion)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.payloads).toHaveLength(0);
    expect(f.egress.credentialCalls).toHaveLength(0);
    expect(f.egress.fetchCalls).toHaveLength(0);
  });
  it.each([
    { email: "raw@example.com" }, { phone: "+14155551234" }, { external_id: "raw-subject" }, { email: "A".repeat(64) },
    { email: "g".repeat(64) }, { email: "b".repeat(63) }, { email: "b".repeat(64), phone: "+14155551234" },
    {},
  ])("rejects raw/malformed/missing identifiers atomically before authority %j", async identifiers => {
    const f = eventsFixture();
    const input = { ...conversion, event: { ...conversion.event, identifiers: { ...identifiers, event_source_url: "https://example.com/signup" } } };
    // Deliberately tainted runtime input; the production schema, rather than TS, must reject it.
    expect(await f.backend.deliver(input as unknown as TikTokEventsRequest)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.payloads).toHaveLength(0); expect(f.egress.credentialCalls).toHaveLength(0);
  });
  it("denies an ungranted definition", async () => {
    const f = eventsFixture();
    expect(await f.backend.deliver({ ...conversion, event: { ...conversion.event, definitionId: "other-definition" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.payloads).toHaveLength(0);
    expect(f.egress.credentialCalls).toHaveLength(0);
    expect(f.egress.sent).toHaveLength(0);
  });
  it.each([
    { ...grant, revoked: true }, { ...grant, expiresAt: now }, { ...grant, accountId: "999" }, { ...grant, connectionId: "foreign" },
    { ...grant, scope: { ownerId: "foreign", workspaceId: "workspace" } }, { ...grant, scope: { ownerId: "owner", workspaceId: "foreign" } },
    { ...grant, destination: "foreign" }, { ...grant, purpose: "foreign" }, { ...grant, payloadVersion: 2 }, { ...grant, definitionIds: ["other-definition"] },
  ])("denies each grant binding independently", async invalidGrant => {
    const f = eventsFixture();
    expect((await f.backend.deliver({ ...conversion, grant: invalidGrant as TikTokEventsRequest["grant"] })).ok).toBe(false);
    expect(f.payloads).toHaveLength(0); expect(f.egress.sent).toHaveLength(0);
  });
  it.each([{ destination: "foreign" }, { purpose: "foreign" }, { occurredAt: now + 1 }, { occurredAt: now - 604800001 }, { identifiers: { ...conversion.event.identifiers, event_source_url: "http://example.com/" } }])("rejects incorrect event binding/age/fields %j", async fields => {
    const f = eventsFixture();
    expect((await f.backend.deliver({ ...conversion, event: { ...conversion.event, ...fields } } as TikTokEventsRequest)).ok).toBe(false);
    expect(f.payloads).toHaveLength(0); expect(f.egress.sent).toHaveLength(0);
  });
  it("checks configuration and accepts the exact seven-day age boundary", async () => {
    const invalid = eventsFixture({ configuration: { ...eventsConfiguration, settings: { conversionConfiguration: { pixelId: "../evil" } } } });
    expect(await invalid.backend.deliver(conversion)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const valid = eventsFixture();
    expect(await valid.backend.deliver({ ...conversion, event: { ...conversion.event, occurredAt: now - 604800000 } })).toEqual(delivered);
  });
  it("sends a fixed authenticated Events POST, no advertiser/subject field or credentials in payload", async () => {
    const f = eventsFixture(); await f.backend.deliver(conversion);
    const call = f.egress.fetchCalls[0];
    expect(call.url).toBe("https://business-api.tiktok.com/open_api/v1.3/event/track/");
    expect(call.init).toMatchObject({ method: "POST", redirect: "error", headers: { "Access-Token": "fixture-token", "Content-Type": "application/json", Accept: "application/json" } });
    expect(JSON.parse(String(call.init?.body))).toEqual(f.payloads[0]);
    expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(String(call.init?.body)).not.toContain("fixture-token");
  });
  it("rejects multi-event/partial-invalid payloads even at credentialed egress", async () => {
    const f = eventsFixture(); await f.backend.deliver(conversion);
    const payload = f.payloads[0];
    const batch = { ...payload, data: [payload.data[0], { ...payload.data[0], user: { email: "raw@example.com" } }] };
    const e = fixture({ kind: "fetch" });
    expect(await e.egress.send(request({ fixture: e, command: { kind: "track-event", payload: batch as TikTokEventsPayload } }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(e.credentialCalls).toHaveLength(0); expect(e.sent).toHaveLength(0);
  });
  it("keeps network failure unknown through the backend and never retries", async () => {
    const e = fixture({ kind: "fetch", fetch: async () => { throw new Error("fixture-token"); } });
    const backend = createConversionDelivery({ configuration: eventsConfiguration, clock, fetch: e.fetch, credentials: { access: (input, options) => e.credentials.access({ ...input, context: serviceContext }, options) }, wait: async () => ({ ok: true, value: undefined }), observer: { observe: () => undefined }, authority: { dispatch: input => input.execute({ isCurrent: () => true }) } });
    const result = await backend.deliver(conversion);
    expect(result).toEqual({ ok: true, value: { status: "unknown" } }); expect(e.fetchCalls).toHaveLength(1);
    expect(await backend.reconcile(conversion)).toEqual({ ok: true, value: { status: "unknown" } }); expect(e.fetchCalls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-token");
  });
  it("bounds duplicate execute callbacks and isolates observer failure", async () => {
    const e = fixture({ kind: "fetch", body: { code: 0, data: {} } });
    const backend = createConversionDelivery({ configuration: eventsConfiguration, clock, fetch: e.fetch, credentials: { access: (input, options) => e.credentials.access({ ...input, context: serviceContext }, options) }, wait: async () => ({ ok: true, value: undefined }), observer: { observe() { throw new Error("fixture telemetry unavailable"); } }, authority: { dispatch: async input => {
      const result = await input.execute({ isCurrent: () => true });
      expect(await input.execute({ isCurrent: () => true })).toMatchObject({ ok: false, error: { code: "conflict" } });
      return result;
    } } });
    expect(await backend.deliver(conversion)).toEqual(delivered);
    expect(e.fetchCalls).toHaveLength(1);
  });
});
