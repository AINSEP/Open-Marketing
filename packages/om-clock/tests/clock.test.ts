import { describe, expect, it } from "vitest";
import { createFakeClock, createClockAdapter } from "../src/index.js";
describe("Clock", () => {
    it("advances and rewinds explicitly without affecting another clock", () => {
        const clock = createFakeClock({ initial: 10 });
        const other = createFakeClock({ initial: 10 });
        clock.advance({ milliseconds: 5 });
        expect(clock.now({})).toBe(15);
        clock.set({ value: 0 });
        expect(clock.now({})).toBe(0);
        expect(other.now({})).toBe(10);
    });
    it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid time %s without mutation", (value: number) => {
        expect(() => createFakeClock({ initial: value })).toThrow(RangeError);
        const clock = createFakeClock({ initial: 10 });
        expect(() => clock.set({ value: value })).toThrow(RangeError);
        expect(() => clock.advance({ milliseconds: value })).toThrow(RangeError);
        expect(clock.now({})).toBe(10);
    });
    it("rejects overflow without mutation", () => {
        const clock = createFakeClock({ initial: Number.MAX_SAFE_INTEGER });
        expect(() => clock.advance({ milliseconds: 1 })).toThrow(RangeError);
        expect(clock.now({})).toBe(Number.MAX_SAFE_INTEGER);
    });
    it("reads actual epoch time", () => {
        const before = 100;
        const realClock = createClockAdapter({ readEpochMilliseconds: () => before });
        expect(realClock.now({})).toBeGreaterThanOrEqual(before);
        expect(realClock.now({})).toBeLessThanOrEqual(before);
    });
});
