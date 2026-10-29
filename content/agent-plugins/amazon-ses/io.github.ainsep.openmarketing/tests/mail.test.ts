import { readFileSync } from "node:fs";
import { sign, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMailAdapterContext, createMailProviderRegistry, validateMailProvider } from "@jini-ai/platform/mail";
import mailProvider, { createAmazonSesMailProvider } from "../src/index.js";
import { credential, mailFixture, mailInput, snsCertificate, snsPrivateKey, identity } from "./fixtures.js";
const now = Date.parse(new X509Certificate(snsCertificate).validFrom) + 3600000;
const configuration = { region: "us-east-1", senderDomain: "example.com", snsTopicArn: "arn:aws:sns:us-east-1:123456789012:fixture", maxSendRate: 1 };
const certificateUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem";
type ProviderArgs = Parameters<typeof createAmazonSesMailProvider>[0];
/** Fake TLS transport returns a synthetic certificate; no live AWS call occurs. */
function provider(required: Partial<ProviderArgs> = {}) {
  return createAmazonSesMailProvider({ clock: { now: () => now }, configuration,
    authority: async ({ execute }) => execute(), fetch: async () => new Response(snsCertificate),
    deadlineSignal: () => new AbortController().signal, ...required });
}
function make(required: Omit<Parameters<typeof mailFixture>[0], "provider" | "token"> = {}) {
  return mailFixture({ now, ...required, provider: args => provider(args), token: JSON.stringify(credential) });
}

