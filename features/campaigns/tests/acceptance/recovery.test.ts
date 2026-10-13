import { describe, expect, it } from "vitest";
import { createCampaignService } from "../../index.js";
import type { CampaignCapabilityPort, CampaignJob, CampaignJobPort, CampaignReadback, CampaignReceipt, CampaignRepoPort } from "../../index.js";
import { context, otherContext, fixture, flight, request, value } from "../fixtures.js";

/** Build a real paused plan/card; each test replaces only the faulting boundary. */
async function queuedFixture() {
  const env = await fixture();
  const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
  const exact = value({ outcome: await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight }) });
  const approved = request({ proposal: exact });
  value({ outcome: env.safety.approve({ context, proposal: exact, approvalId: approved.approvalId }) });
  value({ outcome: await env.service.launch({ context, request: approved }) });
  return { ...env, saved, exact, approved };
}
async function providerState(required: { env: Awaited<ReturnType<typeof queuedFixture>> }): Promise<CampaignReadback> {
  const { env } = required;
  return value({ outcome: await env.capabilities.readState({ context, campaignId: env.saved.campaignId, connectionId: "connection", accountId: "account", operationId: env.approved.operationId }) });
}

describe("claimed operations and uncertainty", () => {
  it("rejects a repository's active creation receipt before enqueue", async () => {
    const env = await fixture();
    const repo: CampaignRepoPort = { ...env.repo, async save(input, options) {
      const receipt = value({ outcome: await env.repo.save(input, options) });
      const tainted = { ...receipt, desiredState: "active" } as unknown as CampaignReceipt;
      return { ok: true, value: tainted };
    } };
    const service = createCampaignService({ ...env, repo });
    expect(await service.createPaused({ context, draft: env.draft })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.draft.operationId }) })).toBeNull();
  });
  it("rejects a repository's substituted proposal acknowledgement", async () => {
    const env = await fixture();
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    const repo: CampaignRepoPort = { ...env.repo, async saveProposal(input, options) {
      const exact = value({ outcome: await env.repo.saveProposal(input, options) });
      return { ok: true, value: { ...exact, proposedAt: exact.proposedAt + 1 } };
    } };
    const service = createCampaignService({ ...env, repo });
    expect(await service.proposeLaunch({ context, campaignId: saved.campaignId, flight })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value({ outcome: await env.repo.getProposal({ context, operationId: "launch-1" }) })?.proposedAt).toBe(900);
  });
  it("allows a replacement repository to own its campaign identity algorithm", async () => {
    const env = await fixture();
    const campaignId = "replacement-campaign-id";
    let underlyingId = "";
    const repo: CampaignRepoPort = { ...env.repo,
      async save(input, options) {
        const saved = value({ outcome: await env.repo.save(input, options) });
        underlyingId = saved.campaignId;
        return { ok: true, value: { ...saved, campaignId } };
      },
      async get(input, options) {
        if (input.campaignId !== campaignId) return { ok: true, value: null };
        const record = value({ outcome: await env.repo.get({ ...input, campaignId: underlyingId }, options) });
        if (!record) return { ok: true, value: null };
        const observation = record.observation ? { ...record.observation, campaignId } : null;
        return { ok: true, value: { ...record, receipt: { ...record.receipt, campaignId }, observation } };
      },
      async observe(input, options) {
        if (input.state.campaignId !== campaignId) return { ok: false, error: { code: "forbidden", message: "Replacement identity mismatch", retryable: false } };
        const observed = value({ outcome: await env.repo.observe({ ...input, state: { ...input.state, campaignId: underlyingId } }, options) });
        return { ok: true, value: { ...observed, campaignId } };
      },
    };
    const service = createCampaignService({ ...env, repo });
    expect(value({ outcome: await service.createPaused({ context, draft: env.draft }) })).toEqual({ campaignId, desiredState: "paused", observedState: "paused" });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.draft.operationId }) })?.status).toBe("submitted");
  });
  it.each(["duplicate", "mixed", "empty"] as const)("keeps a complete but %s creation hierarchy unknown", async (kind) => {
    const env = await fixture({ creation: "partial" });
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    const partial = value({ outcome: await env.capabilities.readState({ context, campaignId: saved.campaignId, connectionId: "connection", accountId: "account", operationId: env.draft.operationId }) });
    const hierarchy = invalidHierarchy({ readback: partial, kind });
    value({ outcome: env.capabilities.setReadback({ context, readback: { ...partial, hierarchy, complete: true } }) });
    expect(value({ outcome: await env.service.reconcile({ context, operationId: env.draft.operationId }) }).status).toBe("unknown");
    expect(value({ outcome: await env.repo.get({ context, campaignId: saved.campaignId }) })?.receipt.observedState).toBe("unknown");
    expect(await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight })).toMatchObject({ ok: false, error: { code: "conflict" } });
  });
  it("denies creative drift that occurs during claim and retains unknown completion", async () => {
    const env = await queuedFixture();
    const jobs: CampaignJobPort = { ...env.jobs, async claim(input, options) {
      const claimed = await env.jobs.claim(input, options);
      value({ outcome: env.assets.put({ context, creativeId: "creative-1", revisionDigest: "b".repeat(64) }) });
      return claimed;
    } };
    const service = createCampaignService({ ...env, jobs });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await providerState({ env })).state.state).toBe("paused");
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("unknown");
    expect(value({ outcome: await service.dispatch({ context, operationId: env.approved.operationId }) }).status).toBe("unknown");
  });
  it("denies observed state drift that occurs during claim", async () => {
    const env = await queuedFixture();
    const jobs: CampaignJobPort = { ...env.jobs, async claim(input, options) {
      const claimed = await env.jobs.claim(input, options);
      value({ outcome: await env.repo.observe({ context, state: { campaignId: env.saved.campaignId, state: "active", observedAt: 900, providerReference: "external-activation" } }) });
      return claimed;
    } };
    const service = createCampaignService({ ...env, jobs });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await providerState({ env })).state.state).toBe("paused");
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("unknown");
  });
  it("denies an internally valid substituted card returned by claim", async () => {
    const env = await queuedFixture();
    const secondRequest = { ...env.approved, approvalId: "approval-2" };
    value({ outcome: env.safety.approve({ context, proposal: env.exact, approvalId: secondRequest.approvalId }) });
    const jobs: CampaignJobPort = { ...env.jobs, async claim(input, options) {
      const job = value({ outcome: await env.jobs.claim(input, options) });
      if (!job || job.intent.kind !== "launch") throw new Error("launch claim missing");
      return { ok: true, value: { ...job, intent: { ...job.intent, request: secondRequest } } };
    } };
    const service = createCampaignService({ ...env, jobs });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await providerState({ env })).state.state).toBe("paused");
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("dispatching");
    expect(value({ outcome: await env.service.dispatch({ context, operationId: env.approved.operationId }) }).status).toBe("unknown");
  });
  it("rejects foreign scope returned by the outbox before claiming or reconciliation", async () => {
    const env = await queuedFixture();
    const jobs: CampaignJobPort = { ...env.jobs, async get(input, options) {
      const job = value({ outcome: await env.jobs.get(input, options) });
      if (!job) throw new Error("queued job missing");
      return { ok: true, value: { ...job, scope: otherContext.scope } };
    } };
    const service = createCampaignService({ ...env, jobs });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await service.reconcile({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("queued");
    expect((await providerState({ env })).state.state).toBe("paused");
  });
  it("denies a paused receipt that contradicts its stored active observation", async () => {
    const env = await queuedFixture();
    const repo: CampaignRepoPort = { ...env.repo, async get(input, options) {
      const record = value({ outcome: await env.repo.get(input, options) });
      if (!record || !record.observation) throw new Error("observed campaign missing");
      return { ok: true, value: { ...record, observation: { ...record.observation, state: "active" } } };
    } };
    const service = createCampaignService({ ...env, repo });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("queued");
    expect((await providerState({ env })).state.state).toBe("paused");
  });
  it("persists unknown on a thrown acknowledgement and reconciles without another launch", async () => {
    const env = await queuedFixture();
    let writes = 0;
    const capabilities: CampaignCapabilityPort = { ...env.capabilities, async launch(input, options) {
      writes += 1;
      value({ outcome: await env.capabilities.launch(input, options) });
      throw new Error("private connection lost after activation");
    } };
    const service = createCampaignService({ ...env, capabilities });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toEqual({ ok: false, error: { code: "unavailable", message: "Claimed campaign dispatch unavailable", retryable: false } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("unknown");
    expect((await providerState({ env })).state.state).toBe("active");
    expect(env.audit.entries({}).map(entry => entry.outcome)).toEqual(["submitted", "unknown"]);
    expect(value({ outcome: await service.dispatch({ context, operationId: env.approved.operationId }) }).status).toBe("unknown");
    expect(value({ outcome: await service.reconcile({ context, operationId: env.approved.operationId }) }).status).toBe("submitted");
    expect(writes).toBe(1);
  });
  it("ignores request cancellation for persistence after a provider effect", async () => {
    const env = await queuedFixture();
    const controller = new AbortController();
    const capabilities: CampaignCapabilityPort = { ...env.capabilities, async launch(input, options) {
      const result = await env.capabilities.launch(input, options);
      controller.abort();
      return result;
    } };
    const service = createCampaignService({ ...env, capabilities });
    expect(value({ outcome: await service.dispatch({ context, operationId: env.approved.operationId }, { signal: controller.signal }) }).status).toBe("submitted");
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("submitted");
    expect(env.audit.entries({}).map(entry => entry.outcome)).toEqual(["submitted", "submitted"]);
  });
  it("does not replay an acknowledged effect when completion persistence fails", async () => {
    const env = await queuedFixture();
    let writes = 0;
    let failFinish = true;
    const capabilities: CampaignCapabilityPort = { ...env.capabilities, async launch(input, options) { writes += 1; return env.capabilities.launch(input, options); } };
    const jobs: CampaignJobPort = { ...env.jobs, async finish(input, options) {
      if (failFinish) return { ok: false, error: { code: "unavailable", message: "Completion unavailable", retryable: false } };
      return env.jobs.finish(input, options);
    } };
    const service = createCampaignService({ ...env, capabilities, jobs });
    expect(await service.dispatch({ context, operationId: env.approved.operationId })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.approved.operationId }) })?.status).toBe("dispatching");
    expect(value({ outcome: await service.dispatch({ context, operationId: env.approved.operationId }) }).status).toBe("unknown");
    failFinish = false;
    expect(value({ outcome: await service.reconcile({ context, operationId: env.approved.operationId }) }).status).toBe("submitted");
    expect(writes).toBe(1);
  });
  it("does not promote partial creation using another operation's paused hierarchy", async () => {
    const env = await fixture({ creation: "partial" });
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    const partial = value({ outcome: await env.capabilities.readState({ context, campaignId: saved.campaignId, connectionId: "connection", accountId: "account", operationId: env.draft.operationId }) });
    value({ outcome: env.capabilities.setReadback({ context, readback: { ...partial, complete: true, operationId: "unrelated" } }) });
    expect(value({ outcome: await env.service.reconcile({ context, operationId: env.draft.operationId }) }).status).toBe("unknown");
    expect(await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight })).toMatchObject({ ok: false, error: { code: "conflict" } });
    value({ outcome: env.capabilities.setReadback({ context, readback: { ...partial, complete: true } }) });
    expect(value({ outcome: await env.service.reconcile({ context, operationId: env.draft.operationId }) }).status).toBe("submitted");
    expect(value({ outcome: await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight }) }).operations).toHaveLength(1);
  });
  it("denies a corrupted creation campaign identity before claiming", async () => {
    const env = await fixture();
    let claimed = false;
    const jobs: CampaignJobPort = { ...env.jobs, async get(input, options) {
      const result = await env.jobs.get(input, options);
      if (!result.ok || !result.value) return result;
      const job: CampaignJob = { ...result.value, intent: { kind: "create", campaignId: "other-campaign", draft: env.draft } };
      return { ok: true, value: job };
    }, async claim(input, options) { claimed = true; return env.jobs.claim(input, options); } };
    const service = createCampaignService({ ...env, jobs });
    expect(await service.createPaused({ context, draft: env.draft })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(claimed).toBe(false);
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.draft.operationId }) })?.status).toBe("queued");
  });
});

/** Adversarial evidence keeps every field valid while challenging aggregate hierarchy rules. */
function invalidHierarchy(required: { readback: CampaignReadback; kind: "duplicate" | "mixed" | "empty" }): CampaignReadback["hierarchy"] {
  switch (required.kind) {
    case "duplicate": return [...required.readback.hierarchy, required.readback.hierarchy[0]];
    case "mixed": return required.readback.hierarchy.map((entity, index) => ({ ...entity, state: index === 1 ? "active" as const : "paused" as const }));
    case "empty": return [];
    default: { const exhaustive: never = required.kind; throw new Error(String(exhaustive)); }
  }
}
