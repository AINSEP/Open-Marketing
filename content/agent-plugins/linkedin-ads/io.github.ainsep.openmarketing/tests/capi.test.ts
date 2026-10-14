import { describe, expect, it } from "vitest";
import type { LinkedInCapiRequest, LinkedInCapiConfiguration } from "../src/index.js";
import { capiConfiguration, capiFixture, conversionInput, now } from "./fixtures.js";
import { conversionDispatchSuite } from "./contract/dispatch-suite.js";

conversionDispatchSuite({ name: "Memory host with real LinkedIn plugin transport", makeFixture: () => capiFixture() });

describe("server-only LinkedIn conversion delivery", () => {
  it.each(["consent", "grant", "connection", "production", "admitted"] as const)("rechecks current %s after token resolution", field => {
    const f = capiFixture({ credentialHook: () => { f.capiState[field] = false; } });
    return f.backend.deliver(conversionInput()).then(output => {
      expect(output).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.credentialCalls).toHaveLength(1); expect(f.calls).toHaveLength(0);
    });
  });
  it("checks the synchronous live fence immediately before fetch", async () => {
    const f = capiFixture({ authorityHook: () => { f.capiState.consent = false; } });
    expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.dispatches).toHaveLength(1); expect(f.calls).toHaveLength(0);
  });
  it("passes the exact reviewed payload to authority and preserves it if the caller mutates pending inputs", async () => {
    const input = conversionInput();
    const f = capiFixture({ credentialHook: () => { input.event.identifiers.email = "c".repeat(64); input.event.eventId = "changed"; } });
    expect(await f.backend.deliver(input)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual(f.dispatches[0].payload);
    expect(f.dispatches[0].payload.user.userIds[0]).toEqual({ idType: "SHA256_EMAIL", idValue: "a".repeat(64) });
    expect(f.dispatches[0].payload.eventId).toBe("om-event");
  });
  it.each([
    { email: "person@example.com" }, { email: "A".repeat(64) }, { email: "a".repeat(63) },
    { email: "a".repeat(64), phone: "b".repeat(64) }, { phone: "b".repeat(64) },
    { email: "a".repeat(64), linkedin_first_party_ads_tracking_uuid: "uuid" },
  ])("rejects raw, uppercase, partial and unsupported identifiers before any I/O", async identifiers => {
    const f = capiFixture(); const input = conversionInput();
    expect(await f.backend.deliver({ ...input, event: { ...input.event, identifiers } } as unknown as LinkedInCapiRequest)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
  });
  it("requires the committed digest key to match the accepted identifier key", async () => {
    const f = capiFixture(); const input = conversionInput();
    expect(await f.backend.deliver({ ...input, event: { ...input.event, identifierDigests: { phone: "b".repeat(64) } } } as unknown as LinkedInCapiRequest)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0);
  });
  it.each(["local-sandbox", "read-only"] as const)("denies conversions in %s mode before credentials", async mode => {
    const f = capiFixture({ configuration: { ...capiConfiguration, mode } });
    expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it.each([now - 90 * 86400000 - 1, now + 1])("rejects old/future event %s before egress", async occurredAt => {
    const f = capiFixture(); const input = conversionInput(); input.event.occurredAt = occurredAt;
    expect(await f.backend.deliver(input)).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(f.credentialCalls).toHaveLength(0);
  });
  it("accepts the exact 90-day boundary without converting milliseconds to seconds", async () => {
    const f = capiFixture(); const input = conversionInput(); input.event.occurredAt = now - 90 * 86400000;
    expect(await f.backend.deliver(input)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(JSON.parse(String(f.calls[0].init.body)).conversionHappenedAt).toBe(input.event.occurredAt);
  });
  it("rechecks event age, grant expiry and token expiry after credential delays", async () => {
    const old = conversionInput(); old.event.occurredAt = now - 90 * 86400000;
    const age = capiFixture({ credentialHook: () => { age.state.time++; } });
    expect(await age.backend.deliver(old)).toMatchObject({ ok: false, error: { code: "expired" } });
    const grant = capiFixture({ credentialHook: () => { grant.state.time += 60000; } });
    expect(await grant.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const token = capiFixture({ credential: { accessToken: "synthetic-secret", expiresAt: now }, });
    expect(await token.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "expired" } });
    expect([age.calls.length, grant.calls.length, token.calls.length]).toEqual([0, 0, 0]);
  });
  it.each([
    { connectionId: "other" }, { accountId: "456" }, { scope: { ownerId: "other", workspaceId: "workspace" } },
    { definitionIds: ["trial"] }, { purpose: "other" }, { destination: "other" },
    { payloadSchema: "other" }, { revoked: true }, { expiresAt: now },
  ])("denies mismatched/revoked/expired grants before lookup", async changed => {
    const f = capiFixture(); const input = conversionInput();
    expect(await f.backend.deliver({ ...input, grant: { ...input.grant, ...changed } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
  it("rejects foreign context, unknown definition, oversized input and inflated conversion metadata", async () => {
    const f = capiFixture(); const input = conversionInput();
    expect(await f.backend.deliver({ ...input, context: { ...input.context, scope: { ownerId: "foreign", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await f.backend.deliver({ ...input, grant: { ...input.grant, definitionIds: ["unmapped"] }, event: { ...input.event, definitionId: "unmapped" } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await f.backend.deliver({ ...input, extra: "x".repeat(65536) } as unknown as LinkedInCapiRequest)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(await f.backend.deliver({ ...input, event: { ...input.event, userInfo: { firstName: "raw" } } } as unknown as LinkedInCapiRequest)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0);
  });
  it.each([{}, { signup: "urn:li:conversion:789" }])("rejects invalid definition mappings without I/O", async conversionRules => {
    const f = capiFixture({ configuration: { ...capiConfiguration, conversionRules } as LinkedInCapiConfiguration });
    expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(f.credentialCalls).toHaveLength(0);
  });
  it("bounds configured rule mappings and grant definition batches before token lookup", async () => {
    const rules = Object.fromEntries(Array.from({ length: 101 }, (_, index) => ["definition-" + index, "urn:lla:llaPartnerConversion:789"]));
    const f = capiFixture({ configuration: { ...capiConfiguration, conversionRules: rules } });
    expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const g = capiFixture(); const input = conversionInput();
    input.grant.definitionIds = ["signup", ...Array.from({ length: 16 }, (_, index) => "other-" + index)];
    expect(await g.backend.deliver(input)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect([f.credentialCalls.length, g.credentialCalls.length]).toEqual([0, 0]);
  });
  it("cancels before lookup and after credentials without reaching fetch", async () => {
    const controller = new AbortController(); controller.abort();
    const f = capiFixture();
    expect(await f.backend.deliver(conversionInput(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const second = new AbortController(); const g = capiFixture({ credentialHook: () => second.abort() });
    expect(await g.backend.deliver(conversionInput(), { signal: second.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(f.credentialCalls).toHaveLength(0); expect(g.calls).toHaveLength(0);
  });
  it.each([400, 401, 403, 409, 429])("returns sanitized non-retryable vendor rejection %s", async status => {
    const f = capiFixture({ response: () => new Response("synthetic-secret", { status }) });
    const result = await f.backend.deliver(conversionInput());
    expect(result).toMatchObject({ ok: false, error: { retryable: false } });
    expect(f.calls).toHaveLength(1); expect(JSON.stringify({ result, observations: f.observations })).not.toContain("synthetic-secret");
  });
  it.each([
    () => new Response(null, { status: 500 }), () => new Response(null, { status: 200 }),
    () => new Response("not JSON", { status: 201 }), () => new Response("x".repeat(1048577), { status: 201 }),
    () => { throw new Error("synthetic-secret timeout"); },
  ])("retains unknown delivery and never blindly retries a claimed event", async response => {
    const f = capiFixture({ response });
    expect(await f.backend.deliver(conversionInput())).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await f.backend.deliver(conversionInput())).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(1);
    expect(JSON.stringify(f.observations)).not.toContain("synthetic-secret");
  });
  it("cannot send twice even if a faulty authority invokes its callback twice", async () => {
    const f = capiFixture({ authority: { async dispatch(input) { await input.execute({ isCurrent: () => true }); return input.execute({ isCurrent: () => true }); } } });
    expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(f.calls).toHaveLength(1);
  });
  it("deduplicates concurrent deliveries before either can send a second request", async () => {
    const f = capiFixture();
    const results = await Promise.all([f.backend.deliver(conversionInput()), f.backend.deliver(conversionInput())]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(f.calls).toHaveLength(1);
  });
  it("redacts credential/authority errors, handles a throwing fence and preserves post-send uncertainty", async () => {
    const credentials = capiFixture({ credential: { accessToken: "bad\r\nsynthetic-secret" } });
    expect((await credentials.backend.deliver(conversionInput())).ok).toBe(false); expect(credentials.calls).toHaveLength(0);
    const before = capiFixture({ authority: { async dispatch() { throw new Error("synthetic-secret"); } } });
    expect(await before.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const fence = capiFixture({ authority: { async dispatch(input) { return input.execute({ isCurrent: () => { throw new Error("synthetic-secret"); } }); } } });
    expect(await fence.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const after = capiFixture({ authority: { async dispatch(input) { await input.execute({ isCurrent: () => true }); throw new Error("synthetic-secret"); } } });
    expect(await after.backend.deliver(conversionInput())).toEqual({ ok: true, value: { status: "unknown" } });
    expect([before.calls.length, fence.calls.length, after.calls.length]).toEqual([0, 0, 1]);
  });
  it("keeps a delivery receipt despite telemetry failure and emits only context IDs normally", async () => {
    const f = capiFixture({ observerThrows: true });
    expect(await f.backend.deliver(conversionInput())).toEqual({ ok: true, value: { status: "delivered" } });
    const g = capiFixture(); await g.backend.deliver(conversionInput());
    expect(g.observations).toEqual([{ operation: "linkedin-ads.capi", outcome: "delivered", correlationId: "correlation", traceId: "trace" }]);
    expect(JSON.stringify(g.observations)).not.toContain("a".repeat(64));
  });
  it("reconciles to unknown without token lookup, authority dispatch or vendor resend", async () => {
    const f = capiFixture();
    expect(await f.backend.reconcile(conversionInput())).toEqual({ ok: true, value: { status: "unknown" } });
    expect(f.credentialCalls).toHaveLength(0); expect(f.dispatches).toHaveLength(0); expect(f.calls).toHaveLength(0);
  });
});
