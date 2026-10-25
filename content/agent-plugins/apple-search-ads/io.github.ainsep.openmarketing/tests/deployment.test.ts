import { expect, it } from "vitest";
import { campaignDeploymentPlanSchema, deployCampaignPaused, translateCampaign } from "../src/index.js";
import { context, deploymentFixture, installCampaign, installResolved, installTarget, pausedPlan, savedReferences } from "./fixtures.js";

it("translates an explicit App Store install plan with exact money, identity, UTC and PAUSED fields", () => {
  expect(translateCampaign({ campaign: installCampaign, target: installTarget, resolved: installResolved })).toEqual({ ok: true, value: pausedPlan });
  expect(translateCampaign({ campaign: installCampaign, target: { ...installTarget, dailyBudget: { minorUnits: 9007199254740991, currency: "USD" } }, resolved: installResolved })).toMatchObject({ ok: true, value: { campaign: { dailyBudgetAmount: { amount: "90071992547409.91", currency: "USD" } } } });
});

it("rejects unsupported intent and strict/mismatched metadata rather than dropping fields", () => {
  const base = { campaign: installCampaign, target: installTarget, resolved: installResolved };
  for (const input of [
    { ...base, campaign: { ...installCampaign, objective: "traffic" } },
    { ...base, campaign: { ...installCampaign, audience: { ...installCampaign.audience, searchTerms: [] } } },
    { ...base, campaign: { ...installCampaign, audience: { countries: ["US", "US"] } } },
    { ...base, campaign: { ...installCampaign, schedule: { ...installCampaign.schedule, timezone: "America/Los_Angeles" } } },
    { ...base, campaign: { ...installCampaign, creativeDigest: "b".repeat(64) } },
    { ...base, target: { ...installTarget, accountId: "124" } },
    { ...base, resolved: { ...installResolved, adamId: "9007199254740992" } },
    { ...base, resolved: { ...installResolved, adamId: "invalid" } },
    { ...base, resolved: { ...installResolved, adamId: undefined } },
    { ...base, resolved: { ...installResolved, currencyExponent: 0 } },
    { ...base, resolved: { ...installResolved, extra: "ignored?" } },
    { ...base, resolved: { ...installResolved, bid: { minorUnits: 4000, currency: "USD" } } },
    { ...base, resolved: { ...installResolved, bid: { minorUnits: 1, currency: "CAD" } } },
  ]) expect(translateCampaign(input).ok).toBe(false);
});

it("preflights then creates PAUSED parents with readback before children and exact checkpoints", async () => {
  const f = deploymentFixture(); const result = await f.deploy();
  expect(result).toMatchObject({ ok: true, value: { status: "acknowledged", entityIds: ["456", "567", "678"], references: savedReferences } });
  expect(result.ok && result.value.hierarchy).toHaveLength(3);
  expect(f.calls.map(call => [call.init.method, call.url.replace("https://api.searchads.apple.com/api/v5", "")])).toEqual([
    ["GET", "/creatives/789"], ["POST", "/campaigns"], ["GET", "/campaigns/456"],
    ["POST", "/campaigns/456/adgroups"], ["GET", "/campaigns/456/adgroups/567"],
    ["POST", "/campaigns/456/adgroups/567/ads"], ["GET", "/campaigns/456/adgroups/567/ads/678"],
  ]);
  const bodies = f.calls.filter(call => call.init.method === "POST").map(call => JSON.parse(String(call.init.body)));
  expect(bodies.map(body => body.status)).toEqual(["PAUSED", "PAUSED", "PAUSED"]);
  expect(bodies[0]).toEqual(pausedPlan.campaign);
  expect(bodies[1]).toEqual({ name: "Fixture install", orgId: 123, startTime: "2026-10-25T00:00:00.000Z", endTime: "2026-10-26T00:00:00.000Z", status: "PAUSED", automatedKeywordsOptIn: true, pricingModel: "CPC", defaultBidAmount: { amount: "1.01", currency: "USD" } });
  expect(bodies[2]).toEqual({ name: "Fixture install", creativeId: 789, status: "PAUSED" });
  expect(f.events).toEqual([
    { step: "campaign", phase: "dispatch", references: {} }, { step: "campaign", phase: "acknowledged", references: { campaign: "456" } },
    { step: "adgroup", phase: "dispatch", references: { campaign: "456" } }, { step: "adgroup", phase: "acknowledged", references: { campaign: "456", adgroup: "567" } },
    { step: "ad", phase: "dispatch", references: { campaign: "456", adgroup: "567" } }, { step: "ad", phase: "acknowledged", references: savedReferences },
  ]);
  expect(f.credentialCalls).toHaveLength(7);
  expect(f.observations).toHaveLength(7);
  expect(f.observations[0]).toMatchObject({ operation: "apple-search-ads.deployment", correlationId: "correlation", traceId: "trace", runId: "run" });
  expect(JSON.stringify({ result, events: f.events, observations: f.observations })).not.toContain("synthetic-secret");
});

