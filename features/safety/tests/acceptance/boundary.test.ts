import { expect, it } from "vitest";
import { createMemoryConfirmationExchange, digestArguments } from "../../index.js";
import { approve, context, createHarness, generationRequest, spendRequest, timing, unwrap } from "../fixtures.js";
it("canonical digest is stable by object-key order and rejects non-JSON, huge and deeply nested arguments", () => {
 expect(digestArguments({ arguments: { b: 2, a: 1 } })).toEqual(digestArguments({ arguments: { a: 1, b: 2 } }));
 expect(digestArguments({ arguments: { value: "x".repeat(65_537) } }).ok).toBe(false);
 expect(digestArguments({ arguments: { callback() {} } }).ok).toBe(false);
 let value: unknown = "leaf";
 for (let depth = 0; depth < 18; depth++) value = { nested: value };
 expect(digestArguments({ arguments: value }).ok).toBe(false);
});
it("the dispatched DTO and context are immutable after exact review", async () => {
 const harness = createHarness({ backend: "memory" });
 const service = harness.service();
 const frozen = await approve({ harness, service, request: spendRequest() });
 const result = await service.withDispatch({ context, request: frozen, dispatch: async input => {
  expect(Object.isFrozen(input.request.arguments)).toBe(true);
  expect(Object.isFrozen(input.context.scope)).toBe(true);
  expect(() => { (input.request.arguments as Record<string, unknown>).budget = 999; }).toThrow();
  return { ok: true, value: input.request.arguments.budget };
 } });
 expect(result).toEqual({ ok: true, value: 600 });
 harness.close();
});
it("generation setting edits wait for the current transport handoff", async () => {
 const harness = createHarness({ backend: "memory" });
 const request = generationRequest({ amount: 500 });
 const later = generationRequest({ amount: 1, operationId: "later" });
 const service = harness.service({ requests: [request, later] });
 const frozen = await approve({ harness, service, request });
 const entered = Promise.withResolvers<void>();
 const complete = Promise.withResolvers<void>();
 const dispatch = service.withDispatch({ context, request: frozen, dispatch: async () => { entered.resolve(); await complete.promise; return { ok: true, value: "sent" }; } });
 await entered.promise;
 const settings = unwrap({ outcome: await harness.repo.getGenerationAllowance({ context }) });
 let edited = false;
 const edit = service.setGenerationAllowance({ context, settings: { ...settings, amount: { minorUnits: 0, currency: "USD" } } }).then(result => { edited = true; return result; });
 await Promise.resolve();
 expect(edited).toBe(false);
 complete.resolve();
 expect((await dispatch).ok).toBe(true);
 expect((await edit).ok).toBe(true);
 expect(await service.assessGeneration({ context, ...later.generation })).toMatchObject({ ok: true, value: { kind: "exact_spend" } });
 harness.close();
});
it("unsupported currencies, invalid timezones, forged owners and unauthorized cost observers fail", async () => {
 const harness = createHarness({ backend: "memory" });
 const service = harness.service();
 const settings = unwrap({ outcome: await harness.repo.getGenerationAllowance({ context }) });
 expect((await service.setGenerationAllowance({ context, settings: { ...settings, dayTimezone: "Invalid/Zone" } })).ok).toBe(false);
 expect((await service.setGenerationAllowance({ context, settings: { ...settings, amount: { minorUnits: 1000, currency: "EUR" } } })).ok).toBe(false);
 expect((await service.setGenerationAllowance({ context: { ...context, principal: { kind: "owner", ownerId: "forged" } }, settings })).ok).toBe(false);
 expect((await service.settleGeneration({ context: { scope: context.scope, serviceId: "agent", correlationId: "correlation", traceId: "trace" }, settlement: { reservationId: "missing", observationId: "charge", actual: { minorUnits: 0, currency: "USD" } } })).ok).toBe(false);
 harness.close();
});
it("exact generation retries retain one reservation; quote changes and settlement prevent new dispatch", async () => {
 const harness = createHarness({ backend: "memory" });
 const request = generationRequest({ amount: 400 });
 const service = harness.service({ requests: [request] });
 const dispatch = await approve({ harness, service, request });
 const authorization = { ...request.generation, dispatch };
 const first = unwrap({ outcome: await service.reserveGeneration({ context, authorization }) });
 expect(unwrap({ outcome: await service.reserveGeneration({ context, authorization }) })).toEqual(first);
 unwrap({ outcome: await harness.repo.settleGeneration({ context, settlement: { reservationId: first.reservationId, observationId: "charge", actual: { minorUnits: 300, currency: "USD" } } }) });
 expect((await service.reserveGeneration({ context, authorization })).ok).toBe(false);
 harness.close();
});

it("the confirmation double can reset its instance without preserving authority", async () => {
 const exchange = createMemoryConfirmationExchange(timing());
 const request = spendRequest();
 const card = unwrap({ outcome: await exchange.present({ context, request }) });
 unwrap({ outcome: await exchange.confirm({ context, response: { cardId: card.cardId, operationId: card.operationId, argumentsDigest: card.argumentsDigest, choice: "allow" } }) });
 exchange.reset({});
 expect((await exchange.verify({ context, request: { ...request, approvalId: card.cardId, policyRevision: 0 }, classification: "spend" })).ok).toBe(false);
});
