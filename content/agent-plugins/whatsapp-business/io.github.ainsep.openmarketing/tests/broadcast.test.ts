import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { sendMessage as deliver, messageChannel } from "../src/index.js";
import { approvedTemplate, broadcastFixture, context, fixtureRates, now } from "./fixtures.js";
import { maximumRate } from "../src/rates.js";
import type { Rates } from "../src/rates.js";
const intent = { context, deliveryId: "delivery", recipient: "+15555550100",
  message: { template: { name: "fixture", language: "en_US", bodyParameters: ["fixture"] } } };
const changedIntent = { ...intent, message: { template: { ...intent.message.template, bodyParameters: ["changed"] } } };

it("declares the WhatsApp consent/suppression channel", () => {
  expect(messageChannel).toBe("whatsapp");
});

describe("primary-evidence rate selection (synthetic amounts)", () => {
  it.each([
    ["15555550100", "marketing", 40001n, "max"],
    ["18095550100", "marketing", 40001n, "1809"],
    ["18295550100", "utility", 50000n, "1829"],
    ["18495550100", "authentication", 60000n, "1849"],
    ["15555550100", "authentication", 60000n, "max"],
    ["18765550100", "marketing", 40001n, "max"],
    ["447700900000", "marketing", 40001n, "max"],
  ] as const)("selects %s / %s", (digits, category, micros, matchedPrefix) => {
    expect(maximumRate({ digits, category }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { micros, matchedPrefix } });
  });
  it("refuses empty, missing-category and malformed evidence without echoing it", () => {
    const invalidRates: Rates[] = [{}, { "North America": { utility: "0.01" } }, { "North America": { marketing: "synthetic-secret" } },
      { "North America": { marketing: "0.0000001" } }, { "North America": { marketing: "-1" } }];
    for (const rates of invalidRates) {
      const result = maximumRate({ digits: "15555550100", category: "marketing" }, { rates });
      expect(result).toMatchObject({ ok: false, error: { code: "not_implemented" } });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    }
    expect(maximumRate({ digits: "447700900000", category: "utility" }, { rates: {
      ...fixtureRates, incomplete: { marketing: "0.01" },
    } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(maximumRate({ digits: "15555550100", category: "marketing" })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(maximumRate({ digits: "15555550100", category: "authentication" }, { rates: {
      "North America": { authentication: "0.010000", authenticationInternational: "0.001000" },
    } })).toMatchObject({ ok: true, value: { micros: 10000n, rateString: "0.010000" } });
  });
});
for (const transport of ["memory", "http"] as const) {
  describe(transport + " template send", () => {
    it("submits once, propagates context and retains a stable durable delivery identity", async () => {
      const f = broadcastFixture({ transport, repeatExecute: true });
      const first = await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates });
      expect(first).toMatchObject({ ok: true, value: { status: "accepted", deliveryId: "delivery" } });
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toEqual(first);
      expect(f.calls).toHaveLength(1);
      expect(f.state.credentials).toBe(2); expect(f.reads).toHaveLength(4);
      expect(f.calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
      const authorization = new Headers(f.calls[0]!.init?.headers).get("Authorization");
      expect(authorization).toBe("Bearer synthetic-secret");
      expect(authorization).not.toContain("{"); expect(authorization).not.toContain("app-secret");
      expect(f.observations).toContainEqual(expect.objectContaining({ operation: "whatsapp-business.send", correlationId: "correlation", traceId: "trace", runId: "run" }));
      expect(f.repeatOutcomes).toEqual([{ ok: false, error: { code: "conflict", message: "WhatsApp delivery conflict", retryable: false } }]);
    });
    it("still requires server consent authority without a configuration admission flag", async () => {
      const f = broadcastFixture({ transport });
      expect(f.dependencies.configuration).not.toHaveProperty("admitted");
      f.state.consent = false;
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.state.authority).toBe(1); expect(f.calls).toHaveLength(0);
      f.state.consent = true;
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true });
      expect(f.state.authority).toBe(2); expect(f.calls).toHaveLength(1);
    });
    it("wires the synthetic authority denial after credentials without a POST", async () => {
      const f = broadcastFixture({ transport, credentialHook: () => { f.state.consent = false; } });
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false });
      expect(f.state.credentials).toBe(1); expect(f.state.authority).toBe(1); expect(f.calls).toHaveLength(0);
      for (const denied of ["paid", "grant"] as const) {
        const g = broadcastFixture({ transport }); g.state[denied] = false;
        expect(await deliver({ ...intent, dependencies: g.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false });
        expect(g.calls).toHaveLength(0);
      }
      const h = broadcastFixture({ transport }); h.suppression.add(intent.recipient);
      expect(await deliver({ ...intent, dependencies: h.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false });
      expect(h.calls).toHaveLength(0);
    });
    it("retains uncertainty across malformed success, provider failure and acknowledgement failure", async () => {
      for (const status of [200, 503]) {
        const f = broadcastFixture({ transport, response: () => Response.json({}, { status }) });
        expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "unknown" } });
        expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "unknown" } });
        expect(f.calls).toHaveLength(1);
      }
      const f = broadcastFixture({ transport, throwAfterExecute: true });
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(f.calls).toHaveLength(1);
    });
    it("rejects invalid destinations, changed intent under the same key and cross-workspace calls", async () => {
      const f = broadcastFixture({ transport });
      expect(await deliver({ ...intent, recipient: "invalid", dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false });
      expect(await deliver({ ...intent, context: { ...context, scope: { ownerId: "owner", workspaceId: "foreign" } }, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false });
      expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
      await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates });
      expect(await deliver({ ...changedIntent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false });
      expect(f.calls).toHaveLength(1);
    });
    it("cancels before credentials and reports a timed-out submission as unknown", async () => {
      const f = broadcastFixture({ transport });
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates, signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
      const g = broadcastFixture({ transport, response: () => { throw new Error("synthetic transport failure"); } });
      expect(await deliver({ ...intent, dependencies: g.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(g.calls).toHaveLength(1);
    });
  });
}

it("returns retryable back-pressure for HTTP 429 without retrying", async () => {
  const f = broadcastFixture({ response: () => Response.json({}, { status: 429 }) });
  expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "limit_exceeded", retryable: true } });
  expect(f.calls).toHaveLength(1);
});

