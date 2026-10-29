import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CallContext, Outcome } from "@open-marketing/contracts";
import type { CollectionAuthorityPort, ObservedCampaignPort, VisitTokenPort, WebEvent } from "../index.js";
import { createMemoryWebEventRepo, createWebEventService } from "../index.js";
import { authorityFixture, campaign, clockFixture, context, destinationUrl, encodedCampaign, event, idsFixture, observedFixture, otherWorkspace, tokenFixture, visit } from "./fixtures.js";

describe("web-event service", () => {
  let fixture: ReturnType<typeof setup>;
  beforeEach(() => { fixture = setup(); });
  function setup(required: { tokens?: VisitTokenPort; authority?: CollectionAuthorityPort; observedCampaigns?: ObservedCampaignPort } = {}) {
    const clock = clockFixture();
    const repo = createMemoryWebEventRepo(clock);
    const tokens = required.tokens ?? tokenFixture();
    const collectionAuthority = required.authority ?? authorityFixture();
    const observedCampaigns = required.observedCampaigns ?? observedFixture();
    const service = createWebEventService({ repo, tokens, collectionAuthority, observedCampaigns, clock: clock.clock, ids: idsFixture() });
    return { ...clock, repo, tokens, collectionAuthority, observedCampaigns, service };
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
  it("normalizes macro claims and revalidates observations without replay conflicts", async () => {
    const observed = vi.spyOn(fixture.observedCampaigns, "observed").mockResolvedValue({ ok: true, value: [] });
    const landing = event({ subjectId: "subject", properties: { utm_source: campaign.pluginId, utm_medium: "paid", om_a: campaign.accountId, utm_id: campaign.vendorCampaignId, pageUrl: destinationUrl } });
    expect(await fixture.service.recordTouch({ context, event: landing })).toMatchObject({ ok: true, value: { campaignId: null } });
    observed.mockResolvedValue({ ok: true, value: [campaign] });
    expect(await fixture.service.recordTouch({ context, event: landing })).toMatchObject({ ok: true, value: { touchId: "generated-1", campaignId: encodedCampaign() } });
    const query = { context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 };
    expect(await fixture.service.touchesFor(query)).toMatchObject({ ok: true, value: [{ campaignId: encodedCampaign() }] });
    observed.mockResolvedValue({ ok: true, value: [] });
    expect(await fixture.service.touchesFor(query)).toMatchObject({ ok: true, value: [{ campaignId: null }] });
    expect(observed.mock.calls[0][0]).toEqual({ context, keys: [campaign] });
  });
  const unattributedClaims: WebEvent["properties"][] = [
    { campaignId: "ck1:forged" },
    { linkId: "link", campaignId: "ck1:forged" },
    { utm_source: campaign.pluginId, utm_medium: "paid", om_a: campaign.accountId, utm_id: "{campaignid}" },
    { utm_source: campaign.pluginId, utm_medium: "paid" },
    { campaignId: encodedCampaign(), utm_source: "meta-ads", utm_medium: "paid", om_a: "account", utm_id: "campaign" },
    { campaignId: encodedCampaign({ key: { ...campaign, accountId: "another-account" } }) },
    { campaignId: encodedCampaign({ key: { ...campaign, pluginId: "meta-ads" } }) },
  ];
  const omLinks: WebEvent["properties"][] = [{}, { linkId: "link" }];
  it.each(omLinks)("preserves scope-verified OM IDs on collection, replay and read: %j", async link => {
    const observe = vi.spyOn(fixture.observedCampaigns, "observed").mockResolvedValue({ ok: true, value: [] });
    const landing = event({ subjectId: "subject", properties: { ...link, campaignId: "om-campaign" } });
    const first = await fixture.service.recordTouch({ context, event: landing });
    expect(first).toMatchObject({ ok: true, value: { campaignId: "om-campaign" } });
    expect(await fixture.service.recordTouch({ context, event: landing })).toEqual(first);
    expect(await fixture.service.touchesFor({ context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 }))
      .toMatchObject({ ok: true, value: [{ campaignId: "om-campaign" }] });
    expect(await fixture.service.recordTouch({ context, event: { ...landing, properties: { ...landing.properties, campaignId: "other-campaign" } } }))
      .toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(observe.mock.calls.every(([input]) => input.keys.length === 0)).toBe(true);
  });
  const fallbackMacros: WebEvent["properties"][] = [
    { utm_medium: "cpc" },
    { utm_source: campaign.pluginId, utm_medium: "paid" },
    { utm_source: campaign.pluginId, utm_medium: "paid", om_a: campaign.accountId, utm_id: "{campaignid}" },
  ];
  it.each(fallbackMacros)("retains a canonical claim beside incomplete or non-paid macros: %j", async macros => {
    expect(await fixture.service.recordTouch({ context, event: event({ properties: { campaignId: encodedCampaign(), ...macros } }) }))
      .toMatchObject({ ok: true, value: { campaignId: encodedCampaign() } });
  });
  it.each(unattributedClaims)("keeps permitted visits but leaves unverified claims unattributed: %j", async properties => {
    expect(await fixture.service.recordTouch({ context, event: event({ properties }) })).toMatchObject({ ok: true, value: { campaignId: null } });
  });
  it("does not attribute an observed key from another scope", async () => {
    expect(await fixture.service.recordTouch({ context: otherWorkspace, event: event() })).toMatchObject({ ok: true, value: { campaignId: null } });
  });
  it("validates stored touches and batches repeated keys once for 100 touches", async () => {
    const read = { context, subjectId: "subject", window: { start: 0, end: 500 }, limit: 100 };
    const one = await fixture.service.recordTouch({ context, event: event() });
    if (!one.ok) throw new Error("Fixture touch rejected");
    const observed = vi.spyOn(fixture.observedCampaigns, "observed");
    vi.spyOn(fixture.repo, "touchesFor").mockResolvedValue({ ok: true, value: Array.from({ length: 100 }, (_, index) => ({ ...one.value, touchId: "touch-" + index })) });
    expect(await fixture.service.touchesFor(read)).toMatchObject({ ok: true, value: expect.arrayContaining([{ ...one.value, touchId: "touch-99" }]) });
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed.mock.calls[0][0].keys).toEqual([campaign]);
    vi.spyOn(fixture.repo, "touchesFor").mockResolvedValue({ ok: true, value: [{ ...one.value, occurredAt: NaN }] });
    expect(await fixture.service.touchesFor(read)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("rejects malformed, injected and failing observed results without leaking diagnostics", async () => {
    const observe = vi.spyOn(fixture.observedCampaigns, "observed");
    for (const value of [[{ pluginId: "missing-fields" }], [{ ...campaign, accountId: "injected-account" }], Array(101).fill(campaign)]) {
      observe.mockResolvedValue({ ok: true, value } as Outcome<typeof campaign[]>);
      expect(await fixture.service.recordTouch({ context, event: event() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    }
    observe.mockResolvedValue({ ok: false, error: { code: "unavailable", message: "secret adapter diagnostic", retryable: true } });
    const result = await fixture.service.recordTouch({ context, event: event() });
    expect(result).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(JSON.stringify(result)).not.toContain("secret");
    observe.mockRejectedValue(new Error("secret thrown diagnostic"));
    expect(await fixture.service.recordTouch({ context, event: event() })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("reports exact destination heartbeat freshness using receipt time, never replay time", async () => {
    const query = { context, destinationUrl: destinationUrl + "?ignored=query#fragment" };
    expect(await fixture.service.destinationReadiness(query)).toEqual({ ok: true, value: { status: "missing", heartbeatAt: null } });
    const landing = event({ properties: { pageUrl: destinationUrl + "?email=private#fragment" } });
    await fixture.service.recordTouch({ context, event: landing });
    fixture.time.now = 1000 + 7 * 86400000;
    expect(await fixture.service.destinationReadiness(query)).toEqual({ ok: true, value: { status: "ready", heartbeatAt: 1000 } });
    fixture.time.now++;
    await fixture.service.recordTouch({ context, event: landing });
    expect(await fixture.service.destinationReadiness(query)).toEqual({ ok: true, value: { status: "stale", heartbeatAt: 1000 } });
    expect(await fixture.service.destinationReadiness({ ...query, context: otherWorkspace })).toMatchObject({ ok: true, value: { status: "missing" } });
    expect(await fixture.service.destinationReadiness({ context, destinationUrl: destinationUrl + "/other" })).toMatchObject({ ok: true, value: { status: "missing" } });
  });
  it("rejects unsafe readiness URLs, cancellation and malformed/future receipt output", async () => {
    for (const destinationUrl of ["not-a-url", "http://site.example.test/", "https://user:pass@site.example.test/"]) {
      expect(await fixture.service.destinationReadiness({ context, destinationUrl })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(await fixture.service.destinationReadiness({ context, destinationUrl }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    for (const value of [NaN, 1001, "1000"]) {
      vi.spyOn(fixture.repo, "lastHeartbeat").mockResolvedValue({ ok: true, value } as Outcome<number | null>);
      expect(await fixture.service.destinationReadiness({ context, destinationUrl })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    }
  });
});
