import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createConversionBinding, hashEmail, hashPhone, mapConversion } from "../src/conversions.ts";
import { createFixtureTransport, fixtureBinding, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { failure, success } from "../src/schema.ts";
import type { ConversionConfiguration, ConversionEvent, ConversionJournalPort } from "../src/conversions.ts";
import type { MeasurementGrant } from "@open-marketing/contracts";

const binding = { ...fixtureBinding, mode: "production" as const };
const configuration: ConversionConfiguration = { cloudProjectId: "fixture-project", legacyUploadEligibility: "verified", eligibilityEvidenceId: "fixture-eligibility-not-real", actionIds: { signup: "601", trial: "602" } };
const event: ConversionEvent = { eventId: "conversion-1", eventType: "signup", occurredAt: fixtureTime - 60000, destination: "google-ads", purpose: "measurement", gclid: "fixture-gclid-unchanged", hashedEmail: "e".repeat(64), hashedPhoneNumber: "f".repeat(64), adUserData: "GRANTED", valueMicros: "1230000", currency: "USD" };
const grant: MeasurementGrant = { kind: "measurement", grantId: "grant-1", scope: binding.scope, connectionId: binding.connectionId, accountId: binding.customerId, eventTypes: ["signup", "trial"], destination: event.destination, purpose: event.purpose, payloadSchema: "om.conversion.v1", payloadVersion: 1, expiresAt: fixtureTime + 10000, revoked: false };
function journal(): ConversionJournalPort {
  const records = new Map<string, { identity: string; digest: string; status: "unknown" | "delivered" }>();
  return {
    async claim(input) {
      const existing = records.get(input.record.identity);
      if (existing) return success({ value: { acquired: false, record: existing } });
      records.set(input.record.identity, input.record);
      return success({ value: { acquired: true, record: input.record } });
    },
    async append(input) { records.set(input.record.identity, input.record); return success({ value: undefined }); },
  };
}
test("mapping carries stable GCLID/order/time, configured action and supported consent only", () => {
  const body = mapConversion({ binding, configuration, event });
  const conversion = (body.conversions as Record<string, unknown>[])[0];
  assert.equal(conversion.conversionAction, "customers/1234567890/conversionActions/601");
  assert.equal(conversion.gclid, event.gclid);
  assert.equal(conversion.orderId, event.eventId);
  assert.equal(conversion.conversionDateTime, "2026-10-12 11:59:00+00:00");
  assert.equal(conversion.conversionValue, 1.23);
  assert.deepEqual(conversion.consent, { adUserData: "GRANTED" });
  assert.deepEqual(conversion.userIdentifiers, [{ hashedEmail: event.hashedEmail }, { hashedPhoneNumber: event.hashedPhoneNumber }]);
  assert.equal(JSON.stringify(body).includes("adPersonalization"), false);
  assert.equal(body.partialFailure, true);
});
test("Google normalization handles Gmail dots and E.164 without sending raw identifiers", () => {
  assert.deepEqual(hashEmail({ email: " First.Last@GMAIL.com " }), { ok: true, value: createHash("sha256").update("firstlast@gmail.com").digest("hex") });
  assert.equal(hashEmail({ email: "invalid" }).ok, false);
  assert.equal(hashPhone({ e164: "(555) 123-4567" }).ok, false);
  assert.deepEqual(hashPhone({ e164: "+15551234567" }), { ok: true, value: createHash("sha256").update("+15551234567").digest("hex") });
});
test("unverified API eligibility is explicitly unavailable and produces no egress", async () => {
  const fixture = createFixtureTransport({});
  const plugin = createConversionBinding({ binding, configuration: { ...configuration, legacyUploadEligibility: "unavailable", eligibilityEvidenceId: null }, transport: fixture.transport, journal: journal(), now: () => fixtureTime, authority: { async dispatchConversion(input) { return input.execute(); } } });
  const outcome = await plugin.deliver({ context: fixtureContext, event, grant, deliveryId: "delivery-1" });
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "unavailable");
  assert.equal(fixture.writes(), 0);
});
test("consent/grant/raw-PII failures reject before dispatch", async () => {
  let dispatches = 0;
  const fixture = createFixtureTransport({});
  const plugin = createConversionBinding({ binding, configuration, transport: fixture.transport, journal: journal(), now: () => fixtureTime, authority: { async dispatchConversion(input) { dispatches += 1; return input.execute(); } } });
  for (const item of [{ ...event, adUserData: "DENIED" }, { ...event, email: "pii@example.test" }, { ...event, hashedEmail: "raw@example.test" }, { ...event, ipAddress: "192.0.2.1" }]) {
    assert.equal((await plugin.deliver({ context: fixtureContext, event: item as ConversionEvent, grant, deliveryId: "delivery-1" })).ok, false);
  }
  assert.equal((await plugin.deliver({ context: fixtureContext, event, grant: { ...grant, revoked: true }, deliveryId: "delivery-1" })).ok, false);
  assert.equal(dispatches, 0);
  assert.equal(fixture.writes(), 0);
});
test("CURRENT consent withdrawal in the host blocks a previously valid event", async () => {
  const fixture = createFixtureTransport({});
  const plugin = createConversionBinding({ binding, configuration, transport: fixture.transport, journal: journal(), now: () => fixtureTime, authority: { async dispatchConversion() { return failure({ code: "forbidden", message: "Current consent withdrawn" }); } } });
  assert.equal((await plugin.deliver({ context: fixtureContext, event, grant, deliveryId: "delivery-1" })).ok, false);
  assert.equal(fixture.writes(), 0);
});
test("stable conversion dedupe returns original success and rejects changed payload", async () => {
  const fixture = createFixtureTransport({});
  const plugin = createConversionBinding({ binding, configuration, transport: fixture.transport, journal: journal(), now: () => fixtureTime, authority: { async dispatchConversion(input) { return input.execute(); } } });
  const request = { context: fixtureContext, event, grant, deliveryId: "delivery-1" };
  assert.deepEqual(await plugin.deliver(request), { ok: true, value: { status: "delivered" } });
  assert.deepEqual(await plugin.deliver(request), { ok: true, value: { status: "delivered" } });
  assert.equal((await plugin.deliver({ ...request, event: { ...event, valueMicros: "9990000" } })).ok, false);
  assert.equal(fixture.writes(), 1);
});
for (const mode of ["timeout", "partial"] as const) {
  test("conversion " + mode + " remains unknown with no second upload", async () => {
    let writes = 0;
    const plugin = createConversionBinding({ binding, configuration, journal: journal(), now: () => fixtureTime,
      authority: { async dispatchConversion(input) { return input.execute(); } },
      transport: { async request() {
        writes += 1;
        if (mode === "timeout") return failure({ code: "unavailable", message: "Fixture timeout" });
        return success({ value: { results: [{}], partialFailureError: { code: 3 } } });
      } },
    });
    const request = { context: fixtureContext, event, grant, deliveryId: "delivery-1" };
    assert.deepEqual(await plugin.deliver(request), { ok: true, value: { status: "unknown" } });
    await plugin.deliver(request);
    assert.equal(writes, 1);
  });
}
