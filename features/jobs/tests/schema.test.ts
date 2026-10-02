import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/schema.js";
import { createMemoryJobRepo } from "../index.js";
import { clockFixture, context, idsFixture, job, policy } from "./fixtures.js";
describe("bounded canonical job JSON", () => {
    it("sorts nested keys, preserves array order and rejects cycles/accessors/lossy values", () => {
        expect(canonicalJson({ value: { z: [2, { b: 2, a: 1 }], a: 1 } })).toBe('{"a":1,"z":[2,{"a":1,"b":2}]}');
        const cycle: Record<string, unknown> = {}; cycle.loop = cycle;
        const accessors = Object.defineProperty({}, "secret", { enumerable: true, get() { throw new Error("Getter must never run"); } });
        for (const value of [cycle, accessors, { bad: undefined }, { bad: NaN }, { bad: Infinity }, { bad: new Date(0) }, { bad: 1n }, new Array(2)]) {
            expect(() => canonicalJson({ value })).toThrow(TypeError);
        }
    });
    it("bounds depth, nodes and escaped output before persistence", async () => {
        const repo = createMemoryJobRepo({ clock: clockFixture({}), ids: idsFixture({}), retryPolicy: policy });
        const nested: Record<string, unknown> = {}; let leaf = nested;
        for (let index = 0; index < 20; index++) { const next = {}; leaf.next = next; leaf = next; }
        expect(await repo.enqueue({ context, job: { ...job, payload: nested } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(await repo.enqueue({ context, job: { ...job, payload: { nodes: Array.from({ length: 10001 }, () => 1) } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(await repo.enqueue({ context, job: { ...job, payload: { escaped: "\n".repeat(140000) } } })).toMatchObject({ ok: false, error: { code: "invalid_input" } });
        expect(await repo.claim({ worker: { workerId: "worker" } })).toEqual({ ok: true, value: null });
    });
});
