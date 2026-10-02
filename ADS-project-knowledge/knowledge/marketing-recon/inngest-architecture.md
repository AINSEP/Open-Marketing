# Inngest — how it works

Read `/Users/la/Programming/OSS-Marketing-Repos/inngest`, Go module `github.com/inngest/inngest`, at commit `8e4e5a5b` (indexed cbm project `inngest`, 194,840 nodes / 296,086 edges). Method: cbm `search_graph`/`get_architecture`/`get_code_snippet` to locate symbols, then every claim below is confirmed against the real source file open in the repo. No `graphify`, no `index_repository`, no builds, no tests were run.

## 0. Corrections to the brief

- Nothing in the brief was factually wrong. Two things needed sharpening once the code was open:
  - The brief calls the queue "unusually sophisticated." That undersells it: it isn't one priority queue, it's a **two-tier scheduler** (shadow partitions + backlogs feeding a ready queue) that exists specifically to keep constraint accounting (concurrency/throttle/fairness) off the hot path. See §6.
  - "Replaying a workflow history" was the right comparison to reject, and the code makes the rejection sharper than expected: Inngest doesn't replay anything server-side. The executor sends a flat `{stepID: output}` map and the *SDK* (a separate, un-indexed repo — see §12) re-runs the function body itself. See §4.

## 1. What Inngest is, in plain terms

Inngest is a **queue and durable-step runtime for HTTP handlers**. A developer writes a function against an SDK (TypeScript, Python, Go, etc. — those SDKs are separate repos, not in this checkout) that looks like:

```
inngest.createFunction({ id: "onboard-user" }, { event: "user.signup" }, async ({ event, step }) => {
  await step.run("send-welcome", () => sendEmail(event.data.email));
  await step.sleep("wait-3-days", "3d");
  await step.run("send-checkin", () => sendEmail(event.data.email));
});
```

That function is served from an ordinary HTTP endpoint in the developer's own app (`/api/inngest`). Nothing about it runs continuously; it's invoked exactly like a webhook handler, once per "step" that needs work. The Inngest server (this repo) is the thing that:

1. Receives **events** (arbitrary JSON, pushed to `POST /e/<key>` or produced internally, e.g. `pkg/api`, `pkg/eventstream`).
2. Matches events to registered **functions** by trigger.
3. Calls the function's HTTP endpoint, gets back a description of what step to run next.
4. Persists the step's result, and — this is the core trick — re-invokes the *same* HTTP endpoint for the next step, handing back everything already completed so the SDK can skip straight past it.
5. If a step says "sleep 3 days" or "wait for event X", the server puts a job in a queue for 3 days from now (or until the event arrives) and does nothing else until then — no process, thread, or connection is held open.

So the product is: **event bus + call-scheduler + step-memoization protocol + a genuinely sophisticated multi-tenant queue**, all wrapped in an HTTP request/response cycle instead of a long-lived worker process. That's what makes multi-day waits cheap: durability is "a row in a datastore with a future timestamp," not "a suspended coroutine" or "a checkpointed OS process" (trigger.dev) or "a workflow history replayed inside one continuously-running worker" (Temporal, and Dittofeed on top of it).

## 2. Core concepts, as the code models them

