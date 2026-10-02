# Clock

`Clock.now({})` supplies UTC epoch milliseconds. `createClockAdapter({ readEpochMilliseconds })`
validates an injected source. `createFakeClock({ initial })` creates an independent clock with
`set({ value })` and nonnegative `advance({ milliseconds })` operations. Invalid values
and overflow throw `RangeError` before changing state. `set` deliberately permits
rewinding for boundary tests. These clocks do not schedule work or promise
monotonic time.

The package contains no real-time singleton. Hosts own the time source; imports and factories start no timers.
