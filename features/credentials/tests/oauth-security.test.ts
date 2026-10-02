import { describe, expect, it } from "vitest";
import { createBoundOAuthClient, createMemorySecretSealer } from "../index.js";
import { clock, context, request, value } from "./fixtures.js";

/** Provider fixture is deliberately tainted by the case under test. OM must reject before UI/exchange. */
function client(required: { mutate?: (required: { url: URL }) => void; maxPending?: number; expired?: boolean }) {
  const sealer = createMemorySecretSealer({});
  let nextId = 0;
  let exchanges = 0;
  const port = createBoundOAuthClient({ clock, ids: { next() { return `txn-${++nextId}`; } }, maxPending: required.maxPending,
    allowedReturnUris: [request.returnUri], allowedAuthorizationOrigins: ["https://oauth.example"], bindings: {
      async authorize(input) {
        const url = new URL("https://oauth.example/authorize");
        url.searchParams.set("state", "S".repeat(43));
        url.searchParams.set("redirect_uri", input.request.returnUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("code_challenge", "C".repeat(43));
        url.searchParams.set("code_challenge_method", "S256");
        required.mutate?.({ url });
        return { ok: true, value: { authorizationUrl: url.href, expiresAt: clock.now({}) + (required.expired ? 0 : 300000) } };
      },
      async exchange(input) { exchanges++; return sealer.seal({ reference: input.reference, plaintext: "protected-token" }); },
    },
  });
  return { port, exchanges() { return exchanges; } };
}

describe("OAuth boundary validation", () => {
  it.each(["plain", "none", ""])('rejects PKCE method "%s"', async method => {
    const h = client({ mutate(input) { input.url.searchParams.set("code_challenge_method", method); } });
    expect((await h.port.begin({ context, request })).ok).toBe(false);
    expect(h.exchanges()).toBe(0);
  });
  it.each(["access_token", "client_secret", "code_verifier", "refresh_token"])('rejects secret URL field "%s"', async field => {
    const h = client({ mutate(input) { input.url.searchParams.set(field, "provider-secret"); } });
    const result = await h.port.begin({ context, request });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });
  it("rejects duplicate state and nonadmitted authorization origins", async () => {
    const duplicate = client({ mutate(input) { input.url.searchParams.append("state", "other-state"); } });
    expect((await duplicate.port.begin({ context, request })).ok).toBe(false);
    const wrong = client({ mutate(input) { input.url.hostname = "evil.example"; } });
    expect((await wrong.port.begin({ context, request })).ok).toBe(false);
  });
  it("does not exchange incorrect state or redirect, including concurrent replays", async () => {
    const h = client({});
    const challenge = value({ outcome: await h.port.begin({ context, request }) });
    const callback = { transactionId: challenge.transactionId, state: "S".repeat(43), code: "code", redirectUri: request.returnUri };
    const results = await Promise.all([h.port.complete({ callback }), h.port.complete({ callback })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(h.exchanges()).toBe(1);
    const second = value({ outcome: await h.port.begin({ context, request }) });
    expect((await h.port.complete({ callback: { ...callback, transactionId: second.transactionId, redirectUri: "https://evil.example" } })).ok).toBe(false);
    expect(h.exchanges()).toBe(1);
  });
  it("enforces capacity for concurrent begins and rejects expired challenges", async () => {
    const h = client({ maxPending: 1 });
    const results = await Promise.all([h.port.begin({ context, request }), h.port.begin({ context, request })]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok && result.error.code === "limit_exceeded")).toHaveLength(1);
    expect((await client({ expired: true }).port.begin({ context, request })).ok).toBe(false);
  });
});
