import { describe, expect, it } from "vitest";
import { conversionInput, invocation } from "../fixtures.js";
import type { CapiFixture, Fixture } from "../fixtures.js";

/** Addons must bind its real gateway adapter to this SAME suite after composition lands.
 * Tests assert public receipts and actual vendor request bytes, not private implementation state.
 */
export function dispatchSuite(required: { name: string; makeFixture: () => Fixture }): void {
  describe(required.name + " LinkedIn dispatch contract", () => {
    it("creates DRAFT once and retains the candidate group ID with an unknown outcome", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation())).toEqual({ ok: true, value: { operationId: "operation", status: "unknown", observedState: "unknown", data: { id: "456" } } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://api.linkedin.com/rest/adAccounts/123/adCampaignGroups");
      expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ account: "urn:li:sponsoredAccount:123", name: "Fixture group", runSchedule: { start: 1791849600000, end: 1791936000000 }, totalBudget: { amount: "43.21", currencyCode: "USD" }, status: "DRAFT" });
      expect(f.credentialCalls).toEqual([{ connectionId: "connection", accountId: "123" }]);
    });
    it("requires an exact spend card for each activation and later budget call", async () => {
      const f = required.makeFixture();
      expect(await f.adapter.invoke(invocation({ command: { kind: "activate", entityType: "campaign", entityId: "567" }, operationId: "activation" }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke(invocation({ command: { kind: "set_budget", campaignId: "567", dailyBudget: { amount: "54.32", currencyCode: "USD" } }, operationId: "budget" }))).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0);
      expect(f.effects.map(effect => effect.effects)).toEqual([["ad_spend"], ["ad_spend"]]);
    });
    it("denies normal writes after halt and when admission is absent", async () => {
      const f = required.makeFixture();
      f.state.halted = true;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      f.state.halted = false; f.state.admitted = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0);
    });
    it("deduplicates the same stable operation and rejects changed arguments", async () => {
      const f = required.makeFixture();
      const first = await f.adapter.invoke(invocation());
      expect(await f.adapter.invoke(invocation())).toEqual(first);
      expect(await f.adapter.invoke(invocation({ command: { ...invocation().command, name: "Changed group" } as ReturnType<typeof invocation>["command"] }))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.calls).toHaveLength(1);
    });
    it("rejects foreign scope, ACTIVE payload inflation and cancelled calls before I/O", async () => {
      const f = required.makeFixture();
      const input = invocation();
      expect(await f.adapter.invoke({ ...input, context: { ...input.context, scope: { ownerId: "foreign", workspaceId: "workspace" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await f.adapter.invoke({ ...input, command: { ...input.command, status: "ACTIVE" } } as unknown as ReturnType<typeof invocation>)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      const controller = new AbortController(); controller.abort();
      expect(await f.adapter.invoke(input, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0); expect(f.credentialCalls).toHaveLength(0);
    });
    it("never leaks token data through results or observations", async () => {
      const f = required.makeFixture();
      const response = await f.adapter.invoke(invocation());
      expect(JSON.stringify({ response, observations: f.observations })).not.toContain("synthetic-secret");
      expect(f.observations).toEqual([{ operation: "linkedin-ads.create_campaign_group_draft", outcome: "unknown", correlationId: "correlation", traceId: "trace", runId: "run" }]);
    });
  });
}

/** One CAPI authority acceptance suite for memory and the addons real host adapter. */
export function conversionDispatchSuite(required: { name: string; makeFixture: () => CapiFixture }): void {
  describe(required.name + " LinkedIn conversion authority contract", () => {
    it("delivers one unchanged contacts digest and shared event ID under the durable delivery key", async () => {
      const f = required.makeFixture();
      expect(await f.backend.deliver(conversionInput())).toEqual({ ok: true, value: { status: "delivered" } });
      expect(f.calls).toHaveLength(1);
      expect(f.calls[0].url).toBe("https://api.linkedin.com/rest/conversionEvents");
      expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ conversion: "urn:lla:llaPartnerConversion:789", conversionHappenedAt: 1791849600000, eventId: "om-event", user: { userIds: [{ idType: "SHA256_EMAIL", idValue: "a".repeat(64) }] } });
      expect(f.dispatches[0]).toMatchObject({ deliveryId: "delivery", event: { definitionId: "signup", identifierDigests: { email: "b".repeat(64) } } });
    });
    it("does not send a delivery key twice and rejects changed payload under the same key", async () => {
      const f = required.makeFixture();
      const first = await f.backend.deliver(conversionInput());
      expect(await f.backend.deliver(conversionInput())).toEqual(first);
      const changed = conversionInput(); changed.event.eventId = "different-event";
      expect(await f.backend.deliver(changed)).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.calls).toHaveLength(1);
    });
    it("denies egress when current consent is absent", async () => {
      const f = required.makeFixture(); f.capiState.consent = false;
      expect(await f.backend.deliver(conversionInput())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.calls).toHaveLength(0);
    });
  });
}
