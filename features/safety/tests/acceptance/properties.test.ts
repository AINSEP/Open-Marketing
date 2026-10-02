import { expect, it } from "vitest";
import fc from "fast-check";
import { context, createHarness, generationRequest, unwrap } from "../fixtures.js";
for (const backend of ["memory", "sql"] as const) {
 it(`${backend}: concurrent bounded generations conserve allowance across arbitrary amounts`, async () => {
  await fc.assert(fc.asyncProperty(fc.record({ amounts: fc.array(fc.integer({ min: 1, max: 1200 }), { minLength: 1, maxLength: 12 }) }), async ({ amounts }) => {
   const harness = createHarness({ backend });
   const requests = amounts.map((amount, index) => generationRequest({ operationId: `generation-${index}`, amount }).generation);
   const outcomes = await Promise.all(requests.map(request => harness.repo.reserveGeneration({ context, ...request, expectedKind: "normal_write", expectedRevision: 0 })));
   const reserved = outcomes.filter(outcome => outcome.ok).map(outcome => unwrap({ outcome }));
   const total = reserved.reduce((sum, record) => sum + record.amount.minorUnits, 0);
   expect(total).toBeLessThanOrEqual(1000);
   if (amounts.reduce((sum, amount) => sum + amount, 0) <= 1000) expect(reserved).toHaveLength(amounts.length);
   harness.close();
  }), { seed: 8008, numRuns: 30 });
 });
}