describe("approval and price evidence before authority", () => {
  it.each([
    { data: [{ ...approvedTemplate, status: "PENDING" }] },
    { data: [] },
    { data: [{ ...approvedTemplate, name: "another_template" }] },
    { data: [{ ...approvedTemplate, language: "fr" }] },
    { data: [approvedTemplate, { ...approvedTemplate, id: "790" }] },
    { data: [{ ...approvedTemplate, category: "UNKNOWN" }] },
    { data: [{ ...approvedTemplate, category: "marketing" }] },
    { data: [{ name: "fixture", language: "en_US" }] },
    { data: [], paging: { next: "https://untrusted.example/page", cursors: { after: "cursor" } } },
    { data: [approvedTemplate], paging: { next: "https://untrusted.example/page", cursors: { after: "cursor" } } },
    { data: Array.from({ length: 101 }, () => approvedTemplate) },
  ])("refuses absent, unapproved, ambiguous or incomplete template evidence %#", async templates => {
    const f = broadcastFixture({ templates });
    expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.reads).toHaveLength(2);
    expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it.each([{ currency: "EUR" }, {}, { currency: 123 }])("refuses unsupported or missing WABA currency %#", async account => {
    const f = broadcastFixture({ account });
    expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(f.reads).toHaveLength(1); expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it.each([
    ["+15555550100", "MARKETING", 5],
    ["+18095550100", "MARKETING", 5],
    ["+18295550100", "UTILITY", 5],
    ["+15555550100", "AUTHENTICATION", 6],
    ["+447700900000", "MARKETING", 5],
  ] as const)("quotes %s/%s at a conservative %s cents", async (recipient, category, minorUnits) => {
    const f = broadcastFixture({ templates: { data: [{ ...approvedTemplate, category }] } });
    await deliver({ ...intent, recipient, dependencies: f.dependencies }, { rates: fixtureRates });
    expect(f.authorityInputs[0]!.quote).toMatchObject({ upperBound: { currency: "USD", minorUnits }, estimated: { currency: "USD", minorUnits },
      quoteId: "delivery", status: "known", expiresAt: now + 300000 });
    expect(f.calls).toHaveLength(1);
  });
  it("uses exactly two bound GETs and one credential lookup, with a digest of the actual POST", async () => {
    const f = broadcastFixture();
    await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates });
    expect(f.state.credentials).toBe(1); expect(f.reads).toHaveLength(2);
    expect(f.reads[0]!.url).toBe("https://graph.facebook.com/v26.0/123?fields=currency");
    const url = new URL(f.reads[1]!.url);
    expect(url.pathname).toBe("/v26.0/123/message_templates");
    expect(Object.fromEntries(url.searchParams)).toEqual({ fields: "id,name,language,status,category", name: "fixture", limit: "100" });
    for (const read of f.reads) {
      expect(read.init).toMatchObject({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) });
      expect(new Headers(read.init?.headers).get("Authorization")).toBe("Bearer synthetic-secret");
    }
    expect(f.deadlines.map(deadline => deadline.timeoutMs)).toEqual([10000, 10000, 10000]);
    const request = { method: "POST", url: f.calls[0]!.url, body: f.calls[0]!.init!.body };
    expect(JSON.parse(String(request.body))).toMatchObject({ to: "15555550100", type: "template",
      template: { name: "fixture", language: { code: "en_US" }, components: [{ type: "body", parameters: [{ type: "text", text: "fixture" }] }] } });
    const authority = f.authorityInputs[0]!;
    expect(Object.keys(authority).sort()).toEqual(["argumentsDigest", "execute", "quote"]);
    expect(authority.argumentsDigest).toBe(createHash("sha256").update(JSON.stringify(request)).digest("hex"));
    expect(authority.quote.argumentsDigest).toBe(authority.argumentsDigest);
    expect(authority.quote.pricingEvidenceId).toBe(createHash("sha256").update(JSON.stringify(["2026-10-01", "max", "marketing", "0.040001"])).digest("hex"));
  });
  it("refuses empty production rates, missing categories and malformed decimals before any reservation", async () => {
    const production = broadcastFixture();
    expect(await deliver({ ...intent, dependencies: production.dependencies })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
    expect(production.state.authority).toBe(0); expect(production.calls).toHaveLength(0);
    const invalidRates: Rates[] = [{}, { "North America": { utility: "0.01" } }, { "North America": { marketing: "synthetic-secret" } }];
    for (const rates of invalidRates) {
      const f = broadcastFixture();
      expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
      expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
    }
  });
});

it("rejects free-form and nested connection/credential overrides before any I/O", async () => {
  for (const message of [{ content: "free-form" }, { ...intent.message, connectionId: "foreign" },
    { template: { ...intent.message.template, accessToken: "synthetic-secret" } },
    { template: { ...intent.message.template, bodyParameters: [{ connectionId: "foreign" }] } }]) {
    const f = broadcastFixture();
    expect(await deliver({ ...intent, message: message as typeof intent.message, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.state.credentials).toBe(0); expect(f.reads).toHaveLength(0); expect(f.calls).toHaveLength(0);
  }
});
it("rechecks credential and quote expiry and cancellation at execute", async () => {
  for (const lifetime of [1000, 300000]) {
    const f = broadcastFixture({ credential: { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: "123", phoneNumberId: "456" }),
      expiresAt: now + (lifetime === 1000 ? 1000 : 600000) }, authorityHook: () => { f.state.time += lifetime; } });
    expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false,
      error: { code: lifetime === 1000 ? "unauthenticated" : "expired" } });
    expect(f.state.authority).toBe(1); expect(f.calls).toHaveLength(0);
  }
  const controller = new AbortController();
  const f = broadcastFixture({ authorityHook: () => controller.abort() });
  expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates, signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.calls).toHaveLength(0);
});
it("never returns credential, token JSON or provider exception text", async () => {
  for (const credential of [
    { accessToken: "synthetic-secret invalid JSON" },
    { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: "foreign", phoneNumberId: "456" }) },
    { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: "123" }) },
    { accessToken: JSON.stringify({ accessToken: "synthetic-secret", wabaId: "123", phoneNumberId: "456" }), expiresAt: now },
  ]) {
    const f = broadcastFixture({ credential });
    const result = await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates });
    expect(result.ok).toBe(false); expect(f.state.authority).toBe(0); expect(f.reads).toHaveLength(0);
    expect(JSON.stringify([result, f.observations])).not.toMatch(/synthetic-secret|accessToken|app-secret|15555550100/);
  }
  const f = broadcastFixture({ readResponse: () => { throw new Error("synthetic-secret accessToken app-secret"); } });
  const result = await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates });
  expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(f.state.authority).toBe(0); expect(f.calls).toHaveLength(0);
  expect(JSON.stringify([result, f.observations])).not.toMatch(/synthetic-secret|accessToken|app-secret|15555550100/);
});
it("keeps failed and oversized response reads uncertain", async () => {
  for (const response of [
    () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("fixture read failure")); } })),
    () => new Response("x".repeat(1048576 + 1)),
  ]) {
    const f = broadcastFixture({ response });
    expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(1);
  }
});

