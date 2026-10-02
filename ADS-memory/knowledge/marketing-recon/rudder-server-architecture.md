# RudderStack Server Architecture — Reference Analysis

> Reference-only analysis of upstream `rudder-server`, done to decide **what to port** into
> the Open Design–based Open Marketing repo. This is infrastructure — a customer-data-platform
> event pipeline — not a marketing application. It is reference material for *patterns and
> guarantees*, not a source to copy wholesale.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/rudder-server` (clone of
>   `github.com/rudderlabs/rudder-server`, analyzed at commit `11c9ab8b`, 2026-06-30)
> - **Tools:** codebase-memory-mcp (project `rudder-server`, moderate mode) + graphify
>   (`graphify-out/`, Tree-sitter, no LLM) + direct source reads (`rg`/`Read`). Two independent
>   graph engines plus exhaustive manual tracing of the four core subsystems.
> - **Date:** 2026-09-06

## Section 0 — Premise corrections and self-corrections

**Corrections to the dispatch brief:**

1. **The whole repository is Elastic License 2.0 (ELv2), not MIT.** `LICENSE:1` and
   `enterprise/LICENSE:1` are byte-identical ELv2 text. This was not flagged in the brief and
   is not a minor detail: unlike Chatwoot (MIT core + separately-licensed `enterprise/`) or
   Dittofeed (MIT throughout), **every line of rudder-server, including `enterprise/`, carries
   the same source-available-but-restrictive license.** ELv2 permits reading, copying, and
   preparing derivative works; it forbids offering the software as a hosted/managed multi-tenant
   service and forbids removing license/copyright notices. It does not, on its face, prohibit
   learning from the design and reimplementing ideas independently — which is exactly the
   "patterns, not features" posture this whole report set already takes — but no code should
   be copied verbatim into Open Marketing, and this constraint is stricter than every other
   repo analyzed in this set so far. Treat every "port" recommendation below as **pattern-level
   only, clean-room reimplementation, never literal copy**.
2. **The brief's implicit "how does it avoid double-delivery" framing assumes row-level
   locking (e.g. `SELECT ... FOR UPDATE SKIP LOCKED`), the mechanism most Postgres-backed queues
   use. rudder-server has none.** `grep -rn "FOR UPDATE\|SKIP LOCKED" jobsdb/*.go` returns zero
   matches outside `_test.go`. The real mechanism, found only by tracing the read path
   (`jobsdb/jobsdb_get.go:343-674`) against the write path (`router/handle.go:250-357`), is
   structural: reads never mutate state, and exactly one goroutine owns each job partition
   (enforced by `router/isolation/isolation.go:17-46`'s three isolation modes), so there is never
   a second reader to race against. This is a materially different — and cheaper — durability
   design than the SKIP LOCKED pattern, detailed in Section 3 below.
3. **cbm's complexity/loop metrics are confirmed non-zero and rich on Go — except
   `cyclomatic`.** This was an open question in the brief ("Unverified on Go"). Answer:
   `cognitive`, `loop_depth`, and `transitive_loop_depth` are all populated across every
   package sampled
   (jobsdb, router, warehouse, gateway, processor). **Corrected on review by the coordinator:
   this document originally also claimed `cyclomatic` was populated on Go. It is not —
   `RETURN f.cyclomatic` returns an empty string for every Go function in this project, and
   the same holds on the `listmonk` Go project. Only `cognitive` and the loop family work on
   Go. Do not cite `cyclomatic` for a Go target.** Verified with
   `MATCH (f:Method) ... RETURN toInteger(f.cognitive) AS cog ... ORDER BY cog DESC` returning
   real, varied values (e.g. `router.process` cognitive **161**, `jobsdb/jobsdb.go`-family
   functions in the 1-19 range). See Section "Tool calibration" for the full readout.
4. **cbm `Route` nodes are unusable here — more severely than on either prior repo.** All 141
   `Route` nodes return a populated `method` but an **empty string** for `path`, `file_path`,
   `handler`, and `service` (`query_graph` sample, 30/141 rows, all identical shape). The real
   HTTP surface had to be read directly from `gateway/handle_lifecycle.go:570-668`, which uses
   `go-chi/chi` route registration — cbm's Route extractor apparently does not resolve chi's
   `r.Post("/path", handler)` call pattern into anything but the HTTP verb literal.
5. **graphify's "God Nodes" list is dominated by name-collision artifacts**, confirming the
   brief's suspicion for this repo too. Its own `graph.json` shows the label `Handle` collapses
   **69** distinct qualified nodes (one per package that defines a `Handle` struct — jobsdb,
   gateway, router, processor, batchrouter, warehouse, etc.) into a single 91-edge "hub"; `Call`
   collapses **57** nodes; `UploadJob` collapses **11**. Only `Clickhouse` (60 edges,
   `warehouse/integrations/clickhouse/clickhouse.go`), `DestinationID` (55 edges,
   `processor/`), `Pointer` (83 edges), and `CloseResponse()` (77 edges,
   `utils/httputil/`) in the top-10 are genuinely single entities. **Do not quote a graphify
   god-node number without checking node-id cardinality first** (`python3 -c` against
   `graph.json`, shown in "Reproducing" below).
6. **cbm `hotspots` fan-in is the same name-collision noise found on Chatwoot, and it is worse
   here.** The top 10 `get_architecture` hotspots are `Equal` (763), `Errorf` (326), `string`
   (311), `Load` (221), `Unlock` (204), `Set` (201), `Scan` (191), `Now` (184), `Go` (157),
   `RUnlock` (151) — every one of these is a common Go method name (`sync.RWMutex.Unlock`,
   `time.Now`, `fmt.Errorf`, `stats.Set`) collapsed across the whole codebase, not one
   overloaded chokepoint. None of these numbers appear in this report as real fan-in.
7. **A genuinely new cbm trap, not documented on the prior two repos:**
   `sum(toInteger(f.cognitive))` **silently returns `0`** instead of erroring or summing
   correctly (verified: `MATCH (f:Function) RETURN sum(toInteger(f.cognitive)) AS total_cog,
   count(f) AS n` returns a single column `0`, dropping `n` entirely and zeroing the sum).
   Plain `count(f) AS n` works correctly (returned `3327`, matching `get_architecture`'s
   Function count exactly). **Do not trust aggregate arithmetic over cast properties in this
   cbm version — sample and sort per-row instead**, which is the pattern used throughout this
   report.
8. **The `ORDER BY toInteger()` projection trap and the "function calls in `WHERE` are
   unsupported" trap from the Dittofeed run both reconfirmed here** — `WHERE
   toInteger(f.cognitive) > 30` fails with `unexpected operator at pos 34`, identical failure
   mode to both prior repos. No new information, but the pattern holds a third time — treat it
   as a stable cbm-wide limitation, not a per-repo fluke.

No other premise in the dispatch brief required correction; the jobsdb/gateway/router/
throttler tracing in Sections 2-5 below confirmed the brief's structural hypotheses (jobsdb is
the single most valuable subsystem; routing/retry policy is per-destination-configurable).

## TL;DR

- **Two ratings, because they diverge — though less sharply than Chatwoot or Dittofeed.**
  **Code quality: 8/10.** A mature, heavily-tested (2,681-line `jobsdb_test.go` alone), heavily
  instrumented (364 call sites into the shared `stats.Stats` facade, span-based tracing through
  gateway→processor→router) production pipeline with disciplined package boundaries and several
  genuinely elegant reliability patterns (isolation-mode strategy, ordering barrier with
  self-disabling under load, factory-gated enterprise features). Debt is real but concentrated:
  a handful of very large orchestration functions (`router.process` cognitive 161,
  `warehouse.slave.processSingleStagingFile` 142) rather than systemic rot.
  **Marketing port value: 4/10.** This is not a marketing platform and does not pretend to be
  one — there is no contact, campaign, segment, journey, or template concept anywhere in the
  1,151-Go-file tree. It moves "events" to "destinations." Its value is entirely in *transport
  patterns* (durable queue, retry/backoff, throttling, ordering, circuit-breaking) that Open
  Marketing will eventually need for its own destination-delivery layer — genuinely useful,
  but there is nothing here shaped like a marketing feature to lift.
- **The crown jewel is `jobsdb`** (`jobsdb/`, 16,329 lines across 30 files) — a
  Postgres-backed, dataset-partitioned job store that gets its double-delivery guarantee from
  **structural single-ownership of partitions**, not row locks. No `SELECT ... FOR UPDATE`
  anywhere in it. This is the single most portable idea in the repo, and it is stack-independent.
- **Licensing is the headline constraint, and it's a different shape than Chatwoot's.** The
  *entire* repository — core and `enterprise/` alike — is ELv2 (see Section 0). There is no
  MIT tier to lift code from wholesale, only patterns to reimplement clean-room.
- **The transformation "sandbox" is externalized, and this repo has zero visibility into it.**
  User-supplied JS/Python transformation code never runs in this Go process — it is dispatched
  over HTTP to a separate transformer service, with Python transforms additionally isolated
  per-workspace by process/pod (`http://pyt-{workspaceID}:8080`,
  `processor/internal/transformer/user_transformer/user_transformer.go:56`). Whatever sandboxing
  exists lives in a different repository entirely.

## What it is

A **Go 1.2x monolith-with-optional-service-split** (three deployment modes compiled from the
same binary — `app/apphandlers/{embeddedAppHandler,gatewayAppHandler,processorAppHandler}.go`),
Postgres for durable job storage, Redis for distributed rate limiting, and an external Node.js
transformer service for destination-specific and user-supplied transformations. 1,151 tracked
`.go` files, 328,414 Go LOC (`git ls-files | grep .go | xargs wc -l`). cbm indexed 12,080 nodes /
82,144 edges (moderate mode, auto-excluding 50 vendor/testdata dirs); graphify indexed 16,397
nodes / 29,473 edges / 1,197 communities (971 shown, 226 thin omitted), 84% EXTRACTED / 16%
INFERRED at avg confidence 0.8.

### The pipeline, package by package

| Package | Role | Approx. size |
|---|---|---|
| `gateway/` | HTTP ingestion — auth, validation, batching, durable write | ~2,000 LOC core + tests |
| `jobsdb/` | Postgres-backed durable job queue, shared by every stage | 16,329 LOC |
| `processor/` | Reads gateway jobs, dispatches to transformer(s), writes router jobs | large; pipelined worker pool |
| `router/` | Per-destination-type delivery workers — sync HTTP destinations | 41 files under `router/` |
| `router/batchrouter/` | Batch/async destinations (bulk upload APIs, warehouses) | 23 files |
| `warehouse/` | Data-warehouse loading (Snowflake, BigQuery, Redshift, etc.) | huge — 3 of cbm's top-10 clusters |
| `services/` | Cross-cutting: throttling config, dedup, debugger, archiver, streammanager | 19 subpackages |
| `enterprise/` | Reporting, suppress-user, config-env, tracked-users — same ELv2 license, gated by a runtime `EnterpriseToken`, not by license | 77 files |
| `backend-config/` | Pulls source/destination config from RudderStack's control plane | — |
| `regulation-worker/`, `suppression-backup-service/` | Separate `main.go` binaries for GDPR-style deletion and suppression-list distribution | small, standalone |

cbm's Leiden clustering (`get_architecture` `clusters`) independently confirms this shape: the
top clusters by member count are `services` (859 members, cohesion 0.54), `router` (781, 0.50),
`warehouse` (706, 0.60), `jobsdb` (530, 0.57) — jobsdb earns the tightest cohesion of any
large cluster, consistent with it being a single coherent subsystem rather than a grab-bag.

### Deployment topology

Three modes share one binary and one `jobsdb` abstraction, distinguished by `OwnerType`
(`jobsdb/jobsdb.go:522-546`: `Read` / `Write` / `ReadWrite`):

- **`EMBEDDED`** — gateway, processor, and router all in one process, one Postgres. Self-hosted/
  small-scale default.
- **`GATEWAY`** — ingestion only; opens its jobsdb as `Write`-mostly.
- **`PROCESSOR`** — processor + router; opens the gateway's jobsdb tables as `Read`, its own
  router-facing tables as `ReadWrite`.

This is the actual scaling seam: gateway and processor/router scale independently against the
same Postgres, decoupled entirely by jobsdb's dataset tables — no message broker required for
this hand-off (Kafka appears only as an optional *destination*, not as internal plumbing).

## What's good

- **jobsdb's ownership model eliminates a whole class of bugs by construction.** Because reads
  (`GetJobs`/`GetToProcess`) never mutate state and partitions are owned by exactly one
  goroutine (`router/isolation/isolation.go`), there is no double-claim to defend against, so
  there is no lock contention to tune. Crash recovery is a single boot-time sweep
  (`jobsdb/admin.go:27-37`, `DeleteExecuting`/`FailExecuting`) rather than a lease-expiry
  mechanism.
- **The isolation-mode strategy pattern (`none`/`workspace`/`destination`,
  `router/isolation/isolation.go:17-46`) cleanly separates "how much parallelism" from
  "how delivery works."** Every downstream guarantee (ordering, throttling, retry) is defined
  once and composes correctly regardless of which mode is active.
- **The ordering barrier degrades gracefully instead of deadlocking.**
  `router/internal/eventorder/eventorder.go:26-52` enforces strict in-order delivery per key,
  but auto-disables itself once too many jobs pile up behind one key
  (`WithEventOrderKeyThreshold`), with a timed half-enabled recovery state — ordering is a
  best-effort guarantee that fails open under load rather than one that stalls the pipeline.
- **The enterprise-feature gate is a clean runtime token check, not a directory-presence hack.**
  `app/app.go:54-94` — every enterprise factory (`suppression.Factory`, `reporting.Factory`,
  `configenv.Factory`) takes an `EnterpriseToken` and no-ops without one, compiled in either
  way. Contrast Chatwoot's `enterprise/` being unconditionally eager-loaded regardless of
  license file presence — this is the better-engineered version of the same idea.
- **Backpressure is layered, not monolithic**: pickup-side throttling (don't even read jobs
  faster than a per-destination rate), delivery-side throttling (separately rate-limit the
  actual HTTP call), a circuit breaker (`router/batchrouter/circuitbreaker/circuitbreaker.go`,
  wrapping `sony/gobreaker`) for batch destinations, and per-job exponential backoff
  (`router/misc.go:30-35`) — four independent mechanisms operating at different granularities,
  composable rather than one giant rate limiter trying to do everything.
- **A real, if narrow, embedded fast-path exists alongside the general HTTP transformer
  dispatch.** `processor/internal/transformer/destination_transformer/embedded/{kafka,pubsub,
  warehouse}` run these three high-volume destination formats in-process in pure Go, bypassing
  the HTTP hop to the Node transformer service that every other destination type uses.

## What's weak

### 1. Complexity is concentrated in a few large orchestration functions, not spread evenly
The worst-in-class by cognitive complexity: `router.process` (`router/worker.go`, **161**,
transitive loop depth 17), `warehouse.slave.processSingleStagingFile`
(`warehouse/slave/worker.go`, **142**, tld 10), `jobsdb.bench.scenario.consume`
(`jobsdb/bench/scenario/compaction.go`, **125**), `processor.userTransformAndFilter`
(`processor/processor.go`, **114**), `router.SendPost` (`router/network.go`, **103**). These are
exactly the functions doing the real work of their subsystems (dispatch loop, warehouse staging,
user-transform orchestration, HTTP delivery) — reading them is unavoidable before porting any
of the ideas they implement, but none of them has an internal seam to extract cleanly.

### 2. Two subsystems are large enough to be their own products
`warehouse/` alone spans 3 of cbm's largest Leiden clusters (706 + 486 + 362 = 1,554 combined
members, more than a third of the whole graph) implementing full SQL-warehouse loading for 9
destinations (`bigquery`, `clickhouse`, `snowflake`, `redshift`, `postgres`, `mssql`,
`azure-synapse`, `datalake`, `deltalake`). None of it is relevant to Open Marketing; it exists
because RudderStack is a reverse-ETL/CDP product, not because event delivery requires it.

### 3. cbm's Route and hotspot extraction are unreliable on this codebase (see Section 0)
Both required falling back to direct source reads rather than the graph. This is the third
repo in this set where fan-in hotspots need manual uniqueness verification before quoting.

### 4. Enterprise reporting's actual scope is invisible without an enterprise token
`enterprise/reporting/` (with `error_index`, `event_sampler`, `flusher`, `client` subpackages)
is source-visible but its runtime behavior is gated by `EnterpriseToken` — unlike Dittofeed's
"missing entirely" `packages/ee/`, the code is *here* to read, but whether the OSS build is
functionally complete without a token cannot be verified by reading source alone; the top
complexity hit `enterprise.reporting.mainLoop` (cognitive 81) confirms it is a real, nontrivial
subsystem, not a stub.

### 5. The transformation pipeline's actual sandboxing is unauditable from this repo
As covered in Section 0/TL;DR: user-transform and most destination-transform logic is dispatched
over HTTP to a service this clone does not contain. Anyone evaluating "is user-supplied
transformation code safely isolated" cannot answer that question from `rudder-server` alone.

## Two-tool cross-check (cbm-mcp vs graphify)

cbm: 12,080 nodes / 82,144 edges, 12 Leiden clusters, cohesion 0.43-0.68 (tighter clusters:
`processor` 0.68, `warehouse` 0.60/0.56, `jobsdb` 0.57; looser: `services` 0.43-0.54, `router`
0.45-0.50). graphify: 16,397 nodes / 29,473 edges, 1,197 communities (971 shown, 226 thin
omitted) — a fragmentation level closer to Chatwoot's 2,851/962-singleton result than to
Dittofeed's cleaner 641, consistent with this being a much larger, more service-oriented Go
codebase than either prior target.

- **Agree:** no import cycles (graphify: "None detected" — `graphify-out/GRAPH_REPORT.md:1168`;
  cbm shows no equivalent cycle-detection output, but the DEPENDS_ON/IMPORTS edge shape is
  consistent with a one-way `gateway → jobsdb ← processor → router` flow). Both tools' entry-point
  lists agree on the seven real `main.go` files (`cmd/*/main.go`, root `main.go`,
  `regulation-worker/cmd/main.go`, `suppression-backup-service/cmd/main.go`, plus a benchmark
  harness) — cbm's `entry_points` list matches graphify's file inventory exactly.
- **cbm added:** per-function cognitive and loop-depth metrics (populated and useful on Go —
  but **not** `cyclomatic`, which is empty on Go; see Section 0), 141 `Route` nodes (unusable, per Section 0), Leiden clusters with
  meaningful cohesion scores, `SIMILAR_TO`/`SEMANTICALLY_RELATED` edges (moderate-mode
  similarity, not used further in this report).
- **graphify added:** import-cycle detection (none), a portable committed report
  (`GRAPH_REPORT.md`, 218 KB — too large to read in full; sectioned by header instead), and a
  "Surprising Connections" list that is mostly noise on this repo (inferred test-harness calls
  like `ProcProcessingDelayScenario()` → `StartServer()`, not real architectural insight).
- **Neither tool surfaced the two most important findings in this report** (the lock-free
  claim mechanism in jobsdb, the externalized transformer dispatch) — both required reading
  actual source. This reinforces the standing rule: graph tools narrow *where* to look; they do
  not replace reading the code that matters.

### Tool calibration (carries forward from Chatwoot/Dittofeed; new items marked **NEW**)

1. **cbm complexity/loop metrics: confirmed non-zero and rich on Go** (open question from the
   dispatch brief, now closed — see Section 0 item 3). This is the third language checked
   (Ruby: empty; TypeScript: populated; Go: populated) — the per-language gap is real but Go is
   on the "works" side.
2. **cbm `Route` nodes: unusable here, more severely than on Fastify (Dittofeed) or Rails
   (Chatwoot)** — every field but `method` is an empty string across all 141 nodes. Chi's
   route-registration idiom (`r.Post("/path", handlerFn)` inside `srvMux.Route("/prefix", func(r
   chi.Router) {...})`) apparently defeats cbm's Route extractor entirely, not just partially.
3. **cbm `hotspots` fan-in: still name-collision noise, still needs uniqueness verification
   before quoting** — same failure mode as Chatwoot, now confirmed on a third, much larger Go
   codebase, so this is a durable property of the tool's fan-in aggregation, not a per-language
   or per-repo fluke.
4. **graphify god-node lists: dominated by cross-file name collisions on this repo** —
   `Handle` (69 collapsed nodes), `Call` (57), `UploadJob` (11) all rank in the top 10 by raw
   edge count. Verify node-id cardinality (`python3` against `graph.json`, shown below) before
   citing any graphify god-node number as a real architectural fact.
5. **NEW — cbm aggregate functions over cast properties are unreliable.**
   `sum(toInteger(f.cognitive))` silently returns `0` and drops any second `RETURN` column
   rather than erroring. Plain `count(f)` works correctly. Do not use `SUM`/`AVG` over
   `toInteger()`-cast numeric properties in this cbm version; sample and sort per-row instead
   (every complexity number in this report was obtained that way).
6. **The `ORDER BY toInteger()` projected-alias requirement and "function calls in `WHERE` are
   unsupported" both reconfirmed a third time**, no new information but now a 3-for-3 pattern
   across Ruby, TypeScript, and Go targets — treat both as stable cbm limitations to design
   queries around, not repo-specific quirks.
7. **Cost/time:** cbm moderate index ≈ 1-2 min for 1,151 Go files (auto-excluded 50 dirs,
   mostly `testdata/`). graphify ≈ several minutes, 1,288 files, 16 MB `graph.json`, $0 LLM cost
   (Tree-sitter only). Both well within budget for a repo this size.

## Reimplementation notes (per section: port / adapt / skip)

| Area | Verdict | Why |
|---|---|---|
| jobsdb's ownership/claim model | **Port the idea** | Single-owner partitions instead of row locks is stack-independent and directly applicable to a local SQLite-backed outbox in Open Marketing — no Postgres required to get the same guarantee. |
| Exponential backoff formula (`router/misc.go:30-35`) | **Port verbatim (it's 5 lines of math, not code to copy)** | `min(max, base * 2^(attempt-1))` is the standard formula; reimplement, don't import. |
| Isolation-mode strategy (`none`/`workspace`/`destination`) | **Port the shape** | Even a single-process app benefits from choosing partition granularity explicitly rather than hard-coding one queue. |
| Ordering barrier with self-disabling (`eventorder.go`) | **Port the idea, simplify heavily** | The core insight — per-key in-order delivery that degrades to unordered under load rather than stalling — is valuable for webhook/CRM-sync delivery; the full `Barrier`/`cmd`-queue implementation is overkill at Open Marketing's scale. |
| Layered backpressure (pickup throttle / delivery throttle / circuit breaker / backoff) | **Port the shape, pick one or two layers** | Four independent mechanisms is right for a multi-tenant SaaS pipeline; Open Marketing likely only needs a circuit breaker + backoff to start. |
| GCRA/adaptive throttling (`router/throttler/`) | **Skip the implementation, note the algorithm name** | GCRA is a well-known, well-documented rate-limiting algorithm; use an existing small library rather than porting rudder-server's Redis-backed distributed version, which solves a multi-instance problem Open Marketing doesn't have yet. |
| HTTP-dispatched transformation (Node transformer service) | **Skip entirely** | Solves "isolate untrusted per-tenant code across many workspaces" — not Open Marketing's problem. If/when Open Marketing needs user-scriptable transforms, that's a fresh design, not a port. |
| Embedded fast-path transformers (kafka/pubsub/warehouse) | **Skip** | Product-specific to RudderStack's own high-volume destinations. |
| Enterprise-token feature gating (`app/app.go:54-94`) | **Port the shape** | Runtime factory + token check is a clean, reusable pattern for any app with a paid-feature tier, independent of RudderStack's specific features. |
| jobsdb compaction (merging leftover jobs from old datasets before drop) | **Note the idea, skip the implementation** | Solves unbounded Postgres table growth under continuous high-volume writes — relevant only if Open Marketing's own event log grows large enough to need it; premature otherwise. |
| Archiver → blob storage export (`archiver/worker.go`) | **Port the shape lightly** | "Export terminal-state records to the workspace's own storage before/instead of deleting" is a good compliance pattern for any audit trail, worth a small adaptation. |
| warehouse/, regulation-worker/, suppression-backup-service/ | **Skip entirely** | Product-specific to being a CDP/reverse-ETL platform; zero relevance to a marketing app. |

## Port targets for Open Marketing (ranked)

1. **The single-owner-partition claim model** — no row locks, no lease expiry, crash recovery
   is a boot-time sweep. The highest-value idea in the repo, and it scales *down* as well as up.
2. **Layered backpressure as a composable set, not a monolith** — pickup throttle, delivery
   throttle, circuit breaker, and per-job exponential backoff as four small, independently
   testable pieces.
3. **The self-disabling ordering barrier** — strict-order-when-possible, unordered-under-load,
   rather than a hard ordering guarantee that can stall the whole pipeline.
4. **Runtime-token feature gating via factories** (`app/app.go`) — cleaner than a
   directory-presence or build-tag approach for any future paid-tier feature in Open Marketing.
5. **Terminal-state archival to the tenant's own storage** — a good shape for an audit/compliance
   trail on any queue, adapted lightly rather than ported directly.

**Skip:** `warehouse/` (huge, product-specific), the external transformer dispatch and its
sandboxing story (unauditable from this repo, solves a multi-tenant-untrusted-code problem Open
Marketing doesn't have), `regulation-worker/` and `suppression-backup-service/` (GDPR/compliance
tooling specific to being a data pipeline vendor), GCRA/Redis-backed distributed throttling
(right-sized for a multi-instance SaaS cluster, not for Open Marketing today), and all of
`enterprise/`'s specific features (reporting, suppress-user, config-env, tracked-users — the
*gating pattern* is worth porting, per above; the features themselves are not).

**Do not expect from this repo:** any marketing-domain vocabulary at all — no contact, no
campaign, no segment, no journey, no template, no send-time logic. If a future recon in this
set needs those, they come from Dittofeed, Mautic, or novu, not here.

---

## Behavioral sections

### 1. HTTP/API surface

Served by `gateway/` via `go-chi/chi` (`gateway/handle_lifecycle.go:570`,
`srvMux := chi.NewRouter()`). Full route table, read directly from source
(`gateway/handle_lifecycle.go:588-645`) because cbm's `Route` extraction is empty here
(Section 0):

| Prefix | Routes | Auth |
|---|---|---|
| `/v1` | `POST /alias, /audiencelist, /batch, /group, /identify, /merge, /page, /screen, /track, /import, /webhook`; `GET /webhook` | writeKey HTTP Basic Auth (`gateway/handle_http_auth.go:22-58`) |
| `/pixel/v1` | `GET /track, /page` | writeKey (query param or header) |
| `/beacon/v1/batch` | `POST` | writeKey |
| `/internal/v1` | `POST /extract, /retl, /audiencelist, /replay, /batch`; warehouse proxy (`GET /fetch-tables`, `POST /pending-events`, `/trigger-upload`, `/jobs`, `GET /jobs/status`) | sourceID/internal auth, gated by `internalEndpointsEnabled` |
| `/internal/v2` | `job-status` (rsources v2) | internal |
| `/health`, `/`, `/version`, `/robots.txt`, `/docs` | `GET` | none |

Auth model: HTTP Basic Auth with the source's **writeKey as the username** (Segment-compatible
convention), resolved against a source map populated from the backend-config subscription
(`gateway/handle_http_auth.go:218-228`, `sourceToRequestContext`). Internal endpoints use a
separate sourceID-based auth (`authRequestContextForSourceID`) and are off by default
(`internalEndpointsEnabled` flag). Middleware stack: in-flight request counter, stat middleware,
concurrent-request limiter, and an uncompress middleware (`gateway/handle_lifecycle.go:576-587`)
— no auth middleware at the `chi.Use()` level; auth is applied per-handler
(`gw.writeKeyAuth(delegate)` wraps each `/v1/*` handler individually).

### 2. Event ingestion, traced end to end

The full synchronous path, traced through `gateway/handle.go` and
`gateway/handle_lifecycle.go`:

1. **HTTP receipt** — chi routes to a per-event-type handler (e.g. `webTrackHandler`), which
   parses/validates the payload and pushes a `webRequestT` onto a **per-user hashed channel**
   (`findUserWebRequestWorker`, `gateway/handle.go:158-167`, hash of `userID` mod
   `maxUserWebRequestWorkerProcess`).
2. **First-level batching** — `userWebRequestBatcher` (`gateway/handle.go:174-198`) drains that
   worker's channel with `lo.BufferWithTimeout(maxUserWebRequestBatchSize,
   userWebRequestBatchTimeout)`, producing per-user-shard batches.
3. **Validation, still synchronous** — `userWebRequestWorkerProcess`
   (`gateway/handle.go:206-290`) calls `getJobDataFromRequest` per request: writeKey→source
   resolution, rate-limit check, suppression check, payload-size check, JSON validity. Failures
   short-circuit here with an immediate response on the request's `done` channel — **no DB
   write happens for a rejected request.**
4. **Second-level batching across users** — surviving jobs are pushed to
   `gw.userWorkerBatchRequestQ`; `userWorkerRequestBatcher`
   (`gateway/handle_lifecycle.go:459-491`) coalesces batches from *many different users* by
   `dbBatchWriteTimeout` or `maxDBBatchSize`, whichever comes first.
5. **The durable write, synchronous** — a pool of `dbWriterWorkerProcess` goroutines
   (`gateway/handle_lifecycle.go:497-...`) each take one coalesced batch and commit it in
   **one Postgres transaction**: `gw.jobsDB.WithStoreSafeTx(ctx, func(tx) {
   gw.jobsDB.StoreInTx(ctx, tx, allJobs) })` (`gateway/handle_lifecycle.go:509-517`).
6. **Ack** — the transaction's success/failure is fanned back out through a per-job-UUID error
   map, through the response channels, back through both batching layers, to each original
   HTTP handler's `done` channel — **the HTTP response is not sent until the Postgres commit
   completes.**

**Durability guarantee, stated precisely:** an event is acknowledged to the client if and only
if it has been durably committed to the gateway's jobsdb tables in Postgres. Everything after
that (`processor` pickup, transformation, `router`/`batchrouter` delivery to destinations) is
fully asynchronous and decoupled by jobsdb — a crash of processor or router loses nothing,
because the job rows persist in Postgres regardless of which process reads them. The
double-batching (per-user, then cross-user) exists purely for write throughput — trading a
bounded amount of added latency (`userWebRequestBatchTimeout` + `dbBatchWriteTimeout`, both
short reloadable durations) for many-row INSERT transactions instead of one-row-per-request.

### 3. The job queue (`jobsdb`), traced exhaustively

**Storage.** Jobs live in dataset-pair tables per the package doc comment
(`jobsdb/jobsdb.go:1-14`): `<prefix>_jobs_N` (append-only, `job_id BIGSERIAL PRIMARY KEY`,
immutable payload — schema at `jobsdb/jobsdb_dataset_ddl.go:153-165`) and
`<prefix>_job_status_N` (append-only status history — `jobsdb/jobsdb_dataset_ddl.go:169-181`,
`job_state`, `attempt`, `exec_time`, `retry_time`, `error_code`, `error_response`). **A job's
current status is never updated in place — it is whichever status row is latest**, exposed via
a Postgres view: `CREATE VIEW "v_last_<status_table>" AS SELECT DISTINCT ON (job_id) * FROM
<status_table> ORDER BY job_id ASC, id DESC` (`jobsdb/jobsdb_dataset_ddl.go:242`). Multi-consumer
handles (one job fanning out to several named consumers) get a second view keyed on
`(job_id, consumer)` and a GIN index on a `consumers TEXT[]` column
(`jobsdb/jobsdb_dataset_ddl.go:223-257`).

**Claiming — no row locks, by construction.** `grep -rn "FOR UPDATE\|SKIP LOCKED"
jobsdb/*.go` (excluding tests) returns nothing. Reads
(`GetJobs`/`GetToProcess`/`getJobsDS`, `jobsdb/jobsdb_get.go:343-674`) are pure `SELECT`s against
the dataset tables joined with the `v_last_*` view — **they never write**. The actual "claim"
happens one layer up, in the caller: the router's pickup loop
(`router/handle.go:250-357`) reads unprocessed/failed/waiting jobs via an iterator, decides
worker assignment in-process, and **writes an `Executing` status row for the whole batch in one
`UpdateJobStatus` call** (`router/handle.go:254-262`) before dispatching any of them to a worker
goroutine. Because job partitions are owned by exactly one such pickup loop at a time — enforced
by the isolation-mode strategy (`router/isolation/isolation.go:17-46`; `none` = one partition per
destination type, `workspace`/`destination` = finer-grained but still disjoint) — **there is
never a second reader that could claim the same job**, so there is nothing for a row lock to
protect against. This is the load-bearing insight of the whole subsystem: the concurrency-safety
problem a typical Postgres queue solves with `SKIP LOCKED` is solved here one layer earlier, by
guaranteeing there's only ever one claimant per partition in the first place.

**Crash recovery.** If a process dies mid-batch, some jobs are left in `Executing` with no
terminal status. Because only one goroutine could ever have been working that partition, any job
still `Executing` at the next boot is unambiguously orphaned — recovery is a single sweep at
startup: `DeleteExecuting()`/`FailExecuting()` (`jobsdb/admin.go:27-37`, "This is only done
during recovery, which happens during the server start"), not a lease-timeout mechanism.

**Avoiding unbounded table growth — compaction.** New jobs always append to the newest dataset;
when a dataset fills, a new one is created and the old one becomes read-only
(`jobsdb/jobsdb.go:1-14` doc comment). Datasets that still have some unfinished jobs when they'd
otherwise be droppable get their surviving jobs copied into an intermediate dataset by
`doCompaction` (`jobsdb/jobsdb_compaction.go`, cognitive 55, transitive loop depth 9) so the
original (mostly-finished) dataset can be dropped outright rather than kept alive indefinitely
for a handful of stragglers.

**Distinct-consumer / multi-tenancy note.** `GetDistinctConsumers`
(`jobsdb/jobsdb_get.go:265-297`) reveals a "multi-consumer" mode where one job can have several
named consumers, each tracked independently — used, per the interface doc comment
(`jobsdb/jobsdb.go:146-149`), by partition-migration tooling. Single-consumer handles just have
one implicit `''` consumer.

### 4. Routing and delivery to destinations

**Fan-out model.** `processor` reads gateway jobs, calls the transformer (embedded or HTTP,
Section "Transformations" below) per destination the event is configured to reach, and writes
one router-jobsdb job per (event, destination) pair — the fan-out happens in `processor`, before
`router`/`batchrouter` ever see the job.

**Sync vs. batch/async split.** `router/` handles synchronous, one-HTTP-call-per-event
destinations (per-`destType` worker pools, `router/worker.go`). `router/batchrouter/` handles
destinations that only accept batch or async-polled delivery — 10 named async destination
managers under `router/batchrouter/asyncdestinationmanager/` (`bing-ads`, `bqstreamallevents`,
`eloqua`, `klaviyobulkupload`, `lytics_bulk_upload`, `marketo-bulk-upload`,
`salesforce-bulk-upload`, `sftp`, `snowpipestreaming`, `yandexmetrica`), each behind a shared
`manager.go` registration point. The great majority of RudderStack's ~200 advertised
destinations are neither of these — they're generic HTTP destinations whose request shape is
produced by the external transformer service and sent by a shared `router.SendPost`
(`router/network.go`, cognitive 103).

**Retry/backoff policy — per-destination-type, config-scoped.** Exponential backoff:
`nextAttemptAfter(attempt, min, max) = min(max, minBackoff * 2^(attempt-1))`
(`router/misc.go:30-35`), applied to `Failed`-state jobs via `status.RetryTime` (only re-picked
once `RetryTime` has passed — `shouldBackoff`, `router/handle.go:785-787`). The `min`/`max`
bounds are loaded per-destination-type: `getRouterConfigKeys("maxRetryBackoff", rt.destType)`
(`router/handle_lifecycle.go:348`) — this resolves through a fallback chain of increasingly
generic config keys (destType-specific first, then global default: 300s cap, confirmed default
in the same line). **Yes, per-destination(-type): the policy is real, not decorative.**
Abort-vs-keep-retrying is decided separately by `retryLimitReached`
(`router/handle.go:756-783`): a `5xx`-class failure keeps retrying until either
`AttemptNum >= maxFailedCountForJob` *and* `time.Since(firstAttemptedAt) > retryTimeWindow` —
both a count and a wall-clock ceiling, and a separate, looser ceiling for "sources" jobs
(`source_job_run_id` present in job parameters — batch/import jobs get
`maxFailedCountForSourcesJob`/`sourcesRetryTimeWindow` instead). Once the limit is reached the
job's terminal state is `Aborted` — jobsdb's plain terminal state, not a separate dead-letter
table; there is no further export of aborted router jobs by default (the `archiver/` package
covers a different concern — see Section 3/TL;DR).

**Ordering.** `router/internal/eventorder/eventorder.go` implements a per-key (`BarrierKey`)
barrier: a job for a key cannot be dispatched while an earlier job for the same key is
outstanding or has failed and is awaiting retry (`Enter`/`Wait`/`Leave`,
`eventorder.go:143-276`), guaranteeing in-order delivery per key — but the barrier disables
itself for a key once too many jobs pile up behind it
(`WithEventOrderKeyThreshold`/`concurrencyLimitReached`, `eventorder.go:407-417`), trading strict
ordering for throughput under sustained backlog, then re-enables after a timed half-open window.

### 5. Backpressure and rate limiting

Four independent, composable mechanisms, confirmed by source in `router/throttler/factory.go`
and `router/batchrouter/circuitbreaker/circuitbreaker.go`:

1. **Pickup throttling** — `GetPickupThrottler(destType, destID, eventType)`
   (`router/throttler/factory.go:37-46`) rate-limits how fast jobs are even *read* off the queue
   for a destination, before any HTTP call is attempted. Backed by GCRA (Generic Cell Rate
   Algorithm), either local (`throttlingAlgoTypeGCRA`) or Redis-backed for cluster-wide limits
   (`redis-gcra`, `redis-sorted-set`), plus an "adaptive" algorithm variant
   (`router/throttler/internal/pickup/adaptive/`) that adjusts the limit dynamically rather than
   using a fixed ceiling.
2. **Delivery throttling** — `GetDeliveryThrottler(destType, destID, endpointPath)` separately
   rate-limits the actual outbound HTTP call, scoped down to the endpoint path (a destination
   may have several endpoints with different limits).
3. **Circuit breaking (batch destinations only)** — `router/batchrouter/circuitbreaker/
   circuitbreaker.go:44-71` wraps `sony/gobreaker`: opens after `consecutiveFailures` (default
   3), stays open for `timeout` (default 5s), allows 1 probe request in half-open state. A
   third, coarser layer above throttling: stop trying entirely for a cooldown window once a
   destination is clearly down, rather than continuing to throttle-and-fail.
4. **Per-job exponential backoff** (Section 4) — the finest-grained layer, operating per
   individual failed job rather than per destination.

**What happens when a destination is slow or down**, concretely: pickup throttling reduces how
often jobs for it are read at all → delivery throttling caps the outbound call rate further →
if failures are consecutive, the batch-destination circuit breaker trips and stops attempting
delivery for a cooldown window → any job that does fail gets `RetryTime` pushed out
exponentially and is skipped until then → if failures persist past the count/time ceiling, the
job is `Aborted`. No single mechanism owns "destination is unhealthy" — it's an emergent
property of all four layers acting independently.

### 6. Transformations

Two categories, and they are architecturally very different:

- **Embedded (in-process, pure Go, RudderStack-authored only):**
  `processor/internal/transformer/destination_transformer/embedded/{kafka,pubsub,warehouse}` —
  format transformation for these three high-volume destination types runs directly in the Go
  binary, no external call.
- **Everything else — user transformations and the vast majority of destination
  transformations — is dispatched over HTTP to an external service**, never executed in this
  process. `processor/internal/transformer/user_transformer/user_transformer.go:104-160`
  (`Client.Transform`) posts to `<userTransformationURL>/customTransform`
  (`user_transformer.go:503-521`). Three distinct target URLs depending on transformation
  language and workspace: a shared JS transformer URL (`DEST_TRANSFORM_URL`/
  `USER_TRANSFORM_URL`, one shared instance for all workspaces), a shared Python transformer URL
  (`PYTHON_TRANSFORM_URL`), or — for Python specifically — **a per-workspace pod**
  (`perWorkspacePyTURLTemplate`, default `http://pyt-{workspaceID}:8080`,
  `user_transformer.go:56`), i.e. process/pod-level isolation per tenant for Python but shared-
  instance for JS.

**Sandboxing story, stated precisely because it needs to be: this repo has none, and cannot
speak to whether one exists.** All it does is decide *which URL* to POST user code's inputs to.
Whatever isolation exists for the JS path (a shared instance handling every workspace's
transformation code) lives entirely inside the separate `rudder-transformer` Node.js service,
which is not part of this clone and was not analyzed. The only isolation *this* repo controls is
the coarser choice, for Python only, to route each workspace to its own pod rather than share
one.

### 7. Observability

Two shared, external toolkit packages carry almost all instrumentation, both from RudderStack's
own `rudder-go-kit`/`rudder-observability-kit` modules (not part of this clone, so their
internals — e.g., whether `stats.Stats` is backed by StatsD, Datadog, or OpenTelemetry
underneath — could not be verified from source):

- **Metrics** — `github.com/rudderlabs/rudder-go-kit/stats`, imported **364 times** across the
  tree. Every subsystem traced in this report emits named counters/timers/gauges at natural
  seams: `jobsdb_get_jobs_time`, `jobsdb_tables_queried`, `jobsdb_cache_hits`,
  `router_iterator_stats_discarded_jobs`, `router_pickup_total_jobs_count`, per-destination
  delivery-response stats (`sendRouterResponseCountStat`, `router/worker.go:1061`). This is
  metrics-first design, not instrumentation bolted on afterward.
- **Tracing** — a `stats.Tracer` facade with explicit span kinds (`stats.SpanKindServer`,
  `SpanKindConsumer`, `SpanKindInternal`) threaded through the whole pipeline:
  `gw.tracer.Start(ctx, "gw.webRequestHandler", stats.SpanKindServer, ...)`
  (`gateway/handle_http.go:89`) → `proc.tracer.Trace(ctx, "preprocessStage",
  tracing.WithTraceKind(stats.SpanKindConsumer), ...)` (`processor/processor.go:1791`) →
  `rt.tracer.Start(ctx, "rt.pickup"/"rt.transform", stats.SpanKindInternal/Consumer, ...)`
  (`router/handle.go:306`, `router/worker.go:285`) — a single logical event's `traceparent` is
  propagated from the HTTP request through gateway persistence into the processor and router
  spans (`gateway/handle.go:302-316` extracts `traceparent` from job parameters to open a
  matching span at pickup time), giving genuine distributed-trace continuity across the
  async jobsdb hand-off, not just per-process spans.
- **Structured logging** — `obskit "github.com/rudderlabs/rudder-observability-kit/go/labels"`
  supplies typed field constructors (`obskit.Error(err)`, `obskit.DestinationType(...)`,
  `obskit.DestinationID(...)`) used throughout for consistent structured-log keys across every
  package, rather than ad hoc string keys per call site.

No direct `opentelemetry`/`otel` import appears in this repo's own `.go` files — the tracing and
metrics facades are one layer removed, inside the external `rudder-go-kit` dependency.

### 8. Data model

**jobsdb (the operational data model — see Section 3 for full detail):** per-dataset table pairs
`<prefix>_jobs_N` / `<prefix>_job_status_N`, `job_id BIGSERIAL`, immutable
`event_payload`/`parameters` JSONB, append-only status history read through a `DISTINCT ON`
view. Indexes reveal the access pattern precisely: `workspace_id`, `partition_id`, `custom_val`
(event type), and a configurable set of `parameters->>'...'` BTREE indexes
(`cacheParameterFilters = []string{"source_id", "destination_id"}`,
`jobsdb/jobsdb_get.go:82`) plus, for multi-consumer datasets, a GIN index on the `consumers`
array. This is a queue schema optimized for "give me the next N unprocessed/failed/waiting jobs
for this destination/workspace," not a general-purpose event store — there is no query path for
"give me all events for user X," which is telling: jobsdb is transport, not storage.

**warehouse/ (a completely separate data model, for a completely separate purpose):** loads
events into 9 external SQL/columnar warehouses (`bigquery`, `clickhouse`, `snowflake`,
`redshift`, `postgres`, `mssql`, `azure-synapse`, `datalake`, `deltalake`) — this is
RudderStack's reverse-ETL/CDP-warehouse-sync product surface, structurally and purposefully
unrelated to the jobsdb transport model. Not analyzed further; see "Skip" list.

**Config model:** `backend-config/` pulls source/destination configuration from RudderStack's
hosted control plane (or a self-hosted config JSON) over `Subscribe(ctx,
backendconfig.TopicProcessConfig)` (`gateway/handle_lifecycle.go:411`) — sources and
destinations are external configuration, not rows this server owns; the server is a
data-plane-only component by design.

## Reproducing / refreshing this analysis

- **graphify** (installed CLI, `$0` no-LLM):
  `cd /Users/la/Programming/OSS-Marketing-Repos/rudder-server && graphify update .`
  → refreshes `graphify-out/{graph.json, GRAPH_REPORT.md, manifest.json}` (16 MB `graph.json`).
  Do **not** pass `--no-viz` to `update` — not a valid option there, exits 2 (confirmed on this
  repo too — matches the Dittofeed finding). The HTML viz is auto-skipped above 5,000 nodes
  regardless (16,397 here).
- **Checking graphify god-node cardinality before quoting one** (Section 0 item 5):
  ```python
  import json
  g = json.load(open("graphify-out/graph.json"))
  targets = {"Handle", "Call", "UploadJob"}  # or whatever the report lists
  from collections import Counter
  c = Counter(n["label"] for n in g["nodes"] if n["label"] in targets)
  print(c)
  ```
- **codebase-memory-mcp:** project `rudder-server`, indexed 2026-09-06 in `moderate` mode at
  commit `11c9ab8b`. Use `get_architecture`, `query_graph`, `search_graph`, `get_code_snippet`.
  Query notes carried forward and reconfirmed on this repo (see Tool calibration): project
  numeric properties with `toInteger()` and sort on the **projected alias**
  (`RETURN toInteger(f.cognitive) AS cog ... ORDER BY cog DESC`); never call a function inside
  `WHERE`; never `SUM`/aggregate over a `toInteger()`-cast property (silently returns 0) — use
  plain `count()` or sample-and-sort instead.
