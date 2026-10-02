import { it, expect } from "vitest";
import { createMediaLibrary } from "../index.js";
const dependencies = new Proxy({} as Parameters<typeof createMediaLibrary>[0], { get() { throw new Error("Inert skeleton accessed a dependency"); } });
it("importAsset is explicitly unavailable and accesses no dependencies", async () => {
 const service = createMediaLibrary(dependencies);
 const input = {} as Parameters<typeof service.importAsset>[0];
 expect(await service.importAsset(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("createCrop is explicitly unavailable and accesses no dependencies", async () => {
 const service = createMediaLibrary(dependencies);
 const input = {} as Parameters<typeof service.createCrop>[0];
 expect(await service.createCrop(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("list is explicitly unavailable and accesses no dependencies", async () => {
 const service = createMediaLibrary(dependencies);
 const input = {} as Parameters<typeof service.list>[0];
 expect(await service.list(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("recordProvenance is explicitly unavailable and accesses no dependencies", async () => {
 const service = createMediaLibrary(dependencies);
 const input = {} as Parameters<typeof service.recordProvenance>[0];
 expect(await service.recordProvenance(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
it("recordCost is explicitly unavailable and accesses no dependencies", async () => {
 const service = createMediaLibrary(dependencies);
 const input = {} as Parameters<typeof service.recordCost>[0];
 expect(await service.recordCost(input)).toMatchObject({ ok: false, error: { code: "not_implemented" } });
});
