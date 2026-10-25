import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { commandSchema } from "../src/index.js";
import { fixture, now, report } from "./fixtures.js";

describe("closed X commands and OAuth signing", () => {
  it.each([{ kind: "activate" }, { kind: "list_accounts", count: 101 }, { kind: "list_accounts", url: "https://example.com" }, { ...report, entityIds: ["camp1", "camp1"] }, { ...report, entityIds: Array.from({ length: 21 }, (_, index) => "id" + index) }, { ...report, window: { start: now + 1, end: now + 3600000 } }, { ...report, window: { start: now, end: now + 604800001 } }])("rejects unsupported/oversized input before credentials", async command => {
    expect(commandSchema.safeParse(command).success).toBe(false);
    const f = fixture();
    // The runtime boundary must also reject invalid callers that bypass the static type.
    expect(await f.invoke({ command: command as typeof report })).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it("signs the exact GET query using injected time/nonce (independent HMAC oracle)", async () => {
    const f = fixture(); await f.invoke();
    const normalized = "count=100&oauth_consumer_key=consumer&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=" + Math.floor(now / 1000) + "&oauth_token=token&oauth_version=1.0";
    const base = "GET&https%3A%2F%2Fads-api.x.com%2F12%2Faccounts&" + encodeURIComponent(normalized);
    const signature = createHmac("sha1", "consumer-secret&token-secret").update(base).digest("base64");
    const header = new Headers(f.calls[0].init.headers).get("Authorization");
    expect(header).toContain('oauth_signature="' + encodeURIComponent(signature) + '"'); expect(header).toContain('oauth_nonce="nonce"'); expect(header).toContain('oauth_timestamp="' + Math.floor(now / 1000) + '"');
    expect(header).not.toContain("consumer-secret"); expect(header).not.toContain("token-secret");
  });
  it("denies a foreign ACCOUNT report before credential access", async () => {
    const f = fixture(); expect(await f.invoke({ command: { ...report, entity: "ACCOUNT", entityIds: ["other"] } })).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.credentialCalls).toEqual([]);
  });
});