it("default-exports a valid Jini module and signs a fixture send from install settings and time", async () => {
  expect(validateMailProvider({ provider: mailProvider })).toBeUndefined();
  const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
  const descriptor = manifest.extensions["io.github.ainsep.openmarketing"].mailAdapters[0];
  expect(descriptor.id).toBe(mailProvider.id);
  const registry = createMailProviderRegistry();
  expect(registry.contribute({ definition: { id: descriptor.id, provider: mailProvider, label: descriptor.label }, pluginId: manifest.name })).toBe(true);
  expect(descriptor.credentialKeys).toEqual(mailProvider.credentialKeys);
  expect(descriptor.feedback).toBe(mailProvider.capabilities.feedback);
  expect(mailProvider.capabilities).toEqual({ hosted: true, feedback: false, domainVerification: false });
  expect(mailProvider.feedback).toBeUndefined();
  expect(mailProvider.domainRequirements).toBeUndefined();
  const requests: ReturnType<typeof mailFixture>["requests"] = [];
  const ctx = createMailAdapterContext({ credential: { token: JSON.stringify(credential) }, kit: { httpClient: { async send(input) {
    requests.push(input);
    return { status: 200, headers: {}, bodyText: JSON.stringify({ MessageId: "default-message" }) };
  } } } }, { now: () => new Date(now), settings: { ...configuration, alertFrom: "sender@example.com" } });
  expect(await registry.get({ id: descriptor.id })!.provider.create(ctx).send(mailInput)).toEqual({ ok: true, providerMessageId: "default-message", acceptedAt: new Date(now).toISOString() });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.request).toMatchObject({ url: "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails",
    headers: { authorization: expect.stringContaining("Credential=" + credential.accessKeyId), "x-amz-date": new Date(now).toISOString().replace(/[:-]|\.\d{3}/g, "") } });
});
it("refuses missing default settings or clock before HTTP, including sendBatch", async () => {
  let sends = 0;
  const ctx = createMailAdapterContext({ credential: { token: JSON.stringify(credential) }, kit: { httpClient: { async send() {
    sends++;
    throw new Error(credential.secretAccessKey);
  } } } }, { now: () => new Date(now), settings: configuration });
  for (const settings of [{}, { ...configuration, region: undefined }, { ...configuration, snsTopicArn: undefined }, { ...configuration, maxSendRate: undefined }, { ...configuration, senderDomain: undefined }]) {
    const result = await mailProvider.create({ ...ctx, settings }).send(mailInput);
    expect(result).toMatchObject({ ok: false, errorCode: "not_configured", retryable: false });
    expect(JSON.stringify(result)).not.toContain(credential.secretAccessKey);
  }
  const missingClock = mailProvider.create({ ...ctx, now: undefined });
  expect(await missingClock.send(mailInput)).toMatchObject({ ok: false, errorCode: "not_configured" });
  expect(await missingClock.sendBatch({ ...mailInput, messages: [mailInput.message] })).toMatchObject([{ ok: false, errorCode: "not_configured" }]);
  expect(sends).toBe(0);
});
it("keeps default-module credential parsing and transport errors secret-free", async () => {
  const secret = credential.secretAccessKey;
  let sends = 0;
  const ctx = createMailAdapterContext({ credential: { token: secret }, kit: { httpClient: { async send() {
    sends++;
    throw new Error(secret);
  } } } }, { now: () => new Date(now), settings: configuration });
  const invalid = await mailProvider.create(ctx).send(mailInput);
  expect(invalid).toMatchObject({ ok: false, errorCode: "unavailable" });
  expect(JSON.stringify(invalid)).not.toContain(secret);
  expect(sends).toBe(0);
  const failed = await mailProvider.create({ ...ctx, credential: { token: JSON.stringify(credential) } }).send(mailInput);
  expect(failed).toMatchObject({ ok: false, unknown: true });
  expect(JSON.stringify(failed)).not.toContain(secret);
  expect(sends).toBe(1);
});
function webhook(required: { topic?: string; certificateUrl?: string; subject?: string; version?: "1" | "2"; source?: string } = {}) {
  const envelope = { Type: "Notification", MessageId: "sns-event-1", Timestamp: new Date(now).toISOString(),
    TopicArn: required.topic ?? configuration.snsTopicArn, ...(required.subject === undefined ? {} : { Subject: required.subject }),
    Message: JSON.stringify({ notificationType: "Bounce", mail: { messageId: "ses-message", source: required.source ?? "sender@example.com" },
      bounce: { timestamp: new Date(now).toISOString(), bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "recipient@example.net" }, { emailAddress: "RECIPIENT@example.net" }] } }) };
  const canonical = ["Message", "MessageId", ...(required.subject === undefined ? [] : ["Subject"]), "Timestamp", "TopicArn", "Type"]
    .map(key => key + "\n" + envelope[key as keyof typeof envelope] + "\n").join("");
  const version = required.version ?? "2";
  return { providerId: "amazon_ses", workspaceId: "workspace", headers: {}, rawBody: Buffer.from(JSON.stringify({ ...envelope,
    SignatureVersion: version, SigningCertURL: required.certificateUrl ?? certificateUrl,
    Signature: sign(version === "2" ? "RSA-SHA256" : "RSA-SHA1", Buffer.from(canonical), snsPrivateKey).toString("base64") })) };
}
for (const transport of ["memory", "http"] as const) {
  describe(transport + " synthetic policy wiring", () => {
    it("accepts one exact payload, deduplicates it and rejects a conflicting replay", async () => {
      const f = make({ transport });
      const first = await f.mailer.send(mailInput, { purpose: "bulk" });
      expect(first).toMatchObject({ ok: true, providerMessageId: expect.any(String) });
      expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
      expect(await f.mailer.send({ ...mailInput, message: { ...mailInput.message, subject: "changed" } }, { purpose: "bulk" }))
        .toMatchObject({ ok: false, errorCode: "MAIL_IDEMPOTENCY_CONFLICT" });
      expect(f.requests).toHaveLength(1);
      const request = f.requests[0]!.request;
      expect(request.method).toBe("POST");
      expect(request.timeoutMs).toBe(10000);
      expect(request.body).toContain("List-Unsubscribe=One-Click");
      expect(request.body).toContain("https://example.com/unsubscribe/fixture");
    });
    it("never reclaims uncertain outcomes or invents a provider message id", async () => {
      const f = make({ transport, response: () => ({ status: 200, bodyText: "{}" }) });
      expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, unknown: true });
      expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "MAIL_OUTCOME_UNKNOWN", unknown: true });
      expect(f.requests).toHaveLength(1);
    });
    it("wires readiness, synthetic authority denial and Jini suppression without egress", async () => {
      const f = make({ transport });
      f.state.ready = false;
      // Jini's purpose gate refuses a notification-lane send by throwing when no durable outbox path is ready.
      await expect(f.mailer.send(mailInput, { purpose: "bulk" })).rejects.toThrow("MAILER_SEND_REFUSED_NO_DURABLE_PATH");
      f.state.ready = true;
      f.state.allowed = false;
      expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false });
      expect(f.requests).toHaveLength(0);
      const g = make({ transport });
      await g.suppression.suppress({ workspaceId: "workspace", normalizedAddress: "recipient@example.net", scope: "all", reason: "bounced" });
      expect(await g.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "MAIL_RECIPIENT_SUPPRESSED" });
      expect(g.requests).toHaveLength(0);
    });
    it("refuses attachments, header injection, invalid unsubscribe and oversized bodies", async () => {
      const f = make({ transport });
      expect(await f.mailer.send({ ...mailInput, message: { ...mailInput.message, attachments: [{ filename: "x", contentType: "text/plain", contentBase64: "eA==" }] } }, { purpose: "bulk" }))
        .toMatchObject({ ok: false, errorCode: "MAIL_ATTACHMENTS_UNSUPPORTED" });
      expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, subject: "injected\r\nBcc: victim@example.net" } }, { purpose: "bulk" })).toMatchObject({ ok: false });
      expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, headers: { "List-Unsubscribe": "<http://example.com>", "List-Unsubscribe-Post": "wrong" } } }, { purpose: "bulk" })).toMatchObject({ ok: false });
      expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, text: "x".repeat(65536) } }, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "payload_too_large" });
      expect(f.requests).toHaveLength(0);
    });
    it("rejects provider batches larger than one without partially sending", async () => {
      const f = make({ transport });
      expect(await f.inner.sendBatch({ workspaceId: mailInput.workspaceId, idempotencyKey: "batch", sourceContext: mailInput.sourceContext, messages: [mailInput.message, mailInput.message] }, { purpose: "bulk" }))
        .toEqual([expect.objectContaining({ ok: false, errorCode: "batch_not_supported" })]);
      expect(f.requests).toHaveLength(0);
      expect(await f.inner.sendBatch({ workspaceId: mailInput.workspaceId, idempotencyKey: "single", sourceContext: mailInput.sourceContext, messages: [mailInput.message] }, { purpose: "bulk" }))
        .toEqual([expect.objectContaining({ ok: true })]);
    });
  });
}

