import { it, expect } from "vitest";
import { createCreativeService } from "../index.js";
const dependencies = new Proxy({} as Parameters<typeof createCreativeService>[0], { get() { throw new Error("Inert skeleton accessed a dependency"); } });
it("requestGeneration is explicitly unavailable and accesses no dependencies", async () => {
 const service = createCreativeService(dependencies);
 const input = {} as Parameters<typeof service.requestGeneration>[0];
 expect(await service.requestGeneration(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("refreshJob is explicitly unavailable and accesses no dependencies", async () => {
 const service = createCreativeService(dependencies);
 const input = {} as Parameters<typeof service.refreshJob>[0];
 expect(await service.refreshJob(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("pollDue is explicitly unavailable and accesses no dependencies", async () => {
 const service = createCreativeService(dependencies);
 const input = {} as Parameters<typeof service.pollDue>[0];
 expect(await service.pollDue(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("recover is explicitly unavailable and accesses no dependencies", async () => {
 const service = createCreativeService(dependencies);
 const input = {} as Parameters<typeof service.recover>[0];
 expect(await service.recover(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("cancelGeneration is explicitly unavailable and accesses no dependencies", async () => {
 const service = createCreativeService(dependencies);
 const input = {} as Parameters<typeof service.cancelGeneration>[0];
 expect(await service.cancelGeneration(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
