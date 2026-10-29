import { expect, it } from "vitest";
import { createPinterestCapiBackend } from "../src/index.js";
import type { PinterestCapiConfiguration } from "../src/index.js";
import { capiConfiguration, capiFixture, conversionRequest, deny, deploymentFixture, now } from "./fixtures.js";
import { conversionAuthoritySuite } from "./contract/dispatch-suite.js";

conversionAuthoritySuite({ name: "memory authority / real plugin transport", makeFixture: capiFixture });
it("sends unchanged event ID/hash, exact seconds and explicit signup/source mapping", async () => {
  const f = capiFixture();
  expect(await f.backend.deliver(conversionRequest)).toEqual({ ok: true, value: { status: "delivered" } });
  expect(f.calls[0]).toMatchObject({ url: "https://api.pinterest.com/v5/ad_accounts/123/events", init: { method: "POST", redirect: "error", headers: { Authorization: "Bearer synthetic-secret" } } });
  const payload: unknown = JSON.parse(String(f.calls[0].init.body));
  expect(payload).toEqual({ data: [{ event_name: "signup", action_source: "web", event_id: "event", event_time: 1792799999, event_source_url: "https://example.test/signup", opt_out: false, user_data: { em: ["a".repeat(64)] } }] });
  expect(f.dispatches[0].payload).toEqual(payload);
  expect(JSON.stringify({ dispatches: f.dispatches, observations: f.observations })).not.toContain("synthetic-secret");
  expect(f.observations[0]).toMatchObject({ operation: "pinterest-ads.http", correlationId: "correlation", traceId: "trace" });
});

