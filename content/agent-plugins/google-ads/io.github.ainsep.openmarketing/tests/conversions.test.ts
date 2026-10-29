import { test } from "node:test";
import assert from "node:assert/strict";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import { createConversionDelivery, mapConversion } from "../src/index.ts";
import { createGoogleRestTransport, createHttpAdapter } from "../src/transport.ts";
import { fixtureBinding, fixtureContext, fixtureTime } from "../src/fixture.ts";
import { failure, success } from "../src/schema.ts";
import type { CredentialPort } from "../src/types.ts";

type Dependencies = Parameters<typeof createConversionDelivery>[0];
type Input = Parameters<ReturnType<typeof createConversionDelivery>["deliver"]>[0];
const binding = fixtureBinding;
const configuration = pluginConfigurationSchema.parse({ scope: binding.scope, connectionId: binding.connectionId, accountId: binding.customerId, pluginDigest: binding.pluginDigest, settings: { conversionConfiguration: { actionIds: { signup: "601", trial: "602", won: "603" } }, loginCustomerId: "9876543210" } });
const event: Input["event"] = { eventId: "conversion-1", definitionId: "signup", subjectId: "private-subject", occurredAt: fixtureTime - 60000, destination: "google-ads", purpose: "measurement", identifierDigests: { email: "e".repeat(64) }, identifiers: { email: "e".repeat(64), phone: "f".repeat(64), gclid: "fixture-gclid-unchanged", phone_digits: "d".repeat(64), fbc: "fb.1.123.fixture" }, value: { minorUnits: 1234, currency: "USD" } };
const request: Input = { context: { scope: binding.scope, serviceId: "measure-worker", correlationId: fixtureContext.correlationId, traceId: fixtureContext.traceId }, event,
  grant: { kind: "measurement", grantId: "grant-1", scope: binding.scope, connectionId: binding.connectionId, accountId: binding.customerId, definitionIds: [event.definitionId], destination: event.destination, purpose: event.purpose, payloadSchema: "om.conversion.v1", payloadVersion: 1, expiresAt: fixtureTime + 10000, revoked: false }, deliveryId: "delivery-1" };
const unknown = { ok: true, value: { status: "unknown" } };
const delivered = { ok: true, value: { status: "delivered", receiptId: "receipt-1", diagnostics: { accepted: true, processed: null, attributed: null, observedAt: fixtureTime } } };

/** Real public factory and REST/HTTP adapters; every effect is a deterministic fixture, never live I/O. */
function harness(required: { configuration?: Dependencies["configuration"]; receipt?: unknown; lostResponse?: boolean; authority?: Dependencies["authority"] } = {}) {
  const calls: { url: string; init?: RequestInit; body: Record<string, unknown> }[] = [];
  const credentials: Parameters<Dependencies["credentials"]["access"]>[0][] = [];
  const observations: unknown[] = [];
  const state = { current: true, withdrawAtCredential: false, credentialFailure: false, token: "fixture-token-secret", authorityCalls: 0, abortAtCredential: undefined as AbortController | undefined };
  const dependencies: Dependencies = {
    configuration: required.configuration ?? configuration,
    clock: { now: () => fixtureTime }, observer: { observe(input) { observations.push(input); } }, wait: async () => success({ value: undefined }),
    authority: required.authority ?? { async dispatch(input) { state.authorityCalls += 1; return input.execute({ isCurrent: () => state.current }); } },
    credentials: { async access(input) {
      credentials.push(input);
      if (state.withdrawAtCredential) state.current = false;
      state.abortAtCredential?.abort();
      if (state.credentialFailure) return failure({ code: "forbidden", message: "fixture-token-secret credential JSON" });
      return success({ value: { accessToken: state.token, expiresAt: fixtureTime + 1000, secrets: { developerToken: "a".repeat(22) } } });
    } },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (required.lostResponse) throw new Error("fixture-token-secret ACK lost after send");
      return Response.json(Object.hasOwn(required, "receipt") ? required.receipt : { requestId: "receipt-1" });
    },
  };
  return { backend: createConversionDelivery(dependencies), calls, credentials, state, observations };
}

