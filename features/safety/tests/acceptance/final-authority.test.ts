import { expect, it } from "vitest";
import { createMemoryConfirmationExchange, createMemoryPlatformLimitEvidence, createMemorySpendPolicy, createMemoryVerifiedEffectResolver, createSafetyService } from "../../index.js";
import { approve, capEvidence, context, createHarness, spendRequest } from "../fixtures.js";
for (const backend of ["memory", "sql"] as const) {
 it(`${backend}: authority expiring during the reservation prevents transport handoff`, async () => {
  const harness = createHarness({ backend });
  const confirmations = createMemoryConfirmationExchange({ ...harness.time, ttlMs: 10 });
  const request = spendRequest();
  const repo = { ...harness.repo, async reserve(input: Parameters<typeof harness.repo.reserve>[0]) {
   const result = await harness.repo.reserve(input);
   harness.time.setNow({ now: harness.time.clock.now({}) + 11 });
   return result;
  } };
  const service = createSafetyService({ repo, confirmations, clock: harness.time.clock, ids: harness.time.ids, accountLocks: harness.locks, audit: harness.audit, policy: createMemorySpendPolicy({}), effects: createMemoryVerifiedEffectResolver({ effects: [{ scope: context.scope, request, envelope: request.envelope }] }), platformLimits: createMemoryPlatformLimitEvidence({ evidence: [{ scope: context.scope, evidence: capEvidence() }] }) });
  const frozen = await approve({ harness: { ...harness, confirmations }, service, request });
  let calls = 0;
  expect((await service.withDispatch({ context, request: frozen, dispatch: async () => { calls++; return { ok: true, value: "sent" }; } })).ok).toBe(false);
  expect(calls).toBe(0);
  harness.close();
 });
}
