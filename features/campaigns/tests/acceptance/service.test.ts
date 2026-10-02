import { describe, it, expect } from "vitest";
import { createCampaignService, createMemoryCampaignSafety } from "../../index.js";
import type { CampaignDependencies, LaunchProposal, CampaignReadback } from "../../index.js";
import { context, otherContext, fixture, flight, request, value } from "../fixtures.js";

async function approveLaunch(required: { environment: Awaited<ReturnType<typeof fixture>>; approvalId?: string }) {
  const env = required.environment;
  const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
  const exact = value({ outcome: await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight }) });
  const approved = request({ proposal: exact, approvalId: required.approvalId });
  value({ outcome: env.safety.approve({ context, proposal: exact, approvalId: approved.approvalId }) });
  return { saved, exact, approved };
}
async function readback(required: { environment: Awaited<ReturnType<typeof fixture>>; campaignId: string; operationId: string }): Promise<CampaignReadback> {
  return value({ outcome: await required.environment.capabilities.readState({ context, campaignId: required.campaignId, operationId: required.operationId, connectionId: "connection", accountId: "account" }) });
}

describe("campaigns acceptance", () => {
  it("create cannot activate and the full campaign hierarchy is read back PAUSED", async () => {
    const env = await fixture();
    expect(await env.service.createPaused({ context, draft: { ...env.draft, state: "active" } as typeof env.draft })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.draft.operationId }) })).toBeNull();
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    expect(saved.observedState).toBe("paused");
    const platform = await readback({ environment: env, campaignId: saved.campaignId, operationId: env.draft.operationId });
    expect(platform.state.state).toBe("paused");
    expect(platform.hierarchy).toHaveLength(3);
    expect(platform.hierarchy.map(entity => entity.state)).toEqual(["paused", "paused", "paused"]);
    expect(value({ outcome: await env.repo.get({ context, campaignId: saved.campaignId }) })?.observation?.providerReference).toBe("memory:" + saved.campaignId);
  });
  it("queues the displayed exact arguments, survives service replacement and dispatches once", async () => {
    const env = await fixture();
    const { exact, approved, saved } = await approveLaunch({ environment: env });
    const displayed = structuredClone(exact);
    const queued = value({ outcome: await env.service.launch({ context, request: approved }) });
    expect(queued.status).toBe("pending");
    const persisted = value({ outcome: await env.jobs.get({ context, operationId: approved.operationId }) });
    expect(persisted?.intent).toEqual({ kind: "launch", request: approved, proposal: displayed });
    (exact.arguments.flight.expectedExposure as { minorUnits: number }).minorUnits = 999999;
    const replacement = createCampaignService(env);
    const results = await Promise.all([replacement.dispatch({ context, operationId: approved.operationId }), replacement.dispatch({ context, operationId: approved.operationId })]);
    expect(results.map(outcome => value({ outcome }).status)).toContain("submitted");
    expect(value({ outcome: await env.jobs.get({ context, operationId: approved.operationId }) })?.status).toBe("submitted");
    expect((await readback({ environment: env, campaignId: saved.campaignId, operationId: approved.operationId })).state.state).toBe("active");
    expect(value({ outcome: await replacement.launch({ context, request: approved }) }).status).toBe("submitted");
    value({ outcome: await replacement.reconcile({ context, operationId: approved.operationId }) });
    const record = value({ outcome: await env.repo.get({ context, campaignId: saved.campaignId }) });
    expect(record?.observation?.state).toBe("active");
    expect(record?.receipt.desiredState).toBe("paused");
    expect(env.audit.entries({}).map(entry => entry.context.traceId)).toEqual(["trace", "trace", "trace"]);
  });
  it("changed creative revisions invalidate approval before enqueue and after enqueue", async () => {
    const before = await fixture();
    const first = await approveLaunch({ environment: before });
    value({ outcome: before.assets.put({ context, creativeId: "creative-1", revisionDigest: "b".repeat(64) }) });
    expect(await before.service.launch({ context, request: first.approved })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(value({ outcome: await before.jobs.get({ context, operationId: first.approved.operationId }) })).toBeNull();
    const after = await fixture();
    const second = await approveLaunch({ environment: after });
    value({ outcome: await after.service.launch({ context, request: second.approved }) });
    value({ outcome: after.assets.put({ context, creativeId: "creative-1", revisionDigest: "b".repeat(64) }) });
    expect(await after.service.dispatch({ context, operationId: second.approved.operationId })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect((await readback({ environment: after, campaignId: second.saved.campaignId, operationId: second.approved.operationId })).state.state).toBe("paused");
  });
  it("changed arguments invalidate approval and every later spend operation needs a fresh exact card", async () => {
    const env = await fixture();
    const { exact, approved, saved } = await approveLaunch({ environment: env });
    expect(await env.service.launch({ context, request: { ...approved, argumentsDigest: "b".repeat(64) } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const later = value({ outcome: await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight: { ...flight, expectedExposure: { minorUnits: 2200, currency: "USD" } } }) });
    expect(later.operations[0].operationId).not.toBe(exact.operations[0].operationId);
    expect(later.operations[0].argumentsDigest).not.toBe(exact.operations[0].argumentsDigest);
    expect(await env.service.launch({ context, request: request({ proposal: later, approvalId: approved.approvalId }) })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    value({ outcome: env.safety.approve({ context, proposal: later, approvalId: "approval-2" }) });
    value({ outcome: await env.service.launch({ context, request: request({ proposal: later, approvalId: "approval-2" }) }) });
    expect(value({ outcome: await env.jobs.get({ context, operationId: later.operations[0].operationId }) })?.status).toBe("queued");
  });
  it("partial creation remains unknown and reconciles without repeating creation", async () => {
    const env = await fixture({ creation: "partial" });
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    expect(saved.observedState).toBe("unknown");
    expect(await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight })).toMatchObject({ ok: false, error: { code: "conflict" } });
    const partial = await readback({ environment: env, campaignId: saved.campaignId, operationId: env.draft.operationId });
    value({ outcome: env.capabilities.setReadback({ context, readback: { ...partial, complete: true } }) });
    expect(value({ outcome: await env.service.reconcile({ context, operationId: env.draft.operationId }) }).status).toBe("submitted");
    expect(value({ outcome: await env.repo.get({ context, campaignId: saved.campaignId }) })?.receipt.observedState).toBe("paused");
  });
  it("unknown activation never retries and unrelated active evidence cannot acknowledge it", async () => {
    const env = await fixture({ launch: "unknown" });
    const { approved, saved } = await approveLaunch({ environment: env });
    value({ outcome: await env.service.launch({ context, request: approved }) });
    expect(value({ outcome: await env.service.dispatch({ context, operationId: approved.operationId }) }).status).toBe("unknown");
    expect(value({ outcome: await env.service.dispatch({ context, operationId: approved.operationId }) }).status).toBe("unknown");
    expect(value({ outcome: await env.service.reconcile({ context, operationId: approved.operationId }) }).status).toBe("unknown");
    const paused = await readback({ environment: env, campaignId: saved.campaignId, operationId: approved.operationId });
    const active = { ...paused, state: { ...paused.state, state: "active" as const }, hierarchy: paused.hierarchy.map(entity => ({ ...entity, state: "active" as const })), operationId: "unrelated-operation" };
    value({ outcome: env.capabilities.setReadback({ context, readback: active }) });
    expect(value({ outcome: await env.service.reconcile({ context, operationId: approved.operationId }) }).status).toBe("unknown");
    value({ outcome: env.capabilities.setReadback({ context, readback: { ...active, operationId: approved.operationId } }) });
    expect(value({ outcome: await env.service.reconcile({ context, operationId: approved.operationId }) }).status).toBe("submitted");
  });
  it("halt and revocation after enqueue block dispatch", async () => {
    const env = await fixture();
    const { approved, saved } = await approveLaunch({ environment: env });
    value({ outcome: await env.service.launch({ context, request: approved }) });
    env.safety.halt({ scope: context.scope, halted: true });
    expect(await env.service.dispatch({ context, operationId: approved.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect((await readback({ environment: env, campaignId: saved.campaignId, operationId: approved.operationId })).state.state).toBe("paused");
    expect(await env.service.createPaused({ context, draft: { ...env.draft, operationId: "create-2" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const revoked = await fixture();
    const second = await approveLaunch({ environment: revoked });
    value({ outcome: await revoked.service.launch({ context, request: second.approved }) });
    revoked.safety.revoke({ context, approvalId: second.approved.approvalId });
    expect(await revoked.service.dispatch({ context, operationId: second.approved.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it.each([{ mode: "local-sandbox" as const }, { mode: "read-only" as const }])("denies production account mutations in $mode", async ({ mode }) => {
    const env = await fixture({ mode, accountMode: "production" });
    expect(await env.service.createPaused({ context, draft: env.draft })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: env.draft.operationId }) })).toBeNull();
  });
  it("denies account/workspace and owner/principal mismatches", async () => {
    const env = await fixture();
    expect(await env.service.createPaused({ context: otherContext, draft: env.draft })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await env.service.createPaused({ context, draft: { ...env.draft, accountId: "foreign" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(await env.service.createPaused({ context: { ...context, principal: { kind: "owner", ownerId: "foreign" } }, draft: env.draft })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    const { approved } = await approveLaunch({ environment: env });
    expect(await env.service.launch({ context: otherContext, request: approved })).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await env.service.dispatch({ context: otherContext, operationId: approved.operationId })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});
