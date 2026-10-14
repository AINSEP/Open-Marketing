import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTikTokAdsAdapter, encodeTikTokCommand } from "../../src/index.js";
import type { TikTokInvocation } from "../../src/index.js";
import { ad, adgroup, adgroupResponse, binding, campaign, campaignResponse, clock, context, gatewayFixture, haltPermit, invocation, limit, exposure, now, pageInfo, vendorResponse } from "../fixtures.js";
import type { GatewayFixture } from "../fixtures.js";

/** Portable contract for the host gateway. Coordinator must supply the real server fixture
 * to this suite after integration; current runs cover the policy double + memory/fetch egress.
 */
export function tiktokGatewaySuite(required: { createFixture: () => GatewayFixture }): void {
  describe("TikTok gateway contract", () => {
    it.each([{ command: campaign, path: "campaign/create/", id: "456" }, { command: adgroup, path: "adgroup/create/", id: "457" }, { command: ad, path: "ad/create/", id: "458" }])("creates $path disabled under a normal write and reads only the created entity", async ({ command, path, id }) => {
      const f = required.createFixture();
      expect(await f.adapter.invoke(invocation({ command }))).toMatchObject({ ok: true, value: { status: "succeeded", observedState: "disabled", entityIds: [id], observedAt: now } });
      expect(f.calls).toHaveLength(2);
      expect(f.calls[0].effect).toMatchObject({ effects: ["write"], moneyExposure: null, requiredLimit: null });
      expect(f.calls[1].effect.effects).toEqual(["read"]);
      expect(f.calls[1].call.request.kind).toBe(command.kind === "create-ad-paused" ? "get-ads" : command.kind === "create-adgroup-paused" ? "get-adgroups" : "get-campaigns");
      expect(f.egress.sent[0]).toContain(path);
      const encoded = encodeTikTokCommand({ input: command, accountId: "123" });
      expect(encoded.ok).toBe(true);
      if (!encoded.ok || encoded.value.method !== "POST") throw new Error("Fixture write must encode");
      const body = encoded.value.body;
      expect(command.kind === "create-ad-paused" ? (body.creatives as Record<string, unknown>[])[0].operation_status : body.operation_status).toBe("DISABLE");
      expect(f.claims.size).toBe(1);
    });
    it("binds the exact vendor arguments to the stable operation and schema", async () => {
      const f = required.createFixture();
      await f.adapter.invoke(invocation());
      const expected = createHash("sha256").update('{"advertiser_id":"123","budget":20,"budget_mode":"BUDGET_MODE_DAY","campaign_name":"Fixture campaign","objective_type":"TRAFFIC","operation_status":"DISABLE"}').digest("hex");
      expect(f.calls[0].call).toMatchObject({ operationId: "operation", connectionId: "connection", accountId: "123", pluginDigest: binding.pluginDigest, argumentsDigest: expected, schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(f.calls[0].effect.argumentsDigest).toBe(expected);
    });
    it("rejects a created child readback attached to a different parent without parent preflight", async () => {
      const f = required.createFixture();
      f.state.responseFor = input => input.path === "adgroup/get/" ? { code: 0, data: { ...adgroupResponse.data, list: [{ ...adgroupResponse.data.list[0], campaign_id: "999" }] } } : vendorResponse(input);
      expect(await f.adapter.invoke(invocation({ command: adgroup }))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.calls.map(call => call.call.request.kind)).toEqual(["create-adgroup-paused", "get-adgroups"]);
    });
    it.each(["ENABLE", "DELETE", "UNKNOWN"])("returns explicit failure on %s create readback without auto-pausing", async status => {
      const f = required.createFixture();
      f.state.responseFor = input => input.path === "campaign/get/" ? { code: 0, data: { ...campaignResponse.data, list: [{ ...campaignResponse.data.list[0], operation_status: status }] } } : vendorResponse(input);
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict", message: expect.stringContaining("456") } });
      expect(f.calls.map(call => call.call.request.kind)).toEqual(["create-campaign-paused", "get-campaigns"]);
      expect(f.egress.sent).toHaveLength(2);
    });
    it.each([
      { code: 0, data: { list: [], page_info: { ...pageInfo, total_number: 0, total_page: 0 } } },
      { code: 0, data: { list: [], page_info: pageInfo } },
      { code: 0, data: { ...campaignResponse.data, list: [{ ...campaignResponse.data.list[0], advertiser_id: "999" }] } },
      { code: 0, data: { ...campaignResponse.data, list: [{ ...campaignResponse.data.list[0], campaign_id: "999" }] } },
      { code: 0, data: { ...campaignResponse.data, list: [campaignResponse.data.list[0], campaignResponse.data.list[0]], page_info: { ...pageInfo, total_number: 2 } } },
    ])("does not promote incomplete/foreign/duplicate readback to DISABLE", async body => {
      const f = required.createFixture(); f.state.responseFor = input => input.path === "campaign/get/" ? body : vendorResponse(input);
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.calls).toHaveLength(2);
    });
    it.each([{ code: 0, data: {} }, { code: 0, data: { campaign_id: "invalid" } }, { code: 0 }, { code: 1, message: "fixture-token" }])("keeps malformed creation receipts unknown, never repeats the POST", async body => {
      const f = required.createFixture(); f.state.responseFor = () => body;
      const result = await f.adapter.invoke(invocation());
      expect(result).toMatchObject({ ok: true, value: { status: "unknown", observedState: "unknown", data: null } });
      expect(f.calls).toHaveLength(1); expect(f.egress.sent).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("fixture-token");
    });
    it("does not resend duplicate claims or changed arguments under the same key", async () => {
      const f = required.createFixture();
      expect((await f.adapter.invoke(invocation())).ok).toBe(true);
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await f.adapter.invoke(invocation({ command: { kind: "create-campaign-paused", name: "Changed", budget: 30 } }))).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.egress.sent).toHaveLength(2); // One POST and its readback only.
    });
    it("requires a fresh exact spend card for EVERY activation and forwards existing money fields", async () => {
      const f = required.createFixture();
      const activate: TikTokInvocation = { ...invocation({ command: { kind: "activate-entity", entityType: "campaign", entityId: "456" }, operationId: "activate-1" }), moneyExposure: exposure, requiredLimit: limit };
      expect(await f.adapter.invoke(activate)).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.egress.sent).toHaveLength(0);
      f.state.exactApprovals.add("activate-1");
      f.state.responseFor = input => input.path === "campaign/get/" ? { code: 0, data: { ...campaignResponse.data, list: [{ ...campaignResponse.data.list[0], operation_status: "ENABLE" }] } } : vendorResponse(input);
      expect(await f.adapter.invoke(activate)).toMatchObject({ ok: true, value: { observedState: "enabled" } });
      expect(f.calls[1].effect).toMatchObject({ effects: ["ad_spend"], moneyExposure: exposure, requiredLimit: limit });
      expect(await f.adapter.invoke({ ...activate, operationId: "activate-2" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.egress.sent).toHaveLength(2);
      const encoded = encodeTikTokCommand({ input: activate.command, accountId: "123" });
      expect(encoded).toMatchObject({ ok: true, value: { path: "campaign/status/update/", body: { advertiser_id: "123", campaign_ids: ["456"], operation_status: "ENABLE" } } });
    });
    it("rejects missing activation envelope fields before gateway dispatch", async () => {
      const f = required.createFixture();
      expect(await f.adapter.invoke(invocation({ command: { kind: "activate-entity", entityType: "ad", entityId: "458" } }))).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(f.calls).toHaveLength(0);
    });
    it.each([{ type: "campaign" as const, id: "456" }, { type: "adgroup" as const, id: "457" }, { type: "ad" as const, id: "458" }])("pauses $type as a normal write", async ({ type, id }) => {
      const f = required.createFixture();
      expect(await f.adapter.invoke(invocation({ command: { kind: "pause-entity", entityType: type, entityId: id } }))).toMatchObject({ ok: true, value: { observedState: "disabled", entityIds: [id] } });
      expect(f.calls[0].effect.effects).toEqual(["write"]);
      expect(encodeTikTokCommand({ input: f.calls[0].call.request, accountId: "123" })).toMatchObject({ ok: true, value: { path: `${type}/status/update/`, body: { [`${type}_ids`]: [id], operation_status: "DISABLE" } } });
    });
    it.each(["admitted", "current"] as const)("denies withdrawn host %s", async field => {
      const f = required.createFixture(); f.state[field] = false;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.egress.sent).toHaveLength(0);
    });
    it("fences a write revoked during credential resolution", async () => {
      const f = required.createFixture(); f.egress.state.onAccess = () => { f.state.current = false; };
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.egress.sent).toHaveLength(0);
    });
    it("returns unknown on gateway loss and never retries", async () => {
      const f = required.createFixture(); f.state.throwGateway = true;
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(f.calls).toHaveLength(1);
      expect(JSON.stringify(f.observations)).not.toContain("fixture-token");
    });
    it.each(["unavailable", "cancelled", "protocol_mismatch", "limit_exceeded"] as const)("keeps typed %s write uncertainty unknown", async code => {
      const f = required.createFixture(); f.state.gatewayError = { code, message: "fixture-token", retryable: false };
      expect(await f.adapter.invoke(invocation())).toMatchObject({ ok: true, value: { status: "unknown" } });
      expect(f.calls).toHaveLength(1);
    });
    it("cancels before gateway invocation", async () => {
      const f = required.createFixture(); const controller = new AbortController(); controller.abort();
      expect(await f.adapter.invoke(invocation(), { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(f.calls).toHaveLength(0);
    });
    it("keeps read failures explicit, while admitting ordinary reads", async () => {
      const f = required.createFixture();
      expect(await f.adapter.invoke(invocation({ command: { kind: "get-advertiser" } }))).toMatchObject({ ok: true, value: { status: "succeeded", data: { code: 0, data: { list: [{ advertiser_id: "123" }] } } } });
      expect(f.calls[0].effect.effects).toEqual(["read"]);
      f.state.throwGateway = true;
      expect(await f.adapter.invoke(invocation({ command: { kind: "get-advertiser" } }))).toMatchObject({ ok: false, error: { code: "unavailable" } });
    });
    it("dispatches campaign halt only with the typed permit and no money authority", async () => {
      const f = required.createFixture(); const permit = haltPermit();
      expect(await f.adapter.stop({ context, permit })).toMatchObject({ ok: true, value: { observedState: "disabled", entityIds: ["456"] } });
      expect(f.calls[0]).toMatchObject({ call: { request: { kind: "halt-stop", campaignIds: ["456"] }, haltStopPermit: permit }, effect: { effects: ["halt_stop"], moneyExposure: null, requiredLimit: null } });
      expect(f.calls[1].call.haltStopPermit).toBeUndefined();
      expect(await f.adapter.stop({ context, permit })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(f.egress.sent).toHaveLength(2);
    });
    it("checks current halt authority on the host after local permit validation", async () => {
      const f = required.createFixture(); f.state.haltCurrent = false;
      expect(await f.adapter.stop({ context, permit: haltPermit() })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(f.egress.sent).toHaveLength(0);
    });
  });
}
for (const kind of ["memory", "fetch"] as const) describe(kind, () => tiktokGatewaySuite({ createFixture: () => gatewayFixture({ kind }) }));

describe("closed invocation and halt boundaries", () => {
  it.each([
    { ...invocation(), context: { ...context, scope: { ...context.scope, workspaceId: "foreign" } } },
    { ...invocation(), command: { ...campaign, operation_status: "ENABLE" } },
    { ...invocation(), command: { ...campaign, advertiser_id: "999" } },
    { ...invocation(), command: { ...campaign, accessToken: "fixture-token" } },
    { ...invocation(), command: { ...campaign, budget: -1 } },
    { ...invocation(), command: { ...adgroup, locationIds: ["1", "1"] } },
    { ...invocation(), command: { ...ad, landingPageUrl: "https://user:secret@example.com/" } },
    { ...invocation(), command: { kind: "halt-stop", campaignIds: ["456"] } },
  ])("rejects scope drift and unsupported command inflation", async input => {
    const f = gatewayFixture({ kind: "fetch" });
    expect((await f.adapter.invoke(input as TikTokInvocation)).ok).toBe(false);
    expect(f.calls).toHaveLength(0); expect(f.egress.sent).toHaveLength(0);
  });
  it.each(["accountId", "pluginDigest", "scope"])("rejects invalid %s binding", async field => {
    const f = gatewayFixture({ kind: "fetch" });
    const invalid = { ...binding, [field]: field === "scope" ? { ownerId: "foreign", workspaceId: "workspace" } : "invalid" };
    const adapter = createTikTokAdsAdapter({ binding: invalid, gateway: { invoke: async input => { f.calls.push(input); throw new Error("must not dispatch"); } }, clock, observer: { observe: () => undefined } });
    expect((await adapter.invoke(invocation())).ok).toBe(false); expect(f.calls).toHaveLength(0);
  });
  it.each(["account", "scope", "plugin", "binding", "digest", "expiry", "duplicate", "inflation"])("rejects mutated %s halt permit before dispatch", async field => {
    const f = gatewayFixture({ kind: "fetch" }); const permit = haltPermit();
    const mutations: Record<string, unknown> = {
      account: { ...permit, request: { ...permit.request, adAccountId: "999" } }, scope: { ...permit, request: { ...permit.request, scope: { ownerId: "foreign", workspaceId: "workspace" } } },
      plugin: { ...permit, request: { ...permit.request, pluginDigest: "c".repeat(64) } }, binding: { ...permit, request: { ...permit.request, bindingId: "foreign" } },
      digest: { ...permit, request: { ...permit.request, entityIds: ["999"] } }, expiry: { ...permit, expiresAt: now },
      duplicate: haltPermit({ entityIds: ["456", "456"] }), inflation: { ...permit, request: { ...permit.request, budget: 20 } },
    };
    expect((await f.adapter.stop({ context, permit: mutations[field] as ReturnType<typeof haltPermit> })).ok).toBe(false);
    expect(f.calls).toHaveLength(0); expect(f.egress.sent).toHaveLength(0);
  });
});
