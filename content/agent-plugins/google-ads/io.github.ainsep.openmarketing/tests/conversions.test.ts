import { test } from "node:test";
import assert from "node:assert/strict";
import { createConversionBinding, mapConversion } from "../src/conversions.ts";
import { createGoogleRestTransport, createHttpAdapter } from "../src/transport.ts";
import { fixtureBinding, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { failure, success } from "../src/schema.ts";
import type { ConversionConfiguration, ConversionEvent, ConversionJournalPort, ConversionAuthorityPort, DeliveryRecord } from "../src/conversions.ts";
import type { GoogleTransportPort, CredentialPort } from "../src/types.ts";
import type { MeasurementGrant } from "@open-marketing/contracts";

const binding = { ...fixtureBinding, mode: "production" as const };
const configuration: ConversionConfiguration = { api: "data-manager-v1", cloudProjectId: "fixture-project", eligibility: "verified", actionIds: { "definition-lead": "601", "definition-trial": "602" } };
const event: ConversionEvent = { eventId: "conversion-1", definitionId: "definition-lead", eventType: "signup", occurredAt: fixtureTime - 60000, destination: "google-ads", purpose: "measurement", gclid: "fixture-gclid-unchanged", hashedEmail: "e".repeat(64), hashedPhoneNumber: "f".repeat(64), adUserData: "GRANTED", adPersonalization: "DENIED", valueMicros: "1230000", currency: "USD" };
const grant: MeasurementGrant = { kind: "measurement", grantId: "grant-1", scope: binding.scope, connectionId: binding.connectionId, accountId: binding.customerId, eventTypes: ["signup", "trial"], destination: event.destination, purpose: event.purpose, payloadSchema: "om.conversion.v1", payloadVersion: 1, expiresAt: fixtureTime + 10000, revoked: false };
const request = { context: fixtureContext, event, grant, deliveryId: "delivery-1" };
const destination = { operatingAccount: { accountType: "GOOGLE_ADS", accountId: binding.customerId }, productDestinationId: "601" };
const allowed: ConversionAuthorityPort = { async dispatchConversion(input) { return input.execute(); } };
function diagnostic(required: { status?: string; destination?: unknown; count?: string; extra?: Record<string, unknown> } = {}): unknown {
  return { requestStatusPerDestination: [{ destination: required.destination ?? destination, requestStatus: required.status ?? "SUCCESS", eventsIngestionStatus: { recordCount: required.count ?? "1" }, ...required.extra }] };
}
/** Durable-state double persists across factory restarts and keeps appended history. */
function journal(required: { failAppend?: boolean } = {}): ConversionJournalPort & { history: DeliveryRecord[]; records: Map<string, DeliveryRecord> } {
  const records = new Map<string, DeliveryRecord>();
  const history: DeliveryRecord[] = [];
  return {
    records, history,
    async get(input) { return success({ value: structuredClone(records.get(input.identity) ?? null) }); },
    async claim(input) {
      const existing = records.get(input.record.identity);
      if (existing) return success({ value: { acquired: false, record: structuredClone(existing) } });
      records.set(input.record.identity, structuredClone(input.record));
      return success({ value: { acquired: true, record: structuredClone(input.record) } });
    },
    async append(input) {
      if (required.failAppend) return failure({ code: "unavailable", message: "Fixture receipt storage failed" });
      records.set(input.record.identity, structuredClone(input.record));
      history.push(structuredClone(input.record));
      return success({ value: undefined });
    },
  };
}
type FixtureOptions = {
  adapter: "double" | "rest"; preflight?: unknown; ingest?: unknown; diagnostic?: unknown;
  lostResponse?: boolean; afterPreflight?: () => void; journal?: ConversionJournalPort;
  authority?: ConversionAuthorityPort; configuration?: ConversionConfiguration;
};
/** Same behavioral suite drives a vendor double and real REST + bounded fetch adapter.
 * Foreign fetch ABI is fixture-only; it never delegates to global fetch. */
function harness(required: FixtureOptions) {
  const calls: { method: string; body: Record<string, unknown>; url?: string }[] = [];
  const credentials: Parameters<CredentialPort["access"]>[0][] = [];
  const observations: unknown[] = [];
  const state = required.journal ?? journal();
  const respond = (input: { method: string; body: Record<string, unknown> }): unknown => {
    if (input.method === "request_status") return required.diagnostic ?? diagnostic();
    if (input.body.validateOnly === true) {
      required.afterPreflight?.();
      return Object.hasOwn(required, "preflight") ? required.preflight : {};
    }
    if (required.lostResponse) throw new Error("Fixture lost response after acceptance");
    return required.ingest ?? { requestId: "google-receipt-1" };
  };
  const fixtureFetch: typeof fetch = async (url, init) => {
    const address = String(url);
    const method = init?.method === "GET" ? "request_status" : "ingest";
    const body = method === "request_status" ? { requestId: new URL(address).searchParams.get("requestId") } : JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ method, body, url: address });
    assert.equal(init?.redirect, "error");
    return new Response(JSON.stringify(respond({ method, body })), { status: 200 });
  };
  const double: GoogleTransportPort = { async request(input) {
    calls.push(structuredClone(input));
    try { return success({ value: respond(input) }); }
    catch { return failure({ code: "unavailable", message: "Fixture lost receipt" }); }
  } };
  const rest = createGoogleRestTransport({ binding,
    credentials: { async access(input) { credentials.push(input); return success({ value: { accessToken: "fixture-token", scopes: ["https://www.googleapis.com/auth/datamanager"], cloudProjectId: configuration.cloudProjectId } }); } },
    http: createHttpAdapter({ fetch: fixtureFetch, observer: { observe(input) { observations.push(input); } } }),
  });
  const transport = required.adapter === "double" ? double : rest;
  const dependencies = { binding, configuration: required.configuration ?? configuration, transport, journal: state, now: () => fixtureTime, authority: required.authority ?? allowed };
  return { plugin: createConversionBinding(dependencies), dependencies, calls, credentials, observations, state };
}
const unknown = { ok: true, value: { status: "unknown" } };
const delivered = { ok: true, value: { status: "delivered" } };
function ingestionCount(required: { calls: { method: string; body: Record<string, unknown> }[] }): number {
  return required.calls.filter(call => call.method === "ingest" && call.body.validateOnly === false).length;
}