it.each([
  { connectionId: "foreign" }, { accountId: "999" }, { destination: "foreign" }, { purpose: "foreign" }, { payloadSchema: "foreign" },
  { payloadVersion: 2 }, { definitionIds: ["foreign"] }, { revoked: true }, { expiresAt: now }, { scope: { ownerId: "foreign", workspaceId: "workspace" } },
])("denies invalid/mismatched grant before credentials %j", async patch => {
  const f = capiFixture();
  const input = { ...conversionRequest, grant: { ...conversionRequest.grant, ...patch } } as typeof conversionRequest;
  expect((await f.backend.deliver(input)).ok).toBe(false); expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
});
it.each([
  { occurredAt: now + 1000 }, { occurredAt: now - 86400001 }, { occurredAt: now - 1 }, { identifiers: { email: "raw@example.test" } },
  { identifiers: { email: "a".repeat(64), phone: "b".repeat(64) } }, { purpose: "foreign" }, { destination: "foreign" }, { definitionId: "unmapped" },
])("rejects tainted, unsupported or stale events %j", async patch => {
  const f = capiFixture();
  expect((await f.backend.deliver({ ...conversionRequest, event: { ...conversionRequest.event, ...patch } })).ok).toBe(false);
  expect(f.state.credentials).toBe(0); expect(f.calls).toHaveLength(0);
});
const unsupportedConfigurations: Partial<PinterestCapiConfiguration>[] = [
  { conversionRules: {} }, { conversionRules: { other: { eventName: "signup", sourceUrl: "https://example.test/signup" } } },
  { conversionRules: { definition: { eventName: "signup", sourceUrl: "http://example.test/signup" } } }, { mode: "read-only" }, { mode: "local-sandbox" },
];
it.each(unsupportedConfigurations)("fails closed on missing mappings, unverified source or unsupported mode %j", async patch => {
  const f = capiFixture({ configuration: { ...capiConfiguration, ...patch } });
  expect((await f.backend.deliver(conversionRequest)).ok).toBe(false); expect(f.calls).toHaveLength(0); expect(f.state.credentials).toBe(0);
});
it.each([
  { num_events_received: 1, num_events_processed: 0, events: [{ status: "failed" }] },
  { num_events_received: 1, num_events_processed: 1, events: [{ status: "failed" }] },
  { num_events_received: 1, num_events_processed: 1, events: [{ status: "processed", error_message: "synthetic-secret" }] },
  { num_events_received: 2, num_events_processed: 1, events: [{ status: "processed" }, { status: "failed" }] },
  { num_events_received: 1, num_events_processed: 1 }, {},
])("requires a successful per-event processing acknowledgement %j", async body => {
  const f = capiFixture({ response: () => Response.json(body) });
  expect(await f.backend.deliver(conversionRequest)).toEqual({ ok: true, value: { status: "unknown" } });
  expect(await f.backend.reconcile(conversionRequest)).toEqual({ ok: true, value: { status: "unknown" } });
  expect(f.calls).toHaveLength(1); expect(f.state.credentials).toBe(1);
});
it.each(["malformed", "x".repeat(1048577), "lost", "throttle"]) ("does not resend uncertain delivery (%s)", async mode => {
  const f = capiFixture({ response: () => {
    if (mode === "lost") throw new Error("synthetic-secret");
    if (mode === "throttle") return Response.json({ error: "synthetic-secret" }, { status: 429 });
    return new Response(mode);
  } });
  expect(await f.backend.deliver(conversionRequest)).toEqual({ ok: true, value: { status: "unknown" } });
  expect(await f.backend.reconcile(conversionRequest)).toEqual({ ok: true, value: { status: "unknown" } });
  expect((await f.backend.deliver(conversionRequest)).ok).toBe(false); expect(f.calls).toHaveLength(1);
});
it("rechecks current fence after token lookup and rejects a repeated authority callback", async () => {
  const denied = capiFixture({ authority: { async dispatch(input) { return input.execute({ isCurrent: () => false }); } } });
  expect(await denied.backend.deliver(conversionRequest)).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(denied.calls).toHaveLength(0);
  const repeated = capiFixture({ authority: { async dispatch(input) {
    expect(await input.execute({ isCurrent: () => true })).toEqual({ ok: true, value: { status: "delivered" } });
    return input.execute({ isCurrent: () => true });
  } } });
  expect(await repeated.backend.deliver(conversionRequest)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(repeated.calls).toHaveLength(1);
});
it("keeps exact private bytes when caller and host mutate their copies during awaits", async () => {
  const input = structuredClone(conversionRequest);
  const f = capiFixture({ credentialHook: () => { input.event.eventId = "mutated"; input.event.identifiers.email = "c".repeat(64); }, authority: { async dispatch(call) {
    call.payload.data[0].event_id = "host-mutated"; call.configuration.conversionRules.definition.sourceUrl = "https://other.test/";
    return call.execute({ isCurrent: () => true });
  } } });
  expect(await f.backend.deliver(input)).toEqual({ ok: true, value: { status: "delivered" } });
  expect(JSON.parse(String(f.calls[0].init.body))).toMatchObject({ data: [{ event_id: "event", user_data: { em: ["a".repeat(64)] }, event_source_url: "https://example.test/signup" }] });
});
it("bounds input and honours cancellation before credentials, including after token lookup", async () => {
  const f = capiFixture();
  expect((await f.backend.deliver({ ...conversionRequest, event: { ...conversionRequest.event, eventId: "x".repeat(65536) } })).ok).toBe(false);
  expect((await f.backend.deliver(conversionRequest, { signal: AbortSignal.abort() })).ok).toBe(false); expect(f.state.credentials).toBe(0);
  const controller = new AbortController(), cancelled = capiFixture({ credentialHook: () => controller.abort() });
  expect(await cancelled.backend.deliver(conversionRequest, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } }); expect(cancelled.calls).toHaveLength(0);
});
it("never sends on broker/authority denial and preserves unknown after post-dispatch authority faults", async () => {
  const f = deploymentFixture();
  const backend = createPinterestCapiBackend({ ...f.dependencies, configuration: capiConfiguration, credentials: { access: async () => deny() }, authority: { dispatch: async () => deny() } });
  expect((await backend.deliver(conversionRequest)).ok).toBe(false); expect(f.calls).toHaveLength(0);
  const broken = capiFixture({ authority: { async dispatch(call) { await call.execute({ isCurrent: () => true }); throw new Error("host persistence failed"); } } });
  expect(await broken.backend.deliver(conversionRequest)).toEqual({ ok: true, value: { status: "unknown" } }); expect(broken.calls).toHaveLength(1);
});
