# trigger.dev Architecture — Reference Analysis

> Reference-only analysis of upstream trigger.dev, done to decide **whether/how its durable
> execution model could substitute for Temporal** as the substrate for a journey engine in the
> Open Design–based Open Marketing repo (Next.js/Electron).
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/trigger.dev` (clone of
>   `github.com/triggerdotdev/trigger.dev`, analyzed at commit `7851f5ca`, 2026-07-01)
> - **Tools:** codebase-memory-mcp (project `trigger-dev`, moderate mode, 28,180 nodes / 93,802
>   edges) + `rg`/direct source reads. **Graphify did not finish** in the analysis window — see
>   Tool Calibration.
> - **Date:** 2026-09-06/07

## Section 0 — Premise corrections and self-corrections

- **Premise "TypeScript-native durable execution engine" needs qualification.** trigger.dev is
  not one durable-execution engine, it's **two temporal primitives plus one process-snapshotting
  mechanism, glued together relationally**: (1) `DelayedRunSystem` for "start this run later"
  (`internal-packages/run-engine/src/engine/systems/delayedRunSystem.ts:22-40`), (2)
  `WaitpointSystem` for "pause mid-run until X"
  (`internal-packages/run-engine/src/engine/systems/waitpointSystem.ts`), and (3) OS/container
  checkpoint-restore (CRIU via `crictl`/`buildah`, or Docker's experimental checkpoint feature)
  for literally freezing and resuming the running Node.js process
  (`apps/coordinator/src/checkpointer.ts`). There is no Temporal-style replay of a deterministic
  workflow function anywhere in this codebase. This is a materially different design, not a
  reimplementation of Temporal's idea in TypeScript — see Section 2.
- **Correction found in Pass B: the flagship durability mechanism is Cloud-only.** The self-hosting
  docs (`docs/self-hosting/overview.mdx:38-43`) list "Checkpoints" as Cloud ✅ / self-hosted ❌,
  described as "non-blocking waits, less resource usage." Pass A had assumed checkpoint/resume was
  a uniformly available feature because the code is fully present and unlicensed (MIT/Apache) in
  `apps/coordinator/`, `internal-packages/run-engine/src/engine/systems/checkpointSystem.ts`, and
  the provider apps. Pass B traced *why* it's Cloud-only: it needs CRIU support wired through
  `crictl`/`buildah` (Kubernetes/CRI-O) or Docker's long-experimental `docker checkpoint` feature
  (`apps/coordinator/src/checkpointer.ts:138-156`), neither of which a stock self-hosted
  docker-compose deployment provides. This is an **infra-gated capability**, not a source-hidden
  or license-gated one — a fifth licensing/availability pattern, distinct from the four seen
  across the prior four repos in this survey (restricted source in-tree, EE package omitted
  entirely, EE moved to a separate repo, live network license check). See the License section.
- **No `ee`/`enterprise` package or license-key gate exists in this repo at all** — confirmed by
  `grep -ril enterprise` (one incidental doc hit, `docs/batch-queue-metrics.md`) and by every
  `package.json`'s `license` field being either absent (defaults to the root `Apache-2.0`) or
  explicitly `"MIT"` (14 packages). The only cloud/self-hosted behavioral branch found in source is
  `isCloud()` (`apps/webapp/app/services/platform.v3.server.ts:1003-1017`), which gates **billing
  plan wiring only** (`platform.v3.server.ts:50`, `projectCreated.server.ts:15`) — it does not gate
  any task-execution feature. Do not read this repo through the "look for the EE gate" lens that
  applied to Chatwoot/Dittofeed; the actual gate here is operational (infrastructure), not legal or
  code-level.
- **cbm's `Route` nodes are unusable here too** (see Tool Calibration) — this is the fifth
  consecutive framework (after Rails, Fastify-Dittofeed-was-usable-actually-see-below, Go, JAX-RS,
  Next.js App Router) where Route-node quality varies by framework. Correction to the established
  fact itself: Dittofeed's Fastify routes were clean; trigger.dev's webapp is **Remix**
  (file-based routing, `apps/webapp/app/routes/*.ts`), and cbm's `get_architecture(routes:...)`
  returned mostly non-HTTP event names (`"SIGTERM"`, `"heartbeat"`, `"leaderElection"`) with empty
  `method` fields — Remix's routing convention is not what cbm's route extractor expects. Routes
  below were enumerated from source file names, not the graph.

## TL;DR

- **Code quality: 8/10. Marketing-port value: 2/10.** This is the most sophisticated codebase in
  the survey and the least reusable for a marketing journey engine. trigger.dev is a
  multi-tenant, container-per-run **background-job execution platform for arbitrary customer
  code** — closer in shape to a mini AWS Lambda/Batch than to a marketing-automation product. It
  has no concept of a segment, a campaign, a channel, or a subscriber; "journeys" as Dittofeed
  defines them don't exist here at all. What it has is a very well-engineered answer to a
  narrower, harder problem: *how do you pause and resume arbitrary untrusted Node.js code across
  process/machine restarts.*
- **The central finding: trigger.dev is not a cheaper Temporal — it is a more expensive, more
  general one.** Temporal buys durability by requiring deterministic, replayable workflow code
  and keeping all state in an event log the server owns. trigger.dev buys durability by literally
  checkpointing the OS process (CRIU/Docker checkpoint) so *ordinary, non-deterministic* async
  code can pause anywhere — but that costs a container registry, CRI-O/buildah tooling or Docker
  experimental features, and (per the vendor's own docs) is Cloud-only in practice. For a
  **marketing journey** — a finite graph of entry/delay/branch/send/exit nodes, exactly the shape
  Dittofeed's `userJourneyWorkflow` already proved out — you never need "resume arbitrary code
  mid-stack-frame." You need "resume a known step type with known saved state," which is what
  Dittofeed's Temporal workflow *and* a hand-rolled state machine both give you far more cheaply
  than checkpoint/restore ever will.
- **The three genuinely portable ideas are small and data-shaped, not architectural.** (1) the
  `Waitpoint` row + durable delayed-job pattern for "resume later without a live timer"
  (Section 3); (2) the append-only `TaskRunExecutionSnapshot` linked list as a cheap, queryable
  execution audit trail (Section 2); (3) the heartbeat/dead-man's-switch pattern for detecting an
  abandoned in-flight execution and self-healing it (Section 5). None of these require adopting
  run-engine, redis-worker, or checkpointing.
- **Licensing is genuinely open and unusually clean** (see below) but that openness doesn't
  translate into portable code for us, because the code answers a question ("sandbox arbitrary
  customer containers fairly and durably") we don't have.

## What it is

A **TypeScript/Node monorepo** (pnpm workspaces + Turborepo), 4,658 tracked files (excluding
`.git`) — 2,005 `.ts`, 654 `.tsx`, 820 `.sql` (786 Prisma migrations). cbm indexed it in `moderate`
mode: 28,180 nodes / 93,802 edges, 2,103 TypeScript files recognized, 142 `Route` nodes (mostly
noise, see Section 0), 87 `Channel` nodes (message-bus/socket topics — `LISTENS_ON`/`EMITS` edges,
113/54 respectively).

**Stack:** Remix (webapp/dashboard, Node) · Fastify-free — Remix loaders/actions serve the entire
HTTP surface including the public API · **Postgres + Prisma** (77 models, 46 enums, 78 `Json`
columns) as the system of record · **Redis** (ioredis) for queueing, concurrency counters, and
locks · **ClickHouse** for OTel trace/log ingestion at scale (`internal-packages/clickhouse`,
`internal-packages/otlp-importer`) · **MinIO/S3** for large payload/log object storage ·
**ElectricSQL** for realtime dashboard sync via Postgres logical replication · Docker or
Kubernetes as the task-execution substrate · OpenTelemetry throughout. Package manager pnpm
10.33.2, Node build via `tsx`/`turbo`, linting via `oxlint`, testing via `vitest`.

### The packages that matter

| Package/app | Role | cbm nodes |
|---|---|---|
| `apps/webapp` | Remix dashboard + the entire public/private API surface | 5,831 |
| `packages/core` | shared SDK/runtime types, wire protocol, checkpoint test helpers | 1,754 |
| `internal-packages/tsql` | a bespoke SQL-like query language/parser (ANTLR-based) for the dashboard's run/log filters | 1,749 |
| `packages/cli-v3` | `trigger dev`/`trigger deploy` CLI, build pipeline | 846 |
| `packages/trigger-sdk` | the user-facing `task()`/`wait`/`schedules` SDK | 608 |
| `internal-packages/run-engine` | **the flagship** — run state machine, waitpoints, checkpoints, run-queue | 440 |
| `packages/redis-worker` | generic durable Redis job queue + a separate DRR fair-tenant dispatcher | 338 |
| `apps/supervisor` | per-machine daemon: spawns/monitors runner containers, talks to the coordinator | 209 |
| `internal-packages/clickhouse` | OTel event/metrics store | 129 |
| `apps/kubernetes-provider` / `apps/docker-provider` | checkpoint/restore + container lifecycle backends | 95 / — |
| `apps/coordinator` | brokers checkpoint requests between supervisor and run-engine | 77 |
| `internal-packages/rbac` | role/permission model for orgs/projects | 64 |
| `internal-packages/schedule-engine` | cron-based recurring task triggering | (small) |

Dependency direction (cbm `boundaries`, call-count weighted): `webapp → core` (491), `trigger-sdk
→ core` (194), `cli-v3 → core` (154), `webapp → trigger-sdk` (107), `run-engine → tracing` (33),
`webapp → supervisor` (30), `coordinator → core` (30). `core` is the hub: 869 fan-in / 55 fan-out
per cbm's layer inference — every app and package depends on it, it depends on almost nothing.
This is real layering, not aspirational: the SDK/protocol package is genuinely shared and
one-way.

## License — precisely

- **Root license: Apache-2.0** (`LICENSE`), copyright "Trigger.dev", applies to the platform
  itself: `apps/webapp` has **no package-level `license` field** (private, inherits Apache-2.0),
  as do most `internal-packages/*`.
- **14 packages are explicitly `"license": "MIT"`** and ship their own `LICENSE` file: `core`,
  `cli-v3`, `trigger-sdk`, `build`, `python` (own LICENSE files), plus `coordinator`,
  `docker-provider`, `kubernetes-provider`, `plugins`, `react-hooks`, `redis-worker`,
  `schema-to-json`, `rsc`, and `internal-packages/otlp-importer` (MIT field, no separate file).
  The pattern is coherent: **everything a customer's code touches or that gets embedded in a
  customer's build (SDK, CLI, wire types, build plugins) is MIT; the platform that runs it
  (webapp, run-engine, database schema, rbac, redis-worker's fair-queue internals) is
  Apache-2.0.** Apache-2.0's patent grant/termination clause is the only practical difference
  from MIT for our purposes — irrelevant to source-lifting, relevant only if we'd worry about
  patent litigation exposure from Trigger.dev Inc., which we wouldn't for reference use.
- **No enterprise/restricted package exists in the tree, at any granularity** — verified by
  grepping for `enterprise`, `ee/`, `LICENSE_KEY`, `licenseKey` across the whole repo (Section 0).
  This is the cleanest license story of the five repos analyzed in this survey so far.
- **The actual Cloud/self-hosted split is operational, not legal**, and it's worth stating
  precisely because it's a new pattern for this survey:
  - `isCloud()` (`apps/webapp/app/services/platform.v3.server.ts:1003`) checks `env.LOGIN_ORIGIN`
    against three hardcoded Trigger.dev–owned hostnames. Its only two call sites gate **billing
    integration wiring** (`platform.v3.server.ts:50`) and a post-project-creation hook
    (`projectCreated.server.ts:15`) — neither touches task execution, queueing, or checkpointing.
  - The actual limitation is **infrastructure, not code**: checkpoint/restore
    (`apps/coordinator/src/checkpointer.ts`) needs `docker checkpoint` (Docker's own experimental,
    largely-unmaintained feature, gated behind `testDockerCheckpoint()` at
    `checkpointer.ts:139-146`) or CRIU-backed CRI-O checkpointing via `crictl`/`buildah` in
    Kubernetes mode (`checkpointer.ts:501-574`). `docs/self-hosting/overview.mdx:36-43` documents
    this plainly: self-hosted users get **blocking waits** (the runner container/pod holds its
    resources for the full delay) instead of **non-blocking waits** (Cloud checkpoints the process
    out, releases the machine, and restores it later, per
    `checkpointSystem.ts:195-201`/`239` releasing `runQueue` concurrency on checkpoint).
  - **Net effect for anyone lifting this code:** all of it is available, none of it is
    functionally free to run yourself — the value of the flagship mechanism is inseparable from
    infrastructure (a container registry, `buildah`/`crictl`, CRIU-capable kernels/CRI-O) that
    Trigger.dev Cloud operates and a typical self-hoster does not.

## Behavioral sections

### 1. HTTP/API surface

Served entirely by **Remix** route modules under `apps/webapp/app/routes/` — no separate Fastify
or Express layer (unlike Dittofeed). File-based routing gives literal, greppable paths:
**96 `api.v1.*` route files + 6 `api.v2.*`** (enumerated from source; cbm `Route` nodes are
unusable here, Section 0). Families: `deployments.*` (build/deploy lifecycle, 8 routes),
`orgs.*`/`projects.$projectRef.*` (resource CRUD + branches + alert channels), `batches.*`,
`errors.*` (error triage: resolve/ignore/unresolve), `auth.jwt.*` (short-lived JWTs for realtime
subscriptions), `packets.$` (large payload streaming), `mock.ts` (sandbox/testing endpoint). Auth
is **Personal Access Tokens** and **Organization Access Tokens**
(`apps/webapp/app/services/personalAccessToken.server.ts`,
`organizationAccessToken.server.ts`), validated centrally in `apiAuth.server.ts`; project-scoped
public/secret API keys gate the ingest/trigger surface. A separate `admin/api/v1/*` surface
(referenced from `apps/supervisor/README.md:16`) manages worker-group tokens — a distinct,
higher-privilege admin plane from the per-project API. No GraphQL; realtime updates ride
Socket.IO-style channels (87 `Channel` nodes, `LISTENS_ON`/`EMITS` edges) plus ElectricSQL sync
for dashboard tables.

### 2. The durable execution model, traced end to end

**There is no single "durable execution engine" — there are three cooperating layers, and only
the third one is genuinely OS-durable.**

**Layer 1 — the state machine (always active, Postgres-only).** Every run is a `TaskRun` row
(`internal-packages/database/prisma/schema.prisma:880`) whose *execution* state is tracked by an
**append-only linked list** of `TaskRunExecutionSnapshot` rows
(`schema.prisma:1208`), each pointing to `previousSnapshotId`
(`executionSnapshotSystem.ts:332-403`, `createExecutionSnapshot`). `TaskRunExecutionStatus` is an
explicit enum machine: `RUN_CREATED → QUEUED → (QUEUED_EXECUTING) → PENDING_EXECUTING → EXECUTING
→ (EXECUTING_WITH_WAITPOINTS) → SUSPENDED → ... → FINISHED`, handled exhaustively via
`assertNever` in every consumer (`waitpointSystem.ts:891-893`,
`internal-packages/run-engine/src/engine/index.ts` heartbeat handler). Reading the latest snapshot
(`getLatestExecutionSnapshot`, `executionSnapshotSystem.ts:158-176`) is how *every* system
(waitpoint, checkpoint, dequeue) decides what to do next — this snapshot chain is functionally an
audit log/event-sourcing-lite of the run's life, but nothing replays it; each system just reads
the latest row and acts.

**Layer 2 — the durable clock (Redis-backed, survives process/webapp restarts, does not survive
losing Redis).** "Wake me up later" is implemented as a **plain scheduled job**, not a language
timer: `WaitpointSystem.createDateTimeWaitpoint` inserts a `Waitpoint` row
(`type: "DATETIME"`, `completedAfter`, `waitpointSystem.ts:180-257`) and enqueues a
`finishWaitpoint` job at `availableAt: completedAfter`
(`waitpointSystem.ts:249-254`) into the generic `@trigger.dev/redis-worker` queue
(`SimpleQueue`, `packages/redis-worker/src/queue.ts:90-141`). That queue is a Redis
**ZSET-scored-by-timestamp + Hash-for-payload** structure with atomic Lua-scripted
enqueue/dequeue (`queue.ts:440-521`) — the schedule lives in Redis, not in any Node process's
memory, so a webapp restart, a supervisor crash, or a deploy does not lose the wakeup. `blockRunWithWaitpoint`
(`waitpointSystem.ts:386-526`) is the pause primitive: it inserts `TaskRunWaitpoint` join rows
inside a CTE and, in a **separate** follow-up `SELECT` (the code has an explicit, well-reasoned
comment at `waitpointSystem.ts:370-385` about why two statements are required under Postgres
READ COMMITTED MVCC — a concurrent `completeWaitpoint` commit between the CTE and a naive combined
check could be missed), decides whether the run is still blocked. When the last blocking
waitpoint completes, `completeWaitpoint` (`waitpointSystem.ts:72-174`) enqueues
`continueRunIfUnblocked` (debounced via a fixed job id, `waitpointSystem.ts:139,516`), which
re-examines the snapshot and either re-enqueues the run (if it was `SUSPENDED`,
`waitpointSystem.ts:866-881`) or just notifies the still-live worker (if it never actually
stopped executing, `EXECUTING_WITH_WAITPOINTS`, `waitpointSystem.ts:798-839`).

**Layer 3 — the actual process freeze (Cloud-only, OS/container-level, the genuinely novel
piece).** When a run needs to *actually* stop consuming a machine during a wait (rather than
just being logically blocked while the process keeps running), the coordinator checkpoints the
whole container: Docker mode calls `docker checkpoint create --leave-running`
(`apps/coordinator/src/checkpointer.ts:649-657`); Kubernetes/CRI-O mode calls `crictl checkpoint`
then wraps the resulting archive into a scratch OCI image via `buildah from/add/config/commit` and
pushes it to a registry (`checkpointer.ts:507-566`). What's persisted at the suspension point:
- **In Postgres:** a `TaskRunCheckpoint` row (`schema.prisma:1292`) with `type`, `location`
  (local export path in Docker mode) or `imageRef` (pushed registry image in Kubernetes mode) —
  `checkpointSystem.ts:163-173`. This is a **pointer only**.
- **Outside Postgres:** the actual frozen bytes — a CRIU checkpoint archive on local disk (Docker
  simulation mode) or a container image in an OCI registry (Kubernetes/production mode). This is
  where the real process memory, open file descriptors, and call stack live.
- The run's `TaskRunExecutionSnapshot` transitions to `SUSPENDED`
  (`checkpointSystem.ts:211-231`), and **concurrency is released immediately**
  (`runQueue.releaseAllConcurrency`, `checkpointSystem.ts:200-201,238-239`) — the whole point of
  checkpointing is that a suspended run no longer occupies a worker slot.
- **Resume** (`continueRunExecution`, `checkpointSystem.ts:254-367`) validates the snapshot is
  still the latest and in a `PENDING_EXECUTING`-family state, transitions to `EXECUTING`, and
  notifies the worker over the event bus (`sendNotificationToWorker`) — the actual container
  restore (pulling the checkpoint image, running `crictl`/Docker restore) happens on the
  supervisor/provider side, outside run-engine's transactional boundary.

**Why this matters architecturally:** Layers 1–2 give you *logical* pause/resume for free
(no infra beyond Postgres+Redis, which the platform needs anyway) — good enough for `wait.for` on
a small deployment where holding a container for the wait duration is acceptable. Layer 3 is what
turns that logical pause into a *resource-releasing* one, and it's the layer that's Cloud-only.
This is the single most important structural fact for our decision: **the free, portable part of
this design (relational state machine + Redis-scheduled wakeup) covers 90% of what a marketing
journey needs; the expensive, non-portable part (checkpoint/restore) exists purely to let
Trigger.dev multiplex someone else's arbitrary CPU-bound code cheaply, a problem we don't have.**

### 3. How `wait`/`delay` actually works — and the Temporal comparison

Two distinct temporal primitives exist, plus a third for recurring triggers:

- **`triggerAndWait`/scheduled start** (`DelayedRunSystem`,
  `internal-packages/run-engine/src/engine/systems/delayedRunSystem.ts:22-84`) — a run created
  with a future `delayUntil` sits in a `DELAYED` execution status until that time; it's a
  first-class run state, not a waitpoint.
- **`wait.for`/`wait.until` mid-run** — the `Waitpoint` mechanism from Section 2: a Postgres row
  + a Redis-scheduled `finishWaitpoint` job. The SDK entry points live at
  `packages/trigger-sdk/src/v3/wait.ts` and `packages/core/src/v3/wait-until-api.ts`.
- **Recurring schedules** (cron) — `internal-packages/schedule-engine`, a separate package
  (`scheduleCalculation.ts`, `distributedScheduling.ts`) driving the `TaskSchedule`/
  `TaskScheduleInstance` models (`schema.prisma:2219`, `2276`); orthogonal to both of the above.

**Explicit comparison to Temporal:**

| | Temporal | trigger.dev |
|---|---|---|
| Durability mechanism | Deterministic replay of workflow code from an authoritative event history the server owns | (a) relational state machine, (b) Redis-scheduled wakeup jobs, (c) OS/container checkpoint for the actual paused process |
| Code constraint | Workflow code must be deterministic; side effects go through Activities | **None** — the checkpointed process can run arbitrary, non-deterministic Node.js; that's the whole selling point |
| What survives a crash | The event history (server-side), replayed on any worker | Layers 1–2 always; Layer 3 (actual frozen memory) only where checkpoint infra exists |
| Infra cost | A Temporal server (or Temporal Cloud) + its own persistence | Postgres + Redis always; **+ container registry + CRIU/buildah/crictl** for the resource-releasing case |
| Self-hosted parity | Full — same engine locally or in Temporal Cloud | **Explicitly reduced** — self-hosted waits are documented as blocking (`docs/self-hosting/overview.mdx:38`) |

The practical upshot: Temporal's approach is *uniformly* durable and infra-light on the workflow
author's side but demands deterministic code and a dedicated server. trigger.dev's approach lets
you write completely ordinary async code, but its durability is a **spectrum** — free/logical at
the low end, expensive/resource-releasing at the high end — and the expensive end is the part
Trigger.dev doesn't give away. Neither approach was designed for a small number of coarse-grained
journey steps; both are heavier than that problem needs (see Section 10).

### 4. The queue and worker model

Two independent systems, easy to conflate, serving different purposes:

- **Run dispatch (task-run → runner capacity):** `internal-packages/run-engine/src/run-queue/`
  with its own `FairQueueSelectionStrategy`
  (`fairQueueSelectionStrategy.ts:92-628`). Queues are Redis ZSETs keyed by
  org/env/project (`#allChildQueuesByScore`, `:526-561`, a `ZRANGEBYSCORE` on the parent queue).
  Fairness is a **weighted shuffle**, not strict FIFO: environments are shuffled with optional
  bias toward higher concurrency limits or more available capacity
  (`#shuffleQueuesByEnv`, `:170-209`), and within an environment, queue order can blend strict
  age-ordering with randomization (`#weightedRandomQueueOrder`, `:268-316`) — both biases default
  to `0` (pure random shuffle across envs, strict oldest-first within an env). Per-environment
  concurrency limits are enforced by filtering out envs already at their Redis-tracked current
  concurrency (`#getEnvConcurrency`, `:504-524`, backed by `SCARD` on a per-env "current" set).
  This system has **very low external fan-in** — only `run-engine/src/engine/index.ts` and one
  test import it — it exists solely to answer "which task-run gets a runner next."
- **Generic durable jobs (everything else):** `@trigger.dev/redis-worker`'s `SimpleQueue`
  (Section 2/3) is imported from **30+ call sites** across the webapp (webhook delivery,
  batch-trigger orchestration, billing-limit checks, alerts, admin jobs, the `mollifier`
  subsystem — an outbox-style buffered-mutation pattern for run metadata,
  `apps/webapp/app/v3/mollifier/*`). It also contains its **own**, separately-evolved fair-tenant
  dispatcher (`packages/redis-worker/src/fair-queue/`, 1,934-line `index.ts`) implementing
  **Deficit Round Robin** (`schedulers/drr.ts:1-25` — quantum-based credit accumulation per
  tenant, capped to prevent starvation), plus round-robin and weighted alternatives
  (`schedulers/roundRobin.ts`, `schedulers/weighted.ts`). This is a more general and more
  recently-built fairness engine than run-engine's bespoke weighted-shuffle strategy, used for
  the generic job fleet, not for task-run dispatch itself — evidence of an in-flight
  architectural evolution rather than a single unified fairness layer.
- Both layers ultimately rely on the same low-level primitive: a Redis ZSET scored by
  availability time, with a **visibility-timeout** re-scoring on dequeue
  (`queue.ts:496-517`, classic SQS-style invisibility window) so a crashed consumer's in-flight
  item becomes re-claimable automatically.

### 5. Failure handling

**Per-run retry policy** (`internal-packages/run-engine/src/engine/retrying.ts:47-183`,
`retryOutcomeFromCompletion`): classifies the terminal error — cancellation short-circuits to
`cancel_run`; an OOM error attempts a bigger-machine retry if the task's retry config specifies
one (`retryOOMOnMachine`, `:185-255`), else fails; a non-retriable error class
(`shouldRetryError`) fails immediately; `MAX_TASK_RUN_ATTEMPTS = 250`
(`consts.ts:1`) and the task's own `maxAttempts` both cap retry count; backoff delay comes from
`calculateNextRetryDelay` against the task's configured `RetryOptions`.

**Worker/machine death mid-attempt — the dead-man's-switch pattern**
(`internal-packages/run-engine/src/engine/index.ts:2377-2658`, `#handleStalledSnapshot`): every
snapshot transition that expects a live worker to keep proving liveness schedules a
`heartbeatSnapshot` job at an interval keyed by execution status
(`executionSnapshotSystem.ts:407-415`, `#getHeartbeatIntervalMs:545-566`); a legitimate heartbeat
call reschedules it forward (`heartbeatRun`, `executionSnapshotSystem.ts:436-491`). If the
heartbeat job actually fires, the worker is presumed dead, and recovery is
**state-specific**: `PENDING_EXECUTING` (never actually started) → bounded requeue via
`tryNackAndRequeue` (`index.ts:2452-2470`); `EXECUTING`/`EXECUTING_WITH_WAITPOINTS` → treated as a
stall, with **production and dev environments handled differently** — dev (CLI) stalls are
assumed to be a disconnected `trigger dev` process and are *not* retried
(`index.ts:2487-2493`), production stalls are retried and can optionally be reclassified as an
OOM kill via `treatProductionExecutionStallsAsOOM` (`index.ts:2507-2517`); `SUSPENDED` → retries
`continueRunIfUnblocked` with **exponential backoff up to 12 attempts over 6 hours**
(`index.ts:2581-2629`, configurable via `suspendedHeartbeatRetriesConfig`) before giving up;
`PENDING_CANCEL` → force-cancels (`index.ts:2642-2646`). There is no named "poison run" concept,
but `MAX_TASK_RUN_ATTEMPTS` + the bounded stall-retry counts serve that role functionally.

**Generic job failures** (redis-worker layer): visibility-timeout expiry makes a crashed
consumer's item reclaimable; explicit failures re-enqueue with `calculateNextRetryDelay`-computed
backoff (`worker.ts:789-871`); exhausted retries move to a **real dead-letter queue** with
`moveToDeadLetterQueue`/`redriveFromDeadLetterQueue` (`queue.ts:364-434`, Lua-scripted, atomic).

### 6. Isolation

**Trust boundary = the container/pod, nothing finer-grained.** Each deployed project ships its
own Docker image (built by `trigger deploy`); each task-run attempt executes inside a dedicated
Docker container (`apps/docker-provider/src/index.ts`) or Kubernetes Pod
(`apps/supervisor/src/workloadManager/kubernetes.ts`), sized by a machine preset mapped to
resource requests/limits (`kubernetes.ts:135,406-410`, `#getResourcesForMachine`). The
**supervisor** (per-machine daemon) manages the container/pod lifecycle; the **coordinator**
brokers checkpoint requests between the supervisor and run-engine over an internal port
(`COORDINATOR_PORT`, `apps/docker-provider/src/index.ts:15`). I found **no evidence of
finer-grained sandboxing** in this codebase — no gVisor/`runsc`, no seccomp profiles, no explicit
`NetworkPolicy` manifests, no `runAsNonRoot`/`readOnlyRootFilesystem` hardening in the workload
manager (grepped and found none; **flagged as unverified rather than absent** — Kubernetes-native
hardening could live in a Helm chart or the customer's own cluster policy outside this repo, which
I did not have access to). The isolation model is standard container-per-tenant-execution, the
same trust boundary as any container-orchestration platform running third-party code — not a
distinguishing strength of this repo.

### 7. The v3 architecture — which generation is live

**Confirmed via the database schema, not docs:** `RunEngineVersion` is a Prisma enum with `V1`
and `V2` (`internal-packages/database/prisma/schema.prisma:445,545,886,1211`). Column comments
are explicit and unambiguous: `TaskRun.engine` defaults to `V2` with the comment *"This should
always be 2+ (V1 didn't use the run engine or snapshots)"* (`schema.prisma:1211-1212`); another
comment reads *"This is not used from engine v2+, attempts use the TaskRunExecutionSnapshot and
TaskRun"* (`schema.prisma:1635`). `apps/webapp/app/v3/legacyRunEngineWorker.server.ts` exists
specifically to service **V1** runs. **Everything analyzed in Sections 2–5 above is `RunEngineVersion.V2`
— the live, current generation.** V1 (pre-run-engine, no snapshot chain, no waitpoints as
described above) is legacy-only, kept for backward compatibility with old runs, and was not
analyzed further.

Separately, and easy to confuse with the above: the **product** is currently on major version
**4.x** (`packages/trigger-sdk/package.json` → `"version": "4.5.0-rc.7"`), while the **internal
source namespace** for the SDK/protocol is still `v3` (`packages/core/src/v3/`,
`packages/trigger-sdk/src/v3/`) — a naming holdover from an earlier v2→v3 rewrite that the v3→v4
bump didn't rename. `rules/4.3.0/basic-tasks.md:1,3` (an AI-assistant rules file shipped in the
repo) states plainly: *"MUST use `@trigger.dev/sdk`, NEVER `client.defineJob`"* — `defineJob` was
the old (pre-v3) SDK API, confirming it's dead. **Do not describe this repo as "v2" or conflate
the RunEngineVersion V1/V2 pair with the product's v3/v4 SDK generations — they are two
independent version axes.**

### 8. Data model

Prisma schema: **77 models, 46 enums, 78 `Json`-typed columns**, 786 migrations (oldest to
2026-06-26 in-tree). Central models: `TaskRun` (`:880`, the run itself — payload, status,
machine preset, cost/usage accounting), `TaskRunExecutionSnapshot` (`:1208`, the append-only
state-machine log from Section 2), `TaskRunCheckpoint` (`:1292`, pointer-only checkpoint
metadata), `Waitpoint`/`TaskRunWaitpoint`/`WaitpointTag` (`:1323,1410,1442`, the pause primitive),
`WorkerDeployment`/`WorkerDeploymentPromotion` (`:2126,2202`, versioned deploys with staged
promotion), `TaskSchedule`/`TaskScheduleInstance` (`:2219,2276`, cron), `BatchTaskRun`/
`BatchTaskRunItem`/`BatchTaskRunError` (`:1870,1955,1986`, fan-out batch triggering),
`BulkActionGroup`/`BulkActionItem` (`:2478,2553`, bulk run mutation with dedup keys), `RBAC`
(separate package, `internal-packages/rbac`). `TaskEvent` (`:1696`, trace spans/log lines) exists
**both** as a Postgres model and as a ClickHouse table family fed by `otlp-importer`
(`internal-packages/clickhouse/src/taskEvents.ts`) — I could not fully trace which is authoritative
at scale within budget; treat this as a Postgres-for-recent/ClickHouse-for-volume split, similar
in shape to Dittofeed's Postgres/ClickHouse assignment split, and flag it as **unverified** rather
than assert it confidently. `internal-packages/tsql` (1,749 cbm nodes, ANTLR-based) is a bespoke
query language compiled to Postgres/ClickHouse SQL for the dashboard's run/log filter UI — a
surprisingly large investment for what looks like a filter bar.

### 9. Operational footprint

The self-hosting docs describe "two scalable parts: webapp, worker" (`overview.mdx:25-28`), but
the actual docker-compose service list (`docker/docker-compose.yml`) is considerably heavier:
**Postgres (primary + replica), Redis, MinIO (S3-compatible object storage), ClickHouse (+ a
separate migrator container), ElectricSQL (Postgres logical-replication sync service)** — six
stateful services minimum — plus the webapp container itself, and, on the worker side, the
supervisor + coordinator + one runner container/pod per concurrent task attempt, and (for
checkpoint support) a container registry plus CRIU-capable CRI-O/Kubernetes or Docker
experimental-checkpoint. This is a **substantial multi-service deployment** even before running a
single customer task — realistic only as a dedicated platform, not as an embedded component of
another application. Be honest about this when it comes up in Section 10: nothing about this
footprint fits inside a Next.js server process or an Electron app's bundled resources.

### 10. Reimplementation notes

| Section | Port / Adapt / Skip |
|---|---|
| 1. HTTP/API | **Skip** — shaped for multi-tenant SaaS admin, not applicable |
| 2. Execution state machine (snapshot chain) | **Adapt** — the *pattern* (append-only status log with a `previousSnapshotId` chain) is a cheap, valuable idea for any long-running process we build; don't port the 2,954-line `engine/index.ts` |
| 3. Wait/delay (Waitpoint + durable job) | **Adapt** — port the *idea*: a `waitpoint` row + a durable scheduled job, backed by whatever job queue we already have (or SQLite for Electron) |
| 3. Checkpoint/restore | **Skip, explicitly** — wrong problem (arbitrary code resumption), wrong cost (registry + CRIU/buildah), wrong availability (Cloud-only even for its own vendor) |
| 4. run-queue fairness / redis-worker DRR | **Skip** — built for multi-tenant SaaS fairness at a scale and trust level we don't have |
| 5. Heartbeat/dead-man's-switch | **Adapt** — small, generically useful pattern for detecting an abandoned background job, independent of everything else here |
| 6. Container isolation | **Skip** — not our threat model; we're not running other people's code |
| 8. Data model | **Skip** — 77-model schema for a job-execution SaaS; irrelevant shape |
| 9. Operational footprint | **Skip, as a warning** — six-plus stateful services is the clearest signal this is the wrong substrate for an embedded journey engine |

**The central question: what is the cheapest honest way to get durable journey execution in a
Next/Electron app?** Three options, ranked:

1. **(Recommended) A small, home-grown step interpreter + a durable job table.** Model a journey
   as data — a JSON graph of typed nodes, directly modeled on Dittofeed's proven 9-node taxonomy
   (`entry/delay/wait-for/split/message/exit/random-cohort`, see
   `dittofeed-architecture.md`) — and interpret it with our own small runtime function that is
   re-entered per step. "Resume later" is a row in a `scheduled_steps` table (SQLite for
   Electron, Postgres for the Next server) with a `run_at` timestamp, drained by a poller — this
   is exactly trigger.dev's Layers 1–2 (Section 2) minus Redis, minus run-engine, minus
   checkpointing, because a journey step doesn't need to resume an arbitrary call stack, only to
   be re-invoked with saved step-state. **Cost:** a few hundred lines we own and fully understand.
   **Buys:** durability across app restarts for exactly the operations a journey needs
   (delay, wait-for, branch, send, retry), no new infrastructure, no determinism constraints
   because there's no code to replay — just data. This is the same conclusion the Dittofeed
   analysis reached independently ("port the idea, not the code"); trigger.dev's existence
   *strengthens* that conclusion by showing what the next tier of investment (real OS-level
   process durability) actually costs, and confirming a journey engine doesn't need that tier.
2. **Adopt a managed durable-execution service (Temporal Cloud, or a lighter hosted engine like
   Inngest/Restate/DBOS).** Buys battle-tested durability, exactly-once semantics, and a real
   dashboard/observability story for free. Costs a new always-on external dependency and vendor
   relationship, awkward for an Electron app that should work offline/standalone, and is
   disproportionate machinery for what is, per Dittofeed's own numbers, a handful of node types
   and a recompute loop. Reasonable if journeys need to scale far beyond what our own interpreter
   could handle reliably, but that hasn't been demonstrated as a requirement yet.
3. **Port trigger.dev's actual machinery (run-engine, redis-worker, checkpointing).** **Reject.**
   Wrong shape (a multi-tenant arbitrary-code execution platform) solving a problem we don't have
   (sandboxing other people's containers), at a cost (six-plus stateful services, CRIU/registry
   tooling) we can't justify for an in-process journey feature. Even trigger.dev's own vendor
   doesn't give this tier away for free to its self-hosted users — that alone is a strong signal
   it's not a "cheap" answer for anyone.

**Answer: Option 1.** A well-argued "don't port any of trigger.dev's code" is the right call here;
the two ideas worth carrying forward (durable-row-plus-scheduled-job for waits, and an
append-only status log for auditability) are small enough to just re-derive rather than adapt
from source.

## What's good

- **The Layer 1/2 split (Section 2) is a genuinely elegant, cheap durability design** for the 90%
  case — no team should have to invent "a row plus a scheduled job" from scratch, and seeing it
  done carefully (the READ-COMMITTED race-condition comment at `waitpointSystem.ts:370-385` is a
  good example of real production hardening) is valuable independent of whether we port any code.
- **The heartbeat/dead-man's-switch pattern (Section 5) is a clean, reusable idea**, with
  thoughtful special-casing (dev vs. prod stall handling, escalating backoff capped at 6 hours)
  that reflects real operational experience.
- **Exhaustiveness discipline** — `assertNever` used consistently on the execution-status
  discriminated union, the same pattern Dittofeed uses on its journey-node union. A team that
  cares about not silently dropping a new enum case in two different repos independently reached
  for the same tool.
- **Clean, one-way package layering** with `core` as a genuinely shared, low-fan-out hub — no
  surprises in the dependency graph.

## What's weak

- **Two fairness/dispatch systems doing overlapping jobs** (Section 4) — run-engine's bespoke
  weighted-shuffle strategy and redis-worker's newer DRR-based fair-queue submodule are not the
  same code, are not obviously reconciled, and a reader has to work out which one governs task-run
  dispatch (it's the older one) versus generic background jobs (the newer one). Mid-migration
  architecture, not a finished design.
- **The flagship durability feature is not actually available to most deployments of this
  software** (Section 0/License) — a self-hosting user reading "durable execution" marketing
  copy would reasonably assume checkpoint/resume works locally; it doesn't, by the vendor's own
  documentation. This is worth remembering as a cautionary framing example, not just a technical
  fact: "durable" claims should specify which layer they mean.
- **`TaskEvent`'s Postgres-vs-ClickHouse authority is unclear from the code alone** (Section 8) —
  a real gap in my own analysis, not just the repo's; flagged rather than guessed at.
- **Operational weight (Section 9)** is high for what, from a marketing-journey-engine
  perspective, is a much simpler underlying requirement.

## Two-tool cross-check (cbm vs graphify) and tool calibration

**Graphify did not complete in the analysis window** — `graphify update .` was started early and
was still running (only a `.rebuild.lock` and a partial AST cache present, no `graph.json`) after
the full remainder of this analysis was completed by other means. Per instructions not to retry a
merely-slow command, I did not re-run or force it; cbm alone was sufficient for every structural
question this analysis needed. **No graphify-derived cycle-detection or community-report data is
in this document** — that is a real gap, not an oversight, and should be filled by re-reading
`graphify-out/graph.json` (once it exists) before this document is treated as final on structural
questions like import cycles.

**Tool calibration notes (cbm only, this repo):**

1. **`Route` nodes are unusable for a Remix app** (Section 0) — the fourth routing convention
   this survey has hit where cbm's Route extraction misfires (after two Rails misses, one clean
   Fastify hit on Dittofeed, and this Remix miss). Route usability is a function of the specific
   framework's routing convention, confirmed **per-framework, not just per-language** — Fastify
   and Remix are both TypeScript, and only one produced usable Route nodes.
   `get_architecture(aspects:["routes"])` returned non-HTTP event names (`"SIGTERM"`,
   `"heartbeat"`) with empty `method`; source enumeration (`find ... -iname "api.v1*"`) was the
   only reliable path.
2. **cbm's `packages` fan-in/fan-out fields were all reported as `0`** in
   `get_architecture(aspects:["packages"])` for this repo (every package row shows
   `"fan_in":0,"fan_out":0`) despite the `boundaries` aspect correctly reporting non-zero
   cross-package call counts in the same response. Use `boundaries`, not `packages`, for
   dependency-direction questions on this repo — a **new** trap, not previously documented for
   this tool.
3. Cost: cbm indexing took a few minutes for 28,180 nodes/93,802 edges (`moderate` mode,
   28 excluded test/fixture/generated directories, `index_repository` output above) — no LLM
   calls, no cost beyond compute. Consistent with prior repos in this survey.

## Reproducing / refreshing this analysis

- **codebase-memory-mcp:** project `trigger-dev`, indexed 2026-09-06/07 in `moderate` mode at
  commit `7851f5ca`. Re-run: `index_repository({repo_path: ".../trigger.dev", mode: "moderate",
  name: "trigger-dev"})`.
- **graphify:** `cd /Users/la/Programming/OSS-Marketing-Repos/trigger.dev && graphify update .`
  (no `--no-viz` — not a valid flag on `update`, confirmed by this brief and by the prior
  Dittofeed run). **This did not finish during this analysis** — budget extra wall-clock time on
  a repo this size (4,658 files) or run it well ahead of when its output is needed.
