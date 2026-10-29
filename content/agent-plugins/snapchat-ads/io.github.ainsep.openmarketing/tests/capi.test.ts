import { describe, expect, it } from "vitest";
import { createSnapchatCapiBackend } from "../src/index.js";
import type { SnapchatCapiConfiguration, SnapchatCapiDependencies, SnapchatCapiRequest } from "../src/index.js";
const account = "11111111-1111-1111-1111-111111111111", pixel = "22222222-2222-2222-2222-222222222222";
const scope = { ownerId: "owner", workspaceId: "workspace" }, now = 1790812800000;
const configuration: SnapchatCapiConfiguration = { scope, accountId: account, connectionId: "connection", currency: "USD", timezone: "UTC", apiVersion: "v1", pluginDigest: "a".repeat(64),
  mode: "production-server", pixelId: pixel, pixelAccountId: account, destination: "snapchat-offline", purpose: "measurement", payloadSchema: "offline-signup-v1", definition: { id: "offline-signup", actionSource: "OFFLINE", eventName: "SIGN_UP" } };
const request: SnapchatCapiRequest = { context: { scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" }, deliveryId: "delivery",
  event: { eventId: "event", definitionId: "offline-signup", subjectId: "subject", destination: "snapchat-offline", purpose: "measurement", occurredAt: now - 1000,
    identifiers: { email: "b".repeat(64) }, identifierDigests: { email: "c".repeat(64) } },
  grant: { kind: "measurement", grantId: "grant", scope, connectionId: "connection", accountId: account, definitionIds: ["offline-signup"], destination: "snapchat-offline", purpose: "measurement", payloadSchema: "offline-signup-v1", payloadVersion: 1, expiresAt: now + 10000, revoked: false } };
/** Memory measurement authority and injected fetch only; durable identity/current consent belong to host. */
function fixture(required: { config?: SnapchatCapiConfiguration; response?: () => Response; credentialHook?: () => void;
  authority?: SnapchatCapiDependencies["authority"]; expiresAt?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = [], observations: unknown[] = [], claims: unknown[] = [], delivered = new Set<string>();
  const state = { current: true }; let credentials = 0;
  const dependencies: SnapchatCapiDependencies = { configuration: required.config ?? configuration,
    credentials: { async access() { credentials++; required.credentialHook?.(); return { ok: true, value: { accessToken: "synthetic-secret", expiresAt: required.expiresAt ?? now + 10000 } }; } },
    clock: { now: () => now }, observer: { observe(event) { observations.push(event); } },
    authority: required.authority ?? { async dispatch(input) { claims.push(input); if (!state.current || delivered.has(input.deliveryId)) return { ok: false, error: { code: "forbidden", message: "Fixture denial", retryable: false } };
      delivered.add(input.deliveryId); return input.execute({ isCurrent: () => state.current }); } },
    fetch: async (url, init = {}) => { if (!state.current) throw new Error("Fixture fence revoked"); calls.push({ url: String(url), init }); return required.response?.() ?? Response.json({ status: "VALID", reason: "Events have been processed successfully." }); } };
  return { backend: createSnapchatCapiBackend(dependencies), calls, observations, claims, state, credentials: () => credentials };
}
describe("Snapchat offline SIGN_UP", () => {
  it("is inert, sends destination SHA-256 and unchanged event ID/time under one claim", async () => {
    const f = fixture(); expect(f.credentials()).toBe(0); expect(f.calls).toHaveLength(0);
    expect(await f.backend.deliver(request)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(f.calls).toHaveLength(1); const url = new URL(f.calls[0].url);
    expect(url.origin + url.pathname).toBe("https://tr.snapchat.com/v3/" + pixel + "/events"); expect(url.searchParams.get("access_token")).toBe("synthetic-secret");
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body).toEqual({ data: [{ event_name: "SIGN_UP", action_source: "OFFLINE", event_time: request.event.occurredAt, event_id: request.event.eventId, user_data: { em: [request.event.identifiers.email] } }] });
    expect(String(f.calls[0].init.body)).not.toContain(request.event.identifierDigests.email); expect(f.calls[0].init.redirect).toBe("error"); expect(f.calls[0].init.signal).toBeDefined();
    expect(JSON.stringify(f.observations)).not.toContain("synthetic-secret"); expect(f.claims).toHaveLength(1);
  });

  it.each([
    { event: { ...request.event, definitionId: "ordinary-web-signup" } }, { event: { ...request.event, destination: "other" } },
    { event: { ...request.event, purpose: "other" } }, { event: { ...request.event, occurredAt: now + 1 } },
    { event: { ...request.event, occurredAt: now - 7 * 86400000 - 1 } }, { event: { ...request.event, identifiers: { email: "raw@example.test" } } },
    { grant: { ...request.grant, revoked: true } }, { grant: { ...request.grant, expiresAt: now } },
    { grant: { ...request.grant, definitionIds: ["other"] } }, { grant: { ...request.grant, accountId: pixel } },
    { grant: { ...request.grant, payloadSchema: "other" } }, { grant: { ...request.grant, scope: { ...scope, workspaceId: "other" } } },
  ])("fails closed before credential access for mismatched event/grant", async patch => {
    const f = fixture(); expect((await f.backend.deliver({ ...request, ...patch } as SnapchatCapiRequest)).ok).toBe(false); expect(f.credentials()).toBe(0); expect(f.calls).toHaveLength(0);
  });
  it.each([{ definition: { id: "offline-signup", actionSource: "WEB", eventName: "SIGN_UP" } }, { pixelAccountId: pixel }, { mode: "local-sandbox" }])("rejects unverified/non-offline configuration", async patch => {
    const f = fixture({ config: { ...configuration, ...patch } as SnapchatCapiConfiguration }); expect((await f.backend.deliver(request)).ok).toBe(false); expect(f.credentials()).toBe(0);
  });
  it("rechecks consent after credential resolution and synchronously at execute", async () => {
    const f = fixture({ credentialHook: () => { f.state.current = false; } }); expect((await f.backend.deliver(request)).ok).toBe(false); expect(f.calls).toHaveLength(0);
    const revoked = fixture({ authority: { async dispatch(input) { return input.execute({ isCurrent: () => false }); } } });
    expect(await revoked.backend.deliver(request)).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(revoked.calls).toHaveLength(0);
    const expired = fixture({ expiresAt: now }); expect(await expired.backend.deliver(request)).toMatchObject({ ok: false, error: { code: "expired" } }); expect(expired.calls).toHaveLength(0);
  });
  it.each([() => new Response("not json"), () => new Response("x".repeat(1048577)), () => Response.json({ status: "INVALID" }),
    () => Response.json({ status: "VALID" }, { status: 503 }), () => { throw new Error("https://tr.snapchat.com/?access_token=synthetic-secret"); }])("keeps uncertain delivery unknown; reconcile is network-free, claim cannot resend", async response => {
    const f = fixture({ response }); const result = await f.backend.deliver(request);
    expect(result).toEqual({ ok: true, value: { status: "unknown" } }); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    expect(await f.backend.reconcile(request)).toEqual({ ok: true, value: { status: "unknown" } }); expect(f.credentials()).toBe(1); expect(f.calls).toHaveLength(1);
    await f.backend.deliver(request); expect(f.calls).toHaveLength(1);
  });
  it("rejects callback replay and preserves receipt on post-egress authority exception", async () => {
    const f = fixture({ authority: { async dispatch(input) { await input.execute({ isCurrent: () => true }); return input.execute({ isCurrent: () => true }); } } });
    expect(await f.backend.deliver(request)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(f.calls).toHaveLength(1);
    const thrown = fixture({ authority: { async dispatch(input) { await input.execute({ isCurrent: () => true }); throw new Error("synthetic-secret"); } } });
    expect(await thrown.backend.deliver(request)).toEqual({ ok: true, value: { status: "unknown" } }); expect(thrown.calls).toHaveLength(1);
  });
  it("copies reviewed payload before host mutation and cancels before credentials", async () => {
    const original = structuredClone(request);
    const f = fixture({ authority: { async dispatch(input) { original.event.identifiers.email = "d".repeat(64); input.payload.data[0].event_id = "mutated"; return input.execute({ isCurrent: () => true }); } } });
    await f.backend.deliver(original); expect(String(f.calls[0].init.body)).toContain(request.event.identifiers.email); expect(String(f.calls[0].init.body)).not.toContain("mutated");
    const cancelled = fixture(), controller = new AbortController(); controller.abort(); await cancelled.backend.deliver(request, { signal: controller.signal }); expect(cancelled.credentials()).toBe(0);
  });
});