- **Event** — `pkg/event`. Arbitrary JSON with a `name`, `data`, and metadata; the unit that triggers function runs and that `step.waitForEvent` listens for.
- **Function** — `pkg/inngest` (`inngest.Function`). A declarative definition: triggers, steps/edges, and `Concurrency`/`Throttle`/`RateLimit`/`Debounce`/`Priority` config (`pkg/inngest`, referenced throughout `pkg/execution/queue`). Registered via SDK "sync" (the SDK's own HTTP endpoint exposes a `PUT` that returns its function definitions; the server stores them — see `pkg/deploy`, `pkg/devserver/discovery`). Discovery/auto-sync in the dev server polls or accepts pushes from local SDK servers (`pkg/devserver/discovery`).
- **Run** — one execution of a function for one triggering event (or event batch). Identified by `state.Identifier` (`pkg/execution/state/state.go:66-109`): `RunID` (ULID), `WorkflowID`, `AccountID`/`WorkspaceID`/`AppID`, optional `BatchID`, `PriorityFactor`, `CustomConcurrencyKeys`.
- **Step** — one memoizable unit of work inside a run, identified by a hashed `stepID`. Represented on the wire as a `GeneratorOpcode` (`pkg/execution/state/opcode.go:28-59`): `Op` (`enums.Opcode` — `OpcodeStepRun`, `OpcodeSleep`, `OpcodeWaitForEvent`, `OpcodeInvokeFunction`, `OpcodeWaitForSignal`, `OpcodeAIGateway`, `OpcodeGateway`, `OpcodeDeferAdd`/`OpcodeDeferAbort`, plus control opcodes `OpcodeRunComplete`/`OpcodeStepFailed`/`OpcodeDiscoveryRequest` — full list `pkg/enums/opcode.go:7-24`), a hashed `ID`, `Data`/`Error`, and op-specific `Opts` (e.g. `SleepOpts{Duration}`, `WaitForEventOpts{Timeout, If, Event}`).

## 3. Event → function run, traced end to end

1. Event arrives at the API (`pkg/api`) or is enqueued internally; ingestion resolves matching functions and calls `executor.Schedule` (in `pkg/execution/executor/executor.go`), which creates a new `state.Identifier`/run via the state `Manager.New` (`pkg/execution/state/state.go:390-395`) and enqueues a `queue.Item{Kind: queue.KindStart, ...}` (`pkg/execution/queue/kind.go:6`).
2. The queue's shadow-partition scan leases the function's `QueueShadowPartition`, peeks its backlogs, and refills a ready-queue item once concurrency/throttle allow it (`pkg/execution/queue/shadow_process.go:25-260` — detailed in §6).
3. A worker's `executionScan` leases the ready item and calls into `executor.Execute` (`pkg/execution/executor/executor.go:1755-2179`), which resolves the driver — `executeDriverV1`/`executeDriverV2` (`executor.go:2516-2674`) — and builds the outbound SDK request via `driver.MarshalV1` (`pkg/execution/driver/driver.go:106-229`, see §4).
4. The driver POSTs the request to the function's registered URL (`pkg/execution/driver/httpdriver`) or, for **Connect** apps, ships it over a persistent gRPC/WebSocket tunnel instead of an inbound HTTP call (`pkg/connect`) — a mechanism for SDKs that can't accept inbound webhooks (e.g. behind NAT). Either way the payload contract is identical.
5. The SDK responds with either a final result (`OpcodeRunComplete`/`OpcodeStepFailed`) or one or more `GeneratorOpcode`s describing the next step(s) to take. The executor dispatches by opcode: `handleGeneratorStep`/`handleGeneratorStepPlanned` (`executor.go:3984-4063`, `4287-4390`) for `step.run`, `handleGeneratorSleep` (`executor.go:4394-4500`) for `step.sleep`, `handleGeneratorWaitForEvent` (`executor.go:5147-5348`) for `step.waitForEvent`, `handleGeneratorInvokeFunction` for `step.invoke`.
6. Each handler persists the step (or a pause, or a sleep timer) and enqueues exactly one new queue item for what happens next — repeat from step 3 until a run-complete opcode is seen or the run errors out past its retry budget.

## 4. The durable step model — how it actually works

This is the flagship mechanism, and it is **not** workflow-history replay.

**What's sent on every invocation.** `driver.MarshalV1` (`pkg/execution/driver/driver.go:106-229`) builds an `SDKRequest` (`pkg/execution/driver/request.go:44-60`) containing:
- `Event`/`Events` — the triggering event(s), loaded fresh every time (`sl.LoadEvents`).
- `Actions map[string]any` (JSON key `"steps"`) — **the memoized output of every already-completed step**, keyed by hashed step ID. Built by walking the run's ordered `Stack` and pulling each step's stored output from the state store (`driver.go:189-225`: `for _, stepId := range md.Stack { req.Actions[stepId] = steps[stepId] }`).
- `Context.Stack` — the ordered list of completed step IDs plus a `Current` index.
- If the accumulated state is too large (`consts.MaxSDKRequestBodySize`), `UseAPI: true` tells the SDK to pull `Events`/`Actions` from a separate API endpoint instead of inline — a size escape hatch, not a different protocol.

**What the SDK does with it (inferred from the protocol contract; the SDK itself is a different repo — see §12/"could not verify").** The SDK does not "resume" anywhere. It **re-runs the function body from the top on every single HTTP call.** Each time it reaches a `step.run(id, fn)`, it hashes `id`, looks it up in the `steps` map it was just handed, and:
- If present → returns the cached `data`/`error` immediately. `fn` is **never re-invoked**. This is the memoization.
- If absent → depending on `DisableImmediateExecution`/`ForceStepPlan` (`pkg/execution/executor/force_step_plan.go`), it either executes `fn` synchronously in this same HTTP call and reports the result (the "immediate execution" fast path — one network round trip covers discovery + execution for a fresh step), or it reports a discovery opcode (`OpcodeStepPlanned`) asking the executor to schedule it and come back.

**Why this differs from replaying a workflow history (Temporal/Dittofeed model):**
- Temporal-style replay re-executes the *entire* workflow function deterministically against a full **event history** (every scheduled/started/completed command), inside one workflow-worker process, to reconstruct in-memory state before continuing past the point it left off. The replay is the state-reconstruction mechanism, and it requires the workflow code to be deterministic end-to-end (no raw I/O, `Date.now()`, etc. outside SDK-mediated calls).
- Inngest's server never replays anything. It ships a **flat key→value cache of finished step outputs**, not an event log, and it is the *SDK*, not a workflow engine, that "replays" by literally re-running the plain function body top to bottom on every call. Only code wrapped in `step.run`/`step.sleep`/etc. is memoized; **anything outside a step re-executes on every single invocation of the function** (a well-known Inngest/Vercel-workflow-style footgun — non-step side effects are not exactly-once). Temporal's replay covers the *whole* function; Inngest's memoization covers only the step boundaries the developer explicitly drew.
- Practical consequence: Inngest has no requirement that the whole function be a single deterministic replay-safe program — only the parts between steps need to be safe to re-run (idempotent-ish), which is a much smaller ask. The trade is per-step network round trips instead of in-memory continuation.

**What this costs to run**: one HTTP (or Connect-tunnel) round trip per **discovered** step (not per completed step — immediate execution can complete+discover in one round trip when unconstrained), plus one state read (`LoadEvents`+`LoadSteps`, Redis) and one state write (`SaveResponse`, `pkg/execution/state/state.go:409-414`) per step. For a function with N sequential steps that's roughly N HTTP calls to the developer's endpoint and N small Redis read/writes — cheap compared to holding a process or container alive, but not free: request/response overhead scales with step count and with the size of previously-produced step output (all of it is resent every call, capped by `MaxSDKRequestBodySize`, with the `UseAPI` escape hatch beyond that).

## 5. `step.sleep` and `step.waitForEvent` — where the timer actually lives

**The timer lives in the queue, as a normal item with a future score — not in any process, thread, connection, or workflow-engine timer wheel.**

`handleGeneratorSleep` (`pkg/execution/executor/executor.go:4394-4500`):
```go
until := e.now().Add(dur)
nextItem := queue.Item{ Kind: queue.KindSleep, ... }
err = e.queue.Enqueue(ctx, nextItem, until, queue.EnqueueOpts{PassthroughJobId: true})
```
That's it. The executor computes the wake time, enqueues a `KindSleep` item scored at that time, and returns — the HTTP request/response cycle that reported the sleep is fully closed out. No goroutine, connection, or in-memory timer is kept for the sleeping run. Three days later, the same queue mechanics that pick up any other job (shadow-partition refill → ready-queue lease → `executionScan`) pick this one up and re-invoke the SDK, which sees `stepID` for the sleep already in its `steps` map and moves on to the next line.

`handleGeneratorWaitForEvent` (`executor.go:5147-5348`) is the same idea plus a second index for event matching:
1. A `state.Pause` row is written (`pkg/execution/state/pause.go:173-267`): run identifier, the `Event` name and optional `Expression` (a CEL-style match expression) to wait for, and an `Expires` timestamp. Persisted via `PauseStore` (`pkg/execution/state/redis_state/pause_store.go`) and indexed by `(workspaceID, eventName)` so an arriving event can be matched without scanning all pauses.
2. A `queue.Item{Kind: queue.KindPause, Payload: PayloadPauseTimeout{PauseID, Pause}}` is enqueued **at the timeout time** (`executor.go` — `e.queue.Enqueue(ctx, nextItem, expires, ...)`), so the queue itself drives the timeout branch even if no event ever arrives.
3. Two independent triggers can resume the run, and only one wins: (a) a new event matches the pause's index and expression — the event-ingestion path consumes the pause and resumes the run; (b) the timeout queue item fires — it checks the pause still exists and, if so, consumes it as a timeout. `ConsumePause` (`state.Mutater.ConsumePause`, `pkg/execution/state/state.go:417`) is the atomic op that lets exactly one of these win.

So both mechanisms reduce to the same primitive: **a queue item with a future timestamp**, backed by Redis sorted sets (see §10), plus — for `waitForEvent` — a secondary lookup index keyed by event name. This is the single most portable idea in the whole repo (§12).

## 6. The queue — a two-tier scheduler, not a priority queue

`pkg/execution/queue` (55 files, ~5,200 lines excluding tests) implements something closer to a mini scheduler than a job queue. The design exists to answer: *how do you enforce per-tenant concurrency/throttle/fairness without scanning every queue item on every tick?* Answer: separate the "what could run" bookkeeping from the "what's about to run" hot path.

**Two-tier structure:**
- **`QueueShadowPartition`** (`pkg/execution/queue/shadow_partition.go:11-31`) — one per function (or per system queue), tracks whether the partition is leaseable for refill work.
- **`QueueBacklog`** (`pkg/execution/queue/backlog.go:55-71`) — the actual holding areas *inside* a shadow partition, one per distinct constraint combination: the default backlog, a `:start` backlog for new runs, a `:t<exprHash:key>` backlog per throttle key, and up to two `:c1<...>`/`:c2<...>` backlogs per custom concurrency key (`ItemBacklog`, `backlog.go:159-251`; ID format documented at `backlog.go:283-289`).
- **Refill loop** (`ProcessShadowPartition`, `pkg/execution/queue/shadow_process.go:25-...`): leases the shadow partition (`ShadowPartitionLeaseDuration = 4s`), peeks its backlogs, and moves eligible items from backlogs into the real ready-to-run queue — but only as many as current concurrency/throttle state allows. This is where all constraint math happens; the ready queue itself is just a sorted set workers can safely lease from without re-checking limits per item.
- **Fairness inside the refill**: `ShuffleBacklogs` (`backlog.go:390-411`) does a *weighted* random shuffle — non-`start` backlogs get weight 10 vs. 1 for `start` backlogs, so continuing existing runs is favored over admitting new tenants/runs when both compete. `BacklogRefillMultiplier` (`backlog.go:416-432`) goes further: when throttle is configured without custom concurrency keys, the default (continuation) backlog gets a multiplier equal to the total backlog count — i.e., "let 1-in-N refill cycles go to starting new runs, and dedicate the rest to finishing runs already in flight," a direct anti-starvation measure for existing work under load.
- **Constraint accounting is a separate package**, `pkg/constraintapi` (semaphores, GCRA rate limiting, capacity/lease management, all backed by Redis Lua scripts — `pkg/constraintapi/lua`, `gcra_test.go`, `semaphore_manager.go`, `capacity_manager.go`). It's a real, fully-implemented subsystem in the OSS tree, not a cloud stub (confirmed present and wired into `pkg/devserver/devserver.go`).
- **Worker-side leasing**: ready-queue items are leased for `QueueLeaseDuration = 30s` (`pkg/execution/queue/consts.go:57`); partitions/shadow-partitions for `4s` (`consts.go:18,43`), re-extended by a background goroutine while in use (`shadow_process.go:142-180`).
- **Recovery from crashed workers**: a `scavenger` role (`pkg/execution/queue/scavenger.go`) periodically calls `shard.Scavenge` to find items whose lease expired without being acked/nacked and puts them back — this is the at-least-once safety net (see §8).

Priority/account fairness plumbing exists as pluggable finders — `WithPartitionPriorityFinder`, `WithAccountPriorityFinder` (`pkg/execution/queue/option.go:73-89`) — letting a caller (cloud, in practice) inject account-tier priority weighting into partition selection; the OSS default is a flat/neutral finder.

**Verdict on the queue**: yes, this is the best artefact in the repo. The shadow-partition/backlog split is a genuinely reusable pattern for "many tenants, several orthogonal constraints, cheap enforcement" — worth understanding even if we never touch Redis or Go.

## 7. Flow control — how each knob is expressed and enforced

All of these are fields on `inngest.Function`'s config, evaluated once per event via `pkg/expressions` (a CEL-based expression engine) and baked into the queue item/backlog at enqueue time:

- **Concurrency** — `Concurrency.CustomConcurrencyKeys` (function/env/account scope, optional key expression e.g. `event.data.customerId`). Enforced as semaphores via `pkg/constraintapi` and reflected in backlog IDs (`:c1<hash:hash>`, `:c2<...>` — max 2 custom keys, `backlog.go:308-315`). Lifecycle hooks fire on limit (`queue.QueueLifecycleListener.OnFnConcurrencyLimitReached` / `OnAccountConcurrencyLimitReached` / `OnCustomKeyConcurrencyLimitReached`, `pkg/execution/queue/queue_lifecycle.go:13-58`).
- **Throttle** — `GetThrottleConfig` (`pkg/execution/queue/item.go:666-691`): a rate + key expression, distinct from rate-limiting in that it delays/queues excess items rather than dropping them. Backed by a dedicated `:t<exprHash:key>` backlog per key (§6) and a GCRA implementation in `pkg/constraintapi`. `HasOutdatedThrottle` (`throttle.go:7-40`) detects and triggers backlog normalization when a function's throttle config changes mid-flight.
- **Rate limit** — `pkg/execution/ratelimit` (`RateLimitKey`, `ratelimit.go:54-73`): evaluates a key expression against the event, hashes it, and rejects (rather than delays) over the configured limit — the semantic difference from throttle. GCRA via Lua (`ratelimit_lua.go`).
- **Debounce** — `pkg/execution/debounce/debounce.go`: on each matching event, stores the latest event under a debounce key and (re)schedules a single delayed queue item; only the last event within the window actually starts a run (`DebounceItem`/`DebouncePayload`, lines 46-120). Migration-safe (`DebounceMigrating`) for cluster resharding.
- **Priority** — `Identifier.PriorityFactor` (`pkg/execution/state/state.go:95-100`) — a per-run integer that biases scheduling order for that run's subsequent steps; `GetPriorityFactor` (`queue/item.go:467-481`).
- **Multi-tenant fairness** — not a user-facing knob but a system property: the shadow-partition/backlog weighting in §6 is what keeps one noisy tenant's `start` backlog from starving another's in-flight runs, and per-account shard resolution (`forAccountShards`, `processor.go:254-266`) plus the pluggable priority finders are the seams cloud uses for cross-account fairness.

## 8. Failure handling

- **Retries**: table-based backoff by default — `pkg/backoff/backoff.go:9-20`: 15s, 30s, 1m, 2m, 5m, 10m, 20m, 40m, 1h, 2h (plus jitter), capping at the last entry for further attempts (`TableBackoff`, lines 47-56). An `ExponentialJitterBackoff` alternative exists (capped at 12h). Retry count is per-function (`MaxAttempts`), checked via `ShouldRetry`/`AlwaysRetryError`/`NeverRetryError` (`pkg/execution/queue/queue.go:133-215`) — errors can opt out of the normal budget in either direction.
- **Dead-letter queue**: **not implemented for function runs.** The only "dead-letter" mention in the whole non-vendor tree is a `// TODO ... push into a dead-letter queue` comment in the Connect gateway's message-delivery path (`pkg/connect/gateway.go:932`), unrelated to run/step retries. A run that exhausts its retries simply ends in `RunStatusFailed` (`pkg/enums`); there is no OSS mechanism to re-drive it automatically — only manual replay via the API/dashboard (`pkg/cqrs` replay types).
- **Executor dies mid-step**: recovery is pure **lease-expiry + at-least-once redelivery**, not a saved execution log. The ready-queue item is leased for `QueueLeaseDuration = 30s` while a worker processes it; if the worker (or its host) dies, no one extends or acks the lease, and the periodic `scavenger` role (`pkg/execution/queue/scavenger.go:11-22`) finds it and re-queues it. Because nothing is durably recorded for a step until `SaveResponse` succeeds (`pkg/execution/state/state.go:409-414`, with `ErrIdempotentResponse`/`ErrDuplicateResponse` guarding double-writes), a re-run of the same step after a crash is safe: worst case the developer's step function runs twice if it wasn't finished writing its result, which is the standard at-least-once caveat, not a data-loss caveat.
- **Idempotency**: run-level via `Identifier.IdempotencyKey()` (`state.go:191-197`, checked at run creation — `Manager.New` returns `ErrIdentifierExists`); step-level via `SaveResponse`'s idempotent-response handling; queue-item-level via `JobID`/`PassthroughJobId` and `ErrQueueItemExists` (seen guarding both sleep and wait-for-event enqueues so a retried handler doesn't double-schedule).

