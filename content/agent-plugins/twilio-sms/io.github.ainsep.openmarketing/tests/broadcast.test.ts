import { describe, expect, it } from "vitest";
import { sendMessage as deliver } from "../src/index.js";
import { broadcastFixture, context } from "./fixtures.js";
const intent = { context, deliveryId: "delivery", recipient: "+15555550100",
  message: { content: "Fixture SMS. Reply STOP to opt out." } };
const changedIntent = { ...intent, message: { content: "Changed message" } };
for (const transport of ["memory", "http"] as const) {
  describe(transport + " recipient dispatch", () => {
    it("submits once, propagates context and retains a stable durable delivery identity", async () => {
      const f = broadcastFixture({ transport, repeatExecute: true });
      const first = await deliver({ ...intent, dependencies: f.dependencies });
      expect(first).toMatchObject({ ok: true, value: { status: "accepted", deliveryId: "delivery" } });
      expect(await deliver({ ...intent, dependencies: f.dependencies })).toEqual(first);
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
      expect(f.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace", runId: "run" }));
    });
    it("still requires server consent authority without a configuration admission flag", async () => {
      const f = broadcastFixture({ transport });
      expect(f.dependencies.configuration).not.toHaveProperty("admitted");
      f.state.consent = false;
      expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.state.authority).toBe(1); expect(f.calls).toHaveLength(0);
      f.state.consent = true;
      expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: true });
      expect(f.state.authority).toBe(2); expect(f.calls).toHaveLength(1);
    });
    it("denies after credentials and pricing without a Messages POST", async () => {
      const f = broadcastFixture({ transport, credentialHook: () => { f.state.consent = false; } });
      expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: false });
      expect(f.state.credentials).toBe(1); expect(f.state.authority).toBe(1); expect(f.calls).toHaveLength(0);
      for (const denied of ["paid", "grant", "approvedTemplate"] as const) {
        const g = broadcastFixture({ transport }); g.state[denied] = false;
        expect(await deliver({ ...intent, dependencies: g.dependencies })).toMatchObject({ ok: false });
        expect(g.calls).toHaveLength(0);
      }
      const h = broadcastFixture({ transport }); h.suppression.add(intent.recipient);
      expect(await deliver({ ...intent, dependencies: h.dependencies })).toMatchObject({ ok: false });
      expect(h.calls).toHaveLength(0);
    });
    it("retains uncertainty across malformed success, provider failure and acknowledgement failure", async () => {
      for (const status of [200, 503]) {
        const f = broadcastFixture({ transport, response: () => Response.json({}, { status }) });
        expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: true, value: { status: "unknown" } });
        expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: true, value: { status: "unknown" } });
        expect(f.calls).toHaveLength(1);
      }
      const f = broadcastFixture({ transport, throwAfterExecute: true });
      expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(f.calls).toHaveLength(1);
    });
    it("rejects invalid destinations, changed intent under the same key and cross-workspace calls", async () => {
      const f = broadcastFixture({ transport });
      expect(await deliver({ ...intent, recipient: "invalid", dependencies: f.dependencies })).toMatchObject({ ok: false });
      expect(await deliver({ ...intent, context: { ...context, scope: { ownerId: "owner", workspaceId: "foreign" } }, dependencies: f.dependencies })).toMatchObject({ ok: false });
      expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
      await deliver({ ...intent, dependencies: f.dependencies });
      expect(await deliver({ ...changedIntent, dependencies: f.dependencies })).toMatchObject({ ok: false });
      expect(f.calls).toHaveLength(1);
    });
    it("cancels before credentials and reports a timed-out submission as unknown", async () => {
      const f = broadcastFixture({ transport });
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
      const g = broadcastFixture({ transport, response: () => { throw new Error("synthetic transport failure"); } });
      expect(await deliver({ ...intent, dependencies: g.dependencies })).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(g.calls).toHaveLength(1);
    });
  });
}

it("rejects malformed card JSON before authority without exposing credentials", async () => {
  const f = broadcastFixture();
  f.dependencies.credentials.access = async () => ({ ok: true, value: { accessToken: "not json fixture-secret" } });
  const result = await deliver({ ...intent, dependencies: f.dependencies });
  expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain("secret");
});
it("returns retryable back-pressure for HTTP 429 without retrying", async () => {
  const f = broadcastFixture({ response: () => Response.json({}, { status: 429 }) });
  expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: false, error: { code: "limit_exceeded", retryable: true } });
  expect(f.calls).toHaveLength(1);
});
it("keeps failed and oversized response reads uncertain", async () => {
  for (const response of [
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture read failure")); } })),
    () => new Response("x".repeat(65536 + 1)),
  ]) {
    const f = broadcastFixture({ response });
    expect(await deliver({ ...intent, dependencies: f.dependencies })).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(1);
  }
});

