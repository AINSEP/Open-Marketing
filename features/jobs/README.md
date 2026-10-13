# @open-marketing/jobs

One server-owned outbox for durable external writes. The worker claims one job,
refreshes authority, fences dispatch and completion, bounds known transient
retries, and preserves uncertain non-idempotent outcomes for reconciliation.
Factories perform no I/O and start no workers. Public imports use
`@open-marketing/jobs` only.

```ts
import { createJobService, createSqlJobRepo } from "@open-marketing/jobs";

// database, clock, ids, dispatcher and authorization come from server composition.
const retryPolicy = { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000, leaseMs: 60000 };
const repo = createSqlJobRepo({ database, clock, ids, retryPolicy });
const jobs = createJobService({ repo, clock, ids, retryPolicy, dispatcher, authorization });
const receipt = await jobs.enqueue({ context, job: {
  operationId: "operation-123", idempotencyKey: "operation-123",
  argumentsDigest, handler: "campaign-write", payload: frozenArguments,
} });
const attempt = await jobs.processOne({ worker: { workerId: "server-worker" } });
```

The domain caller computes the stable digest. Tenant/key duplicates require the
same digest AND exact canonical operation/payload; changing content never
silently overwrites an earlier request. The first enqueue's context survives
retry, including correlation, trace and optional run IDs. `enqueue` is for a job
without a separate domain write. If a domain write is needed, use
`createDomainIntentTransaction({ database, writer, clock, ids })` so the domain
intent and job commit or roll back together on the same session. The writer must
be idempotent for its intent ID and reject an existing intent with a different
operation. It must perform only same-session SQL, with no external effects.

The SQL adapter uses injected `JobsSqlDatabase` / `JobsSqlSession` ports, bound
`$n` parameters, and the unapplied `migrations/0001_jobs.sql`. Server composition
must supply serialized SQLite `BEGIN IMMEDIATE` transactions over one connection
per transaction and preserve rollback failures. Jobs never opens a driver,
imports app internals, or applies a live migration. The host adapts its DB query
shape to `{ sql, parameters }` and must preserve the original typed callback
failure after a confirmed rollback. An unknown commit outcome remains unavailable
and must not be reported as a known rollback. Postgres serialization and row
codecs require separate verification.

`createJobHandlerRegistry({ maxHandlers: 100, maxActive: 128 })` is a bounded,
instance-owned dispatch adapter. It unregisters admission immediately and waits
for active effects before disposing a handler. `reset` permits later
registration; `dispose` permanently closes admission. Handlers perform exactly
one attempt and own the final policy/halt/consent barrier immediately before
egress. A completed dispatch port result binds `jobId` to `JobRequest.operationId`;
`JobService.processOne` returns the persisted outbox ID. Malformed or mismatched
results reconcile. A handler must report transient failure only when it has
reliable evidence that replay is safe. The generic service conservatively treats
all dispatch port errors as unknown, including overload and missing handlers.
Configure host worker concurrency to avoid routine registry saturation.

Expired leases, lost completion acknowledgements, and cancellation of leased or
dispatching work become `reconcile`; queued cancellation becomes `cancelled`.
Reconciliation requires an evidence ID and can resolve only to succeeded,
denied, or failed. It cannot automatically requeue an uncertain effect.
Lease-token IDs must be globally unique across restarts and the retry horizon;
active duplicate tokens are rejected by both stores. The host owns deadlines and
abort signals for DB/provider calls; a handler that never settles will keep its
drain pending rather than pretending its remote effect stopped.

Memory repositories/stores, dispatcher, authorization, observer and transactional
intent helpers are test doubles. They never provide production durability.
Characterization tests reuse the same memory store as the memory/SQL contract
suite. JSON traversal, queue capacity, recovery batches, retries, handler count
and active effects are bounded. Observers are best-effort and contain no payload,
digest, provider response or raw exception.

This continuation passed the one authorized package typecheck, including test
sources. Tests are **written, not run**. Tests, builds and `om:check` remain for
Coordinator combined verification under the owner's no-test-runs override.
Production composition, scheduler ownership, HTTP/CLI/studio surfaces and
provider handlers remain outside this lane. See `HANDOFF.md` and `PROGRESS.md`.