## 9. Dev server vs. cloud — what's actually open source

Everything described in §3–§8 is the **same Go code** in both modes; there is no OSS/EE split in this repository (see §11 — one license covers the whole tree, no `ee/` directory). What differs is only the infrastructure the code is pointed at:

- `pkg/devserver/devserver.go` wires up: an in-process Redis via `github.com/alicebob/miniredis/v2` (`createInmemoryRedis`, `devserver.go:818-830`) *or* a real external Redis (`RedisURI` option, line 143) for the queue/state/pauses/constraintapi engine; and SQLite (`pkg/db/sqlite`, `dbsqlite.Open`) or Postgres (`pkg/db/postgres`) for the CQRS/observability store (§10). The **entire queue engine described in §6 — shadow partitions, backlogs, throttle, debounce, rate limiting, semaphores — runs unmodified against the in-memory Redis** in `inngest dev`; it is not a simplified stand-in.
- What's genuinely cloud-only, based on what's absent or stubbed from this checkout: hosted multi-region Redis clusters/sharding operations, the pluggable account-tier priority finders (§6/§7) beyond a neutral default, a management/billing plane, and (per §8) any dead-letter/auto-replay tooling beyond manual API replay. The `pkg/constraintapi` accounting layer and the `connect` persistent-tunnel gateway (`pkg/connect`) are both present and wired into the dev server too — not cloud-exclusive.
- Practical reading for us: **`inngest dev` is a real, complete, single-binary implementation of the durable-execution engine**, not a toy. That materially changes the "build vs. buy vs. steal" calculus in §12.