test("maps definition-selected action, untouched digests, WEB timestamp, transaction ID and both consent signals", () => {
  assert.deepEqual(mapConversion({ binding, configuration, event }), {
    destinations: [destination], encoding: "HEX", validateOnly: false,
    events: [{ transactionId: event.eventId, eventTimestamp: "2026-10-12T11:59:00.000Z", eventSource: "WEB", conversionValue: 1.23, currency: "USD",
      consent: { adUserData: "CONSENT_GRANTED", adPersonalization: "CONSENT_DENIED" }, adIdentifiers: { gclid: event.gclid },
      userData: { userIdentifiers: [{ emailAddress: event.hashedEmail }, { phoneNumber: event.hashedPhoneNumber }] },
    }],
  });
  const clickOnly = { ...event }; delete clickOnly.hashedEmail; delete clickOnly.hashedPhoneNumber; delete clickOnly.adPersonalization;
  const body = mapConversion({ binding, configuration: { ...configuration, loginCustomerId: "9876543210" }, event: clickOnly });
  assert.equal(JSON.stringify(body).includes("userData"), false);
  assert.equal(JSON.stringify(body).includes("adPersonalization"), false);
  assert.deepEqual((body.destinations as Record<string, unknown>[])[0].loginAccount, { accountType: "GOOGLE_ADS", accountId: "9876543210" });
  const digestOnly = { ...event }; delete digestOnly.gclid;
  const digestBody = mapConversion({ binding, configuration, event: digestOnly });
  assert.equal(JSON.stringify(digestBody).includes("adIdentifiers"), false);
  assert.deepEqual((digestBody.events as Record<string, unknown>[])[0].userData, { userIdentifiers: [{ emailAddress: event.hashedEmail }, { phoneNumber: event.hashedPhoneNumber }] });
});

