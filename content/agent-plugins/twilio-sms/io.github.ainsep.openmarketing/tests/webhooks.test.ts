import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies } from "@open-marketing/contracts";
import { ingestWebhook } from "../src/index.js";
import { resourceBinding as binding } from "./fixtures.js";
const sender = "+15555550200";
const path = "/hooks/agent-plugins/fixture/connection/account";
const webhookUrl = "https://example.com" + path;
const card = { accountSid: binding.accountSid, apiKeySid: "SK" + "a".repeat(32), apiKeySecret: "fixture-key-secret",
  authToken: "fixture-auth-token", messagingServiceSid: binding.messagingServiceSid, webhookUrl };
/** Exact server envelope and call-local credential broker; no external fetch can run. */
function dependencies(required: { card?: Record<string, unknown>; sender?: string } = {}): PluginCapabilityDependencies {
  return { configuration: pluginConfigurationSchema.parse({ scope: binding.scope, connectionId: "connection", accountId: binding.accountSid,
    pluginDigest: "a".repeat(64), settings: { sender: required.sender } }),
    credentials: { access: vi.fn(async () => ({ ok: true as const, value: { accessToken: JSON.stringify(required.card ?? card) } })) },
    fetch: vi.fn(async () => { throw new Error("No egress"); }), clock: { now: () => 1000 }, observer: { observe() {} },
    wait: async () => ({ ok: true, value: undefined }) };
}
/** Independent documented URL + sorted form fields signature. */
function webhook(required: { fields?: Record<string, string>; noService?: boolean } = {}) {
  const fields: Record<string, string> = { AccountSid: binding.accountSid, MessageSid: "SM" + "c".repeat(32), MessagingServiceSid: binding.messagingServiceSid,
    To: sender, From: "+15555550100", Body: "STOP", MessageStatus: "received", ExtraVendorField: "also signed", ...required.fields };
  if (required.noService) delete fields.MessagingServiceSid;
  const canonical = webhookUrl + Object.keys(fields).sort().map(key => key + fields[key]).join("");
  return { dependencies: dependencies(), path, headers: { "x-twilio-signature": createHmac("sha1", card.authToken).update(canonical).digest("base64") },
    rawBody: Buffer.from(new URLSearchParams(fields).toString()) };
}
it("returns STOP via the real generic export and fresh server-shaped credentials; START/HELP never opt in", async () => {
  const event = webhook();
  const expected = { ok: true, value: { events: [{ kind: "stop", eventId: "SM" + "c".repeat(32) + ":stop", providerMessageId: "SM" + "c".repeat(32), recipient: "+15555550100", channel: "sms" }] } };
  expect(await ingestWebhook(event)).toEqual(expected);
  expect(await ingestWebhook(event)).toEqual(expected);
  expect(event.dependencies.credentials.access).toHaveBeenCalledTimes(2);
  for (const Body of ["START", "HELP"]) expect(await ingestWebhook(webhook({ fields: { Body } }))).toEqual({ ok: true, value: { events: [] } });
  expect(event.dependencies.fetch).not.toHaveBeenCalled();
});
it("projects delivery, pooled senders, Advanced Opt-Out and signed MMS without raw text", async () => {
  const variants: Record<string, string>[] = [{ Body: "custom", OptOutType: "STOP" }, { To: "+15555550999" },
    { MessageSid: "MM" + "c".repeat(32), NumMedia: "1", MediaUrl0: "https://example.com/fixture.jpg", MediaContentType0: "image/jpeg" }];
  for (const fields of variants) {
    expect(await ingestWebhook(webhook({ fields }))).toMatchObject({ ok: true, value: { events: [expect.objectContaining({ kind: "stop", recipient: "+15555550100" })] } });
  }
  expect(await ingestWebhook(webhook({ fields: { From: "+15555550999", To: "+15555550100", MessageStatus: "delivered", Body: "" } })))
    .toMatchObject({ ok: true, value: { events: [{ kind: "delivery", status: "delivered", recipient: "+15555550100" }] } });
});
it("rejects forged/foreign signatures, path and credential bindings with secret-free errors", async () => {
  const event = webhook();
  const cases = [{ ...event, path: "/other" }, { ...event, rawBody: Buffer.from(event.rawBody.toString().replace("also+signed", "tampered")) },
    { ...event, rawBody: Buffer.from(event.rawBody.toString() + "&Body=START") }, webhook({ fields: { AccountSid: "AC" + "f".repeat(32) } }),
    webhook({ fields: { MessagingServiceSid: "MG" + "e".repeat(32) } }), webhook({ noService: true }), { ...event, rawBody: Buffer.alloc(262145) }];
  for (const invalid of cases) {
    const result = await ingestWebhook(invalid);
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toMatch(/fixture-auth-token|fixture-key-secret|15555550100/);
  }
  for (const signature of ["x", "A".repeat(28), "A".repeat(27) + "="]) expect(await ingestWebhook({ ...event, headers: { "x-twilio-signature": signature } })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
});
it("requires auth token before parsing and an exact configured HTTPS URL without query", async () => {
  const event = webhook();
  expect(await ingestWebhook({ ...event, rawBody: Buffer.from("invalid"), dependencies: dependencies({ card: { ...card, authToken: undefined } }) })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  for (const url of [undefined, "invalid-url", "http://example.com" + path, webhookUrl + "?route=fixture"]) {
    expect(await ingestWebhook({ ...event, dependencies: dependencies({ card: { ...card, webhookUrl: url } }) })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  }
  const malformed = await ingestWebhook({ ...event, dependencies: dependencies({ card: { ...card, apiKeySecret: { token: "fixture-key-secret" } } }) });
  expect(malformed).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  expect(JSON.stringify(malformed)).not.toContain("fixture-key-secret");
});
it("accepts optional sender binding without a service and signs every field regardless of wire order", async () => {
  const event = webhook();
  const reversed = [...new URLSearchParams(event.rawBody.toString()).entries()].reverse();
  expect(await ingestWebhook({ ...event, rawBody: Buffer.from(new URLSearchParams(reversed).toString()) })).toMatchObject({ ok: true });
  const noService = { ...card, messagingServiceSid: undefined };
  expect(await ingestWebhook({ ...webhook({ noService: true }), dependencies: dependencies({ card: noService, sender }) })).toMatchObject({ ok: true });
  expect(await ingestWebhook({ ...webhook({ fields: { To: "+15555550999" }, noService: true }), dependencies: dependencies({ card: noService, sender }) })).toMatchObject({ ok: false });
});
it.each(["MM" + "c".repeat(31), "MM" + "g".repeat(32), "XX" + "c".repeat(32), "SM" + "c".repeat(33)])("rejects signed malformed message ID %s", async MessageSid => {
  expect(await ingestWebhook(webhook({ fields: { MessageSid } }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
});