## 10. Data model

Two separate stores serve two separate purposes — conflating them would misread the architecture:

**1. Redis — the hot execution/durability engine** (namespaced with Redis Cluster hashtags so all keys for one run land on one slot, `pkg/execution/state/redis_state/key_generator.go:65-84`):
- `{prefix}:metadata:<runID>` — run metadata (`state.Metadata`: status, request version, span ID).
- `{prefix}:bulk-events:<fnID>:<runID>` — the triggering event batch.
- `{prefix}:actions:<fnID>:<runID>` — **the memoized step-output map** — this is the row `LoadSteps` reads to build every outbound SDK request (§4).
- `{prefix}:stack:<runID>`, `:action-inputs`, `:pending`, `:defers-meta`, `:defers-input` — ordering, per-step inputs, in-flight counters, and the "defer" (fire-and-forget-after-run) bookkeeping.
- Pauses (`pkg/execution/state/redis_state/pause_store.go`) — keyed by pause ID plus a secondary `(workspaceID, eventName)` index for `waitForEvent` matching, and a time-partitioned "block" store (`pkg/execution/pauses/block.go`) for cold/expired pauses.
- The queue itself: ready-queue sorted sets, shadow partitions, and backlogs (§6), all Redis-native (sorted sets scored by run time, hashes for item bodies).
- Constraint state (`pkg/constraintapi`): semaphore/capacity counters and GCRA rate-limit state, Redis + Lua.

