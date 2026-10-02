# Outbox implementation checkpoint

Saved: package manifest/config/build entry, src/types.ts, src/retry.ts,
src/service.ts, src/index.ts. Implements tenant-scoped idempotent enqueue,
atomic-store ports, lease fences, authorization before dispatch, bounded retry,
uncertain-outcome reconciliation, abort checks and payload-free observer events.

Tests run: none yet for this new package. Clock/spine checks belong to the previous
completed module batch and do not verify this module.

Next: save tests/memory-store.ts and tests/outbox.test.ts, then run
`corepack pnpm --filter @open-marketing/om-outbox test`.
If workspace linking is incomplete, run existing `../release/node_modules/.bin/vitest run`
from this package after building/linking om-clock through the coordinator.
Then package build/typecheck; update this checkpoint with actual results.

Limitations: production durable/atomic OutboxStore remains injected; no app wiring,
network adapters or scheduler. Expired leases conservatively reconcile, even if
the worker died before transport started. Digest generation belongs to caller;
store compares exact content as well as digest. Retry classification is a trusted
transport contract. Production adapters must impose payload/queue limits and
instrument external I/O. No commits or lockfile edits by this worker.