it.each([130429, 131056])("classifies Meta throughput code %s as retryable", async code => {
  const f = broadcastFixture({ response: () => Response.json({ error: { code } }, { status: 400 }) });
  expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "limit_exceeded", retryable: true } });
  expect(f.calls).toHaveLength(1);
});
it("does not mistake malformed throughput errors for retry authority", async () => {
  const f = broadcastFixture({ response: () => Response.json({ error: { code: "130429" } }, { status: 400 }) });
  expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: false, error: { code: "forbidden", retryable: false } });
});
it("matches contacts.input when WhatsApp normalizes the accepted wa_id", async () => {
  const f = broadcastFixture({ response: () => Response.json({ messaging_product: "whatsapp", contacts: [{ input: intent.recipient.slice(1), wa_id: "5215555550100" }], messages: [{ id: "wamid.normalized" }] }) });
  expect(await deliver({ ...intent, dependencies: f.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "accepted", providerMessageId: "wamid.normalized" } });
  const g = broadcastFixture({ response: () => Response.json({ messaging_product: "whatsapp", contacts: [{ input: "15555550999", wa_id: intent.recipient.slice(1) }], messages: [{ id: "wamid.foreign" }] }) });
  expect(await deliver({ ...intent, dependencies: g.dependencies }, { rates: fixtureRates })).toMatchObject({ ok: true, value: { status: "unknown" } });
});
