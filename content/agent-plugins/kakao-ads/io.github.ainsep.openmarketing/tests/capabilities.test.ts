import { describe, expect, it } from "vitest";
import { pluginConfigurationSchema, campaignStatusOutputSchema } from "@open-marketing/contracts";
import type { CallContext, PluginCapabilityDependencies } from "@open-marketing/contracts";
import { createCapabilities } from "../src/index.js";
const scope = { ownerId: "owner", workspaceId: "workspace" };
const context: CallContext = { scope, principal: { kind: "owner", ownerId: "owner" }, correlationId: "correlation", traceId: "trace", runId: "run" };
const connection = { connectionId: "connection", accountId: "123" };
const now = Date.parse("2026-10-26T10:00:00Z");
function fixture(required: { pages: object[]; statuses?: number[] }) {
  const requests: { url: string; init: RequestInit }[] = [];
  const observations: unknown[] = [];
  let allowed = true;
  let accesses = 0;
  let onAccess = () => {};
  const dependencies: PluginCapabilityDependencies = {
    configuration: pluginConfigurationSchema.parse({ scope, ...connection, pluginDigest: "a".repeat(64), settings: { timezone: "IGNORED" } }),
    credentials: { async access() { accesses += 1; onAccess(); return { ok: true, value: { accessToken: "fixture-token" } }; } },
    fetch: (async (url, init) => { if (!allowed) throw new Error("Host guarded fetch denied"); const index = requests.length; requests.push({ url: String(url), init: init! }); return new Response(JSON.stringify(required.pages[index] ?? {}), { status: required.statuses?.[index] ?? 200 }); }) as typeof fetch,
    clock: { now: () => now }, observer: { observe: event => { observations.push(event); } },
    wait: async () => ({ ok: true, value: undefined }),
  };
  return { capabilities: createCapabilities(dependencies), dependencies, requests, observations, accessCount: () => accesses, revoke: () => { allowed = false; }, onAccess: (required: { work: () => void }) => { onAccess = required.work; } };
}
function campaign(required: { fields?: object } = {}) { return { id: 11, adAccountId: 123, config: "ON", systemConfig: "ON", isDailyBudgetAmountOver: false, status: ["LIVE"], ...required.fields }; }
describe("Kakao canonical capabilities (synthetic fixtures)", () => {
  it("exports only status using the exact server configuration", async () => {
    const test = fixture({ pages: [campaign()] });
    expect(Object.keys(test.capabilities)).toEqual(["campaign.status.v1"]);
    expect(test.accessCount()).toBe(0); expect(test.requests).toHaveLength(0);
    const result = await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: true, campaigns: [{ status: "active" }] } });
    if (result.ok) expect(campaignStatusOutputSchema.safeParse(result.value).success).toBe(true);
  });
  it("reads scoped campaign delivery state, not config alone", async () => {
    const test = fixture({ pages: [campaign(), campaign({ fields: { id: 12, status: ["NO_AVAILABLE_CREATIVE"] } })] });
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11", "12"] } })).toEqual({ ok: true, value: { observedAt: now, complete: false, campaigns: [
      { vendorCampaignId: "11", status: "active", disapprovalDescriptions: [] }, { vendorCampaignId: "12", status: "unknown", disapprovalDescriptions: [] },
    ] } });
    expect(test.requests[0]).toMatchObject({ url: "https://apis.moment.kakao.com/openapi/v4/campaigns/11", init: { method: "GET", redirect: "error", headers: { adAccountId: "123" } } });
    expect(test.observations).toContainEqual(expect.objectContaining({ correlationId: "correlation", traceId: "trace", runId: "run" }));
  });
  it.each([
    { fields: { config: "OFF", status: ["OFF"] }, expected: "paused" },
    { fields: { config: "DEL", status: ["DELETED"] }, expected: "ended" },
    { fields: { status: ["READY"] }, expected: "pending" },
    { fields: { status: ["LIVE", "UNFAMILIAR"] }, expected: "unknown" },
    { fields: { systemConfig: "ADMIN_STOP" }, expected: "unknown" },
    { fields: { isDailyBudgetAmountOver: true }, expected: "unknown" },
  ])("normalizes documented state conservatively ($expected)", async ({ fields, expected }) => {
    const test = fixture({ pages: [campaign({ fields })] });
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { campaigns: [{ status: expected, disapprovalDescriptions: [] }] } });
  });
  it("preserves missing campaigns as unknown", async () => {
    const test = fixture({ pages: [{}], statuses: [404] });
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ vendorCampaignId: "11", status: "unknown" }] } });
  });
  it.each([11, 100])("reads all %i IDs with host-shaped dependencies and the caller signal", async count => {
    const ids = Array.from({ length: count }, (_, index) => String(index + 1));
    const test = fixture({ pages: ids.map(id => campaign({ fields: { id } })) });
    const controller = new AbortController(), signal = controller.signal;
    const result = await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ids } }, { signal });
    expect(result).toMatchObject({ ok: true, value: { complete: true } });
    if (result.ok) expect(result.value.campaigns.map(item => item.vendorCampaignId)).toEqual(ids);
    expect(test.requests).toHaveLength(count);
    expect(test.requests.every(item => item.init.signal instanceof AbortSignal && !item.init.signal.aborted)).toBe(true);
    controller.abort();
    expect(test.requests.every(item => item.init.signal?.aborted)).toBe(true);
  });
  it.each([{ adAccountId: 999 }, { id: 99 }, { id: 9007199254740992 }])("rejects foreign, wrong and unsafe numeric identities atomically", async fields => {
    const test = fixture({ pages: [campaign({ fields })] });
    expect((await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } })).ok).toBe(false);
  });
  it("returns a typed error when host guarded fetch denies after token lookup", async () => {
    const test = fixture({ pages: [] }); test.onAccess({ work: test.revoke });
    const service = { scope, serviceId: "sync", correlationId: "correlation", traceId: "trace" };
    expect(await test.capabilities["campaign.status.v1"]({ context: service, connection, input: { vendorCampaignIds: ["11"] } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(test.accessCount()).toBe(1); expect(test.requests).toHaveLength(0);
  });
  it("rejects cancellation after token lookup", async () => {
    const test = fixture({ pages: [] }); const controller = new AbortController(); test.onAccess({ work: () => controller.abort() });
    expect(await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11"] } }, { signal: controller.signal })).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(test.requests).toHaveLength(0);
  });
  it("rejects malformed inputs and foreign bindings before credential access", async () => {
    const test = fixture({ pages: [] });
    expect((await test.capabilities["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11", "11"] } })).ok).toBe(false);
    expect((await test.capabilities["campaign.status.v1"]({ context, connection: { ...connection, accountId: "999" }, input: { vendorCampaignIds: ["11"] } })).ok).toBe(false);
    expect(test.accessCount()).toBe(0);
  });
  it("resolves one credential for three IDs and obtains a fresh credential on the next call", async () => {
    const ids = ["11", "12", "13"], test = fixture({ pages: [...ids, ...ids].map(id => campaign({ fields: { id } })) });
    const call = { context, connection, input: { vendorCampaignIds: ids } };
    expect(await test.capabilities["campaign.status.v1"](call)).toMatchObject({ ok: true, value: { complete: true } });
    expect(test.accessCount()).toBe(1);
    expect(await test.capabilities["campaign.status.v1"](call)).toMatchObject({ ok: true, value: { complete: true } });
    expect(test.accessCount()).toBe(2);
  });
  it("stops after 25s and leaves unread campaigns unknown", async () => {
    const test = fixture({ pages: [campaign(), campaign({ fields: { id: "12" } }), campaign({ fields: { id: "13" } })] });
    let time = now;
    const dependencies = { ...test.dependencies, clock: { now: () => time }, fetch: (async (url, init) => {
      const response = await test.dependencies.fetch(url, init); time += 25001; return response;
    }) as typeof fetch };
    const result = await createCapabilities(dependencies)["campaign.status.v1"]({ context, connection, input: { vendorCampaignIds: ["11", "12", "13"] } });
    expect(result).toMatchObject({ ok: true, value: { complete: false, campaigns: [{ status: "active" }, { status: "unknown" }, { status: "unknown" }] } });
    expect(test.requests).toHaveLength(1); expect(test.accessCount()).toBe(1);
  });
});