it("signs the exact SES body and advertises no provider idempotency", async () => {
  const f = make();
  expect(f.inner.capabilities({}).supportsIdempotencyKey).toBe(false);
  await f.inner.send(mailInput, { purpose: "bulk" });
  const request = f.requests[0]!.request;
  expect(request.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
  expect(request.headers).toMatchObject({ authorization: expect.stringContaining("AWS4-HMAC-SHA256") });
  expect(request.headers).not.toHaveProperty("Idempotency-Key");
  expect(JSON.parse(String(request.body))).toMatchObject({ Content: { Simple: { Headers: [{ Name: "List-Unsubscribe", Value: mailInput.message.headers["List-Unsubscribe"] }, { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" }] } } });
});
it("authenticates SNS variants and applies hard-bounce suppression once", async () => {
  const f = make();
  const event = webhook({ subject: "escaped\nsubject" });
  expect(await f.ingest.handle(event)).toMatchObject({ status: 200, body: { applied: 1 } });
  expect(await f.ingest.handle(event)).toMatchObject({ status: 200, body: { duplicates: 1 } });
  const module = provider();
  const v1 = webhook({ version: "1" });
  expect(await module.prepareFeedback(v1)).toMatchObject({ ok: true });
  expect(module.feedback!.verify({ ...v1, secrets: [], now })).toBe(true);
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "MAIL_RECIPIENT_SUPPRESSED" });
  expect(f.requests).toHaveLength(0);
});
it("rejects unknown/expired certificates, foreign topics, tampering and foreign senders", async () => {
  const event = webhook();
  expect(provider().feedback!.verify({ ...event, secrets: [], now })).toBe(false);
  const module = provider();
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: true });
  expect(module.feedback!.verify({ ...event, secrets: [], now: Date.parse(new X509Certificate(snsCertificate).validTo) + 1 })).toBe(false);
  expect(module.feedback!.verify({ ...webhook({ topic: "arn:aws:sns:us-east-1:123456789012:foreign" }), secrets: [], now })).toBe(false);
  expect(module.feedback!.verify({ ...webhook({ certificateUrl: "https://evil.invalid/cert.pem" }), secrets: [], now })).toBe(false);
  const f = make();
  expect(await f.ingest.handle({ ...event, rawBody: Buffer.from(event.rawBody.toString().replace("ses-message", "tampered")) })).toMatchObject({ status: 401 });
  expect(await f.ingest.handle(webhook({ source: "foreign@elsewhere.example" }))).toMatchObject({ status: 400 });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
});
it("maps configured DKIM records and rejects foreign domains", async () => {
  const f = make({ response: () => ({ status: 200, bodyText: JSON.stringify(identity) }) });
  const ctx = { workspaceId: "workspace", mode: "test" as const, credential: { token: JSON.stringify(credential) }, httpClient: { async send() { return { status: 200, bodyText: JSON.stringify(identity), headers: {} }; } } };
  expect(await provider().domainStatus!(ctx, { domain: "example.com" })).toMatchObject({ status: "ok", value: { state: "verified" } });
  expect(await provider().domainRequirements!(ctx, { domain: "example.com" })).toMatchObject({ status: "ok", value: { records: [{ type: "CNAME", name: "synthetictoken._domainkey.example.com" }] } });
  expect(await provider().domainStatus!(ctx, { domain: "foreign.example" })).toMatchObject({ status: "rejected" });
  expect(f.requests).toHaveLength(0);
});

it("uses Jini's lane limiter with injected time and defers a second bulk recipient", async () => {
  const f = make({ limit: { perSecond: 1, burst: 1 } });
  expect(f.registry.get({ id: provider().id })).toBeDefined();
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
  const next = { ...mailInput, idempotencyKey: "next-recipient" };
  expect(await f.mailer.send(next, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "MAIL_RATE_LIMITED" });
  expect(f.requests).toHaveLength(1);
  f.state.now += 1000;
  expect(await f.mailer.send(next, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(f.requests).toHaveLength(2);
});

/** Ordinary HTTP has no policy checks: only the provider's authority callback prevents egress. */
function direct(required: { authority: ProviderArgs["authority"] }) {
  const requests: unknown[] = [];
  const mailer = provider(required).create({ credential: { token: JSON.stringify(credential) }, kit: { httpClient: { async send(input) {
    requests.push(input);
    return { status: 200, bodyText: JSON.stringify({ MessageId: "fixture-message" }), headers: {} };
  } } } });
  return { mailer, requests };
}
it("requires authority on both send and single-message sendBatch with an ordinary HTTP client", async () => {
  let checks = 0;
  const denied = { ok: false as const, errorCode: "consent_withdrawn", message: "Denied", retryable: false };
  const f = direct({ authority: async ({ input }, options) => {
    checks++;
    expect(input).toEqual(mailInput);
    expect(options).toEqual({ purpose: "bulk" });
    return denied;
  } });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toEqual(denied);
  expect(await f.mailer.sendBatch({ ...mailInput, messages: [mailInput.message] }, { purpose: "bulk" })).toEqual([denied]);
  expect(checks).toBe(2);
  expect(f.requests).toHaveLength(0);
  const missing = direct({ authority: undefined as unknown as ProviderArgs["authority"] });
  const absent = await missing.mailer.send(mailInput, { purpose: "bulk" });
  expect(absent).toMatchObject({ ok: false });
  expect(absent.ok ? undefined : absent.unknown).not.toBe(true);
  expect(missing.requests).toHaveLength(0);
});
it("freezes the approved input and permits at most one execution even concurrently", async () => {
  let repeated: unknown;
  const f = direct({ authority: async ({ input, execute }) => {
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.message)).toBe(true);
    expect(Object.isFrozen(input.message.to)).toBe(true);
    expect(Object.isFrozen(input.message.headers)).toBe(true);
    const results = await Promise.all([execute(), execute()]);
    repeated = results[1];
    return results[0]!;
  } });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true, providerMessageId: "fixture-message" });
  expect(repeated).toMatchObject({ ok: false, errorCode: "conflict" });
  expect(f.requests).toHaveLength(1);
});
it("preserves uncertainty when authority fails after HTTP submission", async () => {
  const f = direct({ authority: async ({ execute }) => { await execute(); throw new Error("synthetic acknowledgement failure"); } });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, unknown: true });
  expect(f.requests).toHaveLength(1);
});
it("retains a mailto plus HTTPS unsubscribe list and the exact one-click header", async () => {
  const f = make();
  const headers = { "List-Unsubscribe": "<mailto:leave@example.com>, <https://example.com/unsubscribe/fixture>",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, headers } }, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(f.requests[0]!.request.body).toContain(headers["List-Unsubscribe"]);
  expect(f.requests[0]!.request.body).toContain(headers["List-Unsubscribe-Post"]);
});
it.each(["<mailto:leave@example.com>", "<https://user:secret@example.com/leave>", "<https://example.com/leave#fragment>", "<http://example.com/leave>"])("refuses unsafe unsubscribe list %s without egress", async unsubscribe => {
  const f = make();
  expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, headers: { ...mailInput.message.headers,
    "List-Unsubscribe": unsubscribe } } }, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "invalid_unsubscribe" });
  expect(f.requests).toHaveLength(0);
});
it.each([
  { header: "2", delay: 2000 },
  { header: new Date(now + 3000).toUTCString(), delay: 3000 },
  { header: "999999999", delay: 86400000 },
  { header: new Date(now - 1000).toUTCString(), delay: 0 },
  { header: "invalid", delay: undefined },
])("returns retryable provider back-pressure with Retry-After $header", async ({ header, delay }) => {
  const f = make({ response: () => ({ status: 429, bodyText: "{}", headers: { "Retry-After": header } }) });
  const result = await f.inner.send(mailInput, { purpose: "bulk" });
  expect(result).toMatchObject({ ok: false, errorCode: "MAIL_RATE_LIMITED", retryable: true });
  expect(result.ok ? undefined : result.retryAfterMs).toBe(delay);
  expect(f.requests).toHaveLength(1);
});

