import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { webEventSnippetSource } from "../index.js";

type Bootstrap = (required: { now: () => number; nextId: () => string; location: { search: string }; fetch: typeof fetch }) => Promise<unknown>;
function snippet(): Bootstrap {
  const result = webEventSnippetSource({ collectionPath: "/c" });
  if (!result.ok) throw new Error("Invalid source fixture");
  return runInNewContext(result.value, { URLSearchParams }) as Bootstrap;
}
function browser(required: { search?: string; now?: number; id?: string } = {}) {
  return { now: () => required.now ?? 100, nextId: () => required.id ?? "browser-event", location: { search: required.search ?? "?linkId=link&campaignId=campaign&gclid=google&gbraid=bridge&wbraid=web&fbclid=meta" }, fetch: vi.fn<typeof fetch>(async () => new Response()) };
}
describe("first-party snippet source", () => {
  it("is inert until bootstrap and posts one allowlisted landing without URL/referrer", async () => {
    const fixture = browser({ search: "?linkId=link&gclid=google&email=raw%40example.test&msclkid=no&ttclid=no&fbclid=meta" });
    const bootstrap = snippet();
    expect(fixture.fetch).not.toHaveBeenCalled();
    await bootstrap(fixture);
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    const [path, init] = fixture.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/c");
    expect(init).toMatchObject({ mode: "same-origin", credentials: "same-origin", referrerPolicy: "no-referrer", method: "POST" });
    expect(JSON.parse(init.body as string)).toEqual({ eventId: "browser-event", schema: "om.web.landing", version: 1, source: "first-party", name: "landing", occurredAt: 100, properties: { linkId: "link", gclid: "google", fbclid: "meta" } });
    expect(init.body).not.toContain("example.test");
  });
  it("captures all four approved click keys and observed landing time", async () => {
    const fixture = browser();
    await snippet()(fixture);
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
  ])("skips malformed bounded browser input %j", async invalid => {
    const fixture = browser(invalid);
    await snippet()(fixture);
    expect(fixture.fetch).not.toHaveBeenCalled();
  });
  it("accepts the maximum click length without a retry queue", async () => {
    const fixture = browser({ search: "?gclid=" + "x".repeat(2048) });
    fixture.fetch.mockRejectedValue(new Error("fixture network failure"));
    await expect(snippet()(fixture)).rejects.toThrow("fixture network failure");
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
  });
});
