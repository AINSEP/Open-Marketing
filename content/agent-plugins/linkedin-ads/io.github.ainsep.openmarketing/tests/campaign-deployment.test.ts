import { expect, it } from "vitest";
import { deployCampaignPaused, readCampaignDeployment } from "../src/index.js";
import { campaign, configuration, context, draft, fixture as baseFixture } from "./fixtures.js";
const { campaignGroupId: _parent, ...child } = campaign as Extract<typeof campaign, { kind: "create_campaign_paused" }>;
const plan = { group: draft, campaign: { ...child, kind: "create_campaign_draft", campaignGroupId: { from: "group" } }, creative: { kind: "create_creative_draft", campaignId: { from: "campaign" }, reference: "urn:li:share:987" } };
/** The real Rest.li transport with synthetic ACKs and scoped reads; no vendor I/O. */
function fixture(options: { failPost?: number; badAck?: boolean; checkpointFail?: number; change?: Record<string, unknown>; readFailure?: boolean; readId?: string } = {}) {
  const f = baseFixture(); const rows = new Map<string, object>(); const calls: { url: string; init?: RequestInit }[] = []; const checkpoints: object[] = []; const intents = new Set<string>(); let posts = 0;
  const input: Parameters<typeof deployCampaignPaused>[0] = { context, operationId: "launch", plan, dependencies: { ...f.dependencies, admitted: true, fetch: async (url, init) => {
    calls.push({ url: String(url), init }); const headers = new Headers(init?.headers); expect(headers.get("LinkedIn-Version")).toBe("202610"); expect(headers.get("X-Restli-Protocol-Version")).toBe("2.0.0");
    if (init?.method === "GET") { const id = decodeURIComponent(new URL(String(url)).pathname.split("/").at(-1)!); if (options.readFailure && id === (options.readId ?? "567")) throw new Error("read unavailable"); return Response.json({ ...rows.get(id), ...(id === (options.readId ?? "567") ? options.change : {}) }); }
    posts++; if (posts === options.failPost) throw new Error("ambiguous write"); const id = ["456", "567", "urn:li:sponsoredCreative:678"][posts - 1];
    const body = JSON.parse(String(init?.body)); rows.set(id, { ...body, id, account: "urn:li:sponsoredAccount:123", isServing: false });
    return new Response(null, { status: 201, headers: { "x-restli-id": options.badAck ? "bad" : id } });
  } }, async checkpoint(event) { checkpoints.push(event); if (checkpoints.length === options.checkpointFail || (event.phase === "dispatch" && intents.has(event.step))) return { ok: false, error: { code: "conflict", message: "stop", retryable: false } }; if (event.phase === "dispatch") intents.add(event.step); return { ok: true, value: undefined }; } };
  return { input, calls, f, checkpoints, posts: () => posts };
}
it("creates a DRAFT hierarchy with acknowledged parents, scoped readback and no nested jobs", async () => {
  const f = fixture(); const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: { group: "456", campaign: "567", creative: "urn:li:sponsoredCreative:678" } } });
  expect(f.calls.map(call => call.init?.method)).toEqual(["POST", "GET", "POST", "POST", "GET", "GET", "GET"]);
  expect(f.calls[1].url).toBe("https://api.linkedin.com/rest/adAccounts/123/adCampaignGroups/456");
  const bodies = f.calls.filter(call => call.init?.method === "POST").map(call => JSON.parse(String(call.init?.body)));
  expect(bodies.map(body => body.status ?? body.intendedStatus)).toEqual(["DRAFT", "DRAFT", "DRAFT"]);
  expect(bodies[1].campaignGroup).toBe("urn:li:sponsoredCampaignGroup:456"); expect(bodies[2].campaign).toBe("urn:li:sponsoredCampaign:567");
  expect(f.calls.at(-1)?.url).toContain("urn%3Ali%3AsponsoredCreative%3A678"); expect(f.f.effects).toEqual([]); expect(f.checkpoints).toHaveLength(6);
  expect(JSON.stringify(result)).not.toContain("synthetic-secret");
});
it.each([{ failPost: 2 }, { checkpointFail: 2 }])("preserves group and stops at partial failure: %j", async options => {
  const f = fixture(options); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { group: "456" } } }); expect(f.posts()).toBe(options.failPost ? 2 : 1);
});
it.each([{ readFailure: true }, { change: { account: "urn:li:sponsoredAccount:999" } }, { change: { status: "ACTIVE" } }, { change: { id: "999" } }, { change: { runSchedule: {} } }])("keeps the candidate group but creates no children without scoped readback: %j", async options => {
  const f = fixture({ ...options, readId: "456" });
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { group: "456" }, entityIds: ["456"] } });
  expect(f.posts()).toBe(1); expect(f.calls.map(call => call.init?.method)).toEqual(["POST", "GET"]);
  expect(f.checkpoints).toHaveLength(2);
});
it("bad group ACK prevents children; a repeated intent never replays", async () => {
  const f = fixture({ badAck: true }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: [] } }); await deployCampaignPaused(f.input); expect(f.posts()).toBe(1);
});
it.each([{ account: "urn:li:sponsoredAccount:999" }, { campaignGroup: "urn:li:sponsoredCampaignGroup:999" }, { status: "ACTIVE" }, { dailyBudget: { amount: "1", currencyCode: "USD" } }, { runSchedule: {} }, { targetingCriteria: {} }])("configuration drift remains unknown: %j", async change => {
  const f = fixture({ change }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["456", "567", "urn:li:sponsoredCreative:678"] } });
});
it("retains all IDs after read failure and reconciles with GET only", async () => {
  const f = fixture({ readFailure: true }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["456", "567", "urn:li:sponsoredCreative:678"] } });
  const start = f.calls.length; await readCampaignDeployment({ ...f.input, references: { group: "456", campaign: "567", creative: "urn:li:sponsoredCreative:678" } }); expect(f.calls.slice(start).every(call => call.init?.method === "GET")).toBe(true); expect(f.posts()).toBe(3);
});
it("unadmitted, cancelled, foreign scope and invalid full plans do no credential or network I/O", async () => {
  const f = fixture(); f.input.dependencies.admitted = false; expect((await deployCampaignPaused(f.input)).ok).toBe(false); f.input.dependencies.admitted = true;
  await deployCampaignPaused(f.input, { signal: AbortSignal.abort() });
  expect((await deployCampaignPaused({ ...f.input, plan: { ...plan, creative: { ...plan.creative, url: "https://bad.test" } } })).ok).toBe(false);
  expect((await deployCampaignPaused({ ...f.input, context: { ...context, scope: { ...configuration.scope, workspaceId: "foreign" } } })).ok).toBe(false);
  expect(f.f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
});
it.each([{ content: { reference: "urn:li:share:999" } }, { isServing: true }, { intendedStatus: "ACTIVE" }])("requires non-serving creative/reference evidence: %j", async change => {
  const f = fixture({ readId: "urn:li:sponsoredCreative:678", change }); expect(await deployCampaignPaused(f.input)).toMatchObject({ value: { status: "unknown", entityIds: ["456", "567", "urn:li:sponsoredCreative:678"] } });
});
it.each([
  { reference: "urn:li:share:987", ignored: "stripped" },
  { standardUpdateAd: { reference: "urn:li:share:987", contentAuthor: "urn:li:organization:789" } },
  { videoAd: { reference: "urn:li:share:987", preRollMetadata: { ignored: true } } },
])("accepts normalized content in deployment and GET-only reconciliation: %j", async content => {
  const f = fixture({ readId: "urn:li:sponsoredCreative:678", change: { content } });
  const references = { group: "456", campaign: "567", creative: "urn:li:sponsoredCreative:678" };
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "acknowledged", references, hierarchy: [expect.anything(), expect.anything(), { content: { reference: "urn:li:share:987" } }] } });
  const start = f.calls.length;
  expect(await readCampaignDeployment({ ...f.input, references })).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  expect(f.calls.slice(start).map(call => call.init?.method)).toEqual(["GET", "GET", "GET"]);
  expect(f.posts()).toBe(3);
  const creativeBody = JSON.parse(String(f.calls.filter(call => call.init?.method === "POST")[2].init?.body));
  expect(creativeBody).toEqual({ campaign: "urn:li:sponsoredCampaign:567", content: { reference: "urn:li:share:987" }, intendedStatus: "DRAFT" });
});
it.each([
  { content: undefined }, { content: null }, { content: {} }, { content: { videoAd: {} } },
  { content: { reference: "urn:li:share:987", videoAd: { reference: "urn:li:share:999" } } },
  { content: { standardUpdateAd: { reference: "urn:li:share:999" } } },
  { content: { videoAd: { reference: "urn:li:share:987" } }, account: "urn:li:sponsoredAccount:999" },
  { content: { videoAd: { reference: "urn:li:share:987" } }, campaign: "urn:li:sponsoredCampaign:999" },
  { content: { videoAd: { reference: "urn:li:share:987" } }, intendedStatus: "ACTIVE" },
  { content: { videoAd: { reference: "urn:li:share:987" } }, isServing: true },
])("keeps malformed, conflicting or foreign enriched readback unknown without retries: %j", async change => {
  const f = fixture({ readId: "urn:li:sponsoredCreative:678", change });
  expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["456", "567", "urn:li:sponsoredCreative:678"] } });
  expect(f.posts()).toBe(3);
});
it("admission change at the checkpoint stops before credentials", async () => {
  const f = fixture(); f.input.checkpoint = async () => { f.input.dependencies.admitted = false; return { ok: true, value: undefined }; };
  await deployCampaignPaused(f.input); expect(f.f.credentialCalls).toEqual([]); expect(f.calls).toEqual([]);
});