it("denies invalid plans, scope/account/currency mismatches and stale schedules before effects", async () => {
  for (const change of [
    { campaign: { ...pausedPlan.campaign, status: "ENABLED" } },
    { campaign: { ...pausedPlan.campaign, adamId: Number.MAX_SAFE_INTEGER + 1 } },
    { campaign: { ...pausedPlan.campaign, dailyBudgetAmount: { amount: "NaN", currency: "USD" } } },
    { campaign: { ...pausedPlan.campaign, dailyBudgetAmount: { amount: "0.01", currency: "USD" } } },
    { adgroup: { ...pausedPlan.adgroup, startTime: "2026-10-25T01:00:00.000Z" } },
    { ad: { ...pausedPlan.ad, status: "DRAFT" } },
  ]) {
    const f = deploymentFixture(); const plan = { ...f.plan, ...change };
    expect(campaignDeploymentPlanSchema.safeParse(plan).success).toBe(false);
    expect((await deployCampaignPaused({ context, operationId: "deployment", plan, dependencies: f.dependencies, checkpoint: f.checkpoint })).ok).toBe(false);
    expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]); expect(f.events).toEqual([]);
  }
  for (const key of ["accountId", "currency", "scope", "clock"] as const) {
    const f = deploymentFixture();
    if (key === "accountId") f.dependencies.configuration.accountId = "124";
    if (key === "currency") f.dependencies.configuration.currency = "CAD";
    if (key === "scope") f.dependencies.configuration.scope = { ...context.scope, workspaceId: "other" };
    if (key === "clock") f.state.time += 86400000;
    expect((await f.deploy()).ok).toBe(false); expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]);
  }
});

it("fails creative preflight closed on wrong org/app/creative, unsafe ID or invalid state", async () => {
  for (const change of [{ orgId: 124 }, { adamId: 988 }, { id: 790 }, { id: Number.MAX_SAFE_INTEGER + 1 }, { state: "INVALID" }]) {
    const f = deploymentFixture(); f.responses[0] = { id: 789, orgId: 123, adamId: 987, state: "VALID", ...change };
    expect((await f.deploy()).ok).toBe(false); expect(f.calls).toHaveLength(1); expect(f.events).toEqual([]);
  }
});

it("stops before child creation on missing/foreign/serving or mismatched parent readback", async () => {
  for (const change of [{ orgId: 999 }, { adamId: 999 }, { status: "ENABLED" }, { servingStatus: "RUNNING" }, { servingStatus: undefined }, { deleted: true }, { endTime: "2026-10-27T00:00:00.000Z" }, { dailyBudgetAmount: { amount: "37.010000000000000001", currency: "USD" } }]) {
    const f = deploymentFixture(); Object.assign(f.rows[0], change);
    expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    expect(f.calls).toHaveLength(3);
  }
  const f = deploymentFixture(); f.rows[1].campaignId = 999;
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456", adgroup: "567" } } });
  expect(f.calls).toHaveLength(5);
});

it("accepts reordered countries, exact decimal equivalence and documented UTC timestamps", async () => {
  const f = deploymentFixture(); Object.assign(f.rows[0], { countriesOrRegions: ["CA", "US"], dailyBudgetAmount: { amount: "37.0100", currency: "USD" }, startTime: "2026-10-25T00:00:00.000" });
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "acknowledged" } });
});

it("snapshots approval bytes before credential awaits", async () => {
  const f = deploymentFixture(); f.state.credentialHook = () => { f.plan.campaign.dailyBudgetAmount.amount = "99.00"; f.plan.ad.status = "ENABLED"; };
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "acknowledged" } });
  expect(JSON.parse(String(f.calls[1].init.body)).dailyBudgetAmount.amount).toBe("37.01");
  expect(JSON.parse(String(f.calls[5].init.body)).status).toBe("PAUSED");
});

