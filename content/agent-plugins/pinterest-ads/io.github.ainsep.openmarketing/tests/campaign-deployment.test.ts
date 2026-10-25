import { expect, it, vi } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, readCampaignDeployment, translateCampaign } from "../src/index.js";
import { context, deploymentFixture, deploymentRows, launchInput, now, pausedPlan } from "./fixtures.js";

it("translates one bound traffic intent to exact paused campaign/CPC/existing-Pin commands", () => {
  expect(translateCampaign(structuredClone(launchInput))).toEqual({ ok: true, value: pausedPlan });
});
it.each([
  { objective: "sales" }, { creativeIds: ["creative", "second"] }, { audience: { countries: ["GB"], searchTerms: [] } },
])("denies unsupported neutral intent %j", patch => {
  expect(translateCampaign({ ...launchInput, campaign: { ...launchInput.campaign, ...patch } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it.each([
  { accountId: "999" }, { currency: "USD" }, { timezone: "UTC" }, { creativeId: "other" }, { creativeDigest: "c".repeat(64) }, { unitCost: { minorUnits: 25, currency: "USD" } },
])("rejects conflicting account/asset evidence %j", patch => {
  expect(translateCampaign({ ...launchInput, resolved: { ...(launchInput.resolved as object), ...patch } })).toMatchObject({ ok: false, error: { code: "conflict" } });
});
it("rejects missing evidence, duplicated countries, precision loss, zero bids and overflow", () => {
  expect(translateCampaign({ ...launchInput, resolved: {} })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  expect(translateCampaign({ ...launchInput, campaign: { ...launchInput.campaign, audience: { countries: ["GB", "GB"] } } }).ok).toBe(false);
  expect(translateCampaign({ ...launchInput, campaign: { ...launchInput.campaign, schedule: { ...launchInput.campaign.schedule, window: { start: now + 1, end: now + 86400000 } } } })).toMatchObject({ ok: false, error: { code: "not_implemented" } });
  for (const minorUnits of [0, Number.MAX_SAFE_INTEGER]) {
    expect(translateCampaign({ ...launchInput, target: { ...launchInput.target, dailyBudget: { currency: "GBP", minorUnits } } }).ok).toBe(false);
    expect(translateCampaign({ ...launchInput, resolved: { ...(launchInput.resolved as object), unitCost: { currency: "GBP", minorUnits } } }).ok).toBe(false);
  }
  expect(translateCampaign({ ...launchInput, resolved: { ...(launchInput.resolved as object), currencyExponent: 0 } }).ok).toBe(false);
});
it.each([{ currency: "JPY", currencyExponent: 0, micros: 1000000 }, { currency: "KWD", currencyExponent: 3, micros: 1000 }])("converts minor units exactly for $currency", value => {
  const input = { ...launchInput, target: { accountId: "123", dailyBudget: { currency: value.currency, minorUnits: 1 } }, resolved: { ...(launchInput.resolved as object), ...value, unitCost: { currency: value.currency, minorUnits: 1 } } };
  delete (input.resolved as Partial<typeof value>).micros;
  expect(translateCampaign(input)).toMatchObject({ ok: true, value: { campaign: { daily_spend_cap: value.micros }, adGroup: { bid_in_micro_currency: value.micros } } });
});
it("creates singleton PAUSED arrays with readback before every child, preserving the reviewed names", async () => {
  const f = deploymentFixture();
  expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f })).toMatchObject({ ok: true, value: { status: "acknowledged", references: { campaign: "456", adGroup: "567", ad: "678" }, entityIds: ["456", "567", "678"] } });
  expect(f.calls.map(call => [call.init.method, call.url])).toEqual([
    ["POST", "https://api.pinterest.com/v5/ad_accounts/123/campaigns"], ["GET", "https://api.pinterest.com/v5/ad_accounts/123/campaigns/456"],
    ["POST", "https://api.pinterest.com/v5/ad_accounts/123/ad_groups"], ["GET", "https://api.pinterest.com/v5/ad_accounts/123/ad_groups/567"],
    ["POST", "https://api.pinterest.com/v5/ad_accounts/123/ads"], ["GET", "https://api.pinterest.com/v5/ad_accounts/123/ads/678"],
  ]);
  expect(JSON.parse(String(f.calls[0].init.body))).toEqual([{ ...pausedPlan.campaign, ad_account_id: "123" }]);
  expect(JSON.parse(String(f.calls[2].init.body))).toEqual([{ ...pausedPlan.adGroup, campaign_id: "456" }]);
  expect(JSON.parse(String(f.calls[4].init.body))).toEqual([{ ...pausedPlan.ad, ad_group_id: "567" }]);
  expect(f.calls.every(call => call.init.redirect === "error")).toBe(true);
  expect(f.observations).toHaveLength(6); expect(f.observations[0]).toMatchObject({ correlationId: "correlation", traceId: "trace", runId: "run" });
  expect(f.journal).toHaveLength(6); expect(f.journal[1]).toEqual({ step: "campaign", phase: "acknowledged", references: { campaign: "456" } });
});
it("rejects admission, scope, account, currency or unsupported plans before credential/checkpoint I/O", async () => {
  const cases = [ { admitted: false, plan: pausedPlan }, { plan: { ...pausedPlan, accountId: "999" } }, { plan: { ...pausedPlan, currency: "USD" } }, { plan: { ...pausedPlan, campaign: { ...pausedPlan.campaign, status: "ACTIVE" } } }, { plan: { ...pausedPlan, adGroup: { ...pausedPlan.adGroup, auto_targeting_enabled: true } } } ];
  for (const input of cases) {
    const f = deploymentFixture(input);
    expect((await deployCampaignPaused({ context, operationId: "launch", ...f, plan: input.plan })).ok).toBe(false);
    expect(f.state.credentials).toBe(0); expect(f.calls).toHaveLength(0); expect(f.journal).toHaveLength(0);
  }
  const f = deploymentFixture();
  expect((await deployCampaignPaused({ context: { ...context, scope: { ...context.scope, ownerId: "other" } }, operationId: "launch", plan: pausedPlan, ...f })).ok).toBe(false);
  expect(f.journal).toHaveLength(0);
  expect(campaignDeploymentPlanSchema.safeParse({ ...pausedPlan, adGroup: { ...pausedPlan.adGroup, targeting_spec: { LOCATION: { country_codes: ["GB"] } } } }).success).toBe(false);
});
it.each([{ exceptions: [{ code: 1 }] }, { exceptions: { code: 1 } }, { exceptions: "invalid" }])("retains candidate on item exceptions %j; never creates a child on errors", async ({ exceptions }) => {
  const f = deploymentFixture({ response: ({ index }) => index === 1 ? Response.json({ items: [{ data: { id: "456" }, exceptions }] }) : Response.json({ ...deploymentRows.campaigns, status: "ACTIVE" }) });
  expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
  expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(1);
  expect(f.journal[1]).toMatchObject({ references: { campaign: "456" } });
});
it.each([1, 2, 3, 4, 5, 6])("keeps prior candidates and stops when create/read %s is interrupted", async stop => {
  const f = deploymentFixture({ response: ({ index, call }) => {
    if (index === stop) throw new Error("synthetic-secret");
    const key = call.url.split("/")[6] as keyof typeof deploymentRows;
    return Response.json(call.init.method === "POST" ? { items: [{ data: deploymentRows[key] }] } : deploymentRows[key]);
  } });
  const result = await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f });
  expect(result).toMatchObject({ ok: true, value: { status: "unknown", entityIds: ["456", "567", "678"].slice(0, Math.floor(stop / 2)) } });
  expect(f.calls).toHaveLength(stop); expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  const recovery = deploymentFixture();
  if (!result.ok) throw new Error("Missing receipt");
  await readCampaignDeployment({ context, operationId: "launch", plan: pausedPlan, references: result.value.references, ...recovery });
  expect(recovery.calls.every(call => call.init.method === "GET")).toBe(true);
});
it.each([{ step: "campaign", count: 1, ids: ["456"] }, { step: "adGroup", count: 3, ids: ["456", "567"] }, { step: "ad", count: 5, ids: ["456", "567", "678"] }])("keeps $step candidate when persistence throws and denies replay", async value => {
  const f = deploymentFixture({ checkpointHook: input => { if (input.phase === "acknowledged" && input.step === value.step) throw new Error("fixture journal failed"); } });
  const input = { context, operationId: "launch", plan: pausedPlan, ...f };
  expect(await deployCampaignPaused(input)).toMatchObject({ ok: true, value: { status: "unknown", entityIds: value.ids } });
  expect(await deployCampaignPaused(input)).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.calls).toHaveLength(value.count);
});
it.each([201, 400, 429, 500])("keeps a returned ID even under unexpected HTTP %s; stops successors", async status => {
  const f = deploymentFixture({ response: () => Response.json({ items: [{ data: { id: "456" } }] }, { status }) });
  expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } }); expect(f.calls).toHaveLength(1);
});
it("accepts empty item exceptions and retains every ID when a child returns an item error", async () => {
  const f = deploymentFixture({ response: ({ call, index }) => {
    const key = call.url.split("/")[6] as keyof typeof deploymentRows;
    return Response.json(call.init.method === "POST" ? { items: [{ data: deploymentRows[key], exceptions: index === 5 ? { code: 1 } : [] }] } : deploymentRows[key]);
  } });
  expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", adGroup: "567", ad: "678" } } }); expect(f.calls).toHaveLength(5);
});
it.each([
  { key: "campaigns", patch: { ad_account_id: "999" }, count: 2 }, { key: "campaigns", patch: { daily_spend_cap: 10000001 }, count: 2 },
  { key: "campaigns", patch: { end_time: 1792886401 }, count: 2 }, { key: "campaigns", patch: { is_performance_plus: true }, count: 2 },
  { key: "ad_groups", patch: { campaign_id: "999" }, count: 4 }, { key: "ad_groups", patch: { auto_targeting_enabled: true }, count: 4 },
  { key: "ad_groups", patch: { targeting_spec: { LOCATION: ["GB", "US"] } }, count: 4 }, { key: "ad_groups", patch: { bid_in_micro_currency: 250001 }, count: 4 },
  { key: "ads", patch: { pin_id: "999" }, count: 6 }, { key: "ads", patch: { ad_group_id: "999" }, count: 6 },
])("rejects readback mismatch $patch and stops successors", async input => {
  const f = deploymentFixture({ response: ({ call }) => {
    const key = call.url.split("/")[6] as keyof typeof deploymentRows;
    if (call.init.method === "POST") return Response.json({ items: [{ data: deploymentRows[key] }] });
    return Response.json({ ...deploymentRows[key], ...(key === input.key ? input.patch : {}) });
  } });
  expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f })).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.calls).toHaveLength(input.count);
});
it("reconciles complete references with GETs only and never replays an ID-less unknown create", async () => {
  const f = deploymentFixture();
  expect(await readCampaignDeployment({ context, operationId: "launch", plan: pausedPlan, references: { campaign: "456", adGroup: "567", ad: "678" }, ...f })).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  expect(f.calls.map(call => call.init.method)).toEqual(["GET", "GET", "GET"]);
  const empty = deploymentFixture();
  expect(await readCampaignDeployment({ context, operationId: "launch", plan: pausedPlan, references: {}, ...empty })).toMatchObject({ ok: true, value: { status: "unknown", references: {} } });
  expect(empty.calls).toHaveLength(0); expect(empty.state.credentials).toBe(0);
});
it("denies after token lookup, cancellation, and expired/malformed tokens without network", async () => {
  const controller = new AbortController();
  const revoked = deploymentFixture({ credentialHook: () => { revoked.state.current = false; } });
  const cancelled = deploymentFixture({ credentialHook: () => controller.abort() });
  for (const f of [revoked, cancelled, deploymentFixture({ credential: { accessToken: "bad\nheader" } }), deploymentFixture({ credential: { accessToken: "synthetic-secret", expiresAt: now } })]) {
    expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f }, f === cancelled ? { signal: controller.signal } : {})).toMatchObject({ ok: true, value: { status: "unknown" } });
    expect(f.calls).toHaveLength(0);
  }
});
it.each(["not json", "x".repeat(1048577), JSON.stringify({ items: [] }), JSON.stringify({ items: [{ data: { id: 456 } }] })])("never retries malformed/oversized creates", async body => {
  const f = deploymentFixture({ response: () => new Response(body) });
  expect(await deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f })).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(f.calls).toHaveLength(1);
});
it("bounds a stalled write response to the same injected deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = deploymentFixture({ response: () => new Response(new ReadableStream()) });
    const deadline = new AbortController();
    const dependencies = { ...f.dependencies, deadline: (input: { timeoutMs: number }) => { setTimeout(() => deadline.abort(), input.timeoutMs); return deadline.signal; } };
    const pending = deployCampaignPaused({ context, operationId: "launch", plan: pausedPlan, ...f, dependencies });
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ ok: true, value: { status: "unknown" } }); expect(f.calls).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
