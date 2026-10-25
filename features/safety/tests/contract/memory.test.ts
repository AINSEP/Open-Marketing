import { SafetyRepoPortSuite, SpendPolicyPortSuite, ConfirmationExchangePortSuite, VerifiedEffectResolverPortSuite, PlatformLimitEvidencePortSuite, AccountDispatchLockPortSuite, SafetyAuditPortSuite } from "./port-suites.js";
import { createMemorySpendPolicy, createMemoryConfirmationExchange, createMemoryVerifiedEffectResolver, createMemoryPlatformLimitEvidence, createMemoryAccountDispatchLock, createMemorySafetyAudit } from "../../index.js";
import { capEvidence, approver, context, createHarness, spendRequest, timing } from "../fixtures.js";
import { expect, it } from 'vitest';
SafetyRepoPortSuite({ create: () => createHarness({ backend: "memory" }) });
SpendPolicyPortSuite({ create: () => createMemorySpendPolicy({}) });
ConfirmationExchangePortSuite({ create: input => createMemoryConfirmationExchange({ ...timing(), ...input }) });
VerifiedEffectResolverPortSuite({ create: () => createMemoryVerifiedEffectResolver({ effects: [{ scope: context.scope, request: spendRequest(), envelope: spendRequest().envelope }] }) });
PlatformLimitEvidencePortSuite({ create: () => createMemoryPlatformLimitEvidence({ evidence: [{ scope: context.scope, evidence: capEvidence() }] }) });
AccountDispatchLockPortSuite({ create: () => createMemoryAccountDispatchLock(timing()) });
SafetyAuditPortSuite({ create: () => createMemorySafetyAudit({}) });
it('card listing expires at the injected deadline and reset/revoke dispose existing scope state', async () => {
 const time = timing();
 const port = createMemoryConfirmationExchange({ ...time, ttlMs: 10 });
 const presented = await port.present({ context, request: spendRequest() });
 if (!presented.ok) throw new Error(presented.error.message);
 expect(await port.list({ context, query: { limit: 100 } })).toMatchObject({ ok: true, value: { items: [presented.value] } });
 time.setNow({ now: time.clock.now({}) + 10 });
 expect(await port.list({ context, query: { limit: 100 } })).toEqual({ ok: true, value: { items: [], cursor: null } });
 expect(await port.confirm({ context, approver, response: { cardId: presented.value.cardId, operationId: presented.value.operationId,
  argumentsDigest: presented.value.argumentsDigest, choice: 'allow' } })).toMatchObject({ ok: false, error: { code: 'expired' } });
 expect(time.answers).toEqual([]);
 port.revoke({ context, cardId: presented.value.cardId });
 expect(await port.get({ context, cardId: presented.value.cardId })).toEqual({ ok: true, value: null });
 const fresh = await port.present({ context, request: spendRequest() });
 if (!fresh.ok) throw new Error(fresh.error.message);
 port.reset({});
 expect(await port.get({ context, cardId: fresh.value.cardId })).toEqual({ ok: true, value: null });
});