for (const adapter of ["double", "rest"] as const) {
  test(adapter + ": preflight, immutable ingest, durable receipt, read-only processing/success and duplicate success", async () => {
    let dispatches = 0;
    const fixture = harness({ adapter, authority: { async dispatchConversion(input) { dispatches += 1; return input.execute(); } } });
    assert.deepEqual(await fixture.plugin.deliver(request), unknown);
    assert.equal(dispatches, 1);
    assert.equal(fixture.calls.length, 2);
    assert.equal(fixture.calls[0].body.validateOnly, true);
    assert.deepEqual(fixture.calls[1].body, { ...fixture.calls[0].body, validateOnly: false });
    const persisted = await fixture.state.get({ identity: (fixture.state as ReturnType<typeof journal>).history[0].identity });
    assert.equal(persisted.ok && persisted.value?.requestId, "google-receipt-1");
    assert.deepEqual(await fixture.plugin.reconcile(request), delivered);
    assert.equal(dispatches, 2);
    assert.deepEqual(await fixture.plugin.deliver({ ...request, deliveryId: "another-job-attempt" }), delivered);
    assert.equal(ingestionCount(fixture), 1);
    assert.equal(fixture.calls.length, 3);
    if (adapter === "rest") {
      assert.equal(fixture.calls[0].url, "https://datamanager.googleapis.com/v1/events:ingest");
      assert.equal(fixture.calls[2].url, "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=google-receipt-1");
      assert.equal(fixture.credentials.length, 3);
      assert.deepEqual(fixture.credentials[0], { binding, requiredScope: "https://www.googleapis.com/auth/datamanager", cloudProjectId: configuration.cloudProjectId });
      assert.equal(JSON.stringify(fixture.observations).includes("fixture-token"), false);
      assert.equal(JSON.stringify(fixture.observations).includes(event.hashedEmail!), false);
      assert.equal(JSON.stringify(fixture.observations).includes(fixtureContext.correlationId), true);
    }
  });
  for (const preflight of [{ error: { code: 400 } }, { fieldWarnings: [{}] }, { fieldWarnings: null }, null, [], "invalid"]) {
    test(adapter + ": rejected or malformed preflight does not claim or ingest: " + JSON.stringify(preflight), async () => {
      const state = journal();
      const fixture = harness({ adapter, preflight, journal: state });
      assert.equal((await fixture.plugin.deliver(request)).ok, false);
      assert.equal(ingestionCount(fixture), 0);
      assert.equal(state.records.size, 0);
    });
  }
  test(adapter + ": unavailable eligibility and malformed event fields deny before egress", async () => {
    const unavailable = harness({ adapter, configuration: { ...configuration, eligibility: "unavailable" } });
    assert.equal((await unavailable.plugin.deliver(request)).ok, false);
    assert.equal(unavailable.calls.length, 0);
    const fixture = harness({ adapter });
    for (const invalid of [
      { ...event, adUserData: "DENIED" }, { ...event, email: "raw@example.test" }, { ...event, phone: "+15551234567" },
      { ...event, hashedEmail: "E".repeat(64) }, { ...event, hashedPhoneNumber: "raw" }, { ...event, ipAddress: "192.0.2.1" },
      { ...event, occurredAt: NaN }, { ...event, occurredAt: fixtureTime + 1 }, { ...event, occurredAt: -1 },
      { ...event, gclid: "a".repeat(257) }, { ...event, gclid: "bad click id" }, { ...event, valueMicros: "9007199254740992" },
      { ...event, valueMicros: "-1" }, { ...event, currency: "EUR" }, { ...event, definitionId: "unconfigured" },
      { ...event, gclid: undefined, hashedEmail: undefined, hashedPhoneNumber: undefined },
    ]) assert.equal((await fixture.plugin.deliver({ ...request, event: invalid as ConversionEvent })).ok, false);
    assert.equal(fixture.calls.length, 0);
  });
  test(adapter + ": multiple OM definitions in one covered category select their own action", async () => {
    const fixture = harness({ adapter, configuration: { ...configuration, actionIds: { "custom-purchase-definition": "777" } } });
    const customEvent = { ...event, definitionId: "custom-purchase-definition" };
    assert.deepEqual(await fixture.plugin.deliver({ ...request, event: customEvent }), unknown);
    assert.equal((fixture.calls[1].body.destinations as Record<string, unknown>[])[0].productDestinationId, "777");
  });
  test(adapter + ": scoped grants, expired grants and closed configuration reject before egress", async () => {
    const fixture = harness({ adapter });
    for (const deniedGrant of [
      { ...grant, scope: { ...grant.scope, ownerId: "other-owner" } },
      { ...grant, scope: { ...grant.scope, workspaceId: "other-workspace" } },
      { ...grant, connectionId: "other-connection" }, { ...grant, accountId: "9876543210" },
      { ...grant, expiresAt: fixtureTime }, { ...grant, destination: "other-destination" },
      { ...grant, eventTypes: ["trial"] as MeasurementGrant["eventTypes"] },
    ]) assert.equal((await fixture.plugin.deliver({ ...request, grant: deniedGrant })).ok, false);
    assert.equal((await fixture.plugin.deliver({ ...request, context: { ...fixtureContext, scope: { ...fixtureContext.scope, ownerId: "other-owner" } } })).ok, false);
    for (const invalidConfig of [
      { ...configuration, rawToken: "forbidden" }, { ...configuration, actionIds: {} },
      { ...configuration, actionIds: { "definition-lead": "not-numeric" } },
      { ...configuration, actionIds: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ["definition-" + i, "601"])) },
      { ...configuration, loginCustomerId: "bad-manager" },
    ]) {
      const configured = createConversionBinding({ ...fixture.dependencies, configuration: invalidConfig });
      assert.equal((await configured.deliver(request)).ok, false);
    }
    assert.equal(fixture.calls.length, 0);
  });
  test(adapter + ": CURRENT authority denial and consent/grant withdrawal after preflight block ingestion", async () => {
    const denied = harness({ adapter, authority: { async dispatchConversion() { return failure({ code: "forbidden", message: "Current consent withdrawn" }); } } });
    assert.equal((await denied.plugin.deliver(request)).ok, false);
    assert.equal(denied.calls.length, 0);
    const withdrawn = structuredClone(request);
    const fixture = harness({ adapter, afterPreflight: () => { withdrawn.grant.revoked = true; } });
    assert.equal((await fixture.plugin.deliver(withdrawn)).ok, false);
    assert.equal(ingestionCount(fixture), 0);
    const consentWithdrawn = structuredClone(request);
    const consentFixture = harness({ adapter, afterPreflight: () => { consentWithdrawn.event.adUserData = "DENIED"; } });
    assert.equal((await consentFixture.plugin.deliver(consentWithdrawn)).ok, false);
    assert.equal(ingestionCount(consentFixture), 0);
  });
  test(adapter + ": concurrent duplicate claims ingest once; changed payload and action configuration conflict", async () => {
    const fixture = harness({ adapter });
    await Promise.all([fixture.plugin.deliver(request), fixture.plugin.deliver({ ...request, deliveryId: "delivery-2" })]);
    assert.equal(ingestionCount(fixture), 1);
    for (const changed of [{ ...event, valueMicros: "9990000" }, { ...event, purpose: "different-purpose" }]) {
      const matchingGrant = { ...grant, purpose: changed.purpose };
      assert.equal((await fixture.plugin.deliver({ ...request, event: changed, grant: matchingGrant })).ok, false);
    }
    const changedConfiguration = createConversionBinding({ ...fixture.dependencies, configuration: { ...configuration, actionIds: { "definition-lead": "999" } } });
    assert.equal((await changedConfiguration.deliver(request)).ok, false);
    const changedProject = createConversionBinding({ ...fixture.dependencies, configuration: { ...configuration, cloudProjectId: "another-project" } });
    const conflict = await changedProject.deliver(request);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.error.code, "conflict");
    assert.equal(ingestionCount(fixture), 1);
  });
  test(adapter + ": valid data changed during preflight cannot ingest a stale validated body", async () => {
    const changed = structuredClone(request);
    const state = journal();
    const fixture = harness({ adapter, journal: state, afterPreflight: () => { changed.event.valueMicros = "9990000"; } });
    const result = await fixture.plugin.deliver(changed);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "conflict");
    assert.equal(ingestionCount(fixture), 0);
    assert.equal(state.records.size, 0);
  });
  test(adapter + ": durable receipt survives factory restart; processing stays unknown and never resubmits", async () => {
    const fixture = harness({ adapter, diagnostic: diagnostic({ status: "PROCESSING" }) });
    assert.deepEqual(await fixture.plugin.deliver(request), unknown);
    const restarted = createConversionBinding(fixture.dependencies);
    assert.deepEqual(await restarted.deliver(request), unknown);
    assert.equal(fixture.calls[2].method, "request_status");
    assert.equal(ingestionCount(fixture), 1);
  });
  for (const fault of ["lost-response", "lost-storage", "missing-receipt"] as const) {
    test(adapter + ": " + fault + " stays unknown across restart without any resubmission", async () => {
      const fixture = harness({ adapter, lostResponse: fault === "lost-response", journal: journal({ failAppend: fault === "lost-storage" }), ingest: fault === "missing-receipt" ? {} : undefined });
      assert.deepEqual(await fixture.plugin.deliver(request), unknown);
      const restarted = createConversionBinding(fixture.dependencies);
      assert.deepEqual(await restarted.deliver(request), unknown);
      assert.deepEqual(await restarted.reconcile(request), unknown);
      assert.equal(ingestionCount(fixture), 1);
      assert.equal(fixture.calls.length, 2);
    });
  }
  for (const status of ["FAILED", "PARTIAL_SUCCESS"]) {
    test(adapter + ": terminal " + status + " persists non-retryable failure without reingesting", async () => {
      const fixture = harness({ adapter, diagnostic: diagnostic({ status, extra: { errorInfo: { errorCounts: [{ reason: "PROCESSING_ERROR_REASON_INVALID_EVENT", recordCount: "1" }] } } }) });
      await fixture.plugin.deliver(request);
      const result = await fixture.plugin.reconcile(request);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.retryable, false);
      assert.equal((await fixture.plugin.deliver(request)).ok, false);
      assert.equal(ingestionCount(fixture), 1);
      assert.equal(fixture.calls.length, 3);
    });
  }
  for (const ambiguous of [
    {}, diagnostic({ destination: { ...destination, productDestinationId: "999" } }), diagnostic({ count: "2" }),
    diagnostic({ count: "not-a-count" }), diagnostic({ status: "UNRECOGNIZED" }), diagnostic({ extra: { errorInfo: {} } }),
    diagnostic({ extra: { audienceMembersIngestionStatus: {} } }), { requestStatusPerDestination: [] },
    diagnostic({ extra: { audienceMembersIngestionStatus: null } }), diagnostic({ extra: { warningInfo: "malformed" } }),
    diagnostic({ extra: { unsupported: true } }), { requestStatusPerDestination: [null] },
    { ...diagnostic() as Record<string, unknown>, error: { code: 400 } },
    { requestStatusPerDestination: [destination, destination] },
  ]) {
    test(adapter + ": ambiguous/malformed/wrong-destination diagnostics cannot establish delivery: " + JSON.stringify(ambiguous), async () => {
      const fixture = harness({ adapter, diagnostic: ambiguous });
      await fixture.plugin.deliver(request);
      assert.deepEqual(await fixture.plugin.reconcile(request), unknown);
      assert.equal(ingestionCount(fixture), 1);
    });
  }
  test(adapter + ": documented processing warnings permit clean SUCCESS without claiming attribution", async () => {
    const fixture = harness({ adapter, diagnostic: diagnostic({ extra: { warningInfo: { warningCounts: [{ reason: "PROCESSING_WARNING_REASON_INTERNAL_ERROR", recordCount: "1" }] } } }) });
    await fixture.plugin.deliver(request);
    assert.deepEqual(await fixture.plugin.reconcile(request), delivered);
    assert.equal(ingestionCount(fixture), 1);
  });
  test(adapter + ": reconcile before claim performs no HTTP; read dispatch denial never ingests", async () => {
    const fixture = harness({ adapter });
    assert.deepEqual(await fixture.plugin.reconcile(request), unknown);
    assert.equal(fixture.calls.length, 0);
    await fixture.plugin.deliver(request);
    const denied = createConversionBinding({ ...fixture.dependencies, authority: { async dispatchConversion() { return failure({ code: "forbidden", message: "Reconcile authority denied" }); } } });
    assert.equal((await denied.reconcile(request)).ok, false);
    assert.equal(fixture.calls.length, 2);
  });
}