it("retains known references on uncertain creates, unsafe acknowledgements and checkpoint loss", async () => {
  for (const ack of [{}, { id: Number.MAX_SAFE_INTEGER + 1 }, { data: { id: 567 }, error: { message: "synthetic-secret" } }]) {
    const f = deploymentFixture(); f.responses[3] = ack;
    expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
    expect(f.calls).toHaveLength(4);
  }
  for (const { reject, references, writes } of [
    { reject: "campaign:dispatch", references: {}, writes: 0 },
    { reject: "campaign:acknowledged", references: { campaign: "456" }, writes: 1 },
    { reject: "adgroup:dispatch", references: { campaign: "456" }, writes: 1 },
    { reject: "adgroup:acknowledged", references: { campaign: "456", adgroup: "567" }, writes: 2 },
  ]) {
    const f = deploymentFixture(); f.checkpointState.reject = reject;
    const result = await f.deploy();
    expect(result).toMatchObject({ ok: true, value: { status: "unknown", references } });
    expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(writes);
  }
  const f = deploymentFixture(); f.checkpointState.throwCheckpoint = true;
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: {} } });
  expect(f.calls).toHaveLength(1);
});

it("never resends an unknown create, including a repeated invocation fenced by host checkpoints", async () => {
  const f = deploymentFixture(); f.state.response = () => {
    if (f.calls.length === 4) throw new Error("unknown remote outcome synthetic-secret");
    return Response.json(f.responses[f.calls.length - 1]);
  };
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
  const writes = f.calls.filter(call => call.init.method === "POST").length;
  f.state.response = () => Response.json(f.responses[0]);
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown" } });
  expect(f.calls.filter(call => call.init.method === "POST")).toHaveLength(writes);
});

it("reconciles complete and partial saved IDs with GETs only; no discovery or continuation", async () => {
  const f = deploymentFixture(); f.state.response = () => Response.json(f.rows[f.calls.length - 1]);
  expect(await f.reconcile()).toMatchObject({ ok: true, value: { status: "acknowledged", references: savedReferences } });
  expect(f.calls.map(call => call.init.method)).toEqual(["GET", "GET", "GET"]); expect(f.events).toEqual([]);
  const partial = deploymentFixture(); partial.state.response = () => Response.json(partial.rows[0]);
  expect(await partial.reconcile({ references: { campaign: "456" } })).toMatchObject({ ok: true, value: { status: "unknown", references: { campaign: "456" } } });
  expect(partial.calls).toHaveLength(1);
  const missing = deploymentFixture();
  expect(await missing.reconcile({ references: { ad: "678" } })).toMatchObject({ ok: true, value: { status: "unknown", references: { ad: "678" } } });
  expect(missing.calls).toEqual([]); expect((await missing.reconcile({ references: { campaign: Number.MAX_SAFE_INTEGER + 1 } })).ok).toBe(false); expect(missing.calls).toEqual([]);
});

it("retains all IDs on failed ad verification and failed recovery", async () => {
  const f = deploymentFixture(); f.rows[2].adGroupId = 999;
  expect(await f.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: savedReferences } });
  f.calls.length = 0; f.state.response = () => new Response("unavailable", { status: 503 });
  expect(await f.reconcile()).toMatchObject({ ok: true, value: { status: "unknown", references: savedReferences } });
  expect(f.calls.map(call => call.init.method)).toEqual(["GET"]);
});

it("denies admission/cancellation/expiry and rechecks authority after credential lookup", async () => {
  const f = deploymentFixture(); f.state.admitted = false;
  expect((await f.deploy()).ok).toBe(false); expect((await f.reconcile()).ok).toBe(false);
  expect(f.calls).toEqual([]); expect(f.credentialCalls).toEqual([]); expect(f.events).toEqual([]);
  const revoked = deploymentFixture(); revoked.state.credentialHook = () => { revoked.state.admitted = false; };
  expect((await revoked.deploy()).ok).toBe(false); expect(revoked.calls).toEqual([]);
  const mid = deploymentFixture(); mid.state.credentialHook = () => { if (mid.credentialCalls.length === 2) mid.state.admitted = false; };
  expect(await mid.deploy()).toMatchObject({ ok: true, value: { status: "unknown", references: {} } }); expect(mid.calls).toHaveLength(1);
  const cancelled = deploymentFixture(); expect((await cancelled.deploy({ signal: AbortSignal.abort() })).ok).toBe(false);
  expect(cancelled.calls).toEqual([]); expect(cancelled.credentialCalls).toEqual([]);
  const expired = deploymentFixture(); expired.state.credential = { ok: true, value: { accessToken: "synthetic-secret", expiresAt: expired.state.time } };
  expect((await expired.deploy()).ok).toBe(false); expect(expired.calls).toEqual([]);
});