test("A3-shaped real factory accepts canonical credentials and makes one Data Manager POST", async () => {
  const f = harness();
  assert.deepEqual(await f.backend.deliver(request), delivered);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://datamanager.googleapis.com/v1/events:ingest");
  assert.equal(f.calls[0].init?.method, "POST");
  assert.equal(f.calls[0].init?.redirect, "error");
  assert.deepEqual(f.calls[0].body, {
    destinations: [{ operatingAccount: { accountType: "GOOGLE_ADS", accountId: configuration.accountId }, loginAccount: { accountType: "GOOGLE_ADS", accountId: "9876543210" }, productDestinationId: "601" }],
    encoding: "HEX", validateOnly: false,
    events: [{ transactionId: event.eventId, eventTimestamp: "2026-10-12T11:59:00.000Z", eventSource: "WEB", conversionValue: 12.34, currency: "USD", consent: { adUserData: "CONSENT_GRANTED" }, adIdentifiers: { gclid: event.identifiers.gclid }, userData: { userIdentifiers: [{ emailAddress: event.identifiers.email }, { phoneNumber: event.identifiers.phone }] } }],
  });
  assert.deepEqual(f.credentials, [{ connectionId: binding.connectionId, accountId: configuration.accountId }]);
  assert.deepEqual(f.calls[0].init?.headers, { Authorization: "Bearer fixture-token-secret", "Content-Type": "application/json" });
  const observed = JSON.stringify(f.observations);
  assert.equal(observed.includes("fixture-token-secret"), false);
  assert.equal(observed.includes(event.identifiers.email), false);
  assert.equal(observed.includes(request.context.traceId), true);
});

test("supports open granted definitions without inventing a Google event age limit", async () => {
  const f = harness();
  assert.deepEqual(await f.backend.deliver({ ...request, grant: { ...request.grant, definitionIds: ["won"] }, event: { ...event, definitionId: "won", occurredAt: fixtureTime - 30 * 86400000 } }), delivered);
  assert.equal((f.calls[0].body.destinations as Record<string, unknown>[])[0].productDestinationId, "603");
});

test("ignores other destinations' identifier keys and refuses an empty supported set", async () => {
  const f = harness();
  const result = await f.backend.deliver({ ...request, event: { ...event, identifiers: { fbc: "irrelevant", phone_digits: "d".repeat(64) } } });
  assert.deepEqual(result, failure({ code: "invalid_input", message: "Google conversion not sent: no supported identifier" }));
  assert.equal(f.calls.length, 0);
  assert.equal(f.credentials.length, 0);
});

test("unmapped and ungranted definitions refuse before credentials or fetch", async () => {
  for (const granted of [true, false]) {
    const f = harness();
    const result = await f.backend.deliver({ ...request, event: { ...event, definitionId: "custom" }, grant: { ...request.grant, definitionIds: granted ? ["custom"] : ["signup"] } });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, granted ? "unavailable" : "forbidden");
    assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
  }
});

test("preserves click-only/digest-only payloads and currency-specific minor-unit exponents", () => {
  const parsedConfiguration = { ...configuration, settings: { conversionConfiguration: { actionIds: { signup: "601" } } } };
  const clickOnly = mapConversion({ configuration: parsedConfiguration, event: { ...event, identifiers: { gclid: "fixture-click" }, value: undefined } });
  const click = (clickOnly.events as Record<string, unknown>[])[0];
  assert.equal(Object.hasOwn(click, "userData"), false);
  assert.equal(Object.hasOwn(click, "conversionValue"), false);
  assert.equal(Object.hasOwn(click, "currency"), false);
  assert.equal(Object.hasOwn((clickOnly.destinations as Record<string, unknown>[])[0], "loginAccount"), false);
  for (const [currency, minorUnits, expected] of [["JPY", 1234, 1234], ["KWD", 1234, 1.234], ["USD", 0, 0]] as const) {
    const body = mapConversion({ configuration: parsedConfiguration, event: { ...event, identifiers: { email: event.identifiers.email }, value: { currency, minorUnits } } });
    const mapped = (body.events as Record<string, unknown>[])[0];
    assert.equal(Object.hasOwn(mapped, "adIdentifiers"), false);
    assert.equal(mapped.conversionValue, expected); assert.equal(mapped.currency, currency);
  }
});

