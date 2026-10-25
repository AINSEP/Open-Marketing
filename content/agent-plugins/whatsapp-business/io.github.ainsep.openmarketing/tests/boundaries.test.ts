import { expect, it } from "vitest";
import { whatsappReadCommandSchema } from "../src/index.js";
import { fixture, invocation } from "./fixtures.js";

it.each([{ kind: "send" }, { kind: "get_account_status", accessToken: "secret" }, { kind: "list_senders", limit: 101 }, { kind: "list_templates", after: "x\n" }])("rejects unsupported/inflated command %j", async command => {
  const f = fixture();
  expect(whatsappReadCommandSchema.safeParse(command).success).toBe(false);
  expect(await f.adapter.invoke({ ...invocation(), command } as never)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(f.calls).toHaveLength(0); expect(f.credentials).toHaveLength(0);
});
it.each(["list_senders", "list_templates"] as const)("bounds %s pages and discards foreign next URLs", async kind => {
  const item = kind === "list_senders" ? { id: "456", quality_rating: "YELLOW", messaging_limit_tier: "VENDOR_FUTURE_TIER" } : { id: "789", name: "sale", language: "en_US", status: "PENDING", category: "MARKETING" };
  const f = fixture({ response: () => Response.json({ data: [{ ...item, access_token: "synthetic-secret" }], paging: { cursors: { after: "a&b" }, next: "https://evil.example/?access_token=secret" } }) });
  const result = await f.adapter.invoke(invocation({ command: { kind, limit: 1, after: "a&b" } }));
  expect(result).toEqual({ ok: true, value: { operationId: "operation", data: { items: [item], cursor: "a&b" } } });
  expect(f.calls).toHaveLength(1);
  const url = new URL(f.calls[0].url); expect(url.origin).toBe("https://graph.facebook.com"); expect(url.searchParams.get("after")).toBe("a&b");
  expect(url.pathname).toBe(kind === "list_senders" ? "/v26.0/123/phone_numbers" : "/v26.0/123/message_templates");
});
it.each([{ id: "999" }, { data: [{ id: 456 }] }, { data: Array.from({ length: 101 }, () => ({ id: "456" })) }, { data: [{ id: "456" }, { id: "bad" }] }, { data: [], paging: { next: "https://evil.example" } }])("rejects foreign/malformed/mixed/oversized provider data", async body => {
  const f = fixture({ response: () => Response.json(body) });
  const command = "id" in body ? { kind: "get_account_status" as const } : { kind: "list_senders" as const };
  expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
it("keeps absent account status unknown", async () => {
  expect(await fixture({ response: () => Response.json({ id: "123" }) }).adapter.invoke(invocation())).toEqual({ ok: true, value: { operationId: "operation", data: { id: "123" } } });
});
it.each(["bad-json", "x".repeat(1048577)])("bounds and parses provider bytes", async body => {
  const f = fixture({ response: () => new Response(body) });
  expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: body.length > 1048576 ? "limit_exceeded" : "protocol_mismatch" } });
  expect(f.calls).toHaveLength(1);
});
it("rejects cyclic and oversized input before credentials or network", async () => {
  const f = fixture(); const cyclic = { ...invocation(), cycle: {} }; cyclic.cycle = cyclic;
  expect(await f.adapter.invoke(cyclic)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  expect(await f.adapter.invoke({ ...invocation(), extra: "x".repeat(65537) } as never)).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
  expect(f.credentials).toHaveLength(0); expect(f.calls).toHaveLength(0);
});
it("returns a full 100-item final page without reusing its trailing cursor", async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1) }));
  const f = fixture({ response: () => Response.json({ data: items, paging: { cursors: { after: "end" } } }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "list_senders" } }))).toEqual({ ok: true, value: { operationId: "operation", data: { items, cursor: null } } });
  expect(f.calls).toHaveLength(1);
});
it("rejects a response exceeding the requested page size", async () => {
  const f = fixture({ response: () => Response.json({ data: [{ id: "456" }, { id: "789" }] }) });
  expect(await f.adapter.invoke(invocation({ command: { kind: "list_senders", limit: 1 } }))).toMatchObject({ ok: false, error: { code: "protocol_mismatch" } });
});
