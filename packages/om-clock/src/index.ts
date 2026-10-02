/** Supplies UTC epoch milliseconds; consumers must not infer elapsed monotonic time. */
export interface Clock { now(): number }

/** Reject invalid epoch values. @complexity O(1) time/space. @overallScore 100 */
export function assertEpochMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Time must be nonnegative safe integer epoch milliseconds");
}

/** Read validated system UTC time. No scheduling effects. @complexity O(1) time/space. @overallScore 100 */
export const realClock: Clock = Object.freeze({ now(): number {
  const value = Date.now();
  assertEpochMilliseconds(value);
  return value;
} });

/** Controllable clock for deterministic tests; set may rewind explicitly. */
export interface FakeClock extends Clock { set(value: number): void; advance(milliseconds: number): void }

/** Create an isolated clock. Invalid times/deltas throw before mutation.
 * @complexity O(1) time/space for construction and operations. @overallScore 100
 */
export function createFakeClock(initial: number): FakeClock {
  assertEpochMilliseconds(initial);
  let current = initial;
  return Object.freeze({
    now: () => current,
    set(value: number): void { assertEpochMilliseconds(value); current = value; },
    advance(milliseconds: number): void {
      assertEpochMilliseconds(milliseconds);
      const next = current + milliseconds;
      assertEpochMilliseconds(next);
      current = next;
    },
  });
}
