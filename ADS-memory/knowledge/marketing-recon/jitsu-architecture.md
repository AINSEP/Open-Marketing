# Jitsu Architecture — Reference Analysis

> Reference-only analysis of upstream Jitsu (2.0 / "newjitsu"), done to decide **what to port**
> into the Open Design–based Open Marketing repo.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/jitsu` (clone of
>   `github.com/jitsucom/jitsu`, analyzed at commit `137f0311`, 2026-07-01)
> - **Tools:** codebase-memory-mcp (project `jitsu`, moderate mode) + graphify
>   (`graphify-out/`, Tree-sitter, no LLM) + `rg` / direct reads. Two independent engines as a
>   cross-check.
> - **Date:** 2026-09-06

## Section 0 — Premise corrections + self-corrections

- **File counts confirmed, not corrected.** The brief's "~1,302 tracked files, 404 `.ts`, 362
  `.go`, 196 `.tsx`" matches `git ls-files` exactly. No correction needed there.
- **`sendToRotor` doesn't call Rotor over HTTP — it produces to Kafka.** The name suggests an RPC.
  Reading `bulker/ingest/router.go:293-334` shows it's 100% `producer.ProduceAsync` (fire-and-forget
  Kafka writes); Rotor is a Kafka *consumer*, never an HTTP callee on the async path. The only
  direct HTTP call from `ingest` to Rotor is `processSyncDestination` → `callFunctionsEndpoint`
  (`bulker/ingest/router.go`, `FunctionsServerURLTemplate`), used only for the small
  **synchronous/"tag" destination** path (`stream.SynchronousDestinations`), not normal event
  delivery. This was a Pass-A assumption ("ingest talks to rotor via HTTP") that Pass B disproved.
- **The two highest-cognitive-complexity Go functions (394, tied) are not Jitsu's.**
  `jitsu.bulker.jitsubase.jsonorder.createStructDecoder` and
  `...jsoniter.createStructDecoder` (`bulker/jitsubase/jsonorder/reflect_struct_decoder.go`,
  `bulker/jitsubase/jsoniter/reflect_struct_decoder.go`) are two **vendored forks of
  `json-iterator/go`** — both directories carry their own `LICENSE`/`README.md`. Counting them as
  organic complexity would be the same mistake as Chatwoot's `vue` god-node or Mautic's
  `composer.json` nodes: dependency-manifest/vendored-code noise inflating a metric. The real
  top organic hotspot is `_mapForDwh` (Method, cognitive **214**,
  `bulker/bulkerlib/implementations/sql/abstract.go`).
- **cbm's `Route.path` property doesn't exist — I mis-read the schema on the first pass.** The
  schema (`get_graph_schema`) lists Route properties as `name, qualified_name, file_path,
  start_line, end_line, broker, key_path, method, source` — there is no `path`. Querying
  `r.path` silently returns empty strings for every row (not an error), which looks exactly like
  a data-quality bug until you check the schema. The actual route string is in `r.name`. Also:
  `r.file_path` **is genuinely empty** for every Route node sampled here (unlike Dittofeed, where
  Fastify routes carried real file paths) — locate a route's definition by `search_graph` /
  `search_code`, not by trusting `Route.file_path`.
- **New cbm query trap, distinct from the documented `ORDER BY toInteger()` one:** even using the
  documented fix (`WITH n, toInteger(n.prop) AS alias ORDER BY alias DESC LIMIT N`), a
  **subsequent `RETURN n.other_property`** on the carried node comes back as the literal variable
  name (e.g. `"fn"`, `"mt"`) instead of the real value — silently, no error. The alias value itself
  (`cog` in that example) is correct; only *other* property reads on the node carried through
  `WITH...ORDER BY...LIMIT` are corrupted. Workaround: project **every** needed field as an alias
  inside the same `WITH` clause and `RETURN` only aliases — never `node.property` after an
  `ORDER BY`/`LIMIT` chain. Confirmed by direct comparison: the broken form and the all-aliases
  form were run back-to-back against the same query and only the latter returned real
  `qualified_name`/`file_path` values (see Tool Calibration below for exact queries).

## TL;DR

- **Code quality: 7/10. Marketing port value: 5/10.** Jitsu is not a marketing-automation
  product — it's an event-collection pipeline (a self-hosted Segment alternative). It has no
  campaigns, journeys, or segment/audience builder anywhere in this tree. What it has instead is
  **infrastructure a marketing platform needs underneath those features**: a durable ingest →
  transform → warehouse pipeline with real retry/DLQ semantics, a genuinely sandboxed
  user-code execution model, and two flavors of identity resolution (inline anonymous→identified
  stitching, plus a periodic CDP-style profile builder).
- **The TS↔Go seam is real and clean, not accidental.** Go owns the transport boundary — the
  public HTTP ingest surface (`bulker/ingest`), Kafka production, and the warehouse-loading
  writers (`bulker/bulkerapp`, `bulker/bulkerlib`) — plus the Kubernetes-facing sync orchestration
  (`bulker/sync-controller`, `bulker/operator`). TypeScript (`services/rotor`) owns everything
  between: the destination function chain, third-party destination adapters, identity
  resolution, and (via a Deno subprocess) sandboxed user-defined transformation code. The two
  sides talk almost entirely through **Kafka topics carrying JSON envelopes with retry metadata in
  headers** — not RPC. The one HTTP call from Go into TS-land is the synchronous-tag-destination
  path; the one HTTP call from TS into Go is Rotor's destination-function POST to Bulker
  (`libs/destination-functions/src/functions/bulker-destination.ts:269-279`). This is a
  well-drawn boundary: Go never runs user code or destination-specific logic, TS never touches a
  socket at the ingest edge.
- **Sandbox is the most exportable single idea here.** User-supplied transformation code (UDFs)
  runs inside a **Deno Web Worker created with `deno: { permissions: "none" }`**
  (`services/rotor/src/functions-server.ts:864-867`, same pattern in
  `services/rotor/src/lib/pb-server-runtime.ts:507-510` and
  `services/rotor/src/lib/worker-udf-runner.ts:96-100`) — no filesystem, no network, no env from
  inside the worker. Every side effect (`fetch`, key/value store ops, warehouse queries) is
  proxied back to the host process over `postMessage` and executed there under the host's own
  timeout, with a hard per-call `UDF_TIMEOUT_MS` (default 5000ms) that terminates the worker on
  overrun. This is a real capability-based sandbox, not an `eval()` with a try/catch around it.
- **Licensing is the cleanest of the three repos analyzed so far — and also the smallest amount
  of code to reason about.** `LICENSE` (root) and `bulker/LICENSE` are both plain **MIT** (Jitsu
  Labs, Inc / Jitsu). `THIRD-PARTY-LICENSES.md` lists only permissive + a short, explicit,
  unmodified-library-only weak-copyleft list (MPL-2.0 Go deps, LGPL `sharp`/libvips binaries) —
  no restrictive terms anywhere in the tracked tree. There *is* an enterprise carve-out, but
  unlike Chatwoot (shipped under a restrictive license in-tree) or Dittofeed (referenced by
  compose but silently absent), Jitsu's `AGENTS.md:32-34` says it plainly: **"The enterprise-edition
  billing/admin API now lives in `jitsucom/jitsu-cloud-billing`"** — a separate repository, not
  cloned here, not referenced by any file in this tree beyond that one doc line. Nothing to guess
  about and nothing to worry about porting by accident.

## What it is

A **pnpm/Turbo TypeScript monorepo bolted to a Go workspace** (`bulker/go.work`), MIT, 1,302
tracked files — 404 `.ts`, 362 `.go`, 196 `.tsx`. cbm indexed 20,960 nodes / 57,118 edges;
graphify 11,005 nodes / 21,275 edges / 598 communities.

**Stack:** Gin (Go HTTP, `bulker/ingest`, `bulker/bulkerapp`) · Kafka/Redpanda (event transport) ·
ClickHouse (event/analytics store + `eventslog`) · Postgres + Prisma (console config/control
plane, 36 models) · MongoDB (anonymous-event buffer + profile-builder raw store) · Deno (sandboxed
UDF runtime, embedded inside the Node `rotor` process) · Next.js/React console dashboard ·
Kubernetes (native `CronJob`/`Job` orchestration for connector syncs, via a real operator-pattern
controller).

### The five deployables

| Package | Language | Role |
|---|---|---|
| `bulker/ingest` | Go | Public HTTP collection endpoint. Validates write-key, normalizes the event, produces to Kafka. |
| `services/rotor` | TS/Node (+ Deno subprocess) | Kafka consumer. Runs the destination function chain, identity resolution, sandboxed UDFs, and the CDP profile builder. |
| `bulker/bulkerapp` | Go | Kafka consumer. Batches/streams events into the configured warehouse (ClickHouse/BigQuery/Snowflake/Redshift/Postgres/MySQL/DuckDB/S3/GCS), with its own retry topic. |
| `bulker/sync-controller` + `bulker/operator` | Go | Kubernetes controllers: reconcile Postgres-defined connector syncs into native `CronJob`s; drive `sync-sidecar` pods running Airbyte-CDK-style connectors. |
| `webapps/console` | TS/Next.js | Admin UI + the control-plane API every other service polls for its config (`/api/admin/export/*`). |

Every non-console service is **config-pull, not config-push**: `ingest`, `rotor`, and `bulkerapp`
each hold a `Repository[T]` that polls `console`'s export API on `REPOSITORY_REFRESH_PERIOD_SEC`
and caches the JSON to local disk (`docker/docker-compose.yml:34-79` env: `REPOSITORY_BASE_URL`,
`REPOSITORY_CACHE_DIR`). No service other than `console` talks to Postgres directly.

## Behavioral sections

### 1. HTTP/API surface

Three independent HTTP surfaces, not one:

- **`bulker/ingest`** (Gin) — the *only* surface meant to be public. Endpoints:
  `POST /api/s/:tp` (browser/S2S ingest, `router_ingest_handler.go:21`), `/api/s/s2s/:tp`,
  batch (`router_batch_handler.go`), Segment-compatible classic API
  (`router_classic_handler.go`), pixel tracking (`router_pixel_handler.go`), plus
  `GET /health /ready /status /metrics`. Auth is a **per-stream write key**
  (`bulker/ingest/router.go:414-444`: `Authorization: Bearer`, `Authorization: Basic`,
  `X-Write-Key` header, or `?writekey=` query param — checked against the stream's own
  credentials, not a shared secret). This is the expected shape for a public collection
  endpoint (same model as Dittofeed's write-keys) — not a finding, a confirmation.
- **`services/rotor`'s internal HTTP** (Express, `services/rotor/src/index.ts:200-230`) — profile
  UDF test/run and profile-event endpoints, gated by a **static Bearer token**
  (`checkAuth`/`checkRawToken`, same file) sourced from `ROTOR_RAW_AUTH_TOKENS`. Not
  internet-facing by default (`docker-compose.yml` only exposes it inside the compose network).
- **`webapps/console`** — the Next.js admin API (auth, workspace CRUD, config export). Not
  deep-audited here (out of scope — we're not porting the dashboard), but note it is the
  **only** service with a real user-authentication story (`ENABLE_CREDENTIALS_LOGIN`,
  OIDC via `OidcProvider`/`OidcLoginGroup` Prisma models).
- **Nothing found unauthenticated that shouldn't be.** `/health`, `/metrics`, `/version` are
  intentionally open (standard). cbm's `Route` list also surfaced Kafka **producer config
  keys** (`queue.buffering.max.messages`, `batch.size`, `linger.ms`) and an error string
  (`"Message size too large"`) misclassified as routes — 105 of 142 `Route` nodes have an empty
  `method`; only 37 (27 GET + 10 POST) are real HTTP routes. See Tool Calibration.

### 2. Event ingestion, traced end to end

```
SDK (jitsu-js) ──HTTP──▶ bulker/ingest (Go, Gin)
                              │  IngestHandler (router_ingest_handler.go:21-148)
                              │  → patchEvent()  (router.go:336) — normalize type/IP/context
                              │  → sendToRotor() (router.go:293-334)
                              ├─ if BackupEnabled: fire-and-forget produce to a per-workspace backup topic
                              ├─ if AsynchronousDestinations > 0:
                              │     producer.ProduceAsync(KafkaDestinationsTopicName, ...)  ◀── the normal path
                              └─ if SynchronousDestinations > 0 (s2s or "tag" mode):
                                    processSyncDestination() → HTTP POST to Rotor's functions-server
                                    (synchronous, response streamed back to the original caller)
                                         │
                    Kafka topic "destination-messages"  (async path only)
                                         │
                                         ▼
                       services/rotor  kafkaRotor consumer (lib/rotor.ts:63-237)
                              │  rotorMessageHandler (lib/message-handler.ts:52-187)
                              │  → buildFunctionChain + runChain (lib/functions-chain.ts:86-343)
                              │      (user-recognition → UDFs via Deno worker → destination fn)
                              └─ on failure: produce to retryTopic (exp. backoff header) or
                                 deatLetterTopic  [sic — upstream typo] (lib/rotor.ts:160-218)
                                         │
                                         ▼ (bulker-flavored destinations)
                       HTTP POST bulker/{destinationId}/post  (bulker-destination.ts:269-279)
                                         │
                                         ▼
                       bulker/bulkerapp  Kafka consumer → batch/stream writer → warehouse
                              └─ on failure: its OWN per-destination retryTopic, drained by an
                                 in-process cron batch consumer (topic_manager.go:378-391)
```

**Synchronous vs. deferred:** the default and dominant path is **fully asynchronous and
fire-and-forget at the HTTP layer** — `IngestHandler` returns `200 {"ok": true}` the instant the
Kafka produce call is accepted by the client library, before Rotor has done anything
(`router.go:125-131`). The only synchronous branch is for a small set of destinations flagged
`SynchronousDestinations` (device-mode-style "tag" destinations that need an immediate response,
e.g. a redirect or a computed value), which calls the functions-server directly over HTTP and
blocks the original request.

**Delivery guarantee as enforced in code: at-least-once, with two independent bounded-retry
tiers, each terminating in a dead-letter topic — not exactly-once, no cross-tier transaction.**
- *Rotor tier* (function-chain failures — anything a destination function throws as
  `RetryError`): exponential backoff, base^attempt minutes, default base **10**, default
  **3** attempts, capped at **1440 min (24h)**
  (`services/rotor/src/index.ts:8-30` — comment example: "5, 25, 125 minutes" for base 5).
  After exhausting attempts, produced to `deatLetterTopic()` (`kafka-config.ts:88-90`).
- *Bulker tier* (warehouse write failures, e.g. transient connection errors during
  `flushBatchFile`/`adjustTableColumnTypes`): a **separate, per-destination** retry topic
  (`bulker/bulkerapp/app/batch_consumer.go:35-36,327-379`), drained by a scheduler-registered
  batch consumer (`topic_manager.go:378-391`, `tm.cron.AddBatchConsumer`) — an in-process cron,
  not a Kubernetes CronJob.
- Neither tier is transactional with the other: a message can be durably retried at the Rotor
  level, succeed in reaching Bulker, and then fail *again* independently at the warehouse-write
  level with its own separate backoff schedule.

### 3. The TS↔Go seam

**Go owns transport and durability primitives; TypeScript owns business logic and user-code
execution.** Concretely: Go never runs a destination function, a UDF, or identity-resolution
logic — it only moves bytes (HTTP → Kafka → warehouse SQL). TypeScript never accepts a public
HTTP connection or writes Kafka messages that a customer's SDK talks to directly.

**Communication is Kafka-first, HTTP-secondary — no gRPC, no shared library, no shared schema
codegen.** The contract between the two is an untyped JSON envelope (`IngestMessage`) serialized
into Kafka message bytes; both sides independently maintain their own struct/interface for it
(`bulker/ingest`'s Go structs vs. `@jitsu/protocols/async-request`'s `IngestMessage` type) — this
is a **duck-typed contract enforced only by tests and convention**, not a shared IDL. That's the
one soft spot in an otherwise clean boundary: a field rename on either side is a silent runtime
break, not a compile error, until either side's tests catch it.

The two direct-HTTP exceptions (sync-destination call Go→TS, Bulker POST call TS→Go) are both
narrow, single-purpose, and internally authenticated with static bearer tokens
(`BULKER_AUTH_KEY`/`ROTOR_AUTH_KEY`) — they don't blur the boundary, they're the two places it's
explicitly punched through on purpose.

### 4. Destinations and fan-out

Two distinct destination tiers, each with its own retry mechanism (see §2):

1. **Bulker warehouse destinations** (Go, `bulker/bulkerlib/implementations/`) — ClickHouse,
   BigQuery, Snowflake* , Redshift (+`redshift_driver`), Postgres, MySQL, DuckDB, plus file-based
   S3/GCS (`file_storage/`). These get schema evolution
   (`adjustTableColumnTypes`, cognitive 99, `abstract.go`), dedup, and batch/stream write modes
   with their own Kafka-backed retry queue.
2. **Rotor destination functions** (TS, `libs/destination-functions/src/functions/`) — 14
   third-party adapters: Amplitude, Braze, Facebook Conversions, GA4, HubSpot, Intercom, June,
   Mixpanel, PostHog, Salesforce, Segment (compat), Statsig, Webhook (generic), MongoDB. Each is
   a small `JitsuFunction` that makes its own HTTP call and throws `RetryError`/`HTTPError` on
   failure (e.g. `bulker-destination.ts:280-294`), relying entirely on Rotor's outer Kafka
   retry/DLQ tier — there's no per-vendor retry logic beyond that.

A destination is **configured as a row, not a schema**: `ConfigurationObject` (`type`,
`workspaceId`, `config: Json`) linked to a stream via `ConfigurationObjectLink` (`fromId`/`toId`,
`type: "push"`, `data: Json`) — `webapps/console/prisma/schema.prisma:225-262`. Streams,
destinations, connections, and functions are all the *same* polymorphic entity/edge pair,
discriminated only by the `type` string and validated at the application layer (Zod, per-function
`Config` schema, e.g. `ProfilesConfig` in `profiles-functions.ts:22-31`) rather than by the
database schema. This buys schema flexibility (new destination type = no migration) at the cost
of losing DB-level referential/type safety on `config`/`data`.

**Dead-letter path:** both tiers converge on the same idea — a named Kafka topic
(`destination-messages-dead-letter` / a per-destination `*-dead` topic in Bulker) plus a
structured log entry via `eventsLogger.deadLetter(...)` (`rotor.ts:203-214`) /
`eventslog.ActorEvent` with `Level: LevelError` (`router_ingest_handler.go:44-47`), which
`bulker/eventslog` persists to ClickHouse or Redis (`ch_events_log.go`, `redis_events_log.go`)
for the console's events browser UI. It is a queue you can replay from, not a silent drop.

*(*Snowflake support exists per `THIRD-PARTY-LICENSES.md`/docs references but its driver file
wasn't directly opened in this pass — flagged as unverified, not asserted.)*

### 5. Transformation/functions — the sandbox, precisely

User-supplied transformation code ("UDFs") is compiled to an IIFE
(`compileUdfToIIFE`, `services/rotor/src/lib/udf-shared.ts`) and executed inside a **Deno Web
Worker instantiated with `deno: { permissions: "none" }`** — every production and debug call
site agrees: `functions-server.ts:864-867` (per-connection long-lived worker pool, the real event
path), `lib/pb-server-runtime.ts:507-510` (profile-builder UDFs), and
`lib/worker-udf-runner.ts:96-100` (the manual `/udfrun` debugger). `permissions: "none"` means the
worker itself cannot open a socket, touch the filesystem, or read environment variables — Deno
enforces this natively, it isn't emulated.

Every side effect a UDF needs is **proxied**: the worker posts a `proxyRequest` message
(`method: "fetch"` / `"store.<op>"` / `"warehouse.query"`), the host process executes it under
its own credentials/timeouts, and posts back a `proxyResponse`
(`worker-udf-runner.ts:172-206`). This is the load-bearing design decision — a UDF gets a `fetch`
that *looks* unrestricted to the function author but is entirely mediated (rate-limited,
logged, and time-boxed) by the host. On top of the permission boundary there's a hard wall-clock
cap: `UDF_TIMEOUT_MS` (default 5000ms), enforced with `worker.terminate()` on timeout
(`worker-udf-runner.ts:112-121`).

**Assessment: this is a real sandbox**, not "isolated-vm" theater or a bare `eval`. The
combination of (native OS-level permission denial) + (capability proxying for the few allowed
effects) + (hard timeout + forced termination) is the same shape you'd want for any
"customer-authored code runs inside our multi-tenant pipeline" feature — which a marketing
platform's custom-event-transform or custom-trigger-condition feature will eventually need.

### 6. Identity resolution — two distinct mechanisms, not one

1. **Inline anonymous→identified stitching** (`libs/destination-functions/src/functions/user-recognition.ts`) —
   runs synchronously in the function chain on every `page`/`track`/`screen` event. If the event
   isn't yet identified, it's appended to a per-connection MongoDB collection
   (`UR_<connectionId>`, `anonEvStore.addEvent`, 30-day lookback,
   `user-recognition.ts:9,105`) keyed by `anonymousId`. When an `identify` event arrives with a
   `userId` (or a configured identifying trait), **all buffered anonymous events for that
   `anonymousId` are evicted, stamped with the userId, trait-merged, and re-injected into the
   function chain** (`return [event, ...res]`, `user-recognition.ts:84`) — so a user's
   pre-identification activity retroactively becomes attributed activity, replayed through the
   same destination pipeline as if it had arrived identified.
2. **Periodic CDP-style profile building** (`services/rotor/src/lib/profiles-functions.ts`,
   `lib/priority-consumer.ts`, `lib/pb-server-runtime.ts`) — a distinct `connection.type ===
   "profiles"` destination buffers raw events + traits into Mongo (`profiles-raw`,
   `profiles-traits`, default `profileWindowDays: 365`,
   `profiles-functions.ts:22-31`), and a **priority-queued Kafka consumer per profile-builder**
   (`priority-consumer.ts:78-139`, topics compacted+deleted, `cleanup.policy:
   "compact,delete"`) runs a UDF-defined merge/build function on a periodic cadence
   (`runPeriodSec`, default 60s) to compute the merged profile and push it to a warehouse via
   `bulkerDestination` (`profiles-functions.ts:7`). This is the actual CDP engine — richer,
   asynchronous, and user-code-driven (profile-builder logic is itself a sandboxed UDF), versus
   the lightweight inline stitching in (1).

### 7. Background/scheduled work

- **Connector syncs are managed by a real Kubernetes controller, not a cron library.**
  `bulker/sync-controller/cronjob_controller.go` polls Postgres-defined sync configs and
  reconciles native `k8s.io/api/batch/v1` **`CronJob`** objects, labeled
  `jitsu.com/managed-by=syncctl` (`cronjob_controller.go:26-40`) — it creates/updates/deletes
  CronJobs to converge with the desired state, the textbook operator reconciliation loop. Sync
  execution itself runs as `sync-sidecar` pods driving Airbyte-CDK-protocol connectors
  (Postgres tables `source_spec`/`source_check`/`source_catalog`/`source_state`/`source_task`/
  `task_log`, `schema.prisma:299-373`).
- **Bulker's warehouse-retry drain is an in-process cron**, not Kubernetes-scheduled
  (`topic_manager.go:378-391`, §2/§4 above).
- **Rotor's profile-builder is a long-running Kafka consumer with an internal rate-limiting
  timer** (`priority-consumer.ts:37-76`), not a scheduled batch job — it reacts to messages and
  self-throttles per-key with a 30s debounce window.
- **Behavior on crash:** Kafka consumer-group offset commits (`autoCommit: true,
  autoCommitInterval: 10000`, `rotor.ts:79-80`) mean a crashed Rotor instance re-delivers
  whatever wasn't committed — **at-least-once, with a window up to the commit interval that can
  duplicate-process** on restart. There is no exactly-once/transactional-outbox mechanism
  anywhere in this pipeline; idempotency at the warehouse layer depends on the destination's own
  merge semantics (dedup keys, `ReplacingMergeTree`-style tables) rather than a guarantee Jitsu
  itself provides.

### 8. Data model

- **Postgres (control plane only, via Prisma, 36 models)** —
  `webapps/console/prisma/schema.prisma`. No customer event data lives here. Notable shapes:
  the generic `ConfigurationObject`/`ConfigurationObjectLink` polymorphic entity/edge pair
  (§4); `ProfileBuilder`/`ProfileBuilderFunction`/`ProfileBuilderState(2)` for CDP config;
  `source_*`/`task_log` for the Airbyte-CDK sync protocol; `reprocessing_jobs`/
  `reprocessing_workers` backing the standalone `bulker/reprocessing-worker` service;
  `FunctionsServer` tracking live UDF-runtime deployment IDs; `RateLimitCounter`.
- **ClickHouse** — the default/primary analytics sink for customer event data reaching a
  ClickHouse-type destination, *and* the `eventslog` observability store
  (`bulker/eventslog/ch_events_log.go`) that backs the console's live events browser — two
  different concerns sharing one engine.
- **MongoDB** — exclusively an intermediate buffer, never a destination or control-plane store
  in its own right: anonymous-event staging (`UR_<connectionId>` collections, §6.1) and raw
  profile-builder input (`profiles-raw`/`profiles-traits`, §6.2). Both are TTL/window-bounded,
  not permanent stores.
- **The actual event warehouse** is whatever the customer configured Bulker to write to
  (ClickHouse/BigQuery/Redshift/Postgres/MySQL/DuckDB/S3/GCS) — Jitsu is deliberately
  warehouse-agnostic at the point of final storage; nothing about the pipeline assumes a
  particular engine past the `bulkerlib` driver interface.

### 9. Reimplementation notes

| Section | Port / Adapt / Skip | Why + cheapest substitute |
|---|---|---|
| Ingest HTTP + write-key auth | **Adapt** | The write-key-in-header/query pattern is cheap and proven; skip Gin/Go, reimplement the same three-header-fallback check in Next.js API routes. |
| Kafka-based async pipeline + retry/DLQ headers | **Adapt the *idea*, not Kafka** | Kafka + a k8s cluster is the wrong cost for a Next/Electron app. The **shape** — durable queue, retry-count + scheduled-retry-time in message metadata, dead-letter topic — maps directly onto a lightweight job queue (BullMQ/Redis, or even a Postgres-backed queue) with the same three-column contract: attempt count, next-retry-at, dead-letter table. |
| Deno-worker UDF sandbox (`permissions:"none"` + proxied effects) | **Port the pattern closely** | This is the single most valuable idea in the repo for any product that will run user-authored transform/trigger code. Electron already ships no Deno, but the same shape is achievable with a `worker_threads`/child-process sandbox with no `require`/`fetch` in scope and a proxied-capability bridge — the *design*, not the runtime, is what's worth taking. |
| Inline anonymous→identified stitching (`user-recognition.ts`) | **Port closely** | Small (141 lines), self-contained, storage-agnostic (any TTL-capable KV works in place of Mongo — SQLite with a `expires_at` column is enough for a single-tenant desktop app). |
| Periodic CDP profile builder | **Adapt, simplify** | The priority-Kafka-topic-per-level mechanism (`priority-consumer.ts`) is solving a multi-tenant scale problem Open Marketing doesn't have yet. Port the *concept* (buffer raw events, periodically recompute a merged profile via user-definable logic) on a plain interval timer against local storage; revisit priority queuing only if/when multi-tenant scale demands it. |
| Two-tier destination model (warehouse-writer vs. per-vendor HTTP function) | **Port the shape** | Splitting "bulk columnar warehouse load" from "one HTTP call per vendor API" is the right decomposition regardless of stack. The 14 vendor adapters themselves are Segment/Jitsu-specific field mappings — skip the code, keep the one-file-per-destination convention. |
| Kubernetes CronJob-based sync scheduling (`sync-controller`) | **Skip entirely** | This assumes a Kubernetes cluster the target app will never run. For scheduled connector syncs, a plain `node-cron`/interval-based job runner is the correct-scale substitute — do not chase the operator-reconciliation pattern here. |
| Airbyte-CDK connector protocol tables (`source_spec`/`source_catalog`/etc.) | **Skip** | Valuable only if adopting the Airbyte connector ecosystem wholesale; out of scope unless a future ADR decides to run third-party Airbyte connectors. |
| ClickHouse as event/analytics store | **Skip for now** | Right tool for multi-tenant, high-cardinality analytics at scale; wrong tool for a single-tenant Next/Electron app. SQLite/Postgres is the honest substitute until event volume says otherwise. |
| Generic `ConfigurationObject`/`ConfigurationObjectLink` polymorphic config model | **Adapt cautiously** | Buys schema-less extensibility for new destination/stream types at the cost of DB-level type safety. Worth the pattern for a plugin-style destination registry; not worth it for core domain entities that benefit from real foreign keys. |
| Console dashboard (Next.js/React) | **Skip** | Not porting Jitsu's UI; Open Marketing has its own. |

## What's good

- **The retry/DLQ contract is uniform across both languages** — retry count, backoff time, and
  original-topic all travel as message headers on both the TS and Go sides
  (`RETRY_COUNT_HEADER`/`RETRY_TIME_HEADER` in `rotor.ts:29-33` vs. the equivalent header set in
  `bulker/bulkerapp/app/batch_consumer.go`), even though the two are independently implemented.
  That's a real cross-language convention, not a coincidence.
- **The sandbox is consistent everywhere it's used** — all three Worker-instantiation call sites
  use identical `permissions: "none"` (§5). No "debug mode skips the sandbox" gap was found.
- **No manifest-key god-node pollution.** graphify's top-10 god nodes
  (`useWorkspace()`, `requireDefined()`, `Now()`, `getServerEnv()`, `getLog()`, `New()`, `db`,
  `rpc()`, `getServerLog()`, `useAppConfig()`) are all real application abstractions — no
  `package.json`/`go.mod` keys, unlike Chatwoot (`vue`, 733 edges) and Mautic
  (`composer.json`, 694 nodes). cbm's `hotspots` (fan-in) list agrees closely (`Errorf` 177,
  `useWorkspace` 92, `New` 88, `requireDefined` 87, `getLog` 78) — high cross-tool confidence on
  what the real hubs are.
- **The enterprise/OSS boundary is a documentation line, not a landmine.** Unlike Dittofeed's
  silently-missing `packages/ee/`, `AGENTS.md:32-34` states outright that enterprise billing
  lives in a separate repo — nothing in this tree references it beyond that sentence, so there's
  no invisible-gap risk to carry into a port decision.

## What's weak

### 1. A real 3-file import cycle sits in the hot path, not just the frontend
graphify: `services/rotor/src/lib/functions-chain.ts → message-handler.ts → rotor.ts →
functions-chain.ts` (`GRAPH_REPORT.md:592`). Unlike Chatwoot/Dittofeed (whose cycles were
confined to frontend routing/state code), this one is in the core event-processing pipeline.
Not disqualifying — TS import cycles between co-designed modules are common and this one is
three cooperating files in the same package — but it's a real finding, not frontend noise.

### 2. The TS↔Go contract is untyped
The `IngestMessage` envelope crossing Kafka is independently re-declared as a Go struct
(`bulker/ingest`) and a TS type (`@jitsu/protocols/async-request`) with no shared schema
generation. A field rename on either side breaks silently until a test or a production incident
catches it (§3). This is the one architectural soft spot in an otherwise deliberate boundary.

### 3. Two vendored JSON libraries, not one
`bulker/jitsubase/jsoniter/` and `bulker/jitsubase/jsonorder/` are near-duplicate vendored forks
of `json-iterator/go` (Section 0) — both carry their own decoder/encoder trees. Maintaining two
copies of a large third-party library in-tree (rather than one fork with the order-preservation
feature flagged) is avoidable maintenance surface, though clearly a deliberate historical choice
(jsonorder exists specifically to preserve key order, which the upstream library doesn't
guarantee).

### 4. No cross-tier delivery transaction
As noted in §2/§7: Rotor's retry tier and Bulker's retry tier are independent. A message can
succeed at the Rotor level and still fail — with its own separate backoff — at the Bulker
warehouse-write level. There is no single end-to-end "this event is durably delivered" signal;
you'd have to correlate two separate dead-letter topics to know for certain whether a given
event ever reached its destination.

### 5. Dashboard god-node concentration mirrors Dittofeed's pattern
Not deep-audited (out of scope — not porting the console UI), but cbm's hotspots list surfaces
`useWorkspace` (fan-in 92) and `getServerEnv`/`getServerLog` (72/69) as top-10 overall hubs
alongside core pipeline code — the same "a few dashboard hooks dominate the god-node list" shape
seen in Dittofeed's `useAppStorePick`. Confirms this is a common Next.js-dashboard-on-a-backend
pattern, not a Jitsu-specific problem.

## Two-tool cross-check (cbm-mcp vs graphify)

cbm: 20,960 nodes / 57,118 edges. graphify: 11,005 nodes / 21,275 edges / 598 communities
(95% EXTRACTED / 5% INFERRED, avg confidence 0.8) — a **~1.9x node-count gap** between the two
engines on the same commit, larger than the gap seen on Chatwoot (1.4x) or Dittofeed (1.5x).
Largest single contributor: cbm's 10,511 `Variable` nodes (mostly Go local variables — cbm's Go
extractor is finer-grained than graphify's here) have no graphify equivalent at that granularity.

- **Agree:** `useWorkspace`, `requireDefined`, `getLog`/`getServerLog`, `New`/`Now` (Go
  constructors/utilities) are the top hubs in both tools. High cross-tool confidence.
- **cbm added:** per-function `cognitive`/`transitive_loop_depth` (the `_mapForDwh` cognitive-214
  finding; §Tool Calibration below on the per-language question), 142 `Route` nodes (mostly
  noise — see below), Leiden-style clusters (12 shown, cohesion 0.59–0.92, `bulker`/`webapps`/
  `services`-scoped).
- **graphify added:** the 3-file import cycle in the rotor pipeline (§What's Weak #1), and a
  clean god-node list with zero manifest pollution.
- **Both produced noise worth flagging** — see Tool Calibration.

### Tool calibration notes (carry into the remaining repos)

1. **Answering the brief's calibration question directly: within this one mixed-language cbm
   index, complexity/loop metrics are populated on BOTH halves, not gapped by language the way
   Ruby was on Chatwoot.** Go: 932 `Function` nodes, 541 (58%) with `cognitive > 0`, 443 (48%)
   with `transitive_loop_depth > 0`, only 7 with `linear_scan_in_loop > 0`. TypeScript: 2,042
   `Function` nodes, 1,101 (54%) with `cognitive > 0`, 594 (29%) with `transitive_loop_depth >
   0`. This *confirms* the Dittofeed-run conclusion ("the metric gap is per-language, not
   per-repo") from a new angle: it's not that one mixed-repo index picks a language to
   instrument — both get real values, at roughly comparable population rates. Go's near-zero
   `linear_scan_in_loop` (7/932) versus TS's much higher rate is plausibly a real idiom
   difference (Go's `for range` + map lookups don't trip the same linear-scan heuristic that
   `.find()`/`.indexOf()` does in JS) rather than an extraction gap — not independently verified
   further; flagged as a hypothesis.
2. **A new, more dangerous variant of the `ORDER BY toInteger()` trap.** Documented previously:
   `ORDER BY toInteger(f.cognitive) DESC` inline is silently ignored. New on this repo: even
   the *documented workaround* — `WITH fn, toInteger(fn.cognitive) AS cog ORDER BY cog DESC LIMIT
   10 RETURN fn.qualified_name AS qn, ...` — sorts `cog` correctly but returns the **node
   variable's own name** (`"fn"`) for every other property in the same `RETURN`, silently, with
   no error. Confirmed by running the broken and fixed forms back to back against the identical
   `MATCH`: broken form → 10 rows of literal `"fn"`/`"mt"`; fixed form (project every field as an
   alias inside the `WITH`, `RETURN` only aliases) → real `qualified_name`/`file_path` values.
   **Rule going forward: never `RETURN node.property` after a `WITH...ORDER BY...LIMIT` chain —
   project everything you need as an alias before the `ORDER BY`.**
3. **cbm `Route` nodes are ~74% noise here (105/142 blank `method`)** — Kafka producer config
   keys (`queue.buffering.max.messages`, `batch.size`, `linger.ms`) and even a bare error string
   (`"Message size too large"`) got extracted as `Route` nodes. Of the 37 real HTTP routes, the
   path string lives in `Route.name`, **not** `Route.path` (that property doesn't exist per
   `get_graph_schema` — querying it silently returns empty rather than erroring), and
   `Route.file_path` is empty on every sampled row (locate the defining file via
   `search_graph`/`grep` instead). Confirms the memory's standing note ("cbm Route nodes were
   unusable on both prior repos — verify before leaning on them") a third time, with a new
   specific failure shape (wrong property name, not just noisy extraction).
4. **graphify's god-node list needed no manifest-key filtering this time** — a genuine
   difference from Chatwoot/Mautic, not a tooling improvement (see What's Good above).
5. **Node-count divergence between engines (1.9x) is the largest seen across the three repos
   analyzed so far** — attributable to cbm's much finer-grained `Variable` extraction on Go
   specifically (10,511 of cbm's 20,960 nodes). Worth checking whether this holds on the next
   Go-containing target in the batch, or is specific to this repo's Go idioms.
6. **Cost/time:** cbm `moderate` index ≈ under 2 min, 20,960 nodes/57,118 edges, auto-excluded 20
   dirs (test fixtures, `__tests__`, generated bins). graphify ≈ under 2 min, 11,005 nodes/21,275
   edges, $0 LLM (95% extracted, 5% inferred at 0.8 confidence). Both cheap enough to run on
   every repo in this set.

## Port targets for Open Marketing (ranked)

1. **The Deno-worker UDF sandbox pattern** (`permissions:"none"` + proxied fetch/store/query) —
   the single highest-value idea in this repo, and stack-independent. Port the *design*
   (capability denial + explicit proxy + hard timeout), not the Deno runtime itself.
2. **The retry-metadata-in-message-headers convention** (retry count, next-retry-time,
   original-topic, error, function-id) — small, portable, and battle-tested across two
   independently-implemented languages in the same repo. Reimplement against whatever queue
   Open Marketing already has.
3. **Inline anonymous→identified event stitching** (`user-recognition.ts`) — 141 lines,
   self-contained, storage-agnostic. Directly portable logic, not just a pattern.
4. **Two-tier destination decomposition** (bulk warehouse writer vs. one-file-per-vendor HTTP
   function) — port the shape; the specific vendor adapters are Segment-schema-specific and not
   worth transliterating.
5. **The write-key ingest auth model** — cheap, proven, and already the industry default for
   collection endpoints (matches Dittofeed). Straightforward to reimplement in a Next.js API
   route.
6. **The periodic CDP profile-builder concept** (buffer raw events, periodically recompute a
   merged profile via user-definable logic) — port the idea on a plain timer; skip the
   priority-Kafka-topic mechanism, which solves a scale problem Open Marketing doesn't have yet.

**Skip:** the Kubernetes CronJob/operator sync-scheduling machinery (`sync-controller`,
`operator`) — assumes a cluster this app will never run; the Airbyte-CDK connector protocol
tables — only relevant if adopting that connector ecosystem wholesale; ClickHouse as the
event store — right tool for multi-tenant scale, wrong tool here; the Next.js console dashboard
— not porting Jitsu's UI; ~~the two vendored JSON libraries~~ (irrelevant outside Go).

**Do not expect from this repo:** a campaign engine, a journey builder, a segment/audience query
language, or an email-sending pipeline — none exist anywhere in this tree. Source those from
Dittofeed (journeys/segments) and Mautic (segment QueryBuilder), as already noted in the prior
two analyses. Jitsu's contribution to Open Marketing is entirely **plumbing that sits underneath**
those features (ingestion, identity stitching, sandboxed user-code execution, warehouse
fan-out with retry/DLQ) — not a competing product surface.

## Reproducing / refreshing this analysis

- **graphify** (installed CLI, `$0` no-LLM):
  `cd /Users/la/Programming/OSS-Marketing-Repos/jitsu && graphify update .`
  → refreshes `graphify-out/{graph.json, GRAPH_REPORT.md, manifest.json}`. Do **not** pass
  `--no-viz` to `update` — not a valid option there, exits 2 (confirmed again on this repo,
  consistent with the Dittofeed run). It auto-skips the HTML render above 5,000 nodes.
- **codebase-memory-mcp:** project `jitsu`, indexed 2026-09-06 in `moderate` mode at commit
  `137f0311` (20 dirs auto-excluded: test fixtures, `__tests__`, generated bin dirs). Use
  `get_architecture`, `query_graph`, `search_graph`, `get_code_snippet`. Cypher notes: numeric
  properties are strings — project through `toInteger()` and sort on the alias, **and** don't
  `RETURN node.property` after a `WITH...ORDER BY...LIMIT` chain (project every needed field as
  an alias first — see Tool Calibration #2). `Route.path` does not exist as a property; use
  `Route.name`.
