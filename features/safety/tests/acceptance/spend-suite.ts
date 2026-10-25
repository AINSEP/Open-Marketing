import { describe, expect, it } from "vitest";
import { createSafetyService, createMemorySpendPolicy, createMemoryVerifiedEffectResolver, createMemoryPlatformLimitEvidence } from "../../index.js";
import { approve, capEvidence, approver, context, createHarness, NOW, otherContext, spendRequest, unwrap } from "../fixtures.js";
import type { EffectRequest, FrozenDispatchRequest, PlatformLimitEvidence } from "../../index.js";
/** Exact authorization and financial authority are independent across both repositories. */
export function spendSuite(required: { backend: "memory" | "sql" }) {
 describe(`${required.backend} exact spend acceptance`, () => {
  it("requires an exact card for each distinct call; activation approval cannot authorize reallocation", async () => {
   const harness = createHarness(required);
   const first = spendRequest();
   const second = spendRequest({ operationId: "reallocation", arguments: { action: "reallocate", budget: 600 } });
   const service = harness.service({ requests: [first, second] });
   const frozen = await approve({ harness, service, request: first });
   expect((await service.authorizeDispatch({ context, request: frozen })).ok).toBe(true);
   expect((await service.authorizeDispatch({ context, request: { ...second, approvalId: frozen.approvalId, policyRevision: 0 } })).ok).toBe(false);
   harness.close();
  });
  it.each(["allow_chat", "always_allow"] as const)("rejects %s spend grants", async choice => {
   const harness = createHarness(required);
   const service = harness.service();
   const card = unwrap({ outcome: await service.prepareApproval({ context, request: spendRequest() }) });
   expect(card.allowedChoices).toEqual(["allow", "cancel"]);
   expect(await harness.confirmations.confirm({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice } })).toMatchObject({ ok: false, error: { code: "forbidden", message: "Response differs from exact card or choices" } });
   harness.close();
  });
  it("presentation alone, forged card IDs, stale policy and cross-owner authority fail", async () => {
   const harness = createHarness(required);
   const service = harness.service();
   const request = spendRequest();
   const card = unwrap({ outcome: await service.prepareApproval({ context, request }) });
   const frozen = { ...request, approvalId: card.cardId, policyRevision: 0 };
   expect((await service.authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   expect((await service.authorizeDispatch({ context, request: { ...frozen, approvalId: "forged" } })).ok).toBe(false);
   const approved = await approve({ harness, service, request });
   expect((await service.authorizeDispatch({ context, request: { ...approved, policyRevision: 1 } })).ok).toBe(false);
   expect((await service.authorizeDispatch({ context: otherContext, request: approved })).ok).toBe(false);
   harness.close();
  });
  it("captures precisely reviewed values at transport, rejecting tampered digests or arguments", async () => {
   const harness = createHarness(required);
   const service = harness.service();
   const frozen = await approve({ harness, service, request: spendRequest() });
   let captured: FrozenDispatchRequest | null = null;
   const result = await service.withDispatch({ context, request: frozen, dispatch: async input => { captured = input.request; return { ok: true, value: "sent" }; } });
   expect(result).toEqual({ ok: true, value: "sent" });
   expect(captured).toEqual(frozen);
   expect((await service.authorizeDispatch({ context, request: { ...frozen, arguments: { budget: 999 } } })).ok).toBe(false);
   expect((await service.authorizeDispatch({ context, request: { ...frozen, envelope: { ...frozen.envelope, argumentsDigest: "f".repeat(64) } } })).ok).toBe(false);
   harness.close();
  });
  it("freezes caller arguments before an asynchronous lock wait", async () => {
   const harness = createHarness(required);
   const service = harness.service();
   const frozen = await approve({ harness, service, request: spendRequest() });
   const lock = unwrap({ outcome: await harness.locks.acquire({ context, accountId: "account" }) });
   const pending = service.withDispatch({ context, request: frozen, dispatch: async input => ({ ok: true, value: input.request.arguments.budget }) });
   (frozen.arguments as Record<string, unknown>).budget = 999;
   unwrap({ outcome: await harness.locks.release(lock) });
   expect(await pending).toEqual({ ok: true, value: 600 });
   harness.close();
  });
  it("effect changes, missing bindings, and plugin hint downgrades fail closed", async () => {
   const harness = createHarness(required);
   const service = harness.service();
   const frozen = await approve({ harness, service, request: spendRequest() });
   const downgraded: EffectRequest = { ...spendRequest(), envelope: { ...frozen.envelope, effects: ["read"] } };
   expect((await service.prepareApproval({ context, request: downgraded })).ok).toBe(false);
   expect((await service.authorizeDispatch({ context, request: { ...frozen, pluginDigest: "d".repeat(64) } })).ok).toBe(false);
   const unknown = harness.service({ requests: [] });
   expect((await unknown.authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   harness.close();
  });
  it.each([
   { label: "stale", change: { observedAt: NOW - 60_001 } },
   { label: "future", change: { observedAt: NOW + 1 } },
   { label: "currency", change: { amount: { minorUnits: 1000, currency: "EUR" } } },
   { label: "plugin", change: { pluginDigest: "e".repeat(64) } },
   { label: "account", change: { accountId: "other-account" } },
   { label: "semantics", change: { semantics: "average_budget" as const } },
   { label: "authority", change: { amount: { minorUnits: 2000, currency: "USD" } } },
   { label: "window", change: { window: { start: NOW + 1000, end: NOW + 2000 } } },
  ])("rejects $label cap evidence despite confirmed approval", async ({ change }) => {
   const harness = createHarness(required);
   const frozen = await approve({ harness, service: harness.service(), request: spendRequest() });
   const evidence: PlatformLimitEvidence = { ...capEvidence(), ...change };
   const service = harness.service({ evidence: [evidence] });
   expect((await service.authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   harness.close();
  });
  it("missing cap, revoked confirmation, or policy change prevents dispatch", async () => {
   const harness = createHarness(required);
   const frozen = await approve({ harness, service: harness.service(), request: spendRequest() });
   expect((await harness.service({ evidence: [] }).authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   expect((await harness.service({ policyAllowed: false }).authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   harness.confirmations.revoke({ context, cardId: frozen.approvalId });
   expect((await harness.service().authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   harness.close();
  });
  it("concurrent exact approvals cannot jointly exceed authority", async () => {
   const harness = createHarness(required);
   const first = spendRequest({ operationId: "first" });
   const second = spendRequest({ operationId: "second" });
   const service = harness.service({ requests: [first, second] });
   const a = await approve({ harness, service, request: first });
   const b = await approve({ harness, service, request: second });
   const outcomes = await Promise.all([service.authorizeDispatch({ context, request: a }), service.authorizeDispatch({ context, request: b })]);
   expect(outcomes.filter(outcome => outcome.ok)).toHaveLength(1);
   expect(await harness.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { reserved: { minorUnits: 600 } } });
   harness.close();
  });
  it("normal mutation loses to completed halt and performs no transport effect", async () => {
   const harness = createHarness(required);
   const service = harness.service();
   const frozen = await approve({ harness, service, request: spendRequest() });
   unwrap({ outcome: await service.haltAccount({ context, adAccountId: "account" }) });
   let calls = 0;
   const result = await service.withDispatch({ context, request: frozen, dispatch: async () => { calls++; return { ok: true, value: undefined }; } });
   expect(result.ok).toBe(false);
   expect(calls).toBe(0);
   harness.close();
  });
  it("holds halt barrier through an in-flight transport handoff", async () => {
   const harness = createHarness(required);
   const service = harness.service();
   const frozen = await approve({ harness, service, request: spendRequest() });
   const entered = Promise.withResolvers<void>();
   const complete = Promise.withResolvers<void>();
   const dispatch = service.withDispatch({ context, request: frozen, dispatch: async () => { entered.resolve(); await complete.promise; return { ok: true, value: "sent" }; } });
   await entered.promise;
   let halted = false;
   const halt = service.haltAccount({ context, adAccountId: "account" }).then(outcome => { halted = true; return outcome; });
   await Promise.resolve();
   expect(halted).toBe(false);
   complete.resolve();
   expect((await dispatch).ok).toBe(true);
   expect((await halt).ok).toBe(true);
   expect((await service.authorizeDispatch({ context, request: frozen })).ok).toBe(false);
   harness.close();
  });
  it("audit failure and boundary exceptions produce no transport call", async () => {
   const harness = createHarness(required);
   const frozen = await approve({ harness, service: harness.service(), request: spendRequest() });
   let calls = 0;
   const denied = await harness.service({ auditFail: true }).withDispatch({ context, request: frozen, dispatch: async () => { calls++; return { ok: true, value: undefined }; } });
   expect(denied.ok).toBe(false);
   expect(calls).toBe(0);
   const service = createSafetyService({ repo: harness.repo, clock: harness.time.clock, ids: harness.time.ids, confirmations: harness.confirmations, accountLocks: harness.locks, audit: harness.audit, policy: createMemorySpendPolicy({}), platformLimits: createMemoryPlatformLimitEvidence({}), effects: { ...createMemoryVerifiedEffectResolver({}), async resolve() { throw new Error("tainted secret"); } } });
   expect(await service.authorizeDispatch({ context, request: frozen })).toMatchObject({ ok: false, error: { code: "unavailable", message: "Safety dependency failed; reconcile any submitted operation" } });
   harness.close();
  });
  it("host-admitted read runs without owner confirmation; mixed read/write does not", async () => {
   const harness = createHarness(required);
   const request: EffectRequest = { ...spendRequest(), envelope: { ...spendRequest().envelope, accountId: null, effects: ["read"], moneyExposure: null, requiredLimit: null } };
   const service = harness.service({ requests: [request] });
   expect((await service.authorizeDispatch({ context, request: { ...request, approvalId: "read-only", policyRevision: 0 } })).ok).toBe(true);
   const mixed: EffectRequest = { ...request, envelope: { ...request.envelope, effects: ["read", "write"] } };
   expect((await harness.service({ requests: [mixed] }).prepareApproval({ context, request: mixed })).ok).toBe(false);
   harness.close();
  });
 });
}
