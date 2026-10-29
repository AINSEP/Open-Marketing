import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { pluginConfigurationSchema } from "@open-marketing/contracts";
import type { PluginCapabilityDependencies } from "@open-marketing/contracts";
import { ingestWebhook } from "../src/index.js";
import { resourceBinding as binding } from "./fixtures.js";
const card = { accessToken: "fixture-token", wabaId: binding.wabaId, phoneNumberId: binding.phoneNumberId, appSecret: "fixture-app-secret" };
/** Server-shaped configuration and fresh credentials; settings cannot select a foreign asset. */
function dependencies(required: { card?: Record<string, unknown>; workspaceId?: string } = {}): PluginCapabilityDependencies {
  return { configuration: pluginConfigurationSchema.parse({ scope: { ...binding.scope, workspaceId: required.workspaceId ?? binding.scope.workspaceId },
    connectionId: "connection", accountId: binding.wabaId, pluginDigest: "a".repeat(64), settings: {} }),
    credentials: { access: vi.fn(async () => ({ ok: true as const, value: { accessToken: JSON.stringify(required.card ?? card) } })) },
    fetch: vi.fn(async () => { throw new Error("No egress"); }), clock: { now: () => 1000 }, observer: { observe() {} }, wait: async () => ({ ok: true, value: undefined }) };
}
function value(required: { body?: string; phoneNumberId?: string; count?: number } = {}) {
  return { metadata: { phone_number_id: required.phoneNumberId ?? binding.phoneNumberId },
    messages: Array.from({ length: required.count ?? 1 }, (_, i) => ({ id: "wamid.incoming-" + i, from: "15555550100", timestamp: "1792886400", type: "text", text: { body: required.body ?? "STOP" } })) };
}
function webhook(required: { entries?: unknown[] } = {}) {
  const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: required.entries ?? [{ id: binding.wabaId, changes: [{ field: "messages", value: value() }] }] }));
  return { dependencies: dependencies(), path: "/hooks/agent-plugins/fixture/connection/account", rawBody,
    headers: { "x-hub-signature-256": "sha256=" + createHmac("sha256", card.appSecret).update(rawBody).digest("hex") } };
}
function preference(required: { waId?: string; category?: string; preference?: string; timestamp?: unknown } = {}) {
  return { wa_id: required.waId ?? "opaque-user-id", category: required.category ?? "marketing_messages", value: required.preference ?? "stop", timestamp: required.timestamp ?? 1792886400 };
}
function preferenceChange(required: { items?: unknown[]; phoneNumberId?: string } = {}) {
  return { field: "user_preferences", value: { metadata: { phone_number_id: required.phoneNumberId ?? binding.phoneNumberId }, user_preferences: required.items ?? [preference()] } };
}
it("returns stable STOP events through the real generic entry with call-local server credentials", async () => {
  const event = webhook();
  const expected = { ok: true, value: { events: [{ kind: "stop", eventId: "wamid.incoming-0:stop", waId: "15555550100", recipient: "+15555550100",
    providerMessageId: "wamid.incoming-0", occurredAt: "2026-10-25T00:00:00.000Z", channel: "whatsapp" }] } };
  expect(await ingestWebhook(event)).toEqual(expected);
  expect(await ingestWebhook(event)).toEqual(expected);
  expect(event.dependencies.credentials.access).toHaveBeenCalledTimes(2);
  expect(event.dependencies.fetch).not.toHaveBeenCalled();
});
it("rejects byte tampering and late foreign assets before returning any batch", async () => {
  const event = webhook();
  expect(await ingestWebhook({ ...event, rawBody: Buffer.from(event.rawBody.toString() + " ") })).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
  for (const foreign of [{ id: "999", changes: [{ field: "messages", value: value() }] },
    { id: binding.wabaId, changes: [{ field: "messages", value: value({ phoneNumberId: "999" }) }] }]) {
    expect(await ingestWebhook(webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "messages", value: value() }] }, foreign] }))).toMatchObject({ ok: false });
  }
});
it("requires appSecret before parsing, binds credential assets and returns secret-free failures", async () => {
  for (const invalid of [{ ...card, appSecret: undefined }, { ...card, accessToken: { secret: "fixture-token" } }]) {
    const result = await ingestWebhook({ ...webhook(), rawBody: Buffer.from("invalid"), dependencies: dependencies({ card: invalid }) });
    expect(result).toMatchObject({ ok: false, error: { code: "unauthenticated" } });
    expect(JSON.stringify(result)).not.toMatch(/fixture-token|fixture-app-secret|15555550100/);
  }
  expect(await ingestWebhook({ ...webhook(), dependencies: dependencies({ card: { ...card, wabaId: "999" } }) })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  expect(await ingestWebhook({ ...webhook(), rawBody: Buffer.alloc(262145) })).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
});
it.each(["stop.", " Unsubscribe! ", "CANCEL", "end", "quit", "revoke", "opt-out", "STOPALL", "Stop promotions", "Stop promotions!", "Detener promociones", "¡Detener promociones!"])("recognizes whole opt-out %s in text and both button fields", async body => {
  for (const message of [{ type: "text", text: { body } }, { type: "button", button: { text: body, payload: "unrelated" } }, { type: "button", button: { text: "unrelated", payload: body } }]) {
    const v = value();
    expect(await ingestWebhook(webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "messages", value: { ...v, messages: [{ ...v.messages[0], ...message }] } }] }] })))
      .toMatchObject({ ok: true, value: { events: [{ kind: "stop", recipient: "+15555550100" }] } });
  }
});
it.each(["START", "HELP", "don't stop", "unstoppable", "stop promotions please"])("ignores non-keyword %s", async body => {
  expect(await ingestWebhook(webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "messages", value: value({ body }) }] }] }))).toEqual({ ok: true, value: { events: [] } });
});
it("preserves STOP and distinct delivery projections while skipping future fields/statuses", async () => {
  const event = webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "future_field", value: {} }, { field: "messages", value: { ...value(),
    statuses: [{ status: "future_status" }, ...["sent", "delivered"].map(status => ({ id: "wamid.outbound", recipient_id: "15555550100", timestamp: "1792886400", status }))] } }] }] });
  const result = await ingestWebhook(event);
  expect(result).toMatchObject({ ok: true });
  if (!result.ok) throw new Error("Expected fixture events");
  expect(result.value.events).toHaveLength(3);
  expect(result.value.events).toContainEqual(expect.objectContaining({ kind: "delivery", status: "sent" }));
  expect(result.value.events).toContainEqual(expect.objectContaining({ kind: "delivery", status: "delivered" }));
  expect(result.value.events).toContainEqual(expect.objectContaining({ kind: "stop" }));
});
it("preserves phone-less wa_id and BSUID without inventing a recipient; resume has no effect", async () => {
  const { wa_id: _unused, ...item } = preference();
  const event = webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "messages", value: value() }, preferenceChange({ items: [preference(),
    { ...item, user_id: "US.13491208655302741918" }, item, preference({ preference: "resume" }), preference({ category: "future" }), preference({ preference: "future" })] })] }] });
  const result = await ingestWebhook(event);
  if (!result.ok) throw new Error("Expected fixture events");
  expect(result.value.events).toHaveLength(3);
  expect(result.value.events[1]).toEqual({ kind: "stop", waId: "opaque-user-id", eventId: expect.stringMatching(/^[a-f0-9]{64}$/), occurredAt: "2026-10-25T00:00:00.000Z", channel: "whatsapp" });
  expect(result.value.events[2]).toEqual({ kind: "stop", userId: "US.13491208655302741918", eventId: expect.stringMatching(/^[a-f0-9]{64}$/), occurredAt: "2026-10-25T00:00:00.000Z", channel: "whatsapp" });
  expect(await ingestWebhook(event)).toEqual(result);
});
it("binds preference IDs to scope, raw identity and vendor time", async () => {
  const event = webhook({ entries: [{ id: binding.wabaId, changes: [preferenceChange({ items: [preference(), preference({ waId: "other" }), preference({ timestamp: 1792886401 })] })] }] });
  const first = await ingestWebhook(event);
  const second = await ingestWebhook({ ...event, dependencies: dependencies({ workspaceId: "other" }) });
  if (!first.ok || !second.ok) throw new Error("Expected fixture events");
  expect(new Set([...first.value.events, ...second.value.events].map(e => e.eventId)).size).toBe(6);
});
it("validates preference time/assets and aggregate bounds before returning a mixed batch", async () => {
  for (const change of [preferenceChange({ phoneNumberId: "999" }), preferenceChange({ items: [preference({ timestamp: -1 })] }), preferenceChange({ items: [preference({ timestamp: "invalid" })] })]) {
    expect(await ingestWebhook(webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "messages", value: value() }, change] }] }))).toMatchObject({ ok: false });
  }
  for (const extra of [{ field: "messages", value: value() }, preferenceChange()]) {
    expect(await ingestWebhook(webhook({ entries: [{ id: binding.wabaId, changes: [{ field: "messages", value: value({ count: 100 }) }, extra] }] }))).toMatchObject({ ok: false });
  }
  const hundred = await ingestWebhook(webhook({ entries: [{ id: binding.wabaId, changes: [preferenceChange({ items: Array.from({ length: 100 }, (_, i) => preference({ timestamp: 1792886400 + i })) })] }] }));
  if (!hundred.ok) throw new Error("Expected fixture events");
  expect(hundred.value.events).toHaveLength(100);
});