for (const receipt of [{}, null, { requestId: "" }, { requestId: 123 }]) {
  test("missing or malformed requestId is unknown: " + JSON.stringify(receipt), async () => {
    const f = harness({ receipt });
    assert.deepEqual(await f.backend.deliver(request), unknown);
    assert.equal(f.calls.length, 1);
  });
}

test("lost acknowledgement and reconciliation never cause a second send", async () => {
  const f = harness({ lostResponse: true });
  assert.deepEqual(await f.backend.deliver(request), unknown);
  assert.deepEqual(await f.backend.reconcile(request), unknown);
  assert.equal(f.calls.length, 1); assert.equal(f.credentials.length, 1); assert.equal(f.state.authorityCalls, 1);
});
test("reconciliation has zero credentials, authority calls or fetch", async () => {
  const f = harness();
  const { identifiers: _identifiers, ...event } = request.event;
  assert.deepEqual(await f.backend.reconcile({ ...request, event }), unknown);
  assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0); assert.equal(f.state.authorityCalls, 0);
  const invalid = await f.backend.reconcile({ ...request, grant: { ...request.grant, revoked: true } });
  assert.equal(invalid.ok, false);
});

for (const [requestStatus, processed] of [["SUCCESS", true], ["FAILED", false], ["PROCESSING", null], ["PARTIAL_SUCCESS", null], ["REQUEST_STATUS_UNKNOWN", null]] as const) {
  test("receipt readback makes one GET and reports " + requestStatus, async () => {
    const f = harness({ receipt: { requestStatusPerDestination: [{ requestStatus, destination: { operatingAccount: { accountId: binding.customerId } }, errorInfo: { private: "fixture-secret" } }] } });
    const { identifiers: _identifiers, ...event } = request.event;
    const result = await f.backend.reconcile({ ...request, event, receiptId: "receipt-1" });
    assert.deepEqual(result, { ok: true, value: { ...delivered.value, diagnostics: { ...delivered.value.diagnostics, processed } } });
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=receipt-1");
    assert.equal(f.calls[0].init?.method, "GET");
    assert.equal(f.calls[0].init?.body, undefined);
    assert.equal(f.credentials.length, 1);
    assert.equal(f.state.authorityCalls, 0);
    assert.equal(JSON.stringify([result, f.observations]).includes("fixture-secret"), false);
  });
}
for (const receipt of [
  {}, null, { requestStatusPerDestination: [] },
  { requestStatusPerDestination: [{ requestStatus: "SUCCESS" }, { requestStatus: "SUCCESS" }] },
  { requestStatusPerDestination: [{ requestStatus: "SUCCESS", destination: { operatingAccount: { accountId: "9999999999" } } }] },
  { requestStatusPerDestination: [{ requestStatus: "unexpected" }] },
]) {
  test("inconclusive status body retains acceptance without confirming processing: " + JSON.stringify(receipt), async () => {
    const f = harness({ receipt });
    assert.deepEqual(await f.backend.reconcile({ ...request, receiptId: "receipt-1" }), delivered);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].init?.method, "GET");
  });
}
test("a failed status GET retains acceptance and never retries ingestion", async () => {
  const f = harness({ lostResponse: true });
  assert.deepEqual(await f.backend.reconcile({ ...request, receiptId: "receipt-1" }), delivered);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init?.method, "GET");
  assert.equal(f.state.authorityCalls, 0);
});

