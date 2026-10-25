import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deliverConversion, reconcileConversion } from "../src/index.js";
import type { XCapiDependencies, XCapiRequest, XCapiPayload } from "../src/index.js";
import { fixture, now, context, pasted } from "./fixtures.js";

/** Real plugin HTTP/signing with current-authority/outbox doubles; all identities are synthetic. */
function capiFixture(required: { response?: () => Response | Promise<Response> } = {}) {
  const f = fixture({ response: required.response ?? (() => Response.json({ request: { params: { account_id: "abc1" } }, data: { conversions_processed: 1 } })) });
  let current = true;
  const claimed = new Set<string>(), payloads: XCapiPayload[] = [];
  const dependencies: XCapiDependencies = { ...f.dependencies, configuration: { ...f.dependencies.configuration, destination: "x-ads", purpose: "measurement", payloadSchema: "x-email-v1", mode: "production-server", conversionRules: { signup: { accountId: "abc1", pixelId: "pixel1", eventId: "event1" } } },
    authority: { async dispatch(input) {
      payloads.push(structuredClone(input.payload));
      if (claimed.has(input.deliveryId)) return { ok: false, error: { code: "conflict", message: "Already dispatched", retryable: false } };
      claimed.add(input.deliveryId);
      return input.execute({ isCurrent: () => current });
    } } };
  const request: XCapiRequest = { context: { scope: context.scope, serviceId: "measure", correlationId: "correlation", traceId: "trace" }, deliveryId: "delivery",
    event: { eventId: "stable-event", definitionId: "signup", subjectId: "contact1", occurredAt: now - 1000, destination: "x-ads", purpose: "measurement", identifiers: { email: "a".repeat(64) }, identifierDigests: { email: "b".repeat(64) } },
    grant: { kind: "measurement", grantId: "grant", scope: context.scope, connectionId: "connection", accountId: "abc1", definitionIds: ["signup"], destination: "x-ads", purpose: "measurement", payloadSchema: "x-email-v1", payloadVersion: 1, expiresAt: now + 3600000, revoked: false } };
  return { ...f, dependencies, ...request, payloads, withdraw() { current = false; } };
}

describe("server-only X conversion delivery", () => {
  it("sends exactly one account-bound event/hash and stable dedupe identity, accepts processed count", async () => {
    const f = capiFixture();
    expect(await deliverConversion(f)).toEqual({ ok: true, value: { status: "delivered" } });
    expect(f.calls).toHaveLength(1); expect(f.calls[0].url).toBe("https://ads-api.x.com/12/measurement/conversions/pixel1");
    expect(f.calls[0].init.method).toBe("POST"); expect(f.calls[0].init.redirect).toBe("error");
    const expected = { conversions: [{ conversion_time: new Date(now - 1000).toISOString(), event_id: "event1", conversion_id: "stable-event", identifiers: [{ hashed_email: "a".repeat(64) }] }] };
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual(expected); expect(f.payloads).toEqual([expected]);
    expect(f.calls[0].init.headers).toMatchObject({ "Content-Type": "application/json", Authorization: expect.stringContaining("OAuth ") });
    const normalized = "oauth_consumer_key=consumer&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA1&oauth_timestamp=" + Math.floor(now / 1000) + "&oauth_token=token&oauth_version=1.0";
    const signatureBase = "POST&https%3A%2F%2Fads-api.x.com%2F12%2Fmeasurement%2Fconversions%2Fpixel1&" + encodeURIComponent(normalized);
    const signature = createHmac("sha1", "consumer-secret&token-secret").update(signatureBase).digest("base64");
    expect(new Headers(f.calls[0].init.headers).get("Authorization")).toContain('oauth_signature="' + encodeURIComponent(signature) + '"');
    expect(JSON.stringify(f.observations)).not.toContain("a".repeat(64)); expect(JSON.stringify(f.observations)).not.toContain("token");
    expect(await deliverConversion(f)).toMatchObject({ ok: false, error: { code: "conflict" } }); expect(f.calls).toHaveLength(1);
  });
  it.each([0, 2, "1", undefined])("keeps malformed/incorrect processed count %s unknown without resending", async count => {
    const f = capiFixture({ response: () => Response.json({ request: { params: { account_id: "abc1" } }, data: { conversions_processed: count } }) });
    expect(await deliverConversion(f)).toEqual({ ok: true, value: { status: "unknown" } });
    expect(await reconcileConversion(f)).toEqual({ ok: true, value: { status: "unknown" } }); expect(f.calls).toHaveLength(1); expect(f.credentialCalls).toHaveLength(1);
  });
  it("lost response, wrong account and non-200 acknowledgement stay unknown", async () => {
    for (const response of [() => { throw new Error("secret lost response"); }, () => Response.json({ request: { params: { account_id: "foreign" } }, data: { conversions_processed: 1 } }), () => Response.json({ request: { params: { account_id: "abc1" } }, data: { conversions_processed: 1 } }, { status: 201 })]) {
      const f = capiFixture({ response });
      const result = await deliverConversion(f); expect(result).toEqual({ ok: true, value: { status: "unknown" } }); expect(JSON.stringify(result)).not.toContain("secret");
      await reconcileConversion(f); expect(f.calls).toHaveLength(1);
    }
  });
  it("denies unadmitted, local-mode, foreign/revoked/expired grants and unresolved mappings before credentials", async () => {
    const cases = [capiFixture(), capiFixture(), capiFixture(), capiFixture(), capiFixture(), capiFixture(), capiFixture()];
    cases[0].dependencies.configuration.admitted = false; cases[1].dependencies.configuration.mode = "local-sandbox";
    cases[2].grant.accountId = "foreign"; cases[3].grant.revoked = true; cases[4].grant.expiresAt = now;
    cases[5].event.destination = "other"; cases[6].dependencies.configuration.conversionRules.signup.accountId = "foreign";
    for (const f of cases) { expect(await deliverConversion(f)).toMatchObject({ ok: false }); expect(f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]); }
  });
  it("rejects raw/extra identifiers atomically and performs zero I/O in reconciliation", async () => {
    const f = capiFixture();
    expect(await deliverConversion({ ...f, event: { ...f.event, identifiers: { email: "user@example.invalid" } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const extra = { ...f.event, identifiers: { ...f.event.identifiers, phone: "+15555550100" } };
    expect(await deliverConversion({ ...f, event: extra })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await reconcileConversion(f)).toEqual({ ok: true, value: { status: "unknown" } }); expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]); expect(f.payloads).toEqual([]);
  });
  it("rechecks grant/consent and admission after successful credential resolution", async () => {
    for (const revoke of [false, true]) {
      const f = capiFixture();
      f.dependencies.credentials.access = async () => { if (revoke) f.dependencies.configuration.admitted = false; else f.withdraw(); return { ok: true, value: { accessToken: JSON.stringify(pasted) } }; };
      expect(await deliverConversion(f)).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.calls).toEqual([]);
    }
  });
  it("guards repeated execute and freezes payload before the host callback", async () => {
    const f = capiFixture();
    f.dependencies.authority.dispatch = async input => {
      input.payload.conversions[0].conversion_id = "altered"; input.event.identifiers.email = "c".repeat(64);
      const first = await input.execute({ isCurrent: () => true });
      expect(await input.execute({ isCurrent: () => true })).toMatchObject({ ok: false, error: { code: "conflict" } });
      return first;
    };
    expect(await deliverConversion(f)).toEqual({ ok: true, value: { status: "delivered" } }); expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0].init.body)).conversions[0]).toMatchObject({ conversion_id: "stable-event", identifiers: [{ hashed_email: "a".repeat(64) }] });
  });
});