it("quotes the largest carrier/number-type rate, rounds up cents and adds headroom per UCS-2 segment", async () => {
  const f = broadcastFixture({ pricing: { price_unit: "USD", outbound_sms_prices: [
    { prices: [{ current_price: "0.0083" }, { current_price: "0.010001" }] },
    { prices: [{ current_price: "0.009" }] },
  ] } });
  expect(await deliver({ ...intent, message: { content: "😀".repeat(68) }, dependencies: f.dependencies })).toMatchObject({ ok: true });
  expect(f.quotes[0]).toMatchObject({ status: "known", estimated: { currency: "USD", minorUnits: 9 },
    upperBound: { currency: "USD", minorUnits: 9 }, quoteId: intent.deliveryId, expiresAt: 1792886700000 });
  expect(f.quotes[0]!.argumentsDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(f.quotes[0]!.pricingEvidenceId).toMatch(/^[a-f0-9]{64}$/);
  expect(f.reads.map(call => call.url)).toEqual([
    "https://lookups.twilio.com/v2/PhoneNumbers/%2B15555550100", "https://pricing.twilio.com/v1/Messaging/Countries/US",
  ]);
  expect(new URLSearchParams(String(f.calls[0]!.init!.body)).has("StatusCallback")).toBe(false);
});
it("quotes whole graphemes conservatively and refuses oversized graphemes before pricing", async () => {
  const pricing = { price_unit: "USD", outbound_sms_prices: [
    { prices: [{ current_price: "0.0083" }, { current_price: "0.010001" }] },
    { prices: [{ current_price: "0.009" }] },
  ] };
  for (const [content, expected] of [
    ["😀".repeat(67), 9],
    ["😀".repeat(35), 3],
    [("a" + "\u0301".repeat(39)).repeat(3), 9],
  ] as const) {
    const f = broadcastFixture({ pricing });
    expect(await deliver({ ...intent, message: { content }, dependencies: f.dependencies })).toMatchObject({ ok: true });
    expect(f.quotes[0]!.upperBound!.minorUnits).toBe(expected);
  }
  const f = broadcastFixture({ pricing });
  expect(await deliver({ ...intent, message: { content: "a" + "\u0301".repeat(66) }, dependencies: f.dependencies }))
    .toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.reads).toHaveLength(0);
  expect(f.state.authority).toBe(0);
  expect(f.calls).toHaveLength(0);
});
it("refuses non-USD, invalid lookup and malformed prices before authority and POST", async () => {
  for (const overrides of [
    { lookup: { valid: false, phone_number: intent.recipient, country_code: "US" } },
    { lookup: { valid: true, phone_number: "+15555550199", country_code: "US" } },
    { pricing: { price_unit: "EUR", outbound_sms_prices: [{ prices: [{ current_price: "0.01" }] }] } },
    { pricing: { price_unit: "USD", outbound_sms_prices: [{ prices: [{ current_price: "fixture-secret" }] }] } },
  ]) {
    const f = broadcastFixture(overrides);
    const result = await deliver({ ...intent, dependencies: f.dependencies });
    expect(result.ok).toBe(false); expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(JSON.stringify(result)).not.toContain(intent.recipient);
  }
});
it("keeps definitive 4xx refusals distinct from ambiguous receipts without leaking provider text", async () => {
  for (const status of [400, 401, 403]) {
    const f = broadcastFixture({ response: () => Response.json({ message: "fixture-secret " + intent.recipient }, { status }) });
    const result = await deliver({ ...intent, dependencies: f.dependencies });
    expect(result).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("fixture-secret"); expect(JSON.stringify(result)).not.toContain(intent.recipient);
  }
});
it("refuses failed or oversized pricing reads without a POST", async () => {
  for (const response of [
    () => Response.json({}, { status: 503 }), () => new Response("x".repeat(65537)),
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("secret " + intent.recipient)); } })),
  ]) {
    const f = broadcastFixture();
    const dependencies = { ...f.dependencies, fetch: async () => response() };
    expect(await deliver({ ...intent, dependencies })).toMatchObject({ ok: false });
    expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
  }
});
