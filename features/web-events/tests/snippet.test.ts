// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import type { TrackingTagOutput } from "@open-marketing/contracts";
import { campaign, destinationUrl, encodedCampaign } from "./fixtures.js";
import { webEventSnippetSource, webEventInstallSource } from "../index.js";

type Bootstrap = (required: { now: () => number; nextId: () => string; location: { search: string; href?: string }; fetch: typeof fetch; document?: Document; consent?: unknown }) => Promise<unknown>;
function snippet(required: { tags?: readonly TrackingTagOutput[] } = {}): Bootstrap {
  const result = webEventSnippetSource({ collectionPath: "/c", ...required });
  if (!result.ok) throw new Error("Invalid source fixture");
  return runInNewContext(result.value, { URLSearchParams, URL }) as Bootstrap;
}
function browser(required: { search?: string; href?: string; now?: number; id?: string } = {}) {
  return { now: () => required.now ?? 100, nextId: () => required.id ?? "browser-event", location: { href: required.href, search: required.search ?? "?linkId=link&campaignId=campaign&gclid=google&gbraid=bridge&wbraid=web&fbclid=meta" }, fetch: vi.fn<typeof fetch>(async () => new Response()) };
}
describe("first-party snippet source", () => {
  it("is inert until bootstrap and posts one allowlisted landing without URL/referrer", async () => {
    const fixture = browser({ search: "?linkId=link&gclid=google&email=raw%40example.test&msclkid=no&ttclid=no&fbclid=meta" });
    const bootstrap = snippet();
    expect(fixture.fetch).not.toHaveBeenCalled();
    await bootstrap({ ...fixture, consent: true });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/c");
    expect(init).toMatchObject({ mode: "same-origin", credentials: "same-origin", referrerPolicy: "no-referrer", method: "POST" });
    expect(JSON.parse(init.body as string)).toEqual({ eventId: "browser-event", schema: "om.web.landing", version: 1, source: "first-party", name: "landing", occurredAt: 100, consent: true, properties: { linkId: "link", gclid: "google", fbclid: "meta" } });
    expect(init.body).not.toContain("example.test");
  });
  it("captures all four approved click keys and observed landing time", async () => {
    const fixture = browser();
    await snippet()({ ...fixture, consent: true });
    const [, init] = fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ occurredAt: 100, properties: { gclid: "google", gbraid: "bridge", wbraid: "web", fbclid: "meta" } });
  });
  it.each(["https://example.test/c", "//example.test/c", "/../c", "/c?redirect=x", "/c\n", "", "/" + "x".repeat(256)])("rejects unsafe collection path %j", collectionPath => {
    expect(webEventSnippetSource({ collectionPath })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it.each([
    { search: "?gclid=" + "x".repeat(2049) },
    { search: "?linkId=" + "x".repeat(257) },
    { search: "?gclid=raw%40example.test" },
    { search: "?gclid=" },
    { search: "?other=" + "x".repeat(16384) },
    { now: Number.MAX_SAFE_INTEGER + 1 },
    { now: -1 },
    { id: "raw@example.test" },
    { href: "not-a-url" },
  ])("skips malformed bounded browser input %j", async invalid => {
    const fixture = browser(invalid);
    await snippet()({ ...fixture, consent: true });
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("accepts the maximum click length without a retry queue", async () => {
    const fixture = browser({ search: "?gclid=" + "x".repeat(2048) });
    fixture.fetch.mockRejectedValue(new Error("fixture network failure"));
    await expect(snippet()({ ...fixture, consent: true })).rejects.toThrow("fixture network failure");
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
  it("captures the macro convention and strips query/fragment from the destination", async () => {
    const fixture = browser({ search: "?utm_source=google-ads&utm_medium=paid&om_a=account&utm_id=campaign&email=private", href: destinationUrl + "?email=private#secret" });
    await snippet()({ ...fixture, consent: true });
    const body = JSON.parse(fixture.fetch.mock.calls[0][1]?.body as string);
    expect(body.properties).toEqual({ utm_source: campaign.pluginId, utm_medium: "paid", om_a: campaign.accountId, utm_id: campaign.vendorCampaignId, pageUrl: destinationUrl });
    expect(JSON.stringify(body)).not.toContain("private");
    expect(JSON.stringify(body)).not.toContain("secret");
  });
  it.each(["?campaignId=" + encodedCampaign(), "?utm_id=%7Bcampaignid%7D&utm_source=google-ads&utm_medium=paid&om_a=account"])("preserves canonical or unresolved claims for server validation: %s", async search => {
    const fixture = browser({ search });
    await snippet()({ ...fixture, consent: true });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fixture.fetch.mock.calls[0][1]?.body as string).properties).toHaveProperty(search.startsWith("?campaignId") ? "campaignId" : "utm_id");
  });
  it("drops all attribution claims on duplicate parameters while retaining the visit", async () => {
    const fixture = browser({ search: "?utm_source=google-ads&utm_medium=paid&om_a=account&utm_id=one&utm_id=two&gclid=click" });
    await snippet()({ ...fixture, consent: true });
    expect(JSON.parse(fixture.fetch.mock.calls[0][1]?.body as string).properties).toEqual({ gclid: "click" });
  });
  const tags: readonly TrackingTagOutput[] = [
    { snippet: '<script src="https://fixture.invalid/google.js"></script><script>fixtureGoogle();</script>', campaignUrlTemplate: "https://site.example.test/?utm_id={campaignid}" },
    { snippet: '<script>fixtureMeta();</script>', campaignUrlTemplate: "https://site.example.test/?utm_id={{campaign.id}}" },
  ];
  it("collects local HTTP landings without HTTPS heartbeat metadata", async () => {
    const fixture = browser({ href: "http://127.0.0.1:3000/f/lead?private=value#fragment" });
    await snippet()({ ...fixture, consent: true });
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fixture.fetch.mock.calls[0][1]?.body as string);
    expect(body.properties).toMatchObject({ linkId: "link" });
    expect(body.properties).not.toHaveProperty("pageUrl");
  });
  it("starts consented scripts while collection is pending and completes their order after rejection", async () => {
    const document = globalThis.document.implementation.createHTMLDocument("fixture");
    const collection = Promise.withResolvers<Response>();
    const fixture = browser();
    fixture.fetch.mockReturnValue(collection.promise);
    const pending = snippet({ tags })({ ...fixture, document, consent: true });
    const rejected = expect(pending).rejects.toThrow("collection failed");
    await vi.waitFor(() => expect(document.scripts).toHaveLength(1));
    collection.reject(new Error("collection failed"));
    await rejected;
    document.scripts[0].dispatchEvent(new Event("load"));
    await vi.waitFor(() => expect(Array.from(document.scripts, script => script.textContent)).toEqual(["", "fixtureGoogle();", "fixtureMeta();"]));
  });
  it.each([undefined, false, "true"])("sends no landing and loads no scripts without literal consent: %j", async consent => {
    const document = globalThis.document.implementation.createHTMLDocument("fixture");
    const fixture = browser();
    await snippet({ tags })({ ...fixture, document, consent });
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(document.scripts).toHaveLength(0);
  });
  it("activates plugin scripts through DOM insertion in external/inline order after consent", async () => {
    const document = globalThis.document.implementation.createHTMLDocument("fixture");
    const pending = snippet({ tags })({ ...browser(), document, consent: true });
    await vi.waitFor(() => expect(document.scripts).toHaveLength(1));
    expect(document.scripts[0].src).toBe("https://fixture.invalid/google.js");
    expect(document.scripts[0].async).toBe(false);
    document.scripts[0].dispatchEvent(new Event("load"));
    await pending;
    await vi.waitFor(() => expect(Array.from(document.scripts, script => script.textContent)).toEqual(["", "fixtureGoogle();", "fixtureMeta();"]));
  });
  it("rejects malformed or excess tag outputs before emitting source", () => {
    expect(webEventSnippetSource({ collectionPath: "/c", tags: [...tags, tags[0]] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(webEventSnippetSource({ collectionPath: "/c", tags: [{ ...tags[0], snippet: "x".repeat(32769) }] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const source = webEventSnippetSource({ collectionPath: "/c", tags });
    expect(source.ok && source.value).not.toContain("</script>");
  });
  it.each([undefined, false, "true"])("installer waits for visitor grant before one landing and tag activation: %j", async omConsent => {
    const fixture = browser();
    fixture.location.search += "&utm_source=fixture-ads&utm_medium=paid&om_a=account&utm_id=campaign";
    const document = globalThis.document.implementation.createHTMLDocument("fixture");
    const window = { ...fixture, document, omConsent, omGrantConsent: () => {} };
    const source = webEventInstallSource({ collectionPath: "/c", tags: [{ snippet: "<script>fixtureTag();</script>", campaignUrlTemplate: destinationUrl }] });
    if (!source.ok) throw new Error("Invalid installer fixture");
    const pending = runInNewContext(source.value, { window, URL, URLSearchParams, Date: { now: fixture.now }, crypto: { randomUUID: fixture.nextId } });
    await Promise.resolve();
    expect(fixture.fetch).not.toHaveBeenCalled();
    expect(document.scripts).toHaveLength(0);
    fixture.location.search = "?utm_id=changed&gclid=changed";
    window.omGrantConsent();
    window.omGrantConsent();
    await pending;
    expect(document.scripts).toHaveLength(1);
    expect(document.scripts[0].textContent).toBe("fixtureTag();");
    expect(JSON.parse(fixture.fetch.mock.calls[0][1]?.body as string)).toMatchObject({ consent: true, occurredAt: 100, eventId: "browser-event",
      properties: { gclid: "google", gbraid: "bridge", wbraid: "web", fbclid: "meta", utm_source: "fixture-ads", utm_medium: "paid", om_a: "account", utm_id: "campaign" } });
    window.omGrantConsent();
    await Promise.resolve();
    expect(document.scripts).toHaveLength(1);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
  it("installer activates when the visitor already granted consent", async () => {
    const fixture = browser();
    const document = globalThis.document.implementation.createHTMLDocument("fixture");
    const source = webEventInstallSource({ collectionPath: "/c", tags: [{ snippet: "<script>fixtureTag();</script>", campaignUrlTemplate: destinationUrl }] });
    if (!source.ok) throw new Error("Invalid installer fixture");
    await runInNewContext(source.value, { window: { ...fixture, document, omConsent: true }, URL, URLSearchParams, Date: { now: fixture.now }, crypto: { randomUUID: fixture.nextId } });
    expect(document.scripts).toHaveLength(1);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fixture.fetch.mock.calls[0][1]?.body as string)).toMatchObject({ consent: true });
    expect(webEventInstallSource({ collectionPath: "//invalid" }).ok).toBe(false);
  });
});
