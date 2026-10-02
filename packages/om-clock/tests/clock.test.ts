import { describe, expect, it } from "vitest";
import { createFakeClock, realClock } from "../src/index.js";

describe("Clock", () => {
  it("advances and rewinds explicitly without affecting another clock", () => {
    const clock = createFakeClock(10);
    const other = createFakeClock(10);
    clock.advance(5);
    expect(clock.now()).toBe(15);
    clock.set(0);
    expect(clock.now()).toBe(0);
    expect(other.now()).toBe(10);
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid time %s without mutation", value => {
    expect(() => createFakeClock(value)).toThrow(RangeError);
    const clock = createFakeClock(10);
    expect(() => clock.set(value)).toThrow(RangeError);
    expect(() => clock.advance(value)).toThrow(RangeError);
    expect(clock.now()).toBe(10);
  });
  it("rejects overflow without mutation", () => {
    const clock = createFakeClock(Number.MAX_SAFE_INTEGER);
    expect(() => clock.advance(1)).toThrow(RangeError);
    expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("reads actual epoch time", () => {
    const before = Date.now();
    expect(realClock.now()).toBeGreaterThanOrEqual(before);
    expect(realClock.now()).toBeLessThanOrEqual(Date.now());
  });
});
