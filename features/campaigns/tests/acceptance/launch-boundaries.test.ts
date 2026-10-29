import { describe, expect, it } from "vitest";
import type { CampaignDependencies, CampaignJob, Outcome } from "../../index.js";
import { proposeLaunch, queueLaunch } from "../../src/launch.js";
import { context, fixture, flight, request, value } from "../fixtures.js";

type Env = Awaited<ReturnType<typeof fixture>>;
const broken = { ok: false as const, error: { code: "unavailable" as const, message: "port unavailable", retryable: true } };

function dependencies(required: { env: Env; override?: Partial<CampaignDependencies> }): CampaignDependencies {
  const { env } = required;
  return { repo: env.repo, capabilities: env.capabilities, assets: env.assets, safety: env.safety, jobs: env.jobs, clock: env.clock, ids: env.ids, audit: env.audit, ...required.override };
}
/** jobs.get that fails, or reports no row, on the nth read of one operation; every other read is real. */
function jobsFailingOn(required: { env: Env; operationId: string; call: number; missing?: boolean }): CampaignDependencies["jobs"] {
  let seen = 0;
  const real = required.env.jobs;
  return { ...real, async get(input, optional): Promise<Outcome<CampaignJob | null>> {
    if (input.operationId !== required.operationId) return real.get(input, optional);
    seen += 1;
    if (seen !== required.call) return real.get(input, optional);
    return required.missing ? { ok: true, value: null } : broken;
  } };
}
async function proposed(required: { env: Env }) {
  const env = required.env;
  const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
  const exact = value({ outcome: await env.service.proposeLaunch({ context, campaignId: saved.campaignId, flight }) });
  const approved = request({ proposal: exact });
  value({ outcome: env.safety.approve({ context, proposal: exact, approvalId: approved.approvalId }) });
  return { saved, exact, approved };
}

describe("proposeLaunch boundaries", () => {
  it("rejects malformed input before any port is read", async () => {
    const env = await fixture();
    expect(await proposeLaunch({ dependencies: dependencies({ env }), input: { context, campaignId: "", flight } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });
  it("rejects a flight that already ended", async () => {
    const env = await fixture();
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    env.setTime({ now: flight.window.end });
    expect(await proposeLaunch({ dependencies: dependencies({ env }), input: { context, campaignId: saved.campaignId, flight } })).toMatchObject({ ok: false, error: { code: "expired" } });
  });
  it("surfaces a repository read failure and a campaign outside scope", async () => {
    const env = await fixture();
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    const failing = dependencies({ env, override: { repo: { ...env.repo, get: async () => broken } } });
    expect(await proposeLaunch({ dependencies: failing, input: { context, campaignId: saved.campaignId, flight } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(await proposeLaunch({ dependencies: dependencies({ env }), input: { context, campaignId: "missing", flight } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
  it("stops before building a card when creation authority or creative lookup fails", async () => {
    const env = await fixture();
    const saved = value({ outcome: await env.service.createPaused({ context, draft: env.draft }) });
    const input = { context, campaignId: saved.campaignId, flight };
    const noAuthority = dependencies({ env, override: { safety: { ...env.safety, authorizeCreation: async () => broken } } });
    expect(await proposeLaunch({ dependencies: noAuthority, input })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const noAssets = dependencies({ env, override: { assets: { resolve: async () => broken } } });
    expect(await proposeLaunch({ dependencies: noAssets, input })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(value({ outcome: await env.repo.getProposal({ context, operationId: "launch-1" }) })).toBeNull();
  });
});

describe("queueLaunch boundaries", () => {
  it("rejects malformed approval input and an unreadable proposal store", async () => {
    const env = await fixture();
    const { approved } = await proposed({ env });
    expect(await queueLaunch({ dependencies: dependencies({ env }), input: { context, request: { ...approved, approvalId: "" } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const failing = dependencies({ env, override: { repo: { ...env.repo, getProposal: async () => broken } } });
    expect(await queueLaunch({ dependencies: failing, input: { context, request: approved } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("fails closed when the outbox cannot be read before or after enqueue", async () => {
    const env = await fixture();
    const { approved } = await proposed({ env });
    const operationId = approved.operationId;
    const before = dependencies({ env, override: { jobs: jobsFailingOn({ env, operationId, call: 1 }) } });
    expect(await queueLaunch({ dependencies: before, input: { context, request: approved } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId }) })).toBeNull();
    const afterRead = dependencies({ env, override: { jobs: jobsFailingOn({ env, operationId, call: 2 }) } });
    expect(await queueLaunch({ dependencies: afterRead, input: { context, request: approved } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
  });
  it("reports a missing job after a successful enqueue and an enqueue failure", async () => {
    const env = await fixture();
    const { approved } = await proposed({ env });
    const missing = dependencies({ env, override: { jobs: jobsFailingOn({ env, operationId: approved.operationId, call: 2, missing: true }) } });
    expect(await queueLaunch({ dependencies: missing, input: { context, request: approved } })).toMatchObject({ ok: false, error: { code: "unavailable", message: "Enqueued intent missing" } });
    const other = await fixture();
    const second = await proposed({ env: other });
    const refusing = dependencies({ env: other, override: { jobs: { ...other.jobs, enqueue: async () => broken } } });
    expect(await queueLaunch({ dependencies: refusing, input: { context, request: second.approved } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(value({ outcome: await other.jobs.get({ context, operationId: second.approved.operationId }) })).toBeNull();
  });
  it("is idempotent while queued and refuses a queued job with a different exact intent", async () => {
    const env = await fixture();
    const { exact, approved } = await proposed({ env });
    const first = value({ outcome: await queueLaunch({ dependencies: dependencies({ env }), input: { context, request: approved } }) });
    const again = value({ outcome: await queueLaunch({ dependencies: dependencies({ env }), input: { context, request: approved } }) });
    expect(again).toEqual(first);
    const other = await fixture();
    const second = await proposed({ env: other });
    const differing = { ...second.approved, approvalId: "other-approval" };
    value({ outcome: await other.jobs.enqueue({ context, operationId: differing.operationId, argumentsDigest: differing.argumentsDigest, intent: { kind: "launch", request: differing, proposal: second.exact } }) });
    expect(await queueLaunch({ dependencies: dependencies({ env: other }), input: { context, request: second.approved } })).toMatchObject({ ok: false, error: { code: "conflict", message: "Queued exact operation differs" } });
    expect(exact.operations).toHaveLength(1);
  });
  it("rechecks the campaign: unreadable, changed, unverified creation and ended flight all refuse to enqueue", async () => {
    const env = await fixture();
    const { approved, saved } = await proposed({ env });
    const check = async (override: Partial<CampaignDependencies>) => queueLaunch({ dependencies: dependencies({ env, override }), input: { context, request: approved } });
    expect(await check({ repo: { ...env.repo, get: async () => broken } })).toMatchObject({ ok: false, error: { code: "unavailable" } });
    const record = value({ outcome: await env.repo.get({ context, campaignId: saved.campaignId }) })!;
    const changed = { ...record, draft: { ...record.draft, accountId: "foreign" } };
    expect(await check({ repo: { ...env.repo, get: async () => ({ ok: true as const, value: changed }) } })).toMatchObject({ ok: false });
    const unverified = { ...record, receipt: { ...record.receipt, observedState: "unknown" as const } };
    expect(await check({ repo: { ...env.repo, get: async () => ({ ok: true as const, value: unverified }) } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    env.setTime({ now: flight.window.end });
    expect(await check({})).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(value({ outcome: await env.jobs.get({ context, operationId: approved.operationId }) })).toBeNull();
  });
});
