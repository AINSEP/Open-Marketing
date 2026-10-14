import { describe, expect, it } from "vitest";
import { invokeMetaInstagram, metaInstagramTools } from "../src/index.js";
import type { MetaInstagramDispatch, MetaInstagramPost } from "../src/index.js";
import { failure } from "../src/boundary.js";
import { context, now } from "./fixtures.js";
import { configuration, image, instagramFixture, instagramRequest, invokeInstagramFixture, resume } from "./instagram-fixtures.js";

/** Shared contract for the in-memory double AND the Coordinator's credentialed server adapter.
 * create supplies a fixture HTTP transport for each scenario; no live Meta request is allowed.
 */
export function metaInstagramDispatchSuite(required: { name: string; create: (required: { mode: "ok" | "timeout" | "refused" | "malformed" }) => { dispatch: MetaInstagramDispatch } }): void {
  describe(required.name, () => {
    it.each([
      { mode: "ok" as const, expected: { ok: true, value: { status: "published", mediaId: "9001" } } },
      { mode: "timeout" as const, expected: { ok: true, value: { status: "unknown", containerId: "201" } } },
      { mode: "refused" as const, expected: { ok: false, error: { code: "forbidden" } } },
      { mode: "malformed" as const, expected: { ok: true, value: { status: "unknown", containerId: "201" } } },
    ])("$mode", async row => {
      const adapter = required.create({ mode: row.mode });
      const result = await invokeMetaInstagram({ request: instagramRequest({ post: resume }), dispatch: adapter.dispatch, clock: { now: () => now }, wait: async () => ({ ok: true, value: undefined }), observer: { observe: () => undefined }, configuration });
      expect(result).toMatchObject(row.expected);
      expect(JSON.stringify(result)).not.toContain("never-export");
    });
  });
}

metaInstagramDispatchSuite({ name: "Instagram guarded dispatch contract (in-memory)", create: instagramFixture });

