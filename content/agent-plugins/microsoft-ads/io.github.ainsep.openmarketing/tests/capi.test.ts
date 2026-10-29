import { expect, it } from "vitest";
import { createConversionDelivery } from "../src/index.js";
import type { MicrosoftAdsConversionRequest } from "../src/index.js";
import { conversionFixture, conversionInput, now } from "./fixtures.js";
import { conversionDispatchSuite } from "./contract/dispatch-suite.js";

conversionDispatchSuite({ name: "Memory measurement authority with Microsoft REST transport", makeFixture: conversionFixture });

it("uploads one UTC hashed-email conversion with the server configuration envelope; acceptance is not attribution", async () => {
  const f = conversionFixture();
  expect(await f.backend.deliver(conversionInput())).toEqual({ ok: true, value: { status: "delivered" } });
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].url).toBe("https://campaign.api.bingads.microsoft.com/CampaignManagement/v13/OfflineConversions/Apply");
  expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ OfflineConversions: [{ ConversionName: "Existing purchase goal", ConversionTime: "2026-10-12T00:00:00.000Z", HashedEmailAddress: "a".repeat(64) }] });
  expect(f.credentials).toEqual(["connection"]);
  const headers = new Headers(f.calls[0].init.headers);
  expect(headers.get("CustomerId")).toBe("234");
  expect(headers.get("CustomerAccountId")).toBe("123");
  expect(JSON.stringify(f.observations)).not.toContain("a".repeat(64));
});
it.each(["malformed settings", "foreign mapping"] as const)("rejects %s without any authority/secret/network effect", async kind => {
  const f = conversionFixture();
  const settings = kind === "malformed settings" ? {} : { conversionConfiguration: { ...f.conversionConfiguration, accountId: "999" } };
  const backend = createConversionDelivery({ ...f.conversionDependencies, configuration: { ...f.conversionDependencies.configuration, settings } });
  const code = kind === "malformed settings" ? "invalid_input" : "forbidden";
  expect(await backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code } });
  expect(await backend.reconcile(conversionInput())).toMatchObject({ ok: false, error: { code } });
  expect(f.conversionDispatches).toEqual([]); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it.each([now + 1, now - 90 * 86400000 - 1])("rejects invalid occurrence %s before effects", async occurredAt => {
  const f = conversionFixture(), input = conversionInput(); input.event.occurredAt = occurredAt;
  expect(await f.backend.deliver(input)).toMatchObject({ ok: false, error: { code: "expired" } }); expect(f.credentials).toEqual([]);
});
it("accepts exactly 90 days and requires the full two-hour goal delay", async () => {
  const f = conversionFixture(), input = conversionInput(); input.event.occurredAt = now - 90 * 86400000;
  expect(await f.backend.deliver(input)).toMatchObject({ ok: true, value: { status: "delivered" } });
  const g = conversionFixture();
  g.conversionConfiguration.conversionGoals.purchase.createdAt++;
  expect(await createConversionDelivery(g.conversionDependencies).deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "not_implemented" } }); expect(g.credentials).toEqual([]);
});
it.each([{ email: "person@example.com" }, { email: "A".repeat(64) }, { email: "a".repeat(64), phone: "b".repeat(64) }])("rejects raw or inflated identifiers %j", async identifiers => {
  const f = conversionFixture(), input = conversionInput();
  expect(await f.backend.deliver({ ...input, event: { ...input.event, identifiers } } as MicrosoftAdsConversionRequest)).toMatchObject({ ok: false, error: { code: "invalid_input" } }); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it.each([{ connectionId: "foreign" }, { accountId: "999" }, { revoked: true }, { expiresAt: now }, { purpose: "foreign" }, { definitionIds: ["foreign"] }, { scope: { ownerId: "foreign", workspaceId: "workspace" } }])("rejects changed grant %j before effects", async change => {
  const f = conversionFixture(), input = conversionInput();
  expect(await f.backend.deliver({ ...input, grant: { ...input.grant, ...change } })).toMatchObject({ ok: false, error: { code: "forbidden" } }); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it.each([{ PartialErrors: [{ Code: 1, Message: "synthetic-secret" }] }, {}, "bad"])("keeps uncertain responses unknown without resubmission: %j", async response => {
  const f = conversionFixture(); f.state.responses = [response];
  expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.calls).toHaveLength(1);
});
it("reconciles unknown email-only deliveries with zero credentials/network", async () => {
  const f = conversionFixture();
  expect(await f.backend.reconcile(conversionInput())).toEqual({ ok: true, value: { status: "unknown" } });
  expect(f.calls).toEqual([]); expect(f.credentials).toEqual([]); expect(f.conversionDispatches).toEqual([]);
});
it("freezes payload and rechecks age after credentials before fetch", async () => {
  const f = conversionFixture(), input = conversionInput(); f.state.hook = () => { input.event.identifiers.email = "c".repeat(64); };
  expect(await f.backend.deliver(input)).toMatchObject({ ok: true, value: { status: "delivered" } });
  expect(JSON.parse(String(f.calls[0].init.body)).OfflineConversions[0].HashedEmailAddress).toBe("a".repeat(64));
  const g = conversionFixture(), old = conversionInput(); old.event.occurredAt = now - 90 * 86400000; g.state.hook = () => g.state.time++;
  expect(await g.backend.deliver(old)).toMatchObject({ ok: false }); expect(g.calls).toEqual([]);
});
it("requires enhanced-conversion goal eligibility before host effects", async () => {
  const f = conversionFixture(), config = f.conversionDependencies.configuration;
  expect(await createConversionDelivery({ ...f.conversionDependencies, configuration: { ...config, settings: { conversionConfiguration: { ...f.conversionConfiguration, conversionGoals: {} } } } }).deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  const input = conversionInput();
  expect(await f.backend.deliver(input, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(f.conversionDispatches).toEqual([]); expect(f.credentials).toEqual([]); expect(f.calls).toEqual([]);
});
it("retains unknown after egress/receipt loss and never issues an uncertain resend", async () => {
  const f = conversionFixture();
  const backend = createConversionDelivery({ ...f.conversionDependencies, fetch: async () => { throw new Error("synthetic-secret timeout"); } });
  expect(await backend.deliver(conversionInput())).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(await backend.deliver(conversionInput())).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.credentials).toEqual(["connection"]);
});
