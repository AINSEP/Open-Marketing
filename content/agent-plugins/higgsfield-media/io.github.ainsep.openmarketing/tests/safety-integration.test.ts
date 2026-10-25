import { describe, expect, it } from "vitest";
import { createSafetyService, createMemorySafetyRepo, createMemoryConfirmationExchange, createMemoryAccountDispatchLock,
  createMemoryPlatformLimitEvidence, createMemorySpendPolicy, createMemoryVerifiedEffectResolver, createMemorySafetyAudit } from "@open-marketing/safety";
import type { EffectRequest } from "@open-marketing/safety";
import { createHiggsfieldDispatchEvidence } from "../src/index.js";
import { fixture, pricing, value } from "./fixtures.js";

/** Plugin quotes/effects enter the REAL safety service through public contracts, with fake money. */
function safetyFixture(required: { amount: number | null }) {
  const f = fixture({ evidence: required.amount === null ? null : { ...pricing, unitUpperBound: { minorUnits: required.amount, currency: "USD" } } });
  const d = f.dependencies;
  const evidence = value({ outcome: createHiggsfieldDispatchEvidence({ dependencies: d }) });
  const generation = { request: { operationId: d.intent.operationId, connectionId: d.binding.connectionId, argumentsDigest: evidence.effect.argumentsDigest, configurationDigest: d.binding.configurationDigest }, quote: evidence.quote };
  const request: EffectRequest = { envelope: evidence.effect, arguments: evidence.arguments, pluginDigest: d.binding.pluginDigest,
    schemaFingerprint: d.binding.generationSchemaFingerprint, operationScope: "image-generation.v1", generation };
  const requests = [request, ...["next", "exhausted"].map(operationId => ({ ...request,
    envelope: { ...request.envelope, operationId },
    generation: { request: { ...generation.request, operationId }, quote: { ...generation.quote, quoteId: "quote-" + operationId } },
  }))];
  const timing = { clock: d.clock, ids: d.ids, ownerTimezone: "America/Los_Angeles" };
  const confirmations = createMemoryConfirmationExchange(timing);
  const service = createSafetyService({ ...timing, repo: createMemorySafetyRepo(timing), confirmations,
    accountLocks: createMemoryAccountDispatchLock(timing), audit: createMemorySafetyAudit({}), policy: createMemorySpendPolicy({}),
    effects: createMemoryVerifiedEffectResolver({ effects: requests.map(item => ({ scope: d.context.scope, request: item, envelope: item.envelope })),
      quotes: requests.map(item => ({ scope: d.context.scope, ...item.generation!, pluginDigest: item.pluginDigest, schemaFingerprint: item.schemaFingerprint })) }),
    platformLimits: createMemoryPlatformLimitEvidence({}),
  });
  return { f, request, requests, confirmations, service };
}

describe("server allowance authority consumes Higgsfield evidence", () => {
  it("reuses Always allow for the next image and requires exact approval after allowance exhaustion", async () => {
    const f = safetyFixture({ amount: 400 });
    const context = f.f.dependencies.context;
    const card = value({ outcome: await f.service.prepareApproval({ context, request: f.request }) });
    value({ outcome: await f.confirmations.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "always_allow" } }) });
    let egress = 0;
    const dispatch = async () => { egress += 1; return { ok: true as const, value: "fixture" }; };
    for (const request of f.requests.slice(0, 2)) {
      expect(value({ outcome: await f.service.withDispatch({ context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, dispatch }) })).toBe("fixture");
    }
    const exhausted = f.requests[2]!;
    expect(await f.service.assessGeneration({ context, ...exhausted.generation! })).toMatchObject({ ok: true, value: { kind: "exact_spend" } });
    expect(value({ outcome: await f.service.prepareApproval({ context, request: exhausted }) }).allowedChoices).toEqual(["allow", "cancel"]);
    expect((await f.service.withDispatch({ context, request: { ...exhausted, approvalId: card.cardId, policyRevision: 0 }, dispatch })).ok).toBe(false);
    expect(egress).toBe(2);
  });
  it.each([{ amount: 25, choices: ["allow", "allow_chat", "always_allow", "cancel"] },
    { amount: 1001, choices: ["allow", "cancel"] }, { amount: null, choices: ["allow", "cancel"] }])("host selects approval choices for $amount minor units", async input => {
    const f = safetyFixture(input);
    const d = f.f.dependencies;
    const card = value({ outcome: await f.service.prepareApproval({ context: d.context, request: f.request }) });
    expect(card.allowedChoices).toEqual(input.choices);
    expect(await f.service.getGenerationAllowance({ context: d.context })).toMatchObject({ ok: true, value: { amount: { minorUnits: 1000, currency: "USD" }, dayTimezone: "America/Los_Angeles" } });
  });
  it("cannot dispatch generation without confirmation, and exact unknown price remains unbounded", async () => {
    const f = safetyFixture({ amount: null });
    const d = f.f.dependencies;
    let egress = 0;
    const dispatch = () => { egress += 1; return Promise.resolve({ ok: true as const, value: "fixture" }); };
    expect((await f.service.withDispatch({ context: d.context, request: { ...f.request, approvalId: "forged", policyRevision: 0 }, dispatch })).ok).toBe(false);
    const card = value({ outcome: await f.service.prepareApproval({ context: d.context, request: f.request }) });
    value({ outcome: await f.confirmations.confirm({ context: d.context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" } }) });
    expect((await f.service.withDispatch({ context: d.context, request: { ...f.request, approvalId: card.cardId, policyRevision: 0 }, dispatch })).ok).toBe(false);
    expect(egress).toBe(0);
  });
  it("holds server safety authority through one simulated handoff and preserves reserved exposure", async () => {
    const f = safetyFixture({ amount: 25 });
    const d = f.f.dependencies;
    const card = value({ outcome: await f.service.prepareApproval({ context: d.context, request: f.request }) });
    value({ outcome: await f.confirmations.confirm({ context: d.context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "always_allow" } }) });
    let egress = 0;
    const approved = { ...f.request, approvalId: card.cardId, policyRevision: 0 };
    const first = await f.service.withDispatch({ context: d.context, request: approved, dispatch: async input => {
      egress += 1;
      expect(input.request.arguments).toEqual(f.request.arguments);
      return { ok: true as const, value: input.permit.reservationId };
    } });
    expect(value({ outcome: first })).toEqual(expect.any(String));
    // No plugin settling/refund path is called; authority owns the reservation.
    expect(egress).toBe(1);
  });
});
