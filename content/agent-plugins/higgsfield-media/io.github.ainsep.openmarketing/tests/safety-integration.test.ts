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
  const timing = { clock: d.clock, ids: d.ids, ownerTimezone: "America/Los_Angeles" };
  const confirmations = createMemoryConfirmationExchange(timing);
  const service = createSafetyService({ ...timing, repo: createMemorySafetyRepo(timing), confirmations,
    accountLocks: createMemoryAccountDispatchLock(timing), audit: createMemorySafetyAudit({}), policy: createMemorySpendPolicy({}),
    effects: createMemoryVerifiedEffectResolver({ effects: [{ scope: d.context.scope, request, envelope: request.envelope }],
      quotes: [{ scope: d.context.scope, ...generation, pluginDigest: request.pluginDigest, schemaFingerprint: request.schemaFingerprint }] }),
    platformLimits: createMemoryPlatformLimitEvidence({}),
  });
  return { f, request, confirmations, service };
}

describe("server allowance authority consumes Higgsfield evidence", () => {
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