describe("organic Instagram tools", () => {
  it("publishes an image with its caption, one stable operation/digest and no spend effect", async () => {
    const fixture = instagramFixture();
    const result = await invokeInstagramFixture({ fixture });
    expect(result).toEqual({ ok: true, value: { status: "published", mediaId: "9001" } });
    expect(fixture.calls[0].request).toEqual({ method: "POST", endpoint: "https://graph.facebook.com/v25.0/123/media", parameters: { image_url: image.kind === "image" ? image.imageUrl : "", caption: image.caption } });
    expect(fixture.calls.map(call => call.request.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    expect(fixture.calls.at(-1)?.request.parameters).toEqual({ creation_id: "201" });
    expect(new Set(fixture.calls.map(call => call.operationId))).toEqual(new Set(["instagram-operation"]));
    expect(new Set(fixture.calls.map(call => call.effect.argumentsDigest)).size).toBe(1);
    expect(fixture.calls.every(call => call.context === fixture.calls[0].context && call.context.runId === context.runId && call.timeoutMs === 15000 && call.effect.moneyExposure === null)).toBe(true);
    expect(fixture.calls.filter(call => call.request.method === "POST").every(call => call.effect.effects.join() === "write")).toBe(true);
    expect(JSON.stringify(fixture.observations)).not.toContain(image.caption);
  });
  it("creates ordered image/video children, checks each and captions only the carousel parent", async () => {
    const fixture = instagramFixture();
    const post: MetaInstagramPost = { kind: "carousel", igUserId: "123", caption: "Ordered #carousel", items: [{ imageUrl: "https://example.com/a.jpg" }, { videoUrl: "https://example.com/b.mp4" }] };
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post }) })).toEqual({ ok: true, value: { status: "published", mediaId: "9001" } });
    const creations = fixture.calls.filter(call => call.request.endpoint.endsWith("/media"));
    expect(creations.map(call => call.request.parameters)).toEqual([
      { image_url: "https://example.com/a.jpg", is_carousel_item: true },
      { video_url: "https://example.com/b.mp4", media_type: "VIDEO", is_carousel_item: true },
      { media_type: "CAROUSEL", children: "201,202", caption: post.caption },
    ]);
    expect(fixture.calls.at(-1)?.request.parameters).toEqual({ creation_id: "203" });
  });
  it("maps a Reel and honors server-configured API version", async () => {
    const fixture = instagramFixture();
    const post: MetaInstagramPost = { kind: "reel", igUserId: "123", caption: "A Reel", videoUrl: "https://example.com/reel.mp4" };
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post }), configuration: { ...configuration, apiVersion: "v26.0" } })).toEqual({ ok: true, value: { status: "published", mediaId: "9001" } });
    expect(fixture.calls[0].request).toEqual({ method: "POST", endpoint: "https://graph.facebook.com/v26.0/123/media", parameters: { video_url: post.videoUrl, media_type: "REELS", caption: post.caption } });
  });
  it("resumes without creation, and a published container has no second publish POST", async () => {
    const fixture = instagramFixture(); fixture.state.containerStatus = "PUBLISHED";
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post: resume }) })).toEqual({ ok: true, value: { status: "published" } });
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0].request.method).toBe("GET");
  });
  it("detects publication during the quota read before a second publish", async () => {
    const fixture = instagramFixture({ handler: input => {
      if (input.request.endpoint.endsWith("/content_publishing_limit")) fixture.state.published = true;
      return undefined;
    } });
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post: resume }) })).toEqual({ ok: true, value: { status: "published" } });
    expect(fixture.calls.every(call => call.request.method === "GET")).toBe(true);
  });
  it("uses returned quota_total rather than a fixed daily quota", async () => {
    const fixture = instagramFixture(); fixture.state.quotaTotal = 7; fixture.state.quotaUsage = 7;
    expect(await invokeInstagramFixture({ fixture })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
    expect(fixture.calls.some(call => call.request.endpoint.endsWith("/media_publish"))).toBe(false);
  });
  it("stops after five processing checks and four one-minute waits", async () => {
    const fixture = instagramFixture(); fixture.state.containerStatus = "IN_PROGRESS";
    expect(await invokeInstagramFixture({ fixture })).toEqual({ ok: true, value: { status: "processing", containerId: "201" } });
    expect(fixture.calls.filter(call => call.request.method === "GET")).toHaveLength(5);
    expect(fixture.waits).toEqual([60000, 60000, 60000, 60000]);
    expect(fixture.state.now - now).toBe(240000);
    expect(fixture.calls.some(call => call.request.endpoint.endsWith("/media_publish"))).toBe(false);
  });
  it("does not return a pending carousel child as a resumable parent", async () => {
    const fixture = instagramFixture(); fixture.state.containerStatus = "IN_PROGRESS";
    const post: MetaInstagramPost = { kind: "carousel", igUserId: "123", caption: "two", items: [{ imageUrl: "https://example.com/1.jpg" }, { imageUrl: "https://example.com/2.jpg" }] };
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post }) })).toEqual({ ok: true, value: { status: "unknown" } });
    expect(fixture.state.creations).toBe(1);
    expect(fixture.calls.some(call => call.request.endpoint.endsWith("/media_publish"))).toBe(false);
  });
  it.each([{ status: "ERROR", code: "conflict" }, { status: "EXPIRED", code: "expired" }, { status: "NEW_STATUS", code: "protocol_mismatch" }])("fails closed on $status", async row => {
    const fixture = instagramFixture(); fixture.state.containerStatus = row.status;
    expect(await invokeInstagramFixture({ fixture })).toMatchObject({ ok: false, error: { code: row.code } });
    expect(fixture.calls.some(call => call.request.endpoint.endsWith("/media_publish"))).toBe(false);
  });
  it("reconciles a lost publish ACK with one GET and no second POST", async () => {
    const fixture = instagramFixture({ handler: input => {
      if (!input.request.endpoint.endsWith("/media_publish")) return undefined;
      fixture.state.published = true;
      return failure({ code: "unavailable", message: "Lost fixture ACK" });
    } });
    expect(await invokeInstagramFixture({ fixture })).toEqual({ ok: true, value: { status: "published" } });
    expect(fixture.calls.filter(call => call.request.endpoint.endsWith("/media_publish"))).toHaveLength(1);
    expect(fixture.calls.at(-1)?.request).toMatchObject({ method: "GET", parameters: { fields: "status_code,status" } });
  });
  it("returns unknown when reconciliation is unreadable, without echoing provider errors", async () => {
    const fixture = instagramFixture({ mode: "timeout", handler: input => {
      if (fixture.calls.some(call => call.request.endpoint.endsWith("/media_publish")) && input.request.method === "GET") return { ok: true, value: { status: "secret-provider-error" } };
      return undefined;
    } });
    expect(await invokeInstagramFixture({ fixture })).toEqual({ ok: true, value: { status: "unknown", containerId: "201" } });
    expect(fixture.calls.filter(call => call.request.endpoint.endsWith("/media_publish"))).toHaveLength(1);
  });
  it("preserves unknown creation ACK without recreating containers", async () => {
    const fixture = instagramFixture({ handler: () => ({ ok: true, value: { id: "not-an-id" } }) });
    expect(await invokeInstagramFixture({ fixture })).toEqual({ ok: true, value: { status: "unknown" } });
    expect(fixture.calls).toHaveLength(1);
  });
  it("refuses revoked authority during the multi-step flow", async () => {
    const fixture = instagramFixture({ handler: input => { if (input.request.method === "POST") fixture.state.current = false; return undefined; } });
    expect(await invokeInstagramFixture({ fixture })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(fixture.calls).toHaveLength(1);
  });
  it.each(["https://localhost/a.jpg", "https://om.local/a.jpg", "https://om.internal/a.jpg", "https://127.1/a.jpg", "https://10.0.0.1/a.jpg", "https://172.16.0.1/a.jpg", "https://192.168.1.1/a.jpg", "https://[::1]/a.jpg", "https://[fd00::1]/a.jpg", "https://[::ffff:192.168.1.1]/a.jpg", "http://example.com/a.jpg"])("rejects non-public media %s before any dispatch", async imageUrl => {
    const fixture = instagramFixture();
    const post: MetaInstagramPost = { kind: "image", igUserId: "123", caption: "local", imageUrl };
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post }) })).toEqual({ ok: false, error: { code: "invalid_input", message: "Instagram needs a publicly reachable media URL; this OM asset is only available locally.", retryable: false } });
    expect(fixture.calls).toEqual([]);
  });
  it.each([{ caption: "a".repeat(2201) }, { caption: "#tag ".repeat(31) }, { caption: "@person ".repeat(21) }, { scheduledAt: now + 1000 }])("rejects invalid caption/scheduling $caption", async override => {
    const fixture = instagramFixture();
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post: { ...image, ...override } as MetaInstagramPost }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.calls).toEqual([]);
  });
  it("validates the entire carousel before creating any child", async () => {
    const fixture = instagramFixture();
    const post: MetaInstagramPost = { kind: "carousel", igUserId: "123", caption: "mixed", items: [{ imageUrl: "https://example.com/ok.jpg" }, { videoUrl: "https://localhost/private.mp4" }] };
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ post }) })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fixture.calls).toEqual([]);
  });
  it("discovers connected accounts without exposing Page credentials or pagination URLs", async () => {
    const fixture = instagramFixture({ handler: () => ({ ok: true, value: { data: [{ id: "1", name: "Linked", instagram_business_account: { id: "2", username: "fixture" }, access_token: "secret" }, { id: "3", name: "Unlinked" }], paging: { next: "https://graph.facebook.com/?access_token=secret" } } }) });
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ command: { kind: "instagram_accounts" } }) })).toEqual({ ok: true, value: { accounts: [{ pageId: "1", pageName: "Linked", igUserId: "2", username: "fixture" }], hasMore: true } });
    expect(fixture.calls[0].request.parameters.fields).toBe("id,name,instagram_business_account{id,username}");
  });
  it("reads status/quota and fails on unusable quota rather than publishing", async () => {
    const fixture = instagramFixture();
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ command: { kind: "instagram_post_status", igUserId: "123", containerId: "201" } }) })).toEqual({ ok: true, value: { container: { status_code: "FINISHED" }, quota: { quota_usage: 0, config: { quota_total: 50, quota_duration: 86400 } } } });
    fixture.state.quotaTotal = 0;
    expect(await invokeInstagramFixture({ fixture })).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
    expect(fixture.calls.some(call => call.request.endpoint.endsWith("/media_publish"))).toBe(false);
  });
  it("requests views/reach/interactions and returns unavailable metrics as absent, never zero", async () => {
    const fixture = instagramFixture({ handler: () => ({ ok: true, value: { data: [{ name: "reach", period: "lifetime", values: [{ value: 12 }], title: "Reach" }] } }) });
    expect(await invokeInstagramFixture({ fixture, request: instagramRequest({ command: { kind: "instagram_media_insights", mediaId: "9001" } }) })).toEqual({ ok: true, value: { insights: [{ name: "reach", period: "lifetime", values: [{ value: 12 }] }] } });
    expect(fixture.calls[0].request.parameters.metric).toBe("reach,views,total_interactions");
  });
  it("cancels before egress and propagates the caller's abort signal", async () => {
    const fixture = instagramFixture(); const controller = new AbortController();
    await invokeInstagramFixture({ fixture }, { signal: controller.signal });
    expect(fixture.options.every(option => option?.signal === controller.signal)).toBe(true);
    controller.abort(); const callsBefore = fixture.calls.length;
    expect(await invokeInstagramFixture({ fixture }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(fixture.calls).toHaveLength(callsBefore);
  });
  it("exports exactly four definitions with one ordinary write tool", () => {
    expect(metaInstagramTools.map(tool => [tool.name, tool.effects])).toEqual([["instagram_accounts", ["read"]], ["instagram_publish_post", ["write"]], ["instagram_post_status", ["read"]], ["instagram_media_insights", ["read"]]]);
  });
});
