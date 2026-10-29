import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMailAdapterContext, createMailProviderRegistry, validateMailProvider } from "@jini-ai/platform/mail";
import mailProvider, { createResendMailProvider } from "../src/index.js";
import { domainId, mailFixture, mailInput } from "./fixtures.js";
const now = 1791849600000;
type ProviderArgs = Parameters<typeof createResendMailProvider>[0];
/** Explicit permissive callback for parser/domain probes; dispatch denial is tested separately. */
function provider(required: { authority?: ProviderArgs["authority"] } = {}) {
  return createResendMailProvider({ clock: { now: () => now }, domainId, authority: required.authority ?? (async ({ execute }) => execute()) });
}
function make(required: Omit<Parameters<typeof mailFixture>[0], "provider" | "token"> = {}) {
  return mailFixture({ ...required, provider: args => createResendMailProvider({ ...args, domainId }), token: "synthetic-full-access-token" });
}

it("default-exports a valid Jini module and sends with the host clock and fixture HTTP", async () => {
  expect(validateMailProvider({ provider: mailProvider })).toBeUndefined();
  const manifest = JSON.parse(readFileSync(new URL("../../plugin.json", import.meta.url), "utf8"));
  const descriptor = manifest.extensions["io.github.ainsep.openmarketing"].mailAdapters[0];
  expect(descriptor.id).toBe(mailProvider.id);
  const registry = createMailProviderRegistry();
  expect(registry.contribute({ definition: { id: descriptor.id, provider: mailProvider, label: descriptor.label }, pluginId: manifest.name })).toBe(true);
  expect(descriptor.credentialKeys).toEqual(mailProvider.credentialKeys);
  expect(descriptor.feedback).toBe(mailProvider.capabilities.feedback);
  expect(mailProvider.capabilities).toMatchObject({ feedback: true, domainVerification: false });
  expect(mailProvider.feedback).toBeDefined();
  expect(mailProvider.domainRequirements).toBeUndefined();
  const requests: ReturnType<typeof mailFixture>["requests"] = [];
  const ctx = createMailAdapterContext({ credential: { token: "synthetic-default-token" }, kit: { httpClient: { async send(input) {
    requests.push(input);
    return { status: 200, headers: {}, bodyText: JSON.stringify({ id: "default-message" }) };
  } } } }, { now: () => new Date(now), settings: { alertFrom: "sender@example.com" } });
  expect(await registry.get({ id: descriptor.id })!.provider.create(ctx).send(mailInput)).toEqual({ ok: true, providerMessageId: "default-message", acceptedAt: new Date(now).toISOString() });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.request.headers).toMatchObject({ Authorization: "Bearer synthetic-default-token", "Idempotency-Key": mailInput.idempotencyKey });
  const missingClock = mailProvider.create({ ...ctx, now: undefined });
  expect(await missingClock.send(mailInput)).toMatchObject({ ok: false, errorCode: "not_configured", retryable: false });
  expect(await missingClock.sendBatch({ ...mailInput, messages: [mailInput.message] })).toMatchObject([{ ok: false, errorCode: "not_configured" }]);
  expect(requests).toHaveLength(1);
});
it("keeps default-module credential and transport errors secret-free", async () => {
  const secret = "synthetic-default-secret";
  let sends = 0;
  const ctx = createMailAdapterContext({ credential: { token: secret + "\n" }, kit: { httpClient: { async send() {
    sends++;
    throw new Error(secret);
  } } } }, { now: () => new Date(now) });
  const invalid = await mailProvider.create(ctx).send(mailInput);
  expect(invalid).toMatchObject({ ok: false, errorCode: "invalid_input" });
  expect(JSON.stringify(invalid)).not.toContain(secret);
  expect(sends).toBe(0);
  const failed = await mailProvider.create({ ...ctx, credential: { token: secret } }).send(mailInput);
  expect(failed).toMatchObject({ ok: false, unknown: true });
  expect(JSON.stringify(failed)).not.toContain(secret);
  expect(sends).toBe(1);
});
function webhook(required: { type?: string; body?: string; timestamp?: number } = {}) {
  const body = required.body ?? JSON.stringify({ type: required.type ?? "email.bounced", created_at: new Date(now).toISOString(),
    data: { email_id: "resend-message", to: ["recipient@example.net", "RECIPIENT@example.net"], bounce: { type: "Permanent" } } });
  const timestamp = String(required.timestamp ?? now / 1000);
  const signature = createHmac("sha256", Buffer.from("synthetic")).update("event-1." + timestamp + "." + body).digest("base64");
  return { providerId: "resend_email", workspaceId: "workspace", rawBody: Buffer.from(body), headers: {
    "svix-id": "event-1", "svix-timestamp": timestamp, "svix-signature": "v1," + signature } };
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
      expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false });
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