it("supports Jini test-mode redirect while retaining unsubscribe and X-Original-To headers", async () => {
  const f = make({ redirectTo: "safe@example.net" });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(f.requests).toHaveLength(1);
  expect(JSON.parse(String(f.requests[0]!.request.body))).toMatchObject({ Destination: { ToAddresses: ["safe@example.net"] },
    Content: { Simple: { Headers: expect.arrayContaining([
      { Name: "X-Original-To", Value: "recipient@example.net" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]) } } });
});
it.each(["From", "To", "Bcc", "Reply-To", "Subject", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"])("refuses reserved custom header %s", async name => {
  const f = make();
  expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, headers: { ...mailInput.message.headers, [name]: "injected" } } }, { purpose: "bulk" }))
    .toMatchObject({ ok: false, errorCode: "invalid_unsubscribe" });
  expect(f.requests).toHaveLength(0);
});
it("refuses case-insensitive duplicate custom headers", async () => {
  const f = make();
  expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, headers: { ...mailInput.message.headers,
    "X-Original-To": "first@example.net", "x-original-to": "second@example.net" } } }, { purpose: "bulk" }))
    .toMatchObject({ ok: false, errorCode: "invalid_unsubscribe" });
  expect(f.requests).toHaveLength(0);
});
it("fetches only the validated certificate, caches it for an hour and follows URL rotation", async () => {
  let time = now;
  const calls: { url: string; init?: RequestInit }[] = [];
  const module = provider({ clock: { now: () => time }, fetch: async (url, init) => {
    calls.push({ url: String(url), init }); return new Response(snsCertificate);
  } });
  const event = webhook();
  expect(module.feedback!.verify({ ...event, now: time, secrets: [] })).toBe(false);
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: true });
  expect(module.feedback!.verify({ ...event, now: time, secrets: [] })).toBe(true);
  expect(calls).toEqual([{ url: certificateUrl, init: { method: "GET", redirect: "error", signal: expect.any(AbortSignal) } }]);
  time += 3599999;
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: true });
  expect(calls).toHaveLength(1);
  time += 1;
  expect(module.feedback!.verify({ ...event, now: time, secrets: [] })).toBe(false);
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: true });
  expect(calls).toHaveLength(2);
  const rotatedUrl = "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-rotated.pem";
  const rotated = webhook({ certificateUrl: rotatedUrl });
  expect(module.feedback!.verify({ ...rotated, now: time, secrets: [] })).toBe(false);
  expect(await module.prepareFeedback(rotated)).toMatchObject({ ok: true });
  expect(module.feedback!.verify({ ...rotated, now: time, secrets: [] })).toBe(true);
  expect(calls.map(call => call.url)).toEqual([certificateUrl, certificateUrl, rotatedUrl]);
  expect(module.feedback!.verify({ ...event, now: time, secrets: [] })).toBe(false);
});
it.each([
  "http://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem",
  "https://sns.us-east-1.amazonaws.com.evil.invalid/SimpleNotificationService-fixture.pem",
  "https://sns.us-west-2.amazonaws.com/SimpleNotificationService-fixture.pem",
  "https://user@sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem",
  "https://sns.us-east-1.amazonaws.com/other.pem",
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem?next=evil",
  "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-fixture.pem#fragment",
])("rejects untrusted certificate URL %s before fetching", async certificateUrl => {
  let fetches = 0;
  const module = provider({ fetch: async () => { fetches++; return new Response(snsCertificate); } });
  expect(await module.prepareFeedback(webhook({ certificateUrl }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(fetches).toBe(0);
});
it("rejects foreign topics, oversized bodies and cancellation before certificate I/O", async () => {
  let fetches = 0;
  const module = provider({ fetch: async () => { fetches++; return new Response(snsCertificate); } });
  expect(await module.prepareFeedback(webhook({ topic: "arn:aws:sns:us-east-1:123456789012:foreign" }))).toMatchObject({ ok: false });
  expect(await module.prepareFeedback({ rawBody: Buffer.alloc(262145) })).toMatchObject({ ok: false });
  expect(await module.prepareFeedback(webhook(), { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(fetches).toBe(0);
});
it("bounds streamed PEM bytes and rejects redirects, malformed certificates and fetch failures", async () => {
  for (const fetch of [
    async () => new Response(null, { status: 302, headers: { Location: "https://evil.invalid/cert.pem" } }),
    async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.alloc(8192)); controller.enqueue(Buffer.alloc(8193)); controller.close(); } })),
    async () => new Response("not a certificate"),
    async () => { throw new Error("synthetic TLS failure"); },
  ]) {
    const module = provider({ fetch });
    const event = webhook();
    expect(await module.prepareFeedback(event)).toMatchObject({ ok: false, error: { retryable: true } });
    expect(module.feedback!.verify({ ...event, now, secrets: [] })).toBe(false);
    expect(module.feedback!.parse({ ...event })).toEqual({ error: "invalid_signature" });
  }
});
it("never falls back to an expired certificate when refresh fails", async () => {
  let time = now;
  let available = true;
  const module = provider({ clock: { now: () => time }, fetch: async () => {
    if (!available) throw new Error("synthetic outage");
    return new Response(snsCertificate);
  } });
  const event = webhook();
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: true });
  available = false;
  time += 3600000;
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: false, error: { code: "unavailable" } });
  expect(module.feedback!.verify({ ...event, now: time, secrets: [] })).toBe(false);
  available = true;
  time = Date.parse(new X509Certificate(snsCertificate).validTo);
  expect(await module.prepareFeedback(event)).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  expect(module.feedback!.verify({ ...event, now: time, secrets: [] })).toBe(false);
});
it("rejects a certificate that is not yet valid and enforces the injected deadline", async () => {
  const early = provider({ clock: { now: () => Date.parse(new X509Certificate(snsCertificate).validFrom) - 1 } });
  expect(await early.prepareFeedback(webhook())).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  let fetches = 0;
  const timedOut = provider({ deadlineSignal: ({ timeoutMs }) => {
    expect(timeoutMs).toBe(10000); return AbortSignal.abort();
  }, fetch: async () => { fetches++; return new Response(snsCertificate); } });
  expect(await timedOut.prepareFeedback(webhook())).toMatchObject({ ok: false });
  expect(fetches).toBe(0);
});
