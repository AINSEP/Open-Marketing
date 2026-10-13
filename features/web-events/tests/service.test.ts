import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { CollectionAuthorityPort, VisitTokenPort, WebEvent } from "../index.js";
import { createMemoryWebEventRepo, createWebEventService } from "../index.js";
import { authorityFixture, clockFixture, context, event, idsFixture, otherWorkspace, tokenFixture, visit } from "./fixtures.js";

describe("web-event service", () => {
  let fixture: ReturnType<typeof setup>;
  beforeEach(() => { fixture = setup(); });
  function setup(required: { tokens?: VisitTokenPort; authority?: CollectionAuthorityPort } = {}) {
    const clock = clockFixture();
    const repo = createMemoryWebEventRepo(clock);
    const tokens = required.tokens ?? tokenFixture();
    const collectionAuthority = required.authority ?? authorityFixture();
    const service = createWebEventService({ repo, tokens, collectionAuthority, clock: clock.clock, ids: idsFixture() });
    return { ...clock, repo, tokens, collectionAuthority, service };
  }
  it("is inert, assigns touch IDs and rechecks current collection authority on replay", async () => {
    const authority = vi.spyOn(fixture.collectionAuthority, "assess");
    const saved = vi.spyOn(fixture.repo, "recordTouch");
    expect(authority).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    const first = await fixture.service.recordTouch({ context, event: event() });
    expect(first).toMatchObject({ ok: true, value: { touchId: "generated-1", eventId: "event", occurredAt: 100, clickIdentifiers: { gclid: "google-click", fbclid: "meta-click" } } });
    expect(await fixture.service.recordTouch({ context, event: event() })).toEqual(first);
    authority.mockResolvedValue({ ok: true, value: { allowed: false } });
    expect(await fixture.service.recordTouch({ context, event: event() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(saved).toHaveBeenCalledTimes(2);
    expect(saved.mock.calls[0][0].event).toMatchObject({ receivedAt: 1000, cursor: 0, traceId: context.traceId });
  });
  const invalidEvents: Partial<WebEvent>[] = [
    { properties: { email: "raw@example.test" } },
    { properties: { msclkid: "not-approved" } },
    { properties: { ttclid: "not-approved" } },
    { properties: { gclid: "x".repeat(2049) } },
    { properties: { gclid: "raw@example.test" } },
    { properties: { gclid: 12 } },
    { properties: { fbclid: "click\n" } },
    { properties: { linkId: "https://example.test/raw" } },
    { version: 2 },
    { occurredAt: Number.MAX_SAFE_INTEGER + 1 },
    { anonymousId: undefined, subjectId: undefined },
  ];
  it.each(invalidEvents)("rejects invalid ingress before authority or storage: %j", async invalid => {
    const authority = vi.spyOn(fixture.collectionAuthority, "assess");
    const saved = vi.spyOn(fixture.repo, "recordTouch");
    expect(await fixture.service.recordTouch({ context, event: event(invalid) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(authority).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
  });
  it("accepts maximum opaque click length and both Google bridge keys", async () => {
    const result = await fixture.service.recordTouch({ context, event: event({ properties: { gclid: "x".repeat(2048), gbraid: "bridge", wbraid: "web-bridge" } }) });
    expect(result).toMatchObject({ ok: true, value: { clickIdentifiers: { gbraid: "bridge", wbraid: "web-bridge" } } });
  });
  it("binds only authenticated persisted visits without granting collection authority", async () => {
    const authority = vi.spyOn(fixture.collectionAuthority, "assess");
    const input = { context, visitToken: "fixture-token", subjectId: "subject" };
    expect(await fixture.service.bindVisitor(input)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    await fixture.repo.saveVisit({ context, visit });
    expect(await fixture.service.bindVisitor(input)).toEqual({ ok: true, value: { ...visit, subjectId: "subject" } });
    expect(await fixture.service.bindVisitor(input)).toEqual({ ok: true, value: { ...visit, subjectId: "subject" } });
    expect(await fixture.service.bindVisitor({ ...input, subjectId: "other" })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(authority).not.toHaveBeenCalled();
  });
  it.each([
    { value: { ...visit, scope: otherWorkspace.scope }, code: "forbidden" },
    { value: { ...visit, expiresAt: 1000 }, code: "expired" },
    { value: { ...visit, expiresAt: NaN }, code: "invalid_input" },
    { value: { ...visit, anonymousId: "" }, code: "invalid_input" },
  ])("revalidates token scope and expiry: $code", async ({ value, code }) => {
    const setupFixture = setup({ tokens: tokenFixture({ result: { ok: true, value } }) });
    const bind = vi.spyOn(setupFixture.repo, "bindVisitor");
    expect(await setupFixture.service.bindVisitor({ context, visitToken: "fixture", subjectId: "subject" })).toMatchObject({ ok: false, error: { code } });
    expect(bind).not.toHaveBeenCalled();
  });
  it("rejects cancellation during authority assessment without saving", async () => {
    const abort = new AbortController();
    vi.spyOn(fixture.collectionAuthority, "assess").mockImplementation(async () => { abort.abort(); return { ok: true, value: { allowed: true } }; });
    const saved = vi.spyOn(fixture.repo, "recordTouch");
    expect(await fixture.service.recordTouch({ context, event: event() }, { signal: abort.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(saved).not.toHaveBeenCalled();
  });
  it("fails closed for malformed or failing authority and sanitizes thrown failures", async () => {
    vi.spyOn(fixture.collectionAuthority, "assess").mockResolvedValue({ ok: true, value: {} } as Outcome<{ allowed: boolean }>);
    expect(await fixture.service.recordTouch({ context, event: event() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    vi.spyOn(fixture.collectionAuthority, "assess").mockRejectedValue(new Error("secret vendor detail"));
    const failure = await fixture.service.recordTouch({ context, event: event() });
    expect(failure).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });
  it("propagates typed token failures and catches token/storage exceptions", async () => {
    vi.spyOn(fixture.tokens, "verify").mockResolvedValue({ ok: false, error: { code: "unauthenticated", message: "Fixture token rejected", retryable: false } });
    expect(await fixture.service.bindVisitor({ context, visitToken: "bad", subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    vi.spyOn(fixture.tokens, "verify").mockRejectedValue(new Error("token secret"));
    expect(await fixture.service.bindVisitor({ context, visitToken: "bad", subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    vi.spyOn(fixture.repo, "touchesFor").mockRejectedValue(new Error("driver secret"));
    expect(await fixture.service.touchesFor({ context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 1 })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("validates context, read window, limit, token size and pre-cancellation", async () => {
    const query = { context, subjectId: "subject", window: { start: 100, end: 100 }, limit: 1 };
    expect(await fixture.service.touchesFor(query)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await fixture.service.touchesFor({ ...query, window: { start: 0, end: 500 }, limit: 101 })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await fixture.service.bindVisitor({ context, visitToken: "x".repeat(4097), subjectId: "subject" })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const forged: CallContext = { ...context, principal: { kind: "owner", ownerId: "forged" } };
    expect(await fixture.service.recordTouch({ context: forged, event: event() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await fixture.service.recordTouch({ context, event: event() }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });
  it("reads the currently bound subject through the service", async () => {
    await fixture.repo.saveVisit({ context, visit });
    const result = await fixture.service.recordTouch({ context, event: event() });
    if (!result.ok) throw new Error("Fixture landing was rejected");
    await fixture.service.bindVisitor({ context, visitToken: "fixture", subjectId: "subject" });
    expect(await fixture.service.touchesFor({ context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 })).toEqual({ ok: true, value: [result.value] });
  });
});