**2. SQLite (dev) / Postgres (cloud) via `pkg/cqrs`** — the historical/observability record, **not** on the execution hot path. Baseline schema (`pkg/db/sqlite/migrations/000001_baseline.sql`): `apps`, `functions`, `events`, `event_batches`, `function_runs`, `function_finishes`, `history` (step-by-step audit trail for the dashboard's run timeline), `traces`/`trace_runs`/`spans` (OpenTelemetry-shaped execution traces), `queue_snapshot_chunks` (debug snapshots), `worker_connections` (Connect gateway session tracking). This is what backs the dashboard/API's "show me this run's history," but resuming a run never reads it — only Redis state does.

## 11. License

**One license covers the entire repository** — `LICENSE.md` at the root, no `ee/`/`enterprise/` directory, no per-package license split (unlike some prior repos in this batch). It is **Server Side Public License v1 (SSPL)**, MongoDB's license, with an added **"Grant of Future License"** clause (`LICENSE.md:561-579`): every piece of code automatically re-licenses to **Apache 2.0 on the third anniversary of the date it was made available**. So at any moment the repo is a mix of "SSPL today, Apache-2.0-eligible code from ≥3 years ago" and "genuinely still-SSPL code from the last 3 years" — there's no marker in-tree distinguishing which lines have crossed that line; it has to be inferred from git blame date if it ever matters.

SSPL is not OSI-approved open source. Its distinguishing clause (§13, "Offering the Program as a Service") requires that if you offer the *functionality* of the program to third parties as a service, you must open-source your entire surrounding service stack (management software, UI, APIs, monitoring — everything) under SSPL. That clause is squarely aimed at cloud providers reselling MongoDB/Inngest-as-a-service; it does not restrict internal use, and it does not restrict *reading the code to learn the architecture and reimplementing your own version* (facts/ideas/APIs aren't copyrightable; SSPL, like any copyright license, only reaches copying the actual code). It matters only if we'd copy substantial chunks of this Go code into a product we host for others — which is not what §12 recommends.

No tier is hidden or gated at runtime in this checkout: §9 already established the dev server runs the real engine, not a crippled one.

## 12. What's worth taking, and the verdict

**Ranked, what's worth taking:**
1. **The sleep/wait-as-a-queue-item pattern (§5).** By far the most portable idea, and the direct answer to "how do you survive a 3-day wait." A journey-engine "wait 3 days" step is nothing more than: write a row with `(journeyRunID, resumeAt, resumeState)`, and a scheduler that polls/pops rows where `resumeAt <= now`. No durable-execution framework, no replay, no long-lived process required. Postgres (`SELECT ... WHERE resume_at <= now() FOR UPDATE SKIP LOCKED`) or SQLite-with-a-poller reproduces this at our scale trivially.
2. **The step-memoization *contract*, not the mechanism (§4).** The idea of "re-run the plain function, but skip already-completed named steps via a cache lookup" is generically useful for any journey/workflow shape we build — but their specific HTTP-request/response + generator-opcode protocol is overkill for a single Electron/Next process where the "worker" and the "orchestrator" are the same address space. We don't need a wire protocol for something that can be an in-process function call.
3. **The shadow-partition/backlog fairness split (§6).** Worth remembering as a design pattern *if* we ever need multi-tenant throttling/concurrency at scale, but it's solving a problem (many independent Redis-Cluster shards, thousands of tenants) we don't have yet. Not worth porting code; worth citing if we ever redesign our own queue under real multi-tenant load.
4. **Not worth taking**: the Go server itself, the HTTP/Connect step-calling protocol, `pkg/constraintapi`'s Lua/Redis semaphore machinery, and the dual-store (Redis + CQRS SQL) split — all sized for a multi-tenant SaaS with independent worker fleets, not a single Next.js/Electron app where the app *is* the worker.

**The central question — cheapest honest way to get durable, resumable, multi-day journey execution in our Next/Electron app.** Three options, ranked:

1. **Build the minimal version ourselves (recommended).** A `journey_runs` table (Postgres if server-hosted, SQLite if Electron-local) with `state JSONB`, `current_step`, `resume_at TIMESTAMP NULL`, `wait_event TEXT NULL`, `wait_expr TEXT NULL`. A single poller (a `setInterval`/cron in the Next.js server, or an Electron background timer) does `WHERE resume_at <= now() OR (wait_event IS NOT NULL AND <matching event arrived>)`, loads `state`, and calls a plain async function that switches on `current_step` — exactly Inngest's memoization idea (§4-take), minus the HTTP round trip, minus the queue sophistication we don't need at our scale. This is maybe 300-500 lines and it is the option that matches "modular + reversible": no new infra, no new dependency, trivially testable, trivially inspectable. It steals Inngest's *idea* (queue-item-as-timer + memoized-step-cache) and ports zero of its code, sidestepping the SSPL question entirely.
2. **Vendor/run `inngest dev` as a subprocess.** Because §9 established the dev server is a real, complete, single-binary implementation (miniredis + SQLite inside one Go process), we could genuinely shell out to it, define our journeys as Inngest functions in a small Node/TS SDK-facing HTTP handler, and let their engine handle scheduling. This buys us the mature queue/retry/concurrency machinery for free, at the cost of: a Go binary dependency in an Electron app (packaging weight, another process to supervise, another failure surface), an HTTP hop we don't need locally, and real (if narrow) SSPL exposure the moment we're not just "running it internally" but shipping it inside a product we distribute to others — worth a licensing look before committing, not a blocker but not free either.
3. **Reach for a hosted workflow provider (Temporal Cloud, or Inngest Cloud itself) and skip building this at all.** Rejected for the same reason trigger.dev was: unnecessary weight and an external dependency for a mechanism (§5) that reduces to "a row with a future timestamp and a poller" — paying for someone else's multi-tenant fairness infrastructure to solve a single-tenant scheduling problem.

**Verdict**: option 1. Steal the idea — durable state is a state machine in a row, a wait is a future-scored row, a resume is a poll — port no code. This is a well-argued case for build-the-simple-thing: everything Inngest's engine is actually sophisticated about (§6, §9's cloud/OSS split, §11's licensing shape) is solving multi-tenant SaaS problems (thousands of independent accounts, Redis Cluster sharding, cross-tenant fairness) that don't exist in a single Next.js/Electron app driving its own journeys.

---

## Handoff

**Answer to the central question, up front**: the timer for `step.sleep`/`step.waitForEvent` lives as an ordinary queue item scored at a future timestamp (`pkg/execution/queue`, backed by Redis sorted sets) — not a suspended process, not a replayed history. That single mechanism is the cheapest honest thing to reproduce: a `journey_runs` row with `resume_at`/`wait_event` plus a poller. Recommended path is **build our own minimal version** (option 1 in §12), not vendoring the dev server and not adopting a hosted provider.

**Inputs used**: `get_architecture` (overview/entry_points/packages/layers/clusters, then scoped to `pkg/execution`), `search_graph` (opcode/pause/queue/sleep/waitForEvent symbol discovery), `get_code_snippet` for `handleGeneratorSleep`, `handleGeneratorWaitForEvent`, direct reads of `pkg/execution/state/{state,pause,opcode}.go`, `pkg/execution/driver/{driver,request}.go`, `pkg/execution/queue/{queue,shadow_partition,backlog,throttle,kind,processor,shadow_process,scavenger,consts}.go`, `pkg/execution/{debounce,ratelimit}/*.go`, `pkg/execution/executor/force_step_plan.go`, `pkg/execution/state/redis_state/key_generator.go`, `pkg/devserver/devserver.go`, `pkg/db/sqlite/migrations/000001_baseline.sql`, `pkg/enums/opcode.go`, `pkg/backoff/backoff.go`, `LICENSE.md`, plus grep sweeps for DLQ/enterprise-dir/license-header patterns across the non-vendor tree.

**What I could not verify (say so rather than guess)**:
- The actual SDK-side re-execution loop (how `step.run` hashes IDs, how immediate-execution vs. discovery is chosen client-side) — the SDKs (`inngest-js`, `inngest-py`, etc.) are separate repositories not present in this checkout. §4's description of SDK behavior is inferred from the server-side protocol contract (`SDKRequest`/`GeneratorOpcode`) and the executor's dispatch code, which is direct evidence of the *contract* but not the SDK's own implementation.
- Whether cloud specifically uses a different (non-neutral) implementation behind `WithPartitionPriorityFinder`/`WithAccountPriorityFinder` — the interface and its OSS default are visible; cloud's concrete implementation is not in this repo.
- Exact behavior of `queue.KindScheduleBatch`/batch triggers (`pkg/execution/batch`) — noted in the file tree, not read in depth; unlikely to affect the journey-engine question but flagged for completeness.

**Risks**: §4 and §5's claims about the durable-step/timer mechanism are High confidence — they're read directly off the code that builds the request and enqueues the sleep/pause items. §9's dev-server-vs-cloud claim is High confidence for what's present (miniredis + full queue engine wired together) and Medium for the completeness of "what's cloud-only" (absence of evidence in an OSS checkout isn't proof cloud has nothing extra, only that nothing extra is *here*). §11's license reading is High confidence (single unambiguous LICENSE.md, checked for competing headers via grep).

No `graphify`, no `index_repository`, no builds, no tests, no writes under the inngest clone. Output: `/Users/la/Programming/Open-Marketing/docs/inngest-architecture.md` (this file).
