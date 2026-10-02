# Clock

`Clock.now()` supplies UTC epoch milliseconds. `realClock` reads and validates
system time. `createFakeClock(initial)` creates an independent clock with
`set(value)` and nonnegative `advance(milliseconds)` operations. Invalid values
and overflow throw `RangeError` before changing state. `set` deliberately permits
rewinding for boundary tests. These clocks do not schedule work or promise
monotonic time.