it("verifies raw Svix bytes before suppression and makes repeated recipients/replays harmless", async () => {
  const f = make();
  const event = webhook();
  expect(await f.ingest.handle(event)).toMatchObject({ status: 200, body: { applied: 1 } });
  expect(await f.ingest.handle(event)).toMatchObject({ status: 200, body: { duplicates: 1 } });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "MAIL_RECIPIENT_SUPPRESSED" });
  expect(f.requests).toHaveLength(0);
});
it("rejects tampered, stale, missing-secret and oversized feedback with no suppression", async () => {
  const f = make();
  const event = webhook();
  expect(await f.ingest.handle({ ...event, rawBody: Buffer.from(event.rawBody.toString() + " ") })).toMatchObject({ status: 401 });
  expect(await f.ingest.handle(webhook({ timestamp: now / 1000 - 301 }))).toMatchObject({ status: 401 });
  const parser = provider().feedback!;
  expect(parser.verify({ ...event, secrets: [], now })).toBe(false);
  expect(await f.ingest.handle({ ...event, rawBody: Buffer.alloc(262145) })).toMatchObject({ status: 413 });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
});
it("passes the stable idempotency key and refuses duplicate header casing", async () => {
  const f = make();
  expect(await f.inner.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(f.requests[0]!.request.headers).toMatchObject({ "Idempotency-Key": "delivery-1" });
  expect(await f.inner.send({ ...mailInput, message: { ...mailInput.message, headers: { ...mailInput.message.headers, "list-unsubscribe": mailInput.message.headers["List-Unsubscribe"] } } }, { purpose: "bulk" }))
    .toMatchObject({ ok: false, errorCode: "invalid_unsubscribe" });
  expect(f.requests).toHaveLength(1);
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
it("reads configured domain DNS with the same Full access credential and rejects foreign evidence", async () => {
  const module = provider();
  const calls: { request: { url: string; headers?: Readonly<Record<string, string>> } }[] = [];
  const ctx = { workspaceId: "workspace", mode: "test" as const, credential: { token: "synthetic-full-access-token" }, httpClient: { async send(input: { request: { url: string; headers?: Readonly<Record<string, string>> } }) {
    calls.push(input); return { status: 200, bodyText: JSON.stringify({ id: domainId, name: "example.com", status: "verified", records: [{ type: "TXT", name: "resend._domainkey", value: "fixture" }] }), headers: {} };
  } } };
  expect(await module.domainRequirements!(ctx, { domain: "example.com" })).toMatchObject({ status: "ok", value: {
    providerId: "resend_email", records: [{ name: "resend._domainkey.example.com", type: "TXT" }] } });
  expect(await module.domainStatus!(ctx, { domain: "example.com" })).toMatchObject({ status: "ok", value: { state: "verified" } });
  expect(calls[0]!.request).toMatchObject({ url: "https://api.resend.com/domains/" + domainId, headers: { Authorization: "Bearer synthetic-full-access-token" } });
  expect(await module.domainStatus!(ctx, { domain: "foreign.example" })).toMatchObject({ status: "rejected" });
  const f = make();
  expect(await f.inner.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(f.requests[0]!.request.headers).toMatchObject({ Authorization: "Bearer synthetic-full-access-token" });
});
it("complaints suppress bulk without blocking transactional sign-in mail", async () => {
  const f = make();
  expect(await f.ingest.handle(webhook({ type: "email.complained" }))).toMatchObject({ status: 200 });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: false, errorCode: "MAIL_RECIPIENT_SUPPRESSED" });
  expect(await f.mailer.send(mailInput, { purpose: "transactional" })).toMatchObject({ ok: true });
  expect(f.requests).toHaveLength(1);
});

/** Ordinary HTTP has no policy checks: only the provider's authority callback prevents egress. */
function direct(required: { authority: ProviderArgs["authority"] }) {
  const requests: unknown[] = [];
  const mailer = createResendMailProvider({ clock: { now: () => now }, domainId, ...required }).create({ credential: { token: "synthetic-full-access-token" }, kit: { httpClient: { async send(input) {
    requests.push(input);
    return { status: 200, bodyText: JSON.stringify({ id: "fixture-message" }), headers: {} };
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

it("retains Jini test redirect and original-recipient headers in the Resend payload", async () => {
  const f = make({ redirectTo: "safe@example.net" });
  expect(await f.mailer.send(mailInput, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(JSON.parse(String(f.requests[0]!.request.body))).toMatchObject({ to: ["safe@example.net"], headers: {
    "X-Original-To": "recipient@example.net", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  } });
});

it.each(["Bcc", "bCc", "To", "FROM", "Cc", "Sender", "Reply-To", "Subject", "Return-Path", "Message-ID", "Date", "MIME-Version", "Content-Type", "Content-Transfer-Encoding"])("rejects reserved header %s before authority or HTTP", async header => {
  let checks = 0;
  const f = direct({ authority: async ({ execute }) => { checks++; return execute(); } });
  expect(await f.mailer.send({ ...mailInput, message: { ...mailInput.message, headers: { ...mailInput.message.headers, [header]: "other@example.net" } } }, { purpose: "bulk" }))
    .toMatchObject({ ok: false, errorCode: "invalid_unsubscribe" });
  expect(checks).toBe(0); expect(f.requests).toHaveLength(0);
});
it("preserves allowed custom headers through authority and the Resend payload", async () => {
  let checks = 0;
  const f = direct({ authority: async ({ execute }) => { checks++; return execute(); } });
  const headers = { ...mailInput.message.headers, "X-Trace": "fixture-trace" };
  expect(await f.mailer.send({ ...mailInput, message: { ...mailInput.message, headers } }, { purpose: "bulk" })).toMatchObject({ ok: true });
  expect(checks).toBe(1); expect(f.requests).toHaveLength(1);
  expect(f.requests[0]).toMatchObject({ request: { body: expect.stringContaining('"X-Trace":"fixture-trace"') } });
});