test("Data Manager credentials require validated advertiser scope/project metadata, never leaking to agent input", async () => {
  let posts = 0;
  for (const token of [
    { accessToken: "fixture-token" },
    { accessToken: "fixture-token", scopes: ["https://www.googleapis.com/auth/adwords"], cloudProjectId: configuration.cloudProjectId },
    { accessToken: "fixture-token", scopes: ["https://www.googleapis.com/auth/datamanager"], cloudProjectId: "another-project" },
    { accessToken: "bad\r\nheader", scopes: ["https://www.googleapis.com/auth/datamanager"], cloudProjectId: configuration.cloudProjectId },
  ]) {
    const transport = createGoogleRestTransport({ binding, credentials: { async access(input) { assert.equal(input.binding.connectionId, binding.connectionId); return success({ value: token }); } }, http: {
      async post() { posts += 1; return success({ value: { status: 200, body: {} } }); }, async get() { return success({ value: { status: 200, body: {} } }); },
    } });
    assert.equal((await transport.request({ method: "ingest", body: {}, cloudProjectId: configuration.cloudProjectId, context: fixtureContext, operationId: "test" })).ok, false);
  }
  assert.equal(posts, 0);
});
test("Data Manager rejects a Search-only HTTP port before ingestion", async () => {
  let lookups = 0;
  const transport = createGoogleRestTransport({ binding, credentials: { async access() { lookups += 1; return success({ value: { accessToken: "fixture-token" } }); } }, http: { async post() { assert.fail("No ingress permitted"); } } });
  assert.equal((await transport.request({ method: "ingest", body: {}, cloudProjectId: configuration.cloudProjectId, context: fixtureContext, operationId: "test" })).ok, false);
  assert.equal(lookups, 0);
});
test("each advertiser resolves its own server token and Data Manager never sends Ads auth headers", async () => {
  const lookups: Parameters<CredentialPort["access"]>[0][] = [];
  const headers: Record<string, string>[] = [];
  const broker: CredentialPort = { async access(input) {
    lookups.push(input);
    return success({ value: { accessToken: "fixture-token-" + input.binding.connectionId, scopes: [input.requiredScope!], cloudProjectId: input.cloudProjectId, loginCustomerId: "9876543210" } });
  } };
  for (const connectionId of ["advertiser-a", "advertiser-b"]) {
    const advertiser = { ...binding, connectionId };
    const transport = createGoogleRestTransport({ binding: advertiser, credentials: broker, http: {
      async post(input) { headers.push(input.headers); return success({ value: { status: 200, body: {} } }); },
      async get() { assert.fail("Ingestion must POST"); },
    } });
    assert.equal((await transport.request({ method: "ingest", body: { validateOnly: true }, cloudProjectId: configuration.cloudProjectId, context: fixtureContext, operationId: "fixture" })).ok, true);
  }
  assert.deepEqual(lookups.map(input => input.binding.connectionId), ["advertiser-a", "advertiser-b"]);
  assert.deepEqual(headers, [
    { Authorization: "Bearer fixture-token-advertiser-a", "Content-Type": "application/json" },
    { Authorization: "Bearer fixture-token-advertiser-b", "Content-Type": "application/json" },
  ]);
});
test("HTTP diagnostics are bounded, method-specific and propagate trace/run/correlation without secrets", async () => {
  const observations: unknown[] = [];
  let fetches = 0;
  const http = createHttpAdapter({ fetch: async (_url, init) => { fetches += 1; assert.equal(init?.method, "GET"); assert.equal(init?.body, undefined); return new Response('"' + "x".repeat(32) + '"'); }, observer: { observe(input) { observations.push(input); } } });
  const input = { headers: { Authorization: "Bearer fixture-secret" }, timeoutMs: 15000, maxBytes: 16, context: { ...fixtureContext, runId: "fixture-run" }, operationId: "conversion-op" };
  assert.equal((await http.get!({ ...input, url: "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=receipt" })).ok, false);
  for (const url of ["https://evil.test/", "https://datamanager.googleapis.com/v1/events:ingest", "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=a&requestId=b", "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=a&other=b"]) assert.equal((await http.get!({ ...input, url })).ok, false);
  assert.equal(fetches, 1);
  assert.equal(JSON.stringify(observations).includes("fixture-secret"), false);
  assert.equal(JSON.stringify(observations).includes("fixture-run"), true);
  assert.equal(JSON.stringify(observations).includes(fixtureContext.traceId!), true);
});