test("withdrawal after credential resolution prevents the single POST", async () => {
  const f = harness(); f.state.withdrawAtCredential = true;
  assert.deepEqual(await f.backend.deliver(request), failure({ code: "forbidden", message: "Google conversion authority withdrawn" }));
  assert.equal(f.credentials.length, 1); assert.equal(f.calls.length, 0);
});
test("a false current-authority fence prevents credential access", async () => {
  const f = harness(); f.state.current = false;
  const result = await f.backend.deliver(request);
  assert.equal(result.ok, false); assert.equal(f.credentials.length, 0); assert.equal(f.calls.length, 0);
});
for (const phase of ["before", "credentials"]) {
  test("cancellation at " + phase + " prevents POST", async () => {
    const f = harness(); const controller = new AbortController();
    if (phase === "before") controller.abort(); else f.state.abortAtCredential = controller;
    const result = await f.backend.deliver(request, { signal: controller.signal });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "cancelled");
    assert.equal(f.calls.length, 0);
  });
}

test("credential and transport failure text never echoes a token", async () => {
  const f = harness(); f.state.credentialFailure = true;
  const result = await f.backend.deliver(request);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes("fixture-token-secret"), false);
  assert.equal(f.calls.length, 0);
  const malformed = harness(); malformed.state.token = "fixture-token-secret\r\nInjected";
  assert.deepEqual(await malformed.backend.deliver(request), unknown);
  assert.equal(malformed.calls.length, 0);
});

test("stale and mismatched grants fail before effects", async () => {
  for (const grant of [
    { ...request.grant, revoked: true }, { ...request.grant, expiresAt: fixtureTime },
    { ...request.grant, accountId: "9999999999" }, { ...request.grant, connectionId: "foreign" },
    { ...request.grant, destination: "other" }, { ...request.grant, purpose: "other" },
    { ...request.grant, scope: { ...binding.scope, ownerId: "foreign" } },
  ]) {
    const f = harness(); const result = await f.backend.deliver({ ...request, grant });
    assert.equal(result.ok, false); assert.equal(f.credentials.length, 0); assert.equal(f.calls.length, 0);
  }
});
test("malformed known identifiers and future times fail even alongside valid identifiers", async () => {
  for (const invalid of [
    { ...event, identifiers: { ...event.identifiers, email: "raw@example.test" } },
    { ...event, identifiers: { ...event.identifiers, phone: "+15551234567" } },
    { ...event, identifiers: { ...event.identifiers, email: "E".repeat(64) } },
    { ...event, identifiers: { ...event.identifiers, gclid: "bad click" } },
    { ...event, identifiers: { ...event.identifiers, gclid: "a".repeat(257) } },
    { ...event, occurredAt: fixtureTime + 1 }, { ...event, occurredAt: -1 },
  ]) {
    const f = harness(); assert.equal((await f.backend.deliver({ ...request, event: invalid })).ok, false);
    assert.equal(f.calls.length, 0); assert.equal(f.credentials.length, 0);
  }
});
test("malformed conversion settings, foreign context and missing deliveryId have no effects", async () => {
  for (const settings of [{}, { conversionConfiguration: { actionIds: {} } }, { conversionConfiguration: { actionIds: { signup: "bad" } } }]) {
    const f = harness({ configuration: { ...configuration, settings } });
    assert.equal((await f.backend.deliver(request)).ok, false); assert.equal(f.credentials.length, 0); assert.equal(f.calls.length, 0);
  }
  const f = harness();
  assert.equal((await f.backend.deliver({ ...request, context: { ...request.context, scope: { ...binding.scope, ownerId: "foreign" } } })).ok, false);
  const { deliveryId: _deliveryId, ...missingId } = request;
  assert.equal((await f.backend.deliver(missingId as Input)).ok, false);
  assert.equal(f.calls.length, 0);
});
test("Data Manager rejects a Search-only HTTP port before ingestion", async () => {
  let lookups = 0;
  const transport = createGoogleRestTransport({ binding, credentials: { async access() { lookups += 1; return success({ value: { accessToken: "fixture-token" } }); } }, http: { async post() { assert.fail("No ingress permitted"); } } });
  assert.equal((await transport.request({ method: "ingest", body: {}, cloudProjectId: "fixture-project", context: fixtureContext, operationId: "test" })).ok, false);
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
    assert.equal((await transport.request({ method: "ingest", body: { validateOnly: true }, cloudProjectId: "fixture-project", context: fixtureContext, operationId: "fixture" })).ok, true);
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
