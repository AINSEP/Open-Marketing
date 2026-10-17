import { describe, it, expect } from "vitest";
import type { CampaignRepoPort, CampaignCapabilityPort, CampaignAssetPort, CampaignSafetyPort, CampaignJobPort, CampaignAuditPort, MemoryCampaignAsset, MemoryCampaignSafety, MemoryCampaignAudit, MemoryCampaignObserver, LaunchProposal } from "../../index.js";
import { context, otherContext, draft, flight, proposal, request, value, revisionDigest } from "../fixtures.js";
import { createHash } from "node:crypto";

/** B1: identical behavioral suite runs against memory and real portable SQL repository. */
export function CampaignRepoPortSuite(required: { create: () => CampaignRepoPort | Promise<CampaignRepoPort> }) {
  describe("CampaignRepoPort behavior", () => {
    it("persists one neutral local draft, deduplicates exact reuse and rejects changed/cross-scope reads", async () => {
      const port = await required.create();
      const campaign = { operationId: 'neutral-local', name: 'Traffic', objective: 'traffic' as const,
        schedule: { window: { start: 1000, end: 5000 }, timezone: 'UTC' }, audience: { countries: ['US'] },
        creativeIds: ['creative'], creativeDigest: revisionDigest,
        targets: [{ pluginId: 'fixture', connectionId: 'connection', accountId: 'account', dailyBudget: { minorUnits: 500, currency: 'USD' }, expectedExposure: { minorUnits: 2000, currency: 'USD' } }] };
      const first = value({ outcome: await port.saveNeutral({ context, campaign }) });
      expect(value({ outcome: await port.saveNeutral({ context, campaign }) })).toEqual(first);
      expect(await port.saveNeutral({ context, campaign: { ...campaign, name: 'Changed' } })).toMatchObject({ ok: false, error: { code: 'conflict' } });
      campaign.name = 'Mutated caller';
      expect(value({ outcome: await port.getNeutral({ context, campaignId: first.campaignId }) })).toEqual(first);
      expect(value({ outcome: await port.getNeutral({ context: otherContext, campaignId: first.campaignId }) })).toBeNull();
      expect(value({ outcome: await port.list({ context, query: { limit: 100 } }) })).toEqual({ items: [], cursor: null });
      expect(await port.get({ context, campaignId: first.campaignId })).not.toMatchObject({ ok: true, value: { draft: expect.anything() } });
      expect(await port.saveNeutral({ context, campaign }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    });
    it("lists bounded scoped keyset pages with latest observations and no duplicates", async () => {
      const port = await required.create();
      const receipts = [];
      for (const operationId of ['list-c', 'list-a', 'list-b']) receipts.push(value({ outcome: await port.save({ context, draft: { ...draft, operationId } }) }));
      value({ outcome: await port.save({ context: otherContext, draft: { ...draft, operationId: 'foreign-list' } }) });
      const observed = receipts[0];
      value({ outcome: await port.observe({ context, state: { campaignId: observed.campaignId, state: 'active', observedAt: 1000, providerReference: 'fixture' } }) });
      const first = value({ outcome: await port.list({ context, query: { limit: 2 } }) });
      expect(first.items).toHaveLength(2);
      expect(first.cursor).toBe(first.items[1].receipt.campaignId);
      const second = value({ outcome: await port.list({ context, query: { limit: 2, cursor: first.cursor! } }) });
      expect(second.items).toHaveLength(1);
      expect(second.cursor).toBeNull();
      const items = [...first.items, ...second.items];
      expect(items.map(record => record.receipt.campaignId)).toEqual(receipts.map(receipt => receipt.campaignId).sort());
      expect(items.find(record => record.receipt.campaignId === observed.campaignId)?.observation?.state).toBe('active');
      expect(await port.list({ context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
      expect(await port.list({ context, query: { limit: 1 } }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
      (first.items[0].draft.creativeIds as string[]).push('mutated');
      expect(value({ outcome: await port.list({ context, query: { limit: 100 } }) }).items.every(record => record.draft.creativeIds.length === 1)).toBe(true);
    });
    it("persists immutable unknown paused intent and rejects altered operation reuse", async () => {
      const port = await required.create();
      const saved = value({ outcome: await port.save({ context, draft }) });
      expect(saved).toEqual({ campaignId: saved.campaignId, desiredState: "paused", observedState: "unknown" });
      expect(value({ outcome: await port.save({ context, draft: structuredClone(draft) }) })).toEqual(saved);
      expect(await port.save({ context, draft: { ...draft, name: "Changed" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(value({ outcome: await port.get({ context, campaignId: saved.campaignId }) })?.draft.name).toBe("Paused plan");
    });
    it("isolates owner/workspace and protects stored values from caller mutation", async () => {
      const port = await required.create();
      const saved = value({ outcome: await port.save({ context, draft }) });
      expect(value({ outcome: await port.get({ context: otherContext, campaignId: saved.campaignId }) })).toBeNull();
      const record = value({ outcome: await port.get({ context, campaignId: saved.campaignId }) });
      if (!record) throw new Error("record missing");
      (record.draft.creativeIds as string[]).push("foreign");
      expect(value({ outcome: await port.get({ context, campaignId: saved.campaignId }) })?.draft.creativeIds).toEqual(["creative-1"]);
      expect(await port.observe({ context: otherContext, state: { campaignId: saved.campaignId, state: "active", observedAt: 1000, providerReference: "provider" } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("appends observations, rejects stale evidence and retains paused desired state", async () => {
      const port = await required.create();
      const saved = value({ outcome: await port.save({ context, draft }) });
      const paused = { campaignId: saved.campaignId, state: "paused" as const, observedAt: 1000, providerReference: "provider" };
      value({ outcome: await port.observe({ context, state: paused }) });
      expect(value({ outcome: await port.get({ context, campaignId: saved.campaignId }) })?.receipt.observedState).toBe("paused");
      value({ outcome: await port.observe({ context, state: { ...paused, state: "active", observedAt: 1001 } }) });
      expect(await port.observe({ context, state: paused })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const active = value({ outcome: await port.get({ context, campaignId: saved.campaignId }) });
      expect(active?.observation?.state).toBe("active");
      expect(active?.receipt).toEqual({ campaignId: saved.campaignId, desiredState: "paused", observedState: "unknown" });
    });
    it("persists exact proposals and refuses overwrite/account or argument substitution", async () => {
      const port = await required.create();
      const saved = value({ outcome: await port.save({ context, draft }) });
      const exact = proposal({ campaignId: saved.campaignId });
      expect(value({ outcome: await port.saveProposal({ context, proposal: exact }) })).toEqual(exact);
      expect(value({ outcome: await port.getProposal({ context, operationId: "launch-1" }) })).toEqual(exact);
      expect(value({ outcome: await port.getProposal({ context: otherContext, operationId: "launch-1" }) })).toBeNull();
      expect(await port.saveProposal({ context, proposal: proposal({ campaignId: saved.campaignId, exposure: 9999 }) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.saveProposal({ context, proposal: { ...exact, arguments: { ...exact.arguments, accountId: "foreign" } } })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(value({ outcome: await port.getProposal({ context, operationId: "launch-1" }) })).toEqual(exact);
    });
    it("rejects activation in draft and invalid input explicitly", async () => {
      const port = await required.create();
      expect(await port.save({ context, draft: { ...draft, activate: true } as typeof draft })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
      expect(await port.observe({} as Parameters<CampaignRepoPort["observe"]>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
/** B1: same suite drives the provider double and validated federation capability adapter. */
export function CampaignCapabilityPortSuite(required: { create: () => CampaignCapabilityPort }) {
  describe("CampaignCapabilityPort behavior", () => {
    it("creates an entirely PAUSED hierarchy and reads account-scoped evidence", async () => {
      const port = required.create();
      const input = { context, draft, campaignId: "campaign", permitId: "creation-permit" };
      expect(value({ outcome: await port.createPaused(input) })).toEqual({ campaignId: "campaign", desiredState: "paused", observedState: "paused" });
      const read = value({ outcome: await port.readState({ context, campaignId: "campaign", connectionId: "connection", accountId: "account", operationId: "create-1" }) });
      expect(read.complete).toBe(true);
      expect(read.operationId).toBe("create-1");
      expect(read.hierarchy).toEqual([{ entityId: "campaign", state: "paused" }, { entityId: "campaign/ad-set", state: "paused" }, { entityId: "campaign/ad/creative-1", state: "paused" }]);
      expect(await port.readState({ context, campaignId: "campaign", connectionId: "connection", accountId: "foreign", operationId: "create-1" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it("binds idempotency to the original create/launch arguments", async () => {
      const port = required.create();
      const input = { context, draft, campaignId: "campaign", permitId: "creation-permit" };
      value({ outcome: await port.createPaused(input) });
      expect(await port.createPaused({ ...input, draft: { ...draft, name: "Changed" } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const exact = proposal({ campaignId: "campaign" });
      const approved = request({ proposal: exact });
      const launched = { context, request: approved, proposal: exact, permitId: "approval-1" };
      expect(value({ outcome: await port.launch(launched) }).status).toBe("submitted");
      expect(value({ outcome: await port.launch(launched) }).status).toBe("submitted");
      const changed = proposal({ campaignId: "campaign", exposure: 5555 });
      expect(await port.launch({ context, request: request({ proposal: changed }), proposal: changed, permitId: "approval-2" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const read = value({ outcome: await port.readState({ context, campaignId: "campaign", connectionId: "connection", accountId: "account", operationId: "launch-1" }) });
      expect(read.state.state).toBe("active");
      expect(read.operationId).toBe("launch-1");
    });
    it("rejects altered approval digest and foreign workspace launch", async () => {
      const port = required.create();
      value({ outcome: await port.createPaused({ context, draft, campaignId: "campaign", permitId: "permit" }) });
      const exact = proposal({ campaignId: "campaign" });
      const approved = request({ proposal: exact });
      expect(await port.launch({ context, request: { ...approved, argumentsDigest: "b".repeat(64) }, proposal: exact, permitId: "permit" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.launch({ context: otherContext, request: approved, proposal: exact, permitId: "permit" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
    });
    it.each(["account", "effect", "exposure", "creative"] as const)("rejects substituted %s even when the original arguments digest matches", async (kind) => {
      const port = required.create();
      value({ outcome: await port.createPaused({ context, draft, campaignId: "campaign", permitId: "permit" }) });
      const exact = proposal({ campaignId: "campaign" });
      const changed = substitutedEnvelope({ proposal: exact, kind });
      expect(await port.launch({ context, request: request({ proposal: changed }), proposal: changed, permitId: "permit" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const read = value({ outcome: await port.readState({ context, campaignId: "campaign", connectionId: "connection", accountId: "account", operationId: "launch-1" }) });
      expect(read.state.state).toBe("paused");
      expect(read.operationId).toBe("create-1");
    });
  });
}
/** Keep the argument digest unchanged while changing a distinct authority-bearing field. */
function substitutedEnvelope(required: { proposal: LaunchProposal; kind: "account" | "effect" | "exposure" | "creative" }): LaunchProposal {
  const exact = required.proposal;
  const operation = exact.operations[0];
  switch (required.kind) {
    case "account": return { ...exact, operations: [{ ...operation, accountId: "foreign" }] };
    case "effect": return { ...exact, operations: [{ ...operation, effects: ["read"] }] };
    case "exposure": return { ...exact, operations: [{ ...operation, moneyExposure: { amount: { minorUnits: 9999, currency: "USD" }, window: exact.arguments.flight.window } }] };
    case "creative": return { ...exact, creativeDigest: "b".repeat(64) };
    default: { const exhaustive: never = required.kind; throw new Error(String(exhaustive)); }
  }
}
export function CampaignAssetPortSuite(required: { create: () => MemoryCampaignAsset }) {
  describe("CampaignAssetPort behavior", () => {
    it("rejects missing/foreign IDs and changes digest with revision, independent of ordering", async () => {
      const port: CampaignAssetPort = required.create();
      expect(await port.resolve({ context, creativeIds: ["missing"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const controls = port as MemoryCampaignAsset;
      value({ outcome: controls.put({ context, creativeId: "one", revisionDigest }) });
      value({ outcome: controls.put({ context, creativeId: "two", revisionDigest: "b".repeat(64) }) });
      const before = value({ outcome: await port.resolve({ context, creativeIds: ["one", "two"] }) });
      expect(value({ outcome: await port.resolve({ context, creativeIds: ["two", "one"] }) })).toEqual(before);
      value({ outcome: controls.put({ context, creativeId: "one", revisionDigest: "c".repeat(64) }) });
      expect(value({ outcome: await port.resolve({ context, creativeIds: ["one", "two"] }) })).not.toEqual(before);
      expect(await port.resolve({ context: otherContext, creativeIds: ["one"] })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(await port.resolve({ context, creativeIds: ["one", "one"] })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
export function CampaignSafetyPortSuite(required: { create: () => MemoryCampaignSafety }) {
  describe("CampaignSafetyPort behavior", () => {
    it("needs exact approval, consumes once and blocks later operations/halt", async () => {
      const controls = required.create();
      const port: CampaignSafetyPort = controls;
      const exact = proposal({ campaignId: "campaign" });
      const approved = request({ proposal: exact });
      expect(await port.authorize({ context, request: approved, proposal: exact })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      value({ outcome: controls.approve({ context, proposal: exact, approvalId: "approval-1" }) });
      value({ outcome: await port.authorize({ context, request: approved, proposal: exact }) });
      let effects = 0;
      const execute = async (_input: { permitId: string }) => { effects += 1; return { ok: true as const, value: { operationId: "launch-1", status: "submitted" as const } }; };
      value({ outcome: await port.dispatchLaunch({ context, request: approved, proposal: exact, execute }) });
      expect(await port.dispatchLaunch({ context, request: approved, proposal: exact, execute })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      const next = proposal({ campaignId: "campaign", operationId: "launch-2", exposure: 2000 });
      expect(await port.authorize({ context, request: request({ proposal: next }), proposal: next })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      controls.halt({ scope: context.scope, halted: true });
      expect(await port.authorizeCreation({ context, draft })).toMatchObject({ ok: false, error: { code: "forbidden" } });
      expect(effects).toBe(1);
    });
    it("rejects substituted exposure even if a double was told to approve it", async () => {
      const port = required.create();
      const exact = proposal({ campaignId: "campaign" });
      const changed = substitutedEnvelope({ proposal: exact, kind: "exposure" });
      value({ outcome: port.approve({ context, proposal: changed, approvalId: "approval-1" }) });
      let effects = 0;
      expect(await port.dispatchLaunch({ context, proposal: changed, request: request({ proposal: changed }), execute: async () => {
        effects += 1;
        return { ok: true, value: { operationId: "launch-1", status: "submitted" } };
      } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(effects).toBe(0);
    });
  });
}
export function CampaignJobPortSuite(required: { create: () => CampaignJobPort }) {
  describe("CampaignJobPort behavior", () => {
    it("atomically deduplicates exact intent, claims once and never reclaims unknown work", async () => {
      const port = required.create();
      const argumentsDigest = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
      const input = { context, operationId: draft.operationId, argumentsDigest, intent: { kind: "create" as const, campaignId: "campaign", draft } };
      const saved = value({ outcome: await port.enqueue(input) });
      expect(value({ outcome: await port.enqueue(input) })).toEqual(saved);
      expect(value({ outcome: await port.get({ context, operationId: draft.operationId }) })?.intent).toEqual(input.intent);
      expect(await port.enqueue({ ...input, argumentsDigest: "b".repeat(64) })).toMatchObject({ ok: false, error: { code: "conflict" } });
      const claims = await Promise.all([port.claim({ context, operationId: draft.operationId }), port.claim({ context, operationId: draft.operationId })]);
      expect(claims.map(outcome => value({ outcome })).filter(Boolean)).toHaveLength(1);
      value({ outcome: await port.finish({ context, operationId: draft.operationId, status: "unknown" }) });
      expect(value({ outcome: await port.claim({ context, operationId: draft.operationId }) })).toBeNull();
      expect(value({ outcome: await port.get({ context, operationId: draft.operationId }) })?.status).toBe("unknown");
      expect(value({ outcome: await port.get({ context: otherContext, operationId: draft.operationId }) })).toBeNull();
    });
    it("cannot finish a job before a claim or enqueue a mismatched identity", async () => {
      const port = required.create();
      const argumentsDigest = createHash("sha256").update(JSON.stringify(draft)).digest("hex");
      value({ outcome: await port.enqueue({ context, operationId: draft.operationId, argumentsDigest, intent: { kind: "create", campaignId: "campaign", draft } }) });
      expect(await port.finish({ context, operationId: draft.operationId, status: "submitted" })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await port.enqueue({ context, operationId: "wrong", argumentsDigest, intent: { kind: "create", campaignId: "campaign", draft } })).toMatchObject({ ok: false, error: { code: "conflict" } });
    });
    it("refuses a launch intent with substituted exposure before storing it", async () => {
      const port = required.create();
      const changed = substitutedEnvelope({ proposal: proposal({ campaignId: "campaign" }), kind: "exposure" });
      const approved = request({ proposal: changed });
      expect(await port.enqueue({ context, operationId: approved.operationId, argumentsDigest: approved.argumentsDigest, intent: { kind: "launch", proposal: changed, request: approved } })).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(value({ outcome: await port.get({ context, operationId: approved.operationId }) })).toBeNull();
    });
  });
}
/** B1: same observer contract can be reused when composition supplies another adapter. */
export function CampaignObserverPortSuite(required: { create: () => MemoryCampaignObserver }) {
  describe("CampaignObserverPort behavior", () => {
    it("records bounded copied events and preserves correlation/trace/run IDs", () => {
      const observer = required.create();
      const event = { operation: "campaigns.dispatch", outcome: "unknown", correlationId: "correlation", traceId: "trace", runId: "run" };
      observer.observe(event);
      event.traceId = "mutated";
      const snapshot = observer.events({});
      expect(snapshot).toEqual([{ operation: "campaigns.dispatch", outcome: "unknown", correlationId: "correlation", traceId: "trace", runId: "run" }]);
      (snapshot[0] as { traceId: string }).traceId = "changed-snapshot";
      expect(observer.events({})[0].traceId).toBe("trace");
    });
  });
}
export function CampaignAuditPortSuite(required: { create: () => MemoryCampaignAudit }) {
  describe("CampaignAuditPort behavior", () => {
    it("appends corrections and retains context/trace without caller mutation", async () => {
      const controls = required.create();
      const port: CampaignAuditPort = controls;
      const original = { context: structuredClone(context), operationId: "op", outcome: "unknown" };
      value({ outcome: await port.record(original) });
      original.context.traceId = "mutated";
      value({ outcome: await port.record({ context, operationId: "op", outcome: "reconciled:submitted" }) });
      expect(controls.entries({})).toEqual([{ context, operationId: "op", outcome: "unknown" }, { context, operationId: "op", outcome: "reconciled:submitted" }]);
      expect(await port.record({} as Parameters<CampaignAuditPort["record"]>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    });
  });
}
