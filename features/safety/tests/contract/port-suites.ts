import { describe, it, expect } from "vitest";
import type { AccountDispatchLockPort, ConfirmationExchangePort, PlatformLimitEvidencePort, SafetyAuditPort, SafetyRepoPort, SpendPolicyPort, VerifiedEffectResolverPort } from "../../index.js";
import { approver, context, otherContext, spendRequest, capEvidence, timing, unwrap, generationRequest, NOW } from "../fixtures.js";
import { digestArguments } from "../../index.js";
import type { CampaignConstituent, EffectRequest, FrozenDispatchRequest } from "../../index.js";
/** B1 behavioral suite; both memory and SQL MUST preserve the same accounting semantics. */
export function SafetyRepoPortSuite(required: { create: () => { repo: SafetyRepoPort; time: ReturnType<typeof timing>; close: () => void } }) {
 describe("SafetyRepoPort B1", () => {
  it("reads balances with unresolved commitments across midnight and scoped settlement", async () => {
   const fixture = required.create();
   try {
    expect(await fixture.repo.getGenerationAllowanceView({ context })).toEqual({ ok: true, value: {
     daily: { minorUnits: 1000, currency: 'USD' }, remaining: { minorUnits: 1000, currency: 'USD' }, timezone: 'America/Los_Angeles',
    } });
    const pending = unwrap({ outcome: await fixture.repo.reserveGeneration({ context, ...generationRequest({ amount: 400 }).generation, expectedKind: 'normal_write', expectedRevision: 0 }) });
    const settled = unwrap({ outcome: await fixture.repo.reserveGeneration({ context, ...generationRequest({ operationId: 'settled', amount: 300 }).generation, expectedKind: 'normal_write', expectedRevision: 0 }) });
    unwrap({ outcome: await fixture.repo.settleGeneration({ context, settlement: { reservationId: settled.reservationId, observationId: 'balance-cost', actual: { minorUnits: 200, currency: 'USD' } } }) });
    expect(await fixture.repo.getGenerationAllowanceView({ context })).toMatchObject({ ok: true, value: { remaining: { minorUnits: 400 } } });
    fixture.time.setNow({ now: Date.parse('2026-10-03T08:00:00Z') });
    expect(await fixture.repo.getGenerationAllowanceView({ context })).toMatchObject({ ok: true, value: { remaining: { minorUnits: 600 } } });
    expect(await fixture.repo.getGenerationAllowanceView({ context: otherContext })).toMatchObject({ ok: true, value: { remaining: { minorUnits: 1000 } } });
    expect(await fixture.repo.getGenerationAllowanceView({ context }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    unwrap({ outcome: await fixture.repo.settleGeneration({ context, settlement: { reservationId: pending.reservationId, observationId: 'excess-cost', actual: { minorUnits: 500, currency: 'USD' } } }) });
    expect(await fixture.repo.getGenerationAllowanceView({ context })).toMatchObject({ ok: false, error: { code: 'unavailable' } });
   } finally { fixture.close(); }
  });
  it("denies quote/argument mismatch and contradictory upper bounds instead of granting an exact-spend bypass", async () => {
   const fixture = required.create();
   const { request, quote } = generationRequest().generation;
   const mismatched = { ...quote, argumentsDigest: "f".repeat(64) };
   const understated = { ...quote, upperBound: { minorUnits: 500, currency: "USD" } };
   expect(await fixture.repo.assessGeneration({ context, request, quote: mismatched })).toMatchObject({ ok: true, value: { kind: "denied" } });
   expect(await fixture.repo.assessGeneration({ context, request, quote: understated })).toMatchObject({ ok: true, value: { kind: "denied" } });
   fixture.close();
  });
  it("rejects contradictory owner scope at the generation reservation boundary", async () => {
   const fixture = required.create();
   const request = generationRequest().generation;
   const forged = { ...context, principal: { kind: "owner" as const, ownerId: "forged-owner" } };
   expect((await fixture.repo.reserveGeneration({ context: forged, ...request, expectedKind: "normal_write", expectedRevision: 0 })).ok).toBe(false);
   fixture.close();
  });
  it("persists scoped halt and leaves other owners unhalted", async () => {
   const fixture = required.create();
   unwrap({ outcome: await fixture.repo.halt({ context, adAccountId: "account" }) });
   expect(await fixture.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { halted: true } });
   expect(await fixture.repo.snapshot({ context: otherContext, accountId: "account" })).toMatchObject({ ok: true, value: { halted: false } });
   fixture.close();
  });
  it("defaults to $10 in the owner timezone and versions setting edits", async () => {
   const fixture = required.create();
   const settings = unwrap({ outcome: await fixture.repo.getGenerationAllowance({ context }) });
   expect(settings).toEqual({ amount: { minorUnits: 1000, currency: "USD" }, dayTimezone: "America/Los_Angeles", revision: 0 });
   expect(await fixture.repo.setGenerationAllowance({ context, settings: { ...settings, amount: { minorUnits: 500, currency: "USD" } } })).toMatchObject({ ok: true, value: { revision: 1 } });
   expect(await fixture.repo.setGenerationAllowance({ context, settings })).toMatchObject({ ok: false, error: { code: "conflict" } });
   fixture.close();
  });
  it("reserves only with independent evidence, retries exactly once, rejects drift", async () => {
   const fixture = required.create();
   const request = { ...spendRequest(), approvalId: "approval", policyRevision: 0 };
   expect((await fixture.repo.reserve({ context, request })).ok).toBe(false);
   const admission = { maximum: { minorUnits: 1000, currency: "USD" }, window: capEvidence().window, expiresAt: NOW + 30_000 };
   const reserved = unwrap({ outcome: await fixture.repo.reserve({ context, request, admission }) });
   expect(unwrap({ outcome: await fixture.repo.reserve({ context, request, admission }) })).toEqual(reserved);
   expect((await fixture.repo.reserve({ context, request: { ...request, arguments: { changed: true } }, admission })).ok).toBe(false);
   expect(await fixture.repo.snapshot({ context, accountId: "account" })).toMatchObject({ ok: true, value: { reserved: { minorUnits: 600 }, settled: { minorUnits: 0 } } });
   fixture.close();
  });
  it("retains unresolved generation at midnight and after quote expiry", async () => {
   const fixture = required.create();
   const first = generationRequest();
   const reservation = unwrap({ outcome: await fixture.repo.reserveGeneration({ context, ...first.generation, expectedKind: "normal_write", expectedRevision: 0 }) });
   fixture.time.setNow({ now: Date.parse("2026-10-02T08:00:00Z") });
   const second = generationRequest({ operationId: "later", now: fixture.time.clock.now({}) });
   expect(await fixture.repo.assessGeneration({ context, ...second.generation })).toMatchObject({ ok: true, value: { kind: "exact_spend" } });
   expect(await fixture.repo.getGenerationReservation({ context, reservationId: reservation.reservationId })).toMatchObject({ ok: true, value: reservation });
   fixture.close();
  });
 });
}
/** Policy boundary tests distinguish read admission and unbounded money. */
export function SpendPolicyPortSuite(required: { create: () => SpendPolicyPort }) {
 describe("SpendPolicyPort B1", () => {
  it("admits a verified bounded read through the policy port", async () => {
   const port = required.create();
   expect(await port.assess({ context, envelope: { operationId: "operation", connectionId: "connection", accountId: null, effects: ["read"], argumentsDigest: "a".repeat(64), moneyExposure: null, requiredLimit: null } })).toMatchObject({ ok: true, value: { allowed: true } });
  });
  it("denies unbounded ad spend and typed service effects", async () => {
   const port = required.create();
   const envelope = spendRequest().envelope;
   expect(await port.assess({ context, envelope })).toMatchObject({ ok: true, value: { allowed: true } });
   expect(await port.assess({ context, envelope: { ...envelope, moneyExposure: null } })).toMatchObject({ ok: true, value: { allowed: false } });
   expect(await port.assess({ context, envelope: { ...envelope, effects: ["halt_stop"] } })).toMatchObject({ ok: true, value: { allowed: false } });
  });
 });
}
/** Explicit response, scope and exact arguments are tested against every confirmation adapter. */
export function ConfirmationExchangePortSuite(required: { create: (required?: { recordAnswer: Parameters<typeof import("../../index.js").createMemoryConfirmationExchange>[0]["recordAnswer"] }) => ConfirmationExchangePort; reopen?: (required: { port: ConfirmationExchangePort }) => ConfirmationExchangePort }) {
 describe("ConfirmationExchangePort B1", () => {
  it("owner-only generic cards reject agents/services, wrong scope and forged or missing identity", async () => {
   const port = required.create();
   const agent = { ...context, principal: { kind: "agent" as const, agentInstanceId: "agent", runId: "run" } };
   const seed = spendRequest();
   const request = { ...seed, envelope: { ...seed.envelope, effects: ["write" as const], moneyExposure: null, requiredLimit: null } };
   const card = unwrap({ outcome: await port.present({ context: agent, request }) });
   const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as const };
   for (const caller of [agent, { ...context, principal: { kind: "service" as const, serviceId: "worker" } }, otherContext,
    { ...context, scope: { ...context.scope, workspaceId: "other-workspace" } }]) {
    expect(await port.confirm({ context: caller, approver, response })).toMatchObject({ ok: false, error: { code: "forbidden" } });
   }
   expect(await port.confirm({ context, approver: { ...approver, ownerId: "other" }, response })).toMatchObject({ ok: false, error: { message: "Approver differs from card owner" } });
   for (const reference of [undefined, { kind: "local_token", ownerId: "owner", deviceId: "device" }, { ...approver, token: "secret" }]) {
    expect(await port.confirm({ context, response, approver: reference } as Parameters<typeof port.confirm>[0])).toMatchObject({ ok: false, error: { code: "invalid_input" } });
   }
   unwrap({ outcome: await port.confirm({ context, response, approver }) });
   expect(await port.verify({ context: agent, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, classification: "write" })).toEqual({ ok: true, value: undefined });
  });
  it("snapshots identity and response before audit, with one winner across competing answers", async () => {
   const entered = Promise.withResolvers<void>();
   const release = Promise.withResolvers<void>();
   const evidence: Parameters<Parameters<typeof import("../../index.js").createMemoryConfirmationExchange>[0]["recordAnswer"]>[0][] = [];
   const original = required.create({ async recordAnswer(input) {
    evidence.push(structuredClone(input));
    input.answer.response.choice = "cancel";
    if (input.answer.approver.kind === "local_token") input.answer.approver.ownerId = "mutated-callback-owner";
    entered.resolve();
    await release.promise;
    return { ok: true, value: undefined };
   } });
   const request = spendRequest();
   const card = unwrap({ outcome: await original.present({ context, request }) });
   const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as "allow" | "cancel" };
   const reference = { ...approver };
   const first = original.confirm({ context, response, approver: reference });
   await entered.promise;
   const second = original.confirm({ context, response: { ...response, choice: "cancel" }, approver });
   response.choice = "cancel"; reference.ownerId = "mutated-caller-owner";
   release.resolve();
   expect(await first).toEqual({ ok: true, value: undefined });
   expect(await second).toMatchObject({ ok: false, error: { code: "conflict" } });
   expect(evidence).toEqual([{ context, answer: { response: { ...response, choice: "allow" }, approver, answeredAt: NOW } }]);
   const reopened = required.reopen?.({ port: original }) ?? original;
   expect(await reopened.verify({ context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, classification: "spend" })).toEqual({ ok: true, value: undefined });
   unwrap({ outcome: await reopened.revoke({ context, cardId: card.cardId }) });
   expect(evidence).toHaveLength(1);
  });
  it.each([false, true])("audit failure (throws=%s) leaves no confirmed authority and permits a fresh answer", async throws => {
   let fail = true;
   const port = required.create({ async recordAnswer() {
    if (!fail) return { ok: true, value: undefined };
    if (throws) throw new Error("fixture audit failure");
    return { ok: false, error: { code: "unavailable", message: "Audit unavailable", retryable: false } };
   } });
   const request = spendRequest();
   const card = unwrap({ outcome: await port.present({ context, request }) });
   const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as const };
   expect(await port.confirm({ context, response, approver })).toMatchObject({ ok: false, error: { code: "unavailable" } });
   expect(await port.list({ context, query: { limit: 100 } })).toMatchObject({ ok: true, value: { items: [card] } });
   expect(await port.verify({ context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, classification: "spend" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
   fail = false;
   expect(await port.confirm({ context, response, approver })).toEqual({ ok: true, value: undefined });
  });
  it("binds one owning card to exact constituents after reopen, denying extra calls, drift, scope and revocation", async () => {
   const first = required.create();
   const seed = spendRequest();
   const args = { tool: 'vendor_fixture_create', input: { name: 'Paused' } };
   const call: CampaignConstituent = { arguments: args, pluginDigest: seed.pluginDigest, schemaFingerprint: seed.schemaFingerprint,
    envelope: { ...seed.envelope, operationId: 'child', effects: ['write'], moneyExposure: null, requiredLimit: null, argumentsDigest: unwrap({ outcome: digestArguments({ arguments: args }) }) } };
   const reviewed = { calls: [call] };
   const request: EffectRequest = { arguments: reviewed, pluginDigest: seed.pluginDigest, schemaFingerprint: seed.schemaFingerprint, pausedCampaignCalls: [call],
    envelope: { ...seed.envelope, effects: ['ad_spend'], accountId: null, moneyExposure: null, requiredLimit: null, argumentsDigest: unwrap({ outcome: digestArguments({ arguments: reviewed }) }) } };
   const card = unwrap({ outcome: await first.present({ context, request }) });
   expect(card.allowedChoices).toEqual(['allow', 'cancel']);
   unwrap({ outcome: await first.confirm({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: 'allow' } }) });
   const port = required.reopen?.({ port: first }) ?? first;
   const dispatch: FrozenDispatchRequest = { ...call, approvalId: card.cardId, policyRevision: 0, campaignApproval: { operationId: card.operationId, argumentsDigest: card.argumentsDigest, index: 0 } };
   expect(await port.verify({ context, request: dispatch, classification: 'write' })).toMatchObject({ ok: true });
   for (const changed of [{ ...dispatch, pluginDigest: 'e'.repeat(64) }, { ...dispatch, arguments: { ...args, injected: true } }, { ...dispatch, campaignApproval: { ...dispatch.campaignApproval!, index: 1 } }, { ...dispatch, envelope: { ...dispatch.envelope, accountId: 'other' } }])
    expect(await port.verify({ context, request: changed, classification: 'write' })).toMatchObject({ ok: false });
   expect(await port.verify({ context: otherContext, request: dispatch, classification: 'write' })).toMatchObject({ ok: false });
   unwrap({ outcome: await port.revoke({ context, cardId: card.cardId }) });
   expect(await port.verify({ context, request: dispatch, classification: 'write' })).toMatchObject({ ok: false });
  });
  it("reopens exact pending cards, preserves immutable answers and scopes revocation", async () => {
   const original = required.create();
   const request = spendRequest();
   const card = unwrap({ outcome: await original.present({ context, request }) });
   const reopened = required.reopen?.({ port: original }) ?? original;
   expect(await reopened.list({ context, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [card], cursor: null } });
   expect(await reopened.get({ context, cardId: card.cardId })).toEqual({ ok: true, value: card });
   const response = { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" as const };
   const answers = await Promise.all([reopened.confirm({ context, approver, response }), reopened.confirm({ context, approver, response })]);
   expect(answers.filter(answer => answer.ok)).toHaveLength(1);
   expect(answers.find(answer => !answer.ok)).toMatchObject({ error: { code: "conflict" } });
   const answered = required.reopen?.({ port: reopened }) ?? reopened;
   expect(await answered.confirm({ context, approver, response })).toMatchObject({ ok: false, error: { code: "conflict" } });
   expect(await answered.verify({ context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, classification: "spend" })).toEqual({ ok: true, value: undefined });
   unwrap({ outcome: await answered.revoke({ context: otherContext, cardId: card.cardId }) });
   expect(await answered.get({ context, cardId: card.cardId })).toEqual({ ok: true, value: card });
   unwrap({ outcome: await answered.revoke({ context, cardId: card.cardId }) });
   expect(await answered.get({ context, cardId: card.cardId })).toEqual({ ok: true, value: null });
  });
  it("reads exact scoped cards, paginates pending cards and removes answers from listing", async () => {
   const port = required.create();
   const first = unwrap({ outcome: await port.present({ context, request: spendRequest({ operationId: 'card-first' }) }) });
   const second = unwrap({ outcome: await port.present({ context, request: spendRequest({ operationId: 'card-second' }) }) });
   unwrap({ outcome: await port.present({ context: otherContext, request: spendRequest({ operationId: 'card-foreign' }) }) });
   expect(await port.get({ context, cardId: first.cardId })).toEqual({ ok: true, value: first });
   expect(await port.get({ context: otherContext, cardId: first.cardId })).toEqual({ ok: true, value: null });
   const page = unwrap({ outcome: await port.list({ context, query: { limit: 1 } }) });
   expect(page.items).toHaveLength(1);
   expect(page.cursor).toBe(page.items[0].cardId);
   const next = unwrap({ outcome: await port.list({ context, query: { limit: 1, cursor: page.cursor! } }) });
   expect([...page.items, ...next.items].map(card => card.cardId)).toEqual([first.cardId, second.cardId].sort());
   expect(next.cursor).toBeNull();
   unwrap({ outcome: await port.confirm({ context, approver, response: { cardId: first.cardId, operationId: first.operationId, argumentsDigest: first.argumentsDigest, choice: 'cancel' } }) });
   expect(unwrap({ outcome: await port.list({ context, query: { limit: 100 } }) }).items).toEqual([second]);
   expect(await port.list({ context, query: { limit: 101 } })).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
   expect(await port.get({ context, cardId: first.cardId }, { signal: AbortSignal.abort() })).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });
  it("presentation is not confirmation; responses and dispatch must exactly match", async () => {
   const port = required.create();
   const request = spendRequest();
   const card = unwrap({ outcome: await port.present({ context, request }) });
   const dispatch = { ...request, approvalId: card.cardId, policyRevision: 0 };
   expect(card.allowedChoices).toEqual(["allow", "cancel"]);
   expect((await port.verify({ context, request: dispatch, classification: "spend" })).ok).toBe(false);
   expect(await port.confirm({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "always_allow" } })).toMatchObject({ ok: false, error: { code: "forbidden", message: "Response differs from exact card or choices" } });
   unwrap({ outcome: await port.confirm({ context, approver, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" } }) });
   expect((await port.verify({ context, request: dispatch, classification: "spend" })).ok).toBe(true);
   expect((await port.verify({ context: otherContext, request: dispatch, classification: "spend" })).ok).toBe(false);
   expect((await port.verify({ context, request: { ...dispatch, pluginDigest: "f".repeat(64) }, classification: "spend" })).ok).toBe(false);
  });
 });
}
/** Host bindings never inherit caller-controlled effect hints. */
export function VerifiedEffectResolverPortSuite(required: { create: () => VerifiedEffectResolverPort }) {
 describe("VerifiedEffectResolverPort B1", () => {
  it("matches only admitted scoped exact binding", async () => {
   const port = required.create();
   const request = spendRequest();
   expect((await port.resolve({ context, request })).ok).toBe(true);
   expect((await port.resolve({ context: otherContext, request })).ok).toBe(false);
   expect((await port.resolve({ context, request: { ...request, schemaFingerprint: "e".repeat(64) } })).ok).toBe(false);
  });
 });
}
/** Cap evidence is scoped data; absent accounts fail explicitly. */
export function PlatformLimitEvidencePortSuite(required: { create: () => PlatformLimitEvidencePort }) {
 describe("PlatformLimitEvidencePort B1", () => {
  it("reads only evidence in the admitted account scope", async () => {
   const port = required.create();
   expect(await port.get({ context, accountId: "account" })).toMatchObject({ ok: true, value: capEvidence() });
   expect((await port.get({ context: otherContext, accountId: "account" })).ok).toBe(false);
   expect((await port.get({ context, accountId: "missing" })).ok).toBe(false);
  });
 });
}
/** Lock suite uses barriers, never wall-clock sleeps. */
export function AccountDispatchLockPortSuite(required: { create: () => AccountDispatchLockPort }) {
 describe("AccountDispatchLockPort B1", () => {
  it("serializes acquisition and rejects duplicate release", async () => {
   const port = required.create();
   const first = unwrap({ outcome: await port.acquire({ context, accountId: "account" }) });
   let acquired = false;
   const second = port.acquire({ context, accountId: "account" }).then(result => { acquired = true; return result; });
   await Promise.resolve();
   expect(acquired).toBe(false);
   unwrap({ outcome: await port.release(first) });
   const next = unwrap({ outcome: await second });
   expect(acquired).toBe(true);
   expect((await port.release(first)).ok).toBe(false);
   unwrap({ outcome: await port.release(next) });
  });
  it("cancelled waiter cannot release its predecessor", async () => {
   const port = required.create();
   const first = unwrap({ outcome: await port.acquire({ context, accountId: "account" }) });
   const abort = new AbortController();
   const cancelled = port.acquire({ context, accountId: "account" }, { signal: abort.signal });
   abort.abort();
   expect(await cancelled).toMatchObject({ ok: false, error: { code: "cancelled" } });
   let acquired = false;
   const next = port.acquire({ context, accountId: "account" }).then(result => { acquired = true; return result; });
   await Promise.resolve();
   expect(acquired).toBe(false);
   unwrap({ outcome: await port.release(first) });
   unwrap({ outcome: await port.release(unwrap({ outcome: await next })) });
  });
 });
}
/** Audit success is tied to an append; doubles expose defensive read snapshots. */
export function SafetyAuditPortSuite(required: { create: () => SafetyAuditPort & { read(required: Record<string, never>): readonly unknown[] } }) {
 describe("SafetyAuditPort B1", () => {
  it("appends two correlated outcomes without replacement", async () => {
   const port = required.create();
   unwrap({ outcome: await port.record({ context, operationId: "operation", outcome: "requested" }) });
   unwrap({ outcome: await port.record({ context, operationId: "operation", outcome: "denied" }) });
   expect(port.read({})).toEqual([{ context, operationId: "operation", outcome: "requested" }, { context, operationId: "operation", outcome: "denied" }]);
  });
 });
}
