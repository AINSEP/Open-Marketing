import { expect, it } from "vitest";
import { deployCampaignPaused, readCampaignDeployment, createMetaInstagramFetchDispatch } from "../src/index.js";
import type { CallContext } from "@open-marketing/contracts";
const context: CallContext = { scope: { ownerId: "owner", workspaceId: "workspace" }, principal: { kind: "service", serviceId: "campaigns" }, correlationId: "correlation", traceId: "trace" };
const plan = { campaign: { kind: "create-campaign", name: "Traffic", objective: "OUTCOME_TRAFFIC", specialAdCategories: [] },
  adset: { kind: "create-adset", name: "Traffic", campaignId: { from: "campaign" }, targeting: { countries: ["US"], age_min: 18, age_max: 65 }, billingEvent: "IMPRESSIONS", optimizationGoal: "LINK_CLICKS", dailyBudgetMinor: 4321, schedule: { start: 1791849600000, end: 1792022400000 } },
  ad: { kind: "create-ad", name: "Traffic", adsetId: { from: "adset" }, creativeId: "987" } };
type FixtureOptions = { badAck?: boolean; failPost?: number; checkpointFail?: number; change?: Record<string, unknown>; readFailure?: boolean; readId?: string };
/** Simulate a scoped read or its failure; optional drift affects just the selected row. */
function readFixtureResponse(required: { url: string; rows: Map<string, object>; options: FixtureOptions }): Response {
  const { url, rows, options } = required;
  if (options.readFailure) throw new Error("read unavailable");
  const id = new URL(url).pathname.split("/").at(-1)!;
  return Response.json({ ...rows.get(id), ...(id === (options.readId ?? "202") ? options.change : {}) });
}
/** Store decoded Graph fields before returning a synthetic create ACK. Fixed-size fixture data. */
function createFixtureResponse(required: { body: Record<string, string>; id: string; rows: Map<string, object>; badAck?: boolean }): Response {
  const { body, id, rows } = required;
  const row: Record<string, unknown> = { ...body, id, account_id: "123", configured_status: body.status };
  for (const key of ["targeting", "special_ad_categories", "creative"]) if (body[key]) row[key] = JSON.parse(body[key]);
  if (body.creative) row.creative = { id: JSON.parse(body.creative).creative_id };
  delete row.status; rows.set(id, row);
  return Response.json(required.badAck ? { id: "bad" } : { id });
}
/** Real bounded Graph transport, synthetic responses, and the owning job's checkpoint double. */
function fixture(options: FixtureOptions = {}) {
  const calls: { url: string; body: Record<string, string>; method: string }[] = [];
  const rows = new Map<string, object>(); const checkpoints: object[] = []; const intents = new Set<string>();
  let posts = 0; let credentials = 0;
  const dispatch = createMetaInstagramFetchDispatch({ credentials: { async access() { credentials++; return { ok: true, value: { accessToken: "synthetic-secret" } }; } }, fetch: async (url, init) => {
    const body = Object.fromEntries(new URLSearchParams(String(init?.body ?? ""))); const method = init?.method ?? "GET";
    calls.push({ url: String(url), body, method }); expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-secret");
    if (method === "GET") return readFixtureResponse({ url: String(url), rows, options });
    posts++; if (posts === options.failPost) throw new Error("ambiguous write");
    return createFixtureResponse({ body, id: String(200 + posts), rows, badAck: options.badAck });
  } });
  const input: Parameters<typeof deployCampaignPaused>[0] = { context, operationId: "launch", connectionId: "connection", accountId: "123", plan, dependencies: { admitted: true, dispatch },
    async checkpoint(event) { checkpoints.push(event); if (checkpoints.length === options.checkpointFail || (event.phase === "dispatch" && intents.has(event.step))) return { ok: false, error: { code: "conflict", message: "stop", retryable: false } }; if (event.phase === "dispatch") intents.add(event.step); return { ok: true, value: undefined }; } };
  return { input, calls, checkpoints, counts: () => ({ posts, credentials }) };
}
it("creates PAUSED in order with actual Graph nested fields and reads the whole scoped hierarchy", async () => {
  const f = fixture(); const result = await deployCampaignPaused(f.input);
  expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", references: { campaign: "201", adset: "202", ad: "203" } } });
  expect(f.calls.map(call => call.method)).toEqual(["POST", "POST", "POST", "GET", "GET", "GET"]);
  expect(f.calls[1].body.campaign_id).toBe("201"); expect(f.calls[2].body.adset_id).toBe("202");
  expect(JSON.parse(f.calls[1].body.targeting)).toEqual({ geo_locations: { countries: ["US"] }, age_min: 18, age_max: 65 });
  expect(JSON.parse(f.calls[2].body.creative)).toEqual({ creative_id: "987" }); expect(f.calls[1].body.daily_budget).toBe("4321");
  expect(f.checkpoints).toHaveLength(6); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
});
it.each([{ failPost: 2 }, { checkpointFail: 2 }])("retains first ID and stops on partial failure: %j", async options => {
  const f = fixture(options); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "201" } } });
  expect(f.counts().posts).toBe(options.failPost ? 2 : 1);
});
it("rejects malformed ACK and never advances or retries an existing dispatch intent", async () => {
  const f = fixture({ badAck: true }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: [] } });
  await deployCampaignPaused(f.input); expect(f.counts().posts).toBe(1);
});
it.each([{ account_id: "999" }, { campaign_id: "999" }, { configured_status: "ACTIVE" }, { daily_budget: "1" }, { start_time: "invalid" }, { targeting: {} }])("readback drift stays unknown without losing IDs: %j", async change => {
  const f = fixture({ change }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["201", "202", "203"] } });
});
it("read failure preserves all IDs; reconciliation is GET-only", async () => {
  const f = fixture({ readFailure: true }); expect(await deployCampaignPaused(f.input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["201", "202", "203"] } });
  const start = f.calls.length; await readCampaignDeployment({ ...f.input, references: { campaign: "201", adset: "202", ad: "203" } });
  expect(f.calls.slice(start).every(call => call.method === "GET")).toBe(true); expect(f.counts().posts).toBe(3);
});
it("unadmitted, cancelled and invalid complete plans cause zero credential and network access", async () => {
  const f = fixture(); f.input.dependencies.admitted = false; expect((await deployCampaignPaused(f.input)).ok).toBe(false);
  f.input.dependencies.admitted = true; await deployCampaignPaused(f.input, { signal: AbortSignal.abort() });
  expect((await deployCampaignPaused({ ...f.input, plan: { ...plan, ad: { ...plan.ad, status: "ACTIVE" } } })).ok).toBe(false);
  expect(f.counts()).toEqual({ posts: 0, credentials: 0 }); expect(f.calls).toEqual([]);
});
it("requires creative readback and stops if admission changes at a checkpoint", async () => {
  const f = fixture({ readId: "203", change: { creative: { id: "999" } } }); expect(await deployCampaignPaused(f.input)).toMatchObject({ value: { status: "unknown", entityIds: ["201", "202", "203"] } });
  const denied = fixture(); denied.input.checkpoint = async () => { denied.input.dependencies.admitted = false; return { ok: true, value: undefined }; };
  await deployCampaignPaused(denied.input); expect(denied.counts()).toEqual({ posts: 0, credentials: 0 });
});
