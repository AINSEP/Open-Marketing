/** Supplies UTC epoch milliseconds; consumers must not infer elapsed monotonic time. */
export interface Clock {
    now(required: Record<string, never>): number;
}
/** Reject invalid epoch values. @complexity O(1) time/space.  */
export function assertEpochMilliseconds({ value }: {
    value: number;
}): void {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new RangeError("Time must be nonnegative safe integer epoch milliseconds");
}
/** Adapt an explicitly supplied time source; no hidden system time read. @example createClockAdapter({ readEpochMilliseconds: () => 100 }) */
export function createClockAdapter(required: {
    readEpochMilliseconds: () => number;
}): Clock {
    return { now() { const value = required.readEpochMilliseconds(); assertEpochMilliseconds({ value }); return value; } };
}
/** Controllable clock for deterministic tests; set may rewind explicitly. */
export interface FakeClock extends Clock {
    set(required: {
        value: number;
    }): void;
    advance(required: {
        milliseconds: number;
    }): void;
}
/** Create an isolated clock. Invalid times/deltas throw before mutation.
 * @complexity O(1) time/space for construction and operations.
 */
export function createFakeClock({ initial }: {
    initial: number;
}): FakeClock {
    assertEpochMilliseconds({ value: initial });
    let current = initial;
    return Object.freeze({
        now: () => current,
        set({ value }: {
            value: number;
        }): void { assertEpochMilliseconds({ value: value }); current = value; },
        advance({ milliseconds }: {
            milliseconds: number;
        }): void {
            assertEpochMilliseconds({ value: milliseconds });
            const next = current + milliseconds;
            assertEpochMilliseconds({ value: next });
            current = next;
        },
    });
}
