# Capability Synthesis — What to Build in Open Marketing

> One document organized by **capability**, not by repo. For each capability: what it is, how the
> best implementation works mechanically, how the weaker ones differ and what that costs, and the
> verdict for Open Marketing with a concrete first version.
>
> - **Target:** `/Users/la/Programming/Open-Marketing` — Next.js + Electron, TypeScript, Postgres.
>   We will not run Temporal, ClickHouse, Kafka, a JVM, PHP, or a multi-service cluster.
> - **Primary sources:** the twelve per-repo analyses in this directory (`chatwoot-`, `dittofeed-`,
>   `formbricks-`, `inngest-`, `jitsu-`, `listmonk-`, `matomo-`, `mautic-`, `novu-`,
>   `rudder-server-`, `trigger-dev-`, `unomi-architecture.md`). `mautic-architecture.md` predates
>   this batch (2026-06-30) and is shorter and older; treated as valid but less thorough.
> - **Secondary:** direct reads of upstream source in `/Users/la/Programming/OSS-Marketing-Repos/`
>   to fill gaps the docs left thin. Every such read is cited `repo path:line` and marked as a
>   fresh verification in this pass.
> - **Date:** 2026-09-06. Nothing was built, run, or indexed to produce this. No repo was modified.
>
> **Citation format:** `repo path:line`. Where a coordinator correction exists inside a source doc,
> the correction is authoritative and this document follows it. Where the source docs disagree with
> each other, it is said in place and listed again in the Handoff.

---

## 1. Journey / workflow execution

### What the capability is, and why it is hard

A person enters a flow, waits three days, branches on a condition, receives a message, waits for an
event that may never arrive, and exits. The whole thing must survive process restarts, deploys, and
crashes; must not hold a thread, connection, or container open during a multi-day wait; must not
send the same message twice after a crash; and must not silently strand people mid-flow.

The hard part is not the graph. It is that **the unit of work outlives every process that could
hold it in memory**, so the state must live in a datastore and the resume must be driven by
something that will still exist in three days.

### The four designs in the survey

Four repos solved this independently and arrived at genuinely different answers.

**Dittofeed — one Temporal workflow per (user, journey).** `userJourneyWorkflow`
(`dittofeed packages/backend-lib/src/journeys/userWorkflow.ts:206`) is a `switch` over the
`JourneyNodeType` union — verified this pass at
`dittofeed packages/isomorphic-lib/src/types.ts:879-890`: `SegmentEntryNode` (wire name
`"EntryNode"`, kept for backwards compatibility), `EventEntryNode`, `DelayNode`, `WaitForNode`,
`SegmentSplitNode`, `MessageNode`, `RandomCohortNode`, `ExitNode`, `RateLimitNode`. Eight work;
`RateLimitNode` is an unimplemented stub that logs `"unable to handle un-implemented node type"` and
routes straight to the exit node — verified at
`dittofeed packages/backend-lib/src/journeys/userWorkflow.ts:1070-1077`. Durability comes from
Temporal replaying the workflow's event history onto a fresh worker, which requires a Temporal
server and demands the workflow body be deterministic end to end.

**trigger.dev — three cooperating layers, only the third genuinely OS-durable.** Layer 1 is a
relational state machine: an append-only `TaskRunExecutionSnapshot` linked list, each row pointing
at `previousSnapshotId` (`trigger.dev internal-packages/run-engine/src/engine/systems/executionSnapshotSystem.ts:332-403`);
every subsystem reads only the *latest* snapshot and acts — nothing replays it. Layer 2 is the
durable clock: `createDateTimeWaitpoint` inserts a `Waitpoint` row and enqueues a `finishWaitpoint`
job at `availableAt: completedAfter`
(`trigger.dev internal-packages/run-engine/src/engine/systems/waitpointSystem.ts:180-257`) into a
Redis ZSET-scored-by-timestamp queue. Layer 3 is CRIU/Docker container checkpointing so an
arbitrary Node process can be frozen and restored — and per the vendor's own docs it is Cloud-only,
because it needs `crictl`/`buildah` or Docker's experimental checkpoint feature.

**Inngest — the timer is a queue item with a future score, and nothing else.**
`handleGeneratorSleep` (`inngest pkg/execution/executor/executor.go:4394-4500`) computes
`until := now.Add(dur)`, enqueues a `KindSleep` item scored at that time, and returns. The HTTP
cycle that reported the sleep closes completely; no goroutine, connection, or timer wheel holds
anything. `waitForEvent` (`inngest pkg/execution/executor/executor.go:5147-5348`) is the same
primitive plus a secondary index: a `state.Pause` row keyed by `(workspaceID, eventName)` with an
optional match expression, *and* a timeout queue item enqueued at the expiry, so both the "event
arrived" arm and the "it never did" arm are driven by the same machinery, with `ConsumePause` as the
atomic op that lets exactly one win. Step memoization is a flat `{stepID: output}` map re-sent on
every invocation (`inngest pkg/execution/driver/driver.go:189-225`) — not a workflow history.

**Novu — a `Job` row per (notification, step), chained by `_parentId`, plus a delayed queue
message.** `AddJob` routes `DIGEST`/`DELAY`/`THROTTLE` through deferred-execution logic; everything
else is queued immediately; `RunJob`'s `finally` calls `tryQueueNextJobs`, which finds the job whose
`_parentId` is the one just completed and re-enters `AddJob`. The chain is a linked list in the DB,
the timer is a BullMQ/SQS `delay`.

**listmonk is not in this category and it is worth saying why.** It has no journey at all — its
resumability is four integer columns on the campaign row (`to_send`, `sent`, `max_subscriber_id`,
`last_subscriber_id`) advanced once per batch. That gets you a resumable broadcast, not a flow.

### Resolving the durability question

**The cheapest honest design for a Next/Electron/Postgres app is a state-machine row with a future
timestamp and a poller. Build it; adopt no execution substrate.**

Two of the source docs reach this independently and argue it well: `inngest-architecture.md` §12
("durable state is a state machine in a row, a wait is a future-scored row, a resume is a poll —
port no code") and `trigger-dev-architecture.md` §10 ("a few hundred lines we own and fully
understand"). `dittofeed-architecture.md` pulls the other way, calling the Temporal model "the
single biggest architectural idea to take from this repo." **These are arguing about different
layers and both are partly right:** Dittofeed's *node taxonomy* is the best in the survey and worth
adopting closely; its *substrate* is not, and a reader skimming that doc alone would over-buy. My
reading follows Inngest and trigger.dev on the substrate and Dittofeed on the taxonomy.

The case against each alternative, briefly: Temporal costs a server plus determinism constraints on
code that has no need to be deterministic. trigger.dev's checkpointing solves "resume an arbitrary
call stack," which a journey never needs — a journey needs "re-invoke a known step type with known
saved state" — and its own vendor does not ship it self-hosted. Inngest's dev server is a genuinely
complete single-binary engine, but it is a Go binary to package inside Electron and it is SSPL
(§A). A hosted provider is an always-on external dependency for an app that should run standalone.

### The concrete first version

Schema (Postgres in the hosted app, the same DDL against SQLite for Electron):

```sql
-- The definition. Immutable once a version is published.
CREATE TABLE journey (
  id            uuid PRIMARY KEY,
  workspace_id  uuid NOT NULL,
  name          text NOT NULL,
  version       int  NOT NULL,
  definition    jsonb NOT NULL,        -- the typed node graph, §2's shape
  status        text NOT NULL,         -- draft | running | paused | archived
  published_at  timestamptz,
  UNIQUE (id, version)
);

-- One row per person per journey run. This row IS the durable execution state.
CREATE TABLE journey_run (
  id               uuid PRIMARY KEY,
  workspace_id     uuid NOT NULL,
  journey_id       uuid NOT NULL,
  journey_version  int  NOT NULL,      -- pinned at entry; see below
  subject_id       uuid NOT NULL,
  status           text NOT NULL,      -- waiting | running | done | failed | canceled
  current_node_id  text NOT NULL,
  state            jsonb NOT NULL DEFAULT '{}',   -- memoized step outputs, keyed by node id
  resume_at        timestamptz,        -- the timer. NULL when not time-waiting.
  wait_event       text,               -- event name for a wait-for node
  wait_match       jsonb,              -- predicate over the event payload
  attempt          int NOT NULL DEFAULT 0,
  lease_owner      text,
  lease_until      timestamptz,
  entered_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Re-entry policy expressed as a constraint, not as application code.
CREATE UNIQUE INDEX journey_run_one_active
  ON journey_run (journey_id, subject_id)
  WHERE status IN ('waiting','running');

CREATE INDEX journey_run_due
  ON journey_run (resume_at)
  WHERE status = 'waiting' AND resume_at IS NOT NULL;

CREATE INDEX journey_run_waiting_event
  ON journey_run (workspace_id, wait_event)
  WHERE status = 'waiting' AND wait_event IS NOT NULL;

-- Append-only audit. One row per node execution. Never updated in place.
CREATE TABLE journey_run_step (
  id           uuid PRIMARY KEY,
  run_id       uuid NOT NULL REFERENCES journey_run(id),
  seq          int  NOT NULL,
  node_id      text NOT NULL,
  node_type    text NOT NULL,
  status       text NOT NULL,          -- ok | skipped | failed
  reason       text,                   -- WHY, from a closed enum. See below.
  output       jsonb,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  UNIQUE (run_id, seq)
);
```

The main loop, run every 5–15 seconds by one poller (a Next.js server interval, an Electron
background timer, or a cron — it does not matter which):

```sql
-- Claim a batch. FOR UPDATE SKIP LOCKED makes concurrent pollers safe.
WITH due AS (
  SELECT id FROM journey_run
  WHERE status = 'waiting' AND resume_at <= now()
  ORDER BY resume_at
  LIMIT 200
  FOR UPDATE SKIP LOCKED
)
UPDATE journey_run r
   SET status = 'running', lease_owner = $1, lease_until = now() + interval '60 seconds'
  FROM due WHERE r.id = due.id
RETURNING r.*;
```

Then, per claimed run: load `journey.definition` **at the pinned `journey_version`**, `switch` on
the current node type, execute, append a `journey_run_step` row, compute the next node, and commit
one of three outcomes — (a) a delay: `status='waiting'`, `resume_at = now() + duration`; (b) a
wait-for: `status='waiting'`, `wait_event` set *and* `resume_at` set to the timeout, so the same
poller drives the timeout arm; (c) a branch or exit: loop immediately in the same transaction. An
arriving event resolves waiters with a single `UPDATE ... WHERE status='waiting' AND wait_event=$1
AND ...` — one statement, so the event arm and the timeout arm cannot both win. That is Inngest's
`ConsumePause` in one line of SQL.

Four rules that make the difference between this working and this being a source of incidents:

1. **Idempotency at the send boundary.** Write the `journey_run_step` row and the
   `message_delivery` row (§4) *before* the provider call, with a deterministic idempotency key
   `hash(run_id, node_id, attempt)`, and pass that key to the provider. A crash between the call and
   the commit re-runs the step; the provider dedupes. This is the standard at-least-once caveat
   Inngest documents explicitly (`inngest pkg/execution/state/state.go:409-414`,
   `ErrIdempotentResponse`/`ErrDuplicateResponse` guarding double writes) and it is unavoidable
   without distributed transactions we are not going to have.
2. **Pin the version at entry.** `journey_run.journey_version` is set when the person enters and
   never changes. An editor publishing v4 does not move the feet of someone standing on v3's step
   6. See §C.1 — no repo in the survey solved in-flight migration, and the honest answer is not to
   attempt it.
3. **Lease, then sweep.** `lease_until` exists so a crashed poller's claimed runs come back: on
   boot, `UPDATE journey_run SET status='waiting' WHERE status='running' AND lease_until < now()`.
   That is rudder-server's boot-time sweep (`rudder-server jobsdb/admin.go:27-37`) rather than
   trigger.dev's per-run heartbeat, which is more machinery than a single-owner poller needs.
4. **Record why, for every decision.** Every `journey_run_step` row carries a `reason` from a closed
   enum — `skipped_by_preference`, `skipped_by_condition`, `skipped_by_suppression`,
   `skipped_by_quiet_hours`, `provider_error`, and so on. This is Novu's `ExecutionDetails` pattern
   (`novu-architecture.md` §12.4), and it is the single cheapest thing that makes "why didn't this
   person get the email" answerable without reading logs. Retrofitting it later means retrofitting
   it into every branch.

**Node taxonomy to ship:** Dittofeed's eight working types — `SegmentEntry`, `EventEntry`, `Delay`,
`WaitFor` (segment or event, with a required timeout), `SegmentSplit`, `RandomCohort`, `Message`,
`Exit`. Skip `RateLimit`: it is a stub upstream (verified above) and rate limiting belongs in the
send layer (§5), not in the journey graph where it would need per-node distributed counters.

**Estimated size:** the poller, the interpreter, and the eight node handlers are a few hundred lines
plus tests. The schema above is the whole persistence layer.

---

## 2. Segmentation and audience definition

### What the capability is, and why it is hard

"Who should receive this" must be expressible by a non-engineer in a UI, storable as data,
evaluable against one person in memory (for a journey branch), *and* compilable to a set query
against the whole population (for an audience build). Those last two are different questions asked
of the same definition, and most systems answer only one of them well.

### The shapes, compared

| System | Shape | Nesting | Compiles to a set query? |
|---|---|---|---|
| **Unomi** | `conditionTypeId` + flat `Map<String,Object>` params; nesting by putting conditions *inside* the param map | arbitrary | Yes — a **separate, independently pluggable** query builder per condition type |
| **Dittofeed** | Typed discriminated-union node tree, TypeBox-validated | arbitrary | Yes — compiled to incremental ClickHouse SQL |
| **Formbricks** | JSON tree of AND/OR groups over 4 resource kinds (`attribute`/`person`/`segment`/`device`) | arbitrary | Yes — `segmentFilterToPrismaQuery` → one SQL query per segment |
| **Mautic** | `LeadBundle` Segment/Query/QueryBuilder — battle-tested SQL generation | arbitrary | Yes, but regenerates the full query every time |
| **Matomo** | String DSL: `;`=AND, `,`=OR, backslash-escaped | **none — no parentheses, structurally capped at two levels** | Yes — direct operator→SQL-fragment switch |
| **Chatwoot** | 18 conditions / 19 actions as literal arrays on the model | flat | No — conversation-scoped in-memory only |
| **listmonk** | A raw SQL boolean expression typed by an admin | n/a | It *is* SQL |

Matomo's grammar deserves one sentence of explanation because it looks like a mistake and isn't:
`countryCode==US;browserName==Chrome,browserName==Firefox` means `country=US AND (Chrome OR
Firefox)`, and you genuinely cannot write `(A OR B) AND (C OR D) OR E`. That ceiling exists because
a segment had to fit in a `&segment=` URL parameter — a 15-year-old constraint we do not have. The
Matomo doc says so itself and points at Dittofeed's typed tree as the better donor.

listmonk's is the one to actively avoid. It is string interpolation, sanitized by trimming
whitespace and stripping a trailing semicolon (`listmonk internal/core/core.go:191-204`, duplicated
as `formatSQLExp` at `listmonk cmd/subscribers.go:844`), gated by a dedicated permission
(`subscribers:sql_query`) and pre-flighted in a read-only transaction
(`listmonk models/queries.go:148-167`). That is a genuinely thoughtful defense for a single-tenant
self-hosted tool and the wrong architecture for anything multi-tenant. In a structured model,
injection is not merely mitigated — it is not expressible.

### The recommendation

**Store Dittofeed's typed node tree. Execute it through Unomi's dual-dispatch architecture. Resolve
field names through Matomo's name→column table.**

Those three claims come from three docs that never quite say it together — the Unomi doc calls its
condition model "the strongest single idea in the 12-repo survey" for a segment engine, while the
Matomo and listmonk docs both point at Dittofeed. They are compatible once you separate *shape*
from *execution architecture*, which is what this recommendation does.

The dual-dispatch idea, precisely: a condition type declares **two** interpreter ids — a
`conditionEvaluator` (does this one loaded person match, right now, in memory?) and a `queryBuilder`
(which stored people match, without loading them?). Unomi resolves them through
`ConditionEvaluatorDispatcherImpl.eval`
(`unomi persistence-spi/src/main/java/org/apache/unomi/persistence/spi/conditions/evaluator/impl/ConditionEvaluatorDispatcherImpl.java:106-229`)
and `ConditionOSQueryBuilderDispatcher.buildFilter`
(`unomi persistence-opensearch/core/src/main/java/org/apache/unomi/persistence/opensearch/ConditionOSQueryBuilderDispatcher.java:102-176`).
One declarative definition, two questions, two pluggable answers, registered by string id.

That is exactly the seam a journey needs: `SegmentSplit` asks question one about a person already in
hand; an audience build asks question two about everyone. Without the seam you end up writing the
same predicate twice and watching them drift — which is precisely what happened to Formbricks, whose
`evaluateSingleCondition` and `getLeftOperandValue` exist **twice**, once in the widget runtime and
once in the editor, with matching cognitive complexity (212/215 and 93/93). Two implementations of
"does this answer satisfy this condition" is a correctness bug waiting for a release.

Unomi writes its two interpreters against two search engines and pays for it (`aggregateQuery` is
duplicated near-identically across the Elasticsearch and OpenSearch backends). We write one
evaluator and one Postgres compiler, and the pattern costs us nothing.

### The taxonomy worth adopting

**Nodes** (Dittofeed's fourteen — `dittofeed packages/isomorphic-lib/src/types.ts:331-345`, verified
this pass — trimmed, plus one addition):

| Node | What it means | Take? |
|---|---|---|
| `And` / `Or` | boolean composition over children | yes |
| `Not` | negation | **add** — Dittofeed lacks it; Unomi has `notCondition` |
| `Everyone` | match all | yes |
| `Trait` | property comparison on the subject (`path` + operator) | yes |
| `Performed` | event happened, with occurrence count and time window | yes |
| `LastPerformed` | most recent occurrence of an event, with property filters | yes |
| `KeyedPerformed` | occurrences grouped by a key in the event payload | yes, later |
| `SubscriptionGroup` | member of an opt-in/opt-out group | yes — §7 |
| `SubscriptionGroupUnsubscribed` | explicitly opted out | yes — §7 |
| `Manual` | explicit membership list | yes |
| `Includes` | reference another segment | yes |
| `RandomBucket` | percentage bucket, `percent` in [0,1] | yes — needed for A/B |
| `Broadcast` / `Email` | Dittofeed-internal plumbing | skip |

**Operators** — Dittofeed's nine (`dittofeed packages/isomorphic-lib/src/types.ts:232-241`, verified
this pass): `Exists`, `NotExists`, `Equals`, `NotEquals`, `GreaterThanOrEqual`, `LessThan`,
`Within(windowSeconds)`, `HasBeen(comparator GTE|LT, value, windowSeconds)`,
`AbsoluteTimestamp(timestamp, direction)`. Plus `RelationalOperators` (`=`, `>=`, `<`) for
occurrence counts on `Performed`. Add from Unomi's 22 (`unomi
plugins/baseplugin/src/main/java/org/apache/unomi/plugins/baseplugin/conditions/PropertyConditionEvaluator.java:288-486`)
the six every marketer asks for on day one: `Contains`, `NotContains`, `StartsWith`, `EndsWith`,
`In`, `NotIn`. Defer `MatchesRegex` (a user-supplied regex is a ReDoS surface), and skip Unomi's
`distance`/`isDay`/`all`/`inContains`/`hasSomeOf`/`hasNoneOf` until something asks for them.

### The one anti-pattern to refuse explicitly

Unomi encodes a comparison value in **five parallel nullable slots** — `propertyValue`,
`propertyValueInteger`, `propertyValueDouble`, `propertyValueDate`, `propertyValueDateExpr` (times
two for the multi-valued forms). The direct consequence is `PropertyConditionEvaluator.isMatch`: a
199-line, 61-branch `if`/`else-if` chain at cognitive complexity **651** — the worst function in the
repo — whose only job is to work out which slot is populated before any comparison happens. The
Unomi doc verified the number by reading the whole method and correctly calls the fix trivial.

Use **one tagged value**: `{ type: 'string'|'number'|'boolean'|'date'|'relativeDate', value }`. The
evaluator becomes `switch (type)` then `switch (operator)`, and the SQL compiler picks the cast from
`type` rather than inferring it. Upstream Unomi has not made this fix in fifteen years and 940 Java
files; making it costs us nothing at the start and is expensive later.

### Two security requirements, carried from the survey

- **Never accept SQL from a user.** (listmonk, above.)
- **Never send a filter tree to a client.** Formbricks' public `/environment` endpoint used to leak
  full segment filter trees to any anonymous visitor; it now returns only `{id, hasFilters}`
  (`formbricks packages/types/segment.ts:352-357`), with the membership check done server-side. Any
  endpoint an anonymous browser can call that touches targeting must have an explicit, typed,
  minimal public projection.

### First version

`segment` table (`id, workspace_id, name, definition jsonb, definition_updated_at, status`), a Zod
(or TypeBox) schema for the node union, one `evaluate(node, subject, events) → boolean`, one
`compile(node) → { sql, params }` producing a Postgres `WHERE`, and an exhaustiveness `assertNever`
on every switch — a discipline both Dittofeed and trigger.dev independently reached for on their
node unions, and the thing that makes adding a fifteenth node type safe. No caching yet; §3 adds it.

---

## 3. Computed properties / incremental recompute

### What the capability is, and why it is hard

Once segments exist, "who is in segment X" must stay current as events arrive, without rescanning
the entire event history on every question. And when someone edits the definition, the previously
computed answer is wrong in a way no incremental update can repair — the watermark itself is now
based on a different question.

### How Dittofeed does it — verified from source in this pass

The docs describe Dittofeed's compute as "incremental with a watermark" without saying what the
watermark is. It is the `computedPropertyPeriod` table, and the mechanics are:

**Read the watermark** (`dittofeed packages/backend-lib/src/computedProperties/periods.ts:166-181`):

```sql
SELECT DISTINCT ON (workspace_id, type, computed_property_id)
  type, computed_property_id, version,
  MAX(to) OVER (PARTITION BY workspace_id, type, computed_property_id) AS "maxTo"
FROM computed_property_period
WHERE workspace_id = $1 AND step = $2
ORDER BY workspace_id, type, computed_property_id, to DESC
```

The result is keyed in memory by `` `${computedPropertyId}-${version}` ``
(`dittofeed packages/backend-lib/src/computedProperties/periods.ts:66-73`).

**Write the next watermark** (`dittofeed .../periods.ts:213-227`): for each segment and user
property, look up the previous period *for that id at that version*, and insert a new row with
`from: previousPeriod ? previousPeriod.maxTo : null` and `to: now`. Then, in the same transaction,
delete rows for those ids older than `now - 5 minutes` (`.../periods.ts:258-276`) — so the table is
a rolling watermark of a handful of rows per property, not an audit log that grows.

**And here is the whole answer to "what happens when a definition changes":** `version` is
`segment.definitionUpdatedAt.toString()` (`dittofeed .../periods.ts:211`). Edit the definition, the
version string changes, the keyed lookup misses, `from` is `null`, and the next run recomputes that
property **from the beginning of time**. No invalidation command, no migration, no admin action —
membership self-heals, at the cost of exactly one full scan per definition edit. This is the
cleanest mechanism in the survey for a problem most systems handle with a manual "rebuild segment"
button.

The pipeline runs in three steps, each with its own period rows
(`dittofeed packages/isomorphic-lib/src/types.ts:6077-6081`): `ComputeState` → `ComputeAssignments`
→ `ProcessAssignments`. Because the watermark is per-step, a partial failure resumes at step
granularity rather than restarting the whole computation.

### The other two answers

**Matomo** solves the same problem for analytics aggregates and does two things Dittofeed does not.
First, the invalidation marker is **written from the hot path and is O(1)**: a late-arriving hit for
a past date calls `ArchiveInvalidator::rememberToInvalidateArchivedReportsLater`
(`matomo core/Archive/ArchiveInvalidator.php:111-140`), which writes a row into the `option` table
and nothing else — explicitly *not* an archive-table UPDATE, because that would run expensive
queries on the tracking path. A queue consumer drains `archive_invalidations` later. Second,
explicit invalidation **cascades in both directions**: down (a month invalidates its weeks and days)
and up (a day invalidates its week, month, and year, since those contain stale summed data) — but
only within one calendar year-month (`shouldPropagateUp`,
`matomo core/Archive/ArchiveInvalidator.php:392-396`), because the archive tables are physically
split per month. Freshness policy is asymmetric and correct: "today" has a TTL because it is still
changing; a closed past period is immutable once `DONE_OK` and only explicit invalidation ever
recomputes it.

Note that Matomo also makes the definition part of the cache key, arriving at Dittofeed's insight by
a different route: an archive's done-flag is `'done' . $segment->getHash()`
(`matomo core/ArchiveProcessor/Rules.php:107-110`) where the hash is an MD5 of the segment
definition string. Change the definition and it is simply a *different* archive — nothing to
invalidate. **Hashing the canonicalized definition is strictly better than Dittofeed's
`definitionUpdatedAt` timestamp**, because a no-op edit (open, save, no change) costs nothing
instead of forcing a full rescan.

**Unomi** is the cautionary case. Membership is denormalized onto the profile (`profile.segments` is
a `Set<String>`, so `isProfileInSegment` is an O(1) set check) and kept current by *three*
independent mechanisms with *three* independent knobs: a realtime rule action
(`EvaluateProfileSegmentsAction`) that recomputes for one profile as a side effect of event
processing; a scheduled batch sweep governed by `segmentUpdateBatchSize` (default 1000) and
`segmentRefreshInterval`; and a daily pass at `dailyDateExprEvaluationHourUtc` (default 05:00 UTC)
for date-relative conditions that drift with wall-clock time even with no new events. The Unomi doc
calls this out: there is no guaranteed consistency window, and after a definition edit a large
population can show stale membership until whichever sweep happens to touch each profile. Three
knobs is not a consistency model.

But Unomi contributes the best single optimization in this section: **the materialized counter**.
`SetEventOccurenceCountAction`
(`unomi plugins/baseplugin/src/main/java/org/apache/unomi/plugins/baseplugin/actions/SetEventOccurenceCountAction.java:163-185`)
increments a named counter inside `profile.systemProperties.pastEvents` inline, as part of ordinary
event processing. `PastEventConditionEvaluator.eval` then reads it in O(1) when a
`generatedPropertyKey` is present, falling back to a live count query otherwise (marked `TODO` for
deprecation upstream). "How many times has X happened" is paid once per event, not once per
evaluation and not once per batch.

### Definition-change behavior, side by side

| System | On definition change |
|---|---|
| Dittofeed | version key changes → `from = null` → automatic full recompute |
| Matomo | segment hash changes → it is a different archive → computed on first request; the old one ages out under retention |
| Unomi | config-dependent; may drift until the next sweep touches each profile |
| Formbricks | no cache — segments are evaluated per identify call, so nothing to invalidate |

### Verdict and first version

**Build it, but not first.** Ship §2's live evaluation uncached, and add this when a segment is slow
enough to justify it — with the live evaluator retained as the correctness oracle the cached path is
tested against.

The first version:

```sql
CREATE TABLE computed_property_period (
  id                    uuid PRIMARY KEY,
  workspace_id          uuid NOT NULL,
  step                  text NOT NULL,     -- compute_state | compute_assignments | process_assignments
  property_type         text NOT NULL,     -- segment | attribute
  computed_property_id  uuid NOT NULL,
  definition_hash       text NOT NULL,     -- hash of the canonicalized definition (Matomo's improvement)
  from_ts               timestamptz,       -- NULL = compute from the beginning
  to_ts                 timestamptz NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON computed_property_period (workspace_id, step, computed_property_id, to_ts DESC);
```

Plus: materialized counters for `Performed`-style nodes, incremented on the event write path
(Unomi's pattern, applied at ingest rather than in a rule engine). Plus: Matomo's split between
"mark stale — cheap, inline, on the hot path" and "recompute — expensive, queued" — which §7 shows
also gives us GDPR erasure for free.

---

## 4. Message sending and delivery

### What the capability is

From "send this" to a provider API call: resolve the recipient list, render per recipient, choose a
credentialed provider, call it, and **record what happened to each recipient**. The last step is
where the survey divides most sharply.

### Provider abstraction — three shapes, one winner

**Novu.** Per channel (`mail`, `sms`, `push`, `chat`) a factory holds a flat array of handler
instances and `getHandler(integration)` linear-scans for the first whose `canHandle(providerId,
channel)` matches (`novu libs/application-generic/src/factories/mail/mail.factory.ts:26-63`). Each
handler wraps exactly one third-party SDK behind `buildProvider(credentials)` / `send(...)`, with
the SDK code one level down in `novu packages/providers/src/lib/<channel>/<provider>/`. Adding a
provider is a file plus one array entry. Live count verified in the Novu analysis **against the
dispatcher, not the directory listing**: 20 email, 38 SMS, 8 push, 13 chat — roughly 79 integrations,
all reachable.

**Dittofeed.** One file per destination under `dittofeed packages/backend-lib/src/destinations/`
(`amazonses`, `sendgrid`, `resend`, `postmark`, `mailchimp`, `smtp`, `twilio`, `signalwire`, `fcm`).
Per the coordinator correction in that doc, **`fcm` is dead**: the generic dispatcher throws
`"not implemented"` for MobilePush (`dittofeed packages/backend-lib/src/messaging.ts:2415`) and
`fcm.ts`'s `sendNotification` has no call sites outside its own test. Count live adapters as email +
SMS only. Gmail is handled inline in `messaging.ts` rather than in `destinations/` at all.

**listmonk.** A four-method `Messenger` interface (`Name`/`Push`/`Flush`/`Close`,
`listmonk internal/manager/manager.go:64-69`) with exactly two implementations: an SMTP connection
pool keyed by from-address or domain, and a generic HTTP `Postback` that forwards a fully rendered
message to an external relay. Clean, minimal, and provider diversity is entirely someone else's
problem.

**Take Novu's factory.** It is the only one demonstrated at N≈79 without the dispatcher itself
growing in complexity, and each handler is testable in isolation. And take the Novu analysis's
*verification method* as a standing review rule: **count live registrations in the dispatcher, not
files in a directory.** Dittofeed's `fcm` is exactly the failure that rule catches.

### Credential handling

Novu encrypts integration credentials at rest — AES-256-CBC, a fresh random 16-byte IV per
encryption, key from `STORE_ENCRYPTION_KEY`, stored as `iv_hex:ciphertext_hex`
(`novu libs/application-generic/src/encryption/cipher.ts`), with `GetDecryptedIntegrations` as the
single read-side decrypt seam. Channel-connection OAuth tokens use a parallel scheme that prefixes
the ciphertext with `nvsk.` so a leaked value is self-identifying.

Adopt: encryption at rest, one decrypt seam (so you can audit every place a plaintext credential
comes into existence), and the self-identifying prefix. **One deliberate departure: use AES-256-GCM,
not CBC.** CBC without a MAC is unauthenticated; GCM is the same cost and detects tampering.

Selection when several credentials exist for one channel: Novu's `SelectIntegration` filters by
`active: true`, orders by `primary`/`priority`, and narrows by `conditions` (e.g. a tenant match)
— the shape is right. The exact condition-matching algorithm was flagged unverified in the Novu
analysis and remains unverified here.

### Per-recipient result tracking — who records, who doesn't

This is the section the brief asks to be explicit about, and it is worth being blunt.

**Novu records it properly.** One `Message` row per send attempt on a channel step, holding channel,
provider, rendered content, and `deliveredAt` — plus `ExecutionDetails` rows for every decision
along the way. Best in the survey.

**Dittofeed records it as events.** Verified this pass: `sendMessage` submits
`InternalEventType.MessageSent` / `MessageFailure` / `MessageSkipped` per attempt
(`dittofeed packages/backend-lib/src/messaging.ts:1209`, `:1217`, `:1286`, `:1299`, `:1386`,
`:1397`, and so on through each channel arm) into the ClickHouse user-event stream. Queryable, but
it is an event log — there is no row you can join on to ask "what is the current delivery state of
this message."

**listmonk does not.** The only durable per-recipient state is `campaigns.last_subscriber_id`
advancing once per `BatchSize` fetch (default 1,000). Messages already pulled into the in-memory
`campMsgQ` when the process dies have no ledger: on resume they are either dropped from the count or
re-selected and re-sent (`listmonk internal/manager/pipe.go:81-139`,
`listmonk queries/campaigns.sql:367-371`). `campaign_views`/`link_clicks` are analytics, not a
ledger. Fine for a newsletter; not a guarantee any receipt-critical sender can use.

**Chatwoot does not, and it is worse than the Dittofeed analysis states.** Verified from source this
pass: `Twilio::OneoffSmsCampaignService#process_audience`
(`chatwoot app/services/twilio/oneoff_sms_campaign_service.rb:19-32`) iterates contacts, calls
`channel.send_message`, and on a `Twilio::REST::TwilioError` **writes a Rails log line and `next`s**
— no row, no retry, no counter, no record that this contact was even attempted. Meanwhile
`Campaign#mark_processing!` (`chatwoot app/models/campaign.rb:71-78`) takes a lock, flips status to
`processing`, and refuses re-entry if already `processing` — so a crash mid-loop strands the
campaign permanently *and* leaves no record of which contacts were reached. The Dittofeed doc's
phrase "no per-recipient ledger" understates it: there is no per-recipient anything.

**Formbricks is not a sender, but its ingestion pipeline is the model for the split.** The durable
write and the quota evaluation share one Postgres `$transaction`
(`formbricks apps/web/app/api/client/[workspaceId]/responses/lib/response.ts:34-52`); everything
else — webhooks, integrations, follow-up emails, metering — is deferred to a BullMQ job that runs
after the HTTP response has already returned.

### Verdict and first version

**Write the per-recipient row before the provider call, in the same transaction that claims the
work.** This is the single most consequential design decision in this section, and three of the five
systems above got it wrong.

```sql
CREATE TABLE message_delivery (
  id                  uuid PRIMARY KEY,
  workspace_id        uuid NOT NULL,
  subject_id          uuid NOT NULL,
  source_kind         text NOT NULL,        -- journey | broadcast | transactional
  source_id           uuid NOT NULL,
  journey_run_id      uuid,                 -- when source_kind = 'journey'
  node_id             text,
  channel             text NOT NULL,        -- email | sms | push | webhook
  provider            text NOT NULL,
  template_id         uuid NOT NULL,
  template_version    int  NOT NULL,        -- what we actually rendered
  address             text NOT NULL,        -- the resolved destination, as sent
  idempotency_key     text NOT NULL,
  status              text NOT NULL,        -- pending | sent | delivered | bounced | complained | failed | skipped
  reason              text,                 -- closed enum; §1 rule 4
  provider_message_id text,
  error_code          text,
  error_body          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz,
  settled_at          timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX ON message_delivery (workspace_id, subject_id, created_at DESC);
CREATE INDEX ON message_delivery (workspace_id, status) WHERE status = 'pending';
```

The unique idempotency key is what makes at-least-once retry safe (§1 rule 1). `template_version`
is what makes "what exactly did we send them" answerable after the template is edited. The
`status='pending'` partial index is the recovery sweep: anything pending past a threshold is either
re-driven or marked failed on the next boot.

Send flow: claim → insert `message_delivery` as `pending` in the claiming transaction → check
suppression (§5) → render (§6) → call the provider with the idempotency key → update to `sent` with
`provider_message_id`. Provider webhooks later move it to `delivered`/`bounced`/`complained`.

---

## 5. Deliverability

### What the capability is, and why it matters more than it looks

Bounces, complaints, retries, throttling, warm-up. Getting this wrong does not produce an error
message; it produces a slow, invisible collapse in inbox placement that is expensive to reverse.

### listmonk is the strongest, and here is exactly how it works

**Ingestion from six providers plus a mailbox.** Six webhook handlers — SES, Azure (shared-secret
header), Sendgrid, Postmark (basic auth), ForwardEmail (HMAC), Lettermint (HMAC) — plus optional
POP3 mailbox polling, all funnel into one `chan models.Bounce`
(`listmonk internal/bounce/bounce.go:20-47`, `:50-51`, `:125-139`). Six different auth shapes, one
internal representation.

**Threshold → action, as a single atomic statement.** Every bounce, whatever its source, reaches
`core.RecordBounce` (`listmonk internal/core/bounces.go:60-87`), which looks up the configured
`(count, action)` pair for that bounce type from the `bounce.actions` setting — defaulted in
`listmonk schema.sql:287` to soft→none, hard→blocklist at 1, complaint→blocklist at 1 — and passes
it into one SQL statement. Read in full this pass
(`listmonk queries/bounces.sql:1-30`), that statement is a CTE chain which:

1. resolves the subscriber by UUID or by email, whichever the provider payload carried;
2. computes `num = COUNT(*) + 1` over existing bounces of that type — the `+1` counting the
   insertion currently in flight;
3. runs `block1` (set `subscribers.status='blocklisted'`) **only** when the action is `blocklist`
   and `num >= threshold` and the subscriber isn't already blocklisted;
4. runs `block2` (set `subscriber_lists.status='unsubscribed'`) under the same guard when the
   action is `unsubscribe`;
5. inserts the bounce row only if the subscriber isn't already blocklisted and the count hasn't
   already exceeded the threshold;
6. ends with a `DELETE FROM subscribers` that fires only when the action is `delete`.

Count and act happen in one statement, so there is no window in which two concurrent bounces both
read "threshold not yet reached."

**Throttling: exactly two knobs, both inline.** A per-worker per-second cap (`MessageRate`, checked
inside the dispatch loop, `listmonk internal/manager/manager.go:487-582`) and an optional sliding
window checked after each subscriber batch is pushed (`listmonk internal/manager/pipe.go:94-135`).
Effective ceiling ≈ `Concurrency × MessageRate`, further capped by the window. No rate-limiter
service, no token-bucket abstraction.

**Compliance headers:** optional RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` pair
(`listmonk internal/manager/manager.go:530-533`).

### What the rest of the survey does — and the gap

Novu, Dittofeed, and Formbricks all have generic retry with backoff, and **none of them has a
bounce→suppression loop at all.** rudder-server has the most sophisticated backpressure in the set —
four independent composable layers (pickup throttle, delivery throttle, circuit breaker, per-job
exponential backoff) — but it is throttling a data pipeline, not protecting a sending reputation:
there is no notion of a recipient domain anywhere in it. Mautic has `MonitoredEmail` for bounce and
reply handling, but that doc is the thin one and the claim is inherited, not verified.

**Nobody in the survey implements warm-up.** No gradual volume ramp on a new sending domain or IP,
no per-recipient-domain rate limit, no reputation signal fed back into scheduling. That is a real
gap we will have to invent (§C.3).

### Minimum credible implementation

1. **A suppression table, checked at send time.**
   ```sql
   CREATE TABLE suppression (
     workspace_id uuid NOT NULL,
     channel      text NOT NULL,
     address      text NOT NULL,       -- normalized: lowercased email, E.164 phone
     reason       text NOT NULL,       -- hard_bounce | complaint | manual | invalid | unsubscribed_all
     source       text NOT NULL,       -- which provider/webhook/admin action created it
     created_at   timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (workspace_id, channel, address)
   );
   ```
   Checked **at send time, not at audience-build time.** The audience was computed hours ago; the
   complaint arrived twenty minutes ago. This ordering is not optional.
2. **Normalizing webhook receivers**, one per provider, each verifying that provider's signature
   shape, all producing `{type: soft|hard|complaint, address, provider_message_id, provider, raw}`.
   listmonk has all six auth shapes to copy the *approach* from (§A: ideas only).
3. **listmonk's threshold→action table, as one statement.** Configurable per bounce type; ship with
   listmonk's defaults, which are sane.
4. **Retry only what is retryable.** Soft bounces and transport-level 4xx/5xx retry with exponential
   backoff. A hard bounce or a complaint never retries — it suppresses. Abort policy from
   rudder-server: stop retrying when **both** `attempt >= max` **and**
   `now - first_attempted_at > window` (`rudder-server router/handle.go:756-783`). A count ceiling
   alone gives up on a slow-but-recoverable provider; a time ceiling alone never gives up on a
   fast-failing one.
5. **Two rate limits:** a global send rate (listmonk's `Concurrency × MessageRate` shape) and a
   per-recipient-domain rate. Add a circuit breaker per `(provider, recipient_domain)` on
   rudder-server's shape (`rudder-server router/batchrouter/circuitbreaker/circuitbreaker.go:44-71`
   — opens after 3 consecutive failures, stays open ~5s, allows one half-open probe) so a
   temporarily-refusing domain stops consuming send capacity.
6. **Warm-up, deferred but designed for:** a `sending_domain_quota (domain, day, allowed, used)`
   row incremented on a ramp schedule, consulted by the same gate as (5). Nobody surveyed built
   this; it becomes urgent the first time a new domain sends real volume.

**Complaints are legally load-bearing.** A complaint must produce an immediate, permanent
suppression, and it must be *the same* suppression the audience builder and the send gate both
consult — not a parallel list that can disagree (§C.2).

---

## 6. Templating and personalization

### The consensus

Liquid, in three of the four repos that template anything: Dittofeed (LiquidJS), Chatwoot (Shopify
Liquid), Mautic (Twig — the odd one out, and Symfony-specific). listmonk uses Go `html/template`
plus a de-fanged Sprig. For a TypeScript product, LiquidJS is the obvious choice: marketers already
know the syntax, it is sandboxed by construction (no arbitrary code), and both halves worth stealing
below are written against it.

### Half one: Chatwoot's drops layer

`chatwoot app/drops/` exposes exactly six objects to templates — `account`, `contact`,
`conversation`, `inbox`, `message`, `user` — rendered through `Liquid::CampaignTemplateService`.
That is the entire mechanism, and it is the right one: a template author gets an explicit,
allowlisted surface rather than reflective access to a model. It is MIT and it is small. The
Chatwoot analysis calls it the highest port-value-per-line in that repo and it is correct.

### Half two: Dittofeed's compliance tags — and the bug not to copy

`dittofeed packages/backend-lib/src/liquid.ts` registers five custom tags plus a `markdown` filter:
`unsubscribe_link` (`:160`), `unsubscribe_url` (`:175`), `subscription_management_link` (`:181`),
`subscription_management_url` (`:196`), `view_in_browser_url` (`:234`).

Read in full this pass, the mechanics are: `generateUnsubscribeUrl`
(`dittofeed packages/backend-lib/src/liquid.ts:80-119`) pulls `secrets`, `workspace_id`,
`subscription_group_id`, the `user` property assignments, and `identifier_key` out of the render
scope and calls `generateSubscriptionChangeUrl` with an HMAC secret (`SecretNames.Subscription`), so
the resulting link is an unauthenticated but signed URL scoped to one person and one group.
`view_in_browser_url` (`:203-232`) hashes `(workspaceId, messageId, secretKey)` and appends it to
`/api/public/view-in-browser?w=&m=&h=`. Both anchor-emitting tags include `clicktracking=off` so an
ESP's link rewriting cannot break the unsubscribe — a detail that looks trivial and is not.

**The bug:** when any required piece is missing, `generateUnsubscribeUrl` logs an error and
**returns an empty string**, and the tag then emits `<a class="df-unsubscribe" clicktracking=off
target="_blank">unsubscribe</a>` — an anchor with no href. The email renders, sends, and is
non-compliant, and the only signal is a log line. A missing unsubscribe URL must **hard-fail the
send**, not degrade silently.

### listmonk's inversion is the better default

listmonk bakes `UnsubscribeURL`, `MessageURL` (view-in-browser), and `TrackView` (open pixel)
directly into the shipped base template every campaign wraps into
(`listmonk static/email-templates/default.tpl:94-101`). Every campaign gets them unless an admin
actively removes them. Dittofeed's tags are opt-in per template, which means one forgetful author
ships a non-compliant email.

**Take listmonk's default-on posture with Dittofeed's tag implementations.** Compliance elements
belong in a base layout that every message inherits, with removal requiring a deliberate act that is
logged.

One more listmonk detail worth carrying: `listmonk internal/manager/manager.go:676-678` deletes
`env`, `expandenv`, and `getHostByName` from the Sprig function map before exposing it to campaign
templates — a real SSRF and info-leak guard. If we ever hand template authors a general-purpose
helper library, strip the environment and network functions first.

### The email builder UI

`listmonk frontend/email-builder/` is a **separately MIT-licensed** React/MUI application
(`@listmonk/email-builder`, vendored from `@usewaypoint/editor-sample`), built independently and
loaded into listmonk's Vue admin as a UMD script inside an `<iframe>`. It is the only ready-made
drag-and-drop email block editor in the entire survey, and the one piece of literal code the survey
recommends taking.

**Pull it from its true upstream, `usewaypoint/email-builder-js`, not out of listmonk's AGPL
tree** — same MIT terms, clean provenance, no argument about whether a file inside an AGPL repo
inherits anything.

Its data model is worth copying too: the editor produces a JSON block document, listmonk stores it
in `campaign.body_source` and the rendered HTML in `campaign.body`, and skips Go template
compilation entirely for the visual content type (`listmonk models/campaigns.go:160`). Keep both
columns — the JSON is the editable truth, the HTML is what ships, and you can re-render the HTML
from the JSON when the renderer improves.

### First version

`template` (`id, workspace_id, name, channel, version, subject, body_source jsonb, body_html,
body_text, created_at`) with versions immutable once used by a send. LiquidJS with a drops-style
allowlisted context (`subject`, `attributes`, `event`, `workspace`, `unsubscribe`). A base layout
carrying the compliance elements. Registered tags for `unsubscribe_url`, `preferences_url`,
`view_in_browser_url` — each of which **throws** rather than returning empty when its inputs are
missing. Vendored `email-builder-js` from upstream behind the visual editor.

---

## 7. Consent, preferences, and compliance

### What the capability is

Whether we are allowed to contact this person, on this channel, about this thing, right now — and
being able to prove it later. This is a legal surface. The engineering requirements below are stated
precisely; they are not legal advice, and the specific obligations that apply depend on
jurisdiction and on facts about the business that source code cannot tell you.

### Four models, each solving a different piece

**1. Dittofeed's subscription groups.** A first-class resource with its own controllers
(`subscriptionGroupsController`, `subscriptionManagementController`), **plus two segment node
types** — `SubscriptionGroup` and `SubscriptionGroupUnsubscribed`
(`dittofeed packages/isomorphic-lib/src/types.ts:358`, `:369`) — so opt-out state is queryable in
exactly the same language as every other audience condition, plus the Liquid tags from §6 as the
authoring-side surface. `subscriptionGroupType` on the node distinguishes opt-in from opt-out
semantics. Chatwoot has no equivalent concept at all.

**2. Novu's five-tier preference merge.** One `Preferences` collection with a `type` discriminator
over `WORKFLOW_RESOURCE` (the author's default), `USER_WORKFLOW` (an org member's override),
`SUBSCRIBER_GLOBAL` (a blanket opt-out), `SUBSCRIBER_WORKFLOW` (per-workflow override), and
`SUBSCRIPTION_SUBSCRIBER_WORKFLOW` (scoped to one topic subscription). `MergePreferences.execute`
(`novu libs/application-generic/src/usecases/merge-preferences/merge-preferences.usecase.ts:58-98`)
applies them in a precedence spelled out in its own docstring — resource → user → subscriber global
→ subscriber workflow — by deep merge. Two carve-outs are enforced in the same function
(`:67-73`): if any workflow-level preference sets `all.readOnly: true`, or the caller passes
`excludeSubscriberPreferences`, the subscriber tiers are dropped from the merge entirely.

Three things make this the model to copy. It is **one pure function** with the order written down.
It is enforced at **exactly one call site** — `SendMessage.evaluateChannelPreference`
(`novu apps/worker/src/app/workflow/usecases/send-message/send-message.usecase.ts:323-421`) — which
is what stops preference logic leaking into every send path. And a skip records **which tier caused
it** (`preferenceDetailFromPreferenceType`, `:384-392`), so a support engineer can distinguish
"blocked by the workflow's default" from "this person opted out."

**3. Unomi's consent model.** `Consent` is a plain value object: `scope` + `typeIdentifier`
(externally defined — Unomi ships no consent vocabulary) + status (`GRANTED`/`DENIED`/`REVOKED`) +
`statusDate`/`revokeDate`, with `isConsentGrantedAtDate(Date)` doing the time-windowed check. They
live in a `Map<String,Consent>` on the profile, so one person holds many independent consents.

Its real contribution is architectural: **consent reuses the general condition language instead of
growing its own.** Mutation goes through the ordinary rule/action pipeline (`ModifyConsentAction`
reads a consent map off an event and calls `profile.setConsent`, returning `PROFILE_UPDATED` only if
something actually changed — so re-applying the same consent is a no-op). Querying goes through
`ConsentAccessor`, one of a family of property accessors that expose object fields as dotted paths,
so "profiles who denied consent type X" is just a `propertyCondition` over `consents.X.status`.

What Unomi does *not* have, and the doc is honest about: no consent-type registry, no double opt-in
workflow, and **consent does not automatically gate collection** — you would build that as a rule
guard. Unomi gives you the pieces, not a policy engine.

**4. Matomo's privacy machinery** is the most production-hardened in the survey, and it operates at
three points. On the **write path**: IP anonymization masks octets *before persistence*
(`matomo plugins/PrivacyManager/IPAnonymizer.php:39-54`) — the raw IP is never written, not scrubbed
later; user IDs are pseudonymized as `sha1($userId . $salt)` with a per-installation salt,
**deliberately stable** so cross-visit identity survives while the raw ID never lands; order IDs use
`sha1(randomInt . orderId . time() . salt)`, **deliberately unstable** because they never need to be
re-derived; referrer URL, name, and keyword are anonymized *after* referrer-type detection so the
"was this a search engine" classification still works. Via a **data-subject API**: right-to-erasure,
below. Via **scheduled purging**: two independent purgers with two independent retention windows —
`LogDataPurger` for raw rows, `ReportsPurger` for aggregates — because the normal posture is short
retention for PII-adjacent raw data and long retention for rolled-up numbers.

### The finding the brief asks for: GDPR deletion and archive invalidation are the same mechanism

`DataSubjects::deleteDataSubjects($visits)`
(`matomo plugins/PrivacyManager/Model/DataSubjects.php:110-147`) does four things:

1. fires `PrivacyManager.deleteDataSubjects` so third-party plugins storing their own per-visit data
   outside core log tables can delete their rows too;
2. computes the affected calendar dates (`getDatesToInvalidate`, `:165-193`) by selecting
   `visit_last_action_time` for the doomed visits and converting to the site's timezone;
3. deletes the log rows across **every** registered log table, sorted so foreign-key-adjacent tables
   delete in a safe order (`sortLogTablesToEnsureDataErasureFromAllTablesIsPossible`, `:249-296`);
4. calls `invalidateArchives` (`:149-163`) — **which is the same
   `ArchiveInvalidator::rememberToInvalidateArchivedReportsLater` deferred marker the tracker writes
   for a late-arriving hit** (§3).

The consequence: deletion is not "remove the raw row and hope the aggregates catch up." It
explicitly forces every pre-aggregated report that could contain the deleted person's contribution
to recompute, so they actually disappear from historical dashboards — not just from future raw
queries. And because erasure rides the *existing* pipeline rather than a bespoke reconciliation job,
**every future report type inherits deletion correctness for free, with zero extra code per
report.**

The ordering implication for us is concrete: build §3's invalidation path first, and erasure becomes
a caller of it. Build erasure first and you will write a second, parallel mechanism that drifts out
of sync with the first — which is exactly the failure mode this design eliminates.

### Engineering requirements

- **Unsubscribe must work without a login**, from a signed URL. Dittofeed's HMAC-per-identifier
  scheme is the right shape; listmonk's per-subscriber UUID link is the simpler one. Never require
  authentication to opt out.
- **Ship RFC 8058 `List-Unsubscribe` and `List-Unsubscribe-Post` headers**
  (listmonk `internal/manager/manager.go:530-533`). One-click unsubscribe is effectively required by
  the major mailbox providers' bulk-sender rules.
- **The transactional carve-out must be explicit and audited.** Novu's `all.readOnly` is exactly
  this and exactly the sharp edge: a workflow author can make a channel non-optional, which is
  correct for a password reset and abuse for a newsletter. Model it, restrict who can set it, and
  log every message that used it.
- **Suppression and consent are different things and must not be collapsed** (§5). A hard bounce
  suppresses an address without withdrawing consent — the person did not choose anything. A
  complaint should do both.
- **Record consent as an event, not only as state.** Current status answers "may we send"; an
  append-only `consent_event (subject_id, scope, type, status, source, ip, occurred_at, evidence
  jsonb)` answers "when and how was this given," which is the question that actually gets asked.
  Unomi's mutation-through-the-event-stream gets this incidentally; make it deliberate.
- **Preference resolution is one pure function called from one place** (Novu), and it records which
  tier decided.

### First version

`subscription_group (id, workspace_id, name, type: opt_in|opt_out, channel)`;
`subscription_state (workspace_id, subject_id, group_id, state: subscribed|unsubscribed, source,
updated_at)`; `consent_event` as above (append-only); one `resolveSendability(subject, channel,
group, messageKind) → { allowed, reason }` pure function called from exactly one place in the send
path; two segment node types wired to `subscription_state`; the §6 base-layout tags pointing at a
signed preferences page. Start with two tiers (group default, subject override) — Novu's five-tier
model is the right *shape* to grow into, not the right thing to build on day one.

---

## 8. Identity and profiles

### What the capability is

An anonymous browser becomes a known person. Two records turn out to be the same human. Attributes
arrive from three sources and disagree. All of this has to happen without losing history and without
becoming unrecoverable.

### The mechanisms worth taking

**Jitsu's inline anonymous→identified stitching** (`jitsu
libs/destination-functions/src/functions/user-recognition.ts`, ~141 lines) is the best-shaped answer
in the survey. Every un-identified `page`/`track`/`screen` event is appended to a per-connection
store keyed by `anonymousId` with a 30-day lookback. When an `identify` arrives carrying a `userId`
(or a configured identifying trait), **all buffered anonymous events for that `anonymousId` are
evicted, stamped with the userId, trait-merged, and re-injected into the function chain**
(`return [event, ...res]`, `:84`) — so the person's pre-identification activity flows through the
same destination pipeline as if it had arrived identified. It is storage-agnostic: Jitsu uses
MongoDB, but any TTL-capable store works, including a Postgres table with an `expires_at` column.

**Unomi's per-attribute merge strategy** is the best idea nobody else has. `PropertyType` declares a
pluggable `mergeStrategy` id, with four shipped implementations —
`AddPropertyMergeStrategyExecutor`, `MostRecentPropertyMergeStrategyExecutor`,
`OldestPropertyMergeStrategyExecutor`, `NonEmptyPropertyMergeStrategyExecutor`. That is the only
principled answer in the survey to "both profiles have a `plan` attribute and they disagree." Every
other system either takes the newest or takes whichever it happened to read second.

Unomi also flags the failure mode to avoid: `Profile.mergedWith` is `@Deprecated` in favor of
explicit `ProfileAlias` linking, invoked by the caller rather than inferred automatically. Implicit,
unrecorded merge is unrecoverable, and they learned it the expensive way.

**Matomo's layered resolution** (`matomo core/Tracker/Request.php:756-819`) tries signals in strict
precedence: application user id (if `enable_userid_overwrites_visitorid`) → a forced visitor id
(`&cid=`, for server-side integrations that own their identity) → third-party cookie → first-party
cookie. If none resolve, and only then, it falls back to a fingerprint (`Settings::getConfigId`, a
64-bit hash over OS/browser/plugin-flags/IP/language plus a **per-installation salt** so fingerprints
cannot be correlated across separate Matomo installs, plus optionally a rotating daily salt). Visit
stitching: a new visit begins if the last action is older than `visit_standard_length` (commonly 30
minutes), or `&new_visit=1` was passed, or — when configured — the last action was a different
calendar day, or the user id changed mid-session (logging in as someone else ends the anonymous
session immediately).

**Take the layering; skip the fingerprint.** Its own inputs (Flash, Java, Silverlight, QuickTime
presence flags) are vestigial in 2026, and a device fingerprint is a consent liability in exactly
the jurisdictions §7 is about. Cookie plus explicit id is enough.

**Chatwoot's attribute model** is the cheap sound starting point: `custom_attributes` jsonb +
a `CustomAttributeDefinition` registry + a `contact_type` enum (`visitor`/`lead`/`customer`).
Formbricks has `Contact`/`ContactAttribute` in the shared schema, but identification is gated behind
a runtime enterprise licence check (`formbricks apps/web/app/api/v1/client/[workspaceId]/user/route.ts:137-145`),
so its free tier can target only by trigger — worth knowing when comparing feature sets, not a
design to copy. PostHog is referenced in the brief for identity but has no analysis doc in this
batch; nothing here is sourced from it.

### First version

Two tables instead of one, and this is the decision that is expensive to reverse:

```sql
CREATE TABLE subject (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind         text NOT NULL DEFAULT 'person',  -- visitor | lead | customer
  attributes   jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subject_identifier (
  workspace_id uuid NOT NULL,
  kind         text NOT NULL,   -- email | phone | user_id | anonymous_id | device_token
  value        text NOT NULL,   -- normalized: lowercased email, E.164 phone
  subject_id   uuid NOT NULL REFERENCES subject(id),
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, value)
);

CREATE TABLE subject_merge (            -- append-only. never delete from this.
  id          uuid PRIMARY KEY,
  winner_id   uuid NOT NULL,
  loser_id    uuid NOT NULL,
  reason      text NOT NULL,
  performed_by text,
  merged_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE attribute_definition (
  workspace_id  uuid NOT NULL,
  key           text NOT NULL,
  value_type    text NOT NULL,     -- string | number | boolean | date  (§2's tagged type)
  merge_strategy text NOT NULL DEFAULT 'most_recent',  -- most_recent | oldest | add | non_empty
  protected     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, key)
);
```

With identifiers in their own table, merge is an `UPDATE subject_identifier SET subject_id = winner`
plus an attribute merge driven by `attribute_definition.merge_strategy`, plus one `subject_merge`
row. With a `contacts.email`-keyed schema, merge is a migration nobody wants to write. **Get this
right in week one** — it is the single most expensive thing in this document to retrofit.

Anonymous backfill: buffer un-identified events keyed by `anonymous_id` with a TTL, and on identify,
re-drive them through the same pipeline (Jitsu's eviction pattern). Do not write a second code path
for replayed events.

---

## 9. Event ingestion

### Keep this proportionate — we are not building a CDP

The capability is: a capture endpoint, durable storage, and an honest statement of what guarantee
is actually achieved. The survey's four ingestion designs span the whole spectrum, and the useful
output is knowing which guarantee we are choosing.

**rudder-server gives the strongest guarantee and states it most clearly.** Two levels of batching
exist purely for write throughput — first per-user hashed worker channels, then a cross-user
coalescing stage — and then one Postgres transaction
(`rudder-server gateway/handle_lifecycle.go:509-517`, `WithStoreSafeTx` → `StoreInTx`). **The HTTP
response is not sent until the commit completes.** So: an event is acknowledged if and only if it is
durably committed. Everything downstream is decoupled by the job table, and a crash of any consumer
loses nothing.

**Jitsu gives the weakest and is honest about it.** `IngestHandler` returns `200 {"ok": true}` the
instant the Kafka produce call is accepted by the client library, before anything has processed it
(`jitsu bulker/ingest/router.go:125-131`). At-least-once, with two independent bounded-retry tiers
each terminating in its own dead-letter topic and **no transaction spanning them** — you have to
correlate two DLQs to know whether a given event ever reached its destination.

**Unomi and Matomo are both fully synchronous per request, with no transactional envelope.** Unomi
persists the event, runs listeners, then conditionally persists the profile and session as separate
sequential writes; a crash between them leaves the event recorded and the profile stale, or the
reverse. Matomo writes `log_visit` and `log_link_visit_action` inline on the request thread, with a
documented lock-ordering workaround (`matomo core/Tracker/Visit.php:174-182`, citing upstream issue
17173) because the two writes must happen in a specific order to avoid deadlock.

### The one idea to take: single-owner partitions instead of row locks

rudder-server's `jobsdb` gets its no-double-delivery guarantee **structurally**, and the
rudder-server analysis found this only by tracing the read path against the write path — no graph
tool surfaced it. `grep -rn "FOR UPDATE\|SKIP LOCKED" jobsdb/*.go` returns nothing outside tests.
Reads never mutate (`rudder-server jobsdb/jobsdb_get.go:343-674` are pure `SELECT`s against the
dataset tables joined with a `v_last_*` view). The claim happens one layer up, in a pickup loop that
reads a batch and writes one `Executing` status row for the whole batch before dispatching
(`rudder-server router/handle.go:250-357`). And because each job partition is owned by exactly one
such loop — enforced by three isolation modes, `none`/`workspace`/`destination`
(`rudder-server router/isolation/isolation.go:17-46`) — **there is never a second claimant, so there
is nothing for a row lock to protect.** Crash recovery is therefore a boot-time sweep of anything
still `Executing` (`rudder-server jobsdb/admin.go:27-37`), not a lease-expiry mechanism.

Status is append-only; the current status is a view:
`SELECT DISTINCT ON (job_id) * FROM <status_table> ORDER BY job_id ASC, id DESC`
(`rudder-server jobsdb/jobsdb_dataset_ddl.go:242`). That is the same append-only-plus-latest shape
as trigger.dev's `TaskRunExecutionSnapshot` chain, reached independently by two teams.

This scales *down* as well as up: with one poller, single ownership is free. §1's design uses
`FOR UPDATE SKIP LOCKED` anyway, because it costs nothing in Postgres and it tolerates a second
poller appearing (a redeploy overlap, a stray Electron instance) without corrupting anything. Take
the append-only status idea; take `SKIP LOCKED` as belt-and-braces over single ownership rather than
instead of it.

### First version

```sql
CREATE TABLE event (
  id           uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  subject_id   uuid,                     -- nullable until identity resolves (§8)
  anonymous_id text,
  name         text NOT NULL,
  properties   jsonb NOT NULL DEFAULT '{}',
  occurred_at  timestamptz NOT NULL,     -- client-asserted
  received_at  timestamptz NOT NULL DEFAULT now(),
  dedup_key    text,
  source       text NOT NULL             -- sdk | api | internal
);
CREATE UNIQUE INDEX ON event (workspace_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX ON event (workspace_id, subject_id, occurred_at DESC);
CREATE INDEX ON event (workspace_id, name, occurred_at DESC);
```

One `POST /v1/events` that validates, resolves identity (§8), inserts, and **acks after commit**
(rudder-server's guarantee, which we can afford because we are not doing 100k/s). Auth by write key
in any of four places — `Authorization: Bearer`, `Authorization: Basic`, an `X-Write-Key` header, or
a `?writekey=` query parameter (`jitsu bulker/ingest/router.go:414-444`) — because the query-param
form is the only one an `<img>` pixel can use. Keys are per-source, not a shared secret.

Explicitly **not** building: Kafka, ClickHouse, a two-tier retry topology, a warehouse fan-out, or a
transformation sandbox. Revisit columnar storage when a `count(*) ... GROUP BY` over a month of
events stops being fast — a measurable threshold, not a design principle.

---

## 10. Webhooks and outbound integration

### This is a security section as much as a feature section

A webhook is a user-supplied URL that our server fetches with our network position. That is the
textbook SSRF setup: an unauthenticated attacker who can save a webhook URL gets to make requests
from inside our network, to cloud metadata endpoints, to internal services. Formbricks is the only
repo in the survey that treats it that way, and its implementation is worth reproducing in full
because the failure modes are subtle.

### How Formbricks does it — read in full this pass

**Validation** — `validateAndResolveWebhookUrl`
(`formbricks apps/web/lib/utils/validate-webhook-url.ts:170-202`):

1. Parse the URL; reject anything that is not `http:` or `https:`.
2. Reject a hostname blocklist: `localhost`, `localhost.localdomain`, `ip6-localhost`,
   `ip6-loopback`, and **`metadata.google.internal`** (`:7-13`).
3. If the host is an IP literal (dotted v4, or bracketed v6), check it directly against the private
   ranges (`:127-143`). The v4 table has 14 patterns (`:15-30`) and covers more than the obvious
   three: `127/8`, `10/8`, `172.16/12`, `192.168/16`, **`169.254/16` (AWS/GCP/Azure metadata)**,
   `0/8`, **`100.64/10` (CGNAT shared space)**, `192.0.0/24`, the three TEST-NETs, `198.18/15`
   benchmarking, multicast `224/4`, reserved `240/4`, and the limited broadcast address. The v6 side
   covers `::1`, `::`, `fe80:` link-local, and `fc`/`fd` ULA.
4. **IPv4-mapped IPv6 is handled in both spellings** (`:43-62`): `::ffff:127.0.0.1` *and* the hex
   form `::ffff:7f00:1`, the latter via `hexMappedToIPv4` reassembling two 16-bit groups into a
   dotted quad before checking. This is the bypass most hand-rolled validators miss.
5. Otherwise resolve the hostname — both `dns.resolve` and `dns.resolve6`, with a 3-second timeout
   (`:76-107`) — and reject if **any** returned address is private, not merely the first.
6. Return the resolved address so the caller can pin it.

**Pinning** — `createPinnedDispatcher` (`:220-247`) builds an undici `Agent` whose `connect.lookup`
returns that exact IP regardless of what the hostname resolves to at fetch time, closing the
DNS-rebinding TOCTOU window between validation and request. TLS SNI and certificate validation still
use the original hostname, so pinning does not weaken transport security. It handles both undici
lookup callback shapes — the `{all: true}` array form and the legacy `(err, address, family)` triple
— with an inline comment noting that returning the wrong one produces `"Invalid IP address:
undefined"` at connect time. That comment is scar tissue and it is worth keeping in our version.

**Dispatch** — `formbricks apps/web/modules/response-pipeline/lib/process-response-pipeline-job.ts:207-256`:

- Standard Webhooks signing: `webhook-id` (deterministic, derived from event + jobId + webhookId),
  `webhook-timestamp` (unix seconds), and `webhook-signature` computed over `(id, timestamp, body)`
  with the webhook's secret. Deterministic ids make receiver-side deduplication possible.
- `redirect: "manual"` so a 30x is *returned* rather than followed, and any 3xx status is thrown as
  `"Webhook delivery blocked: redirect status N"`. Without this, an attacker registers a public URL
  that 302s to `169.254.169.254` and every protection above is bypassed.
- A fetch timeout, and the dispatcher destroyed in a `finally` with its own error handling.

**Fan-out and failure isolation** — `deliverWebhooks` (`:280-315`) uses `Promise.allSettled` so one
bad endpoint cannot block the others, then rethrows the first rejection **only while retry attempts
remain**; past `maxAttempts` it logs and lets the rest of the pipeline (integrations, emails,
metering) proceed. A dead webhook must not block a survey's other side effects. Job-level retry is
BullMQ `attempts: 3` with backoff.

**The escape hatch is named to be embarrassing**: `DANGEROUSLY_ALLOW_WEBHOOK_INTERNAL_URLS`, which
disables the blocklist, the private-range checks, and manual-redirect mode together. Copy the naming
convention along with the mechanism.

### Two additions from elsewhere

- **Retry metadata belongs on the job, not in a side channel.** Jitsu carries attempt count,
  next-retry-time, original topic, error, and function id as message headers, implemented
  independently in Go and TypeScript and still agreeing
  (`jitsu services/rotor/src/lib/rotor.ts:29-33`). Whatever queue we use, those columns go on the
  row.
- **Abort on both a count and a clock** (rudder-server, §5.4). Same rule as message delivery.

### Verdict

**Reimplement Formbricks' validator, pinned dispatcher, and signing from the description above — do
not copy the file.** The Formbricks analysis recommends porting it "almost verbatim" as its
highest-value near-as-is lift, but that same document establishes that `apps/web` outside
`modules/ee/` is AGPLv3 (§A). Both cannot hold unless we accept AGPL for the whole product. The file
is 247 lines and the mechanism is fully described above; rewriting it is cheaper than the licence
conversation.

First version: `webhook (id, workspace_id, url, secret, events text[], status, created_at)`; the
validator run **at save time and again at send time** (a URL's DNS can change between the two); the
pinned dispatcher; Standard Webhooks headers; `redirect: "manual"` with 3xx treated as failure; a
`webhook_delivery` table mirroring `message_delivery`'s shape from §4 so outbound integrations have
the same per-target ledger as messages do.

---

## A. Licensing reality

**This is an engineering reading of licence text, not legal advice.** Two items below warrant
counsel before any code is lifted: Formbricks' root-LICENSE-versus-`package.json` inconsistency, and
any decision to incorporate AGPL code. Where a licence was verified in this pass rather than
inherited from a source doc, it is marked.

| Repo | Licence(s) | May we take code? |
|---|---|---|
| **Jitsu** | MIT (root `LICENSE` and `bulker/LICENSE`). Third-party list is permissive plus unmodified-library MPL-2.0/LGPL. Enterprise billing lives in a separate repo, `jitsucom/jitsu-cloud-billing`, stated at `jitsu AGENTS.md:32-34` and referenced nowhere else in-tree. | **Yes.** Attribution only. Cleanest to reason about in the set. |
| **Dittofeed** | MIT throughout. `packages/ee/` is referenced by `docker-compose.ee.yaml:24` and is **absent from the tree** (0 tracked files). | **Yes** for everything present. What is missing cannot be evaluated — do not assume the OSS build is feature-complete. |
| **Novu** | MIT (`LICENSE-MIT`) for all of `apps/`, `libs/`, `packages/`. Novu Proprietary Software Licence for `enterprise/packages`. That tree is an **uninitialized git submodule** pointing at private `novuhq/packages-enterprise`; the local `src` entries are dangling symlinks into an empty `.source/`. | **Yes** for everything cited in this document. The EE tier is not present to copy or evaluate. |
| **trigger.dev** | Apache-2.0 root; 14 packages explicitly `"license": "MIT"` (`core`, `cli-v3`, `trigger-sdk`, `build`, `python`, `coordinator`, providers, `redis-worker`, …). No `ee/`, no licence-key gate anywhere. | **Yes.** Apache's patent grant/termination is the only practical difference from MIT for our purposes. |
| **Unomi** | Apache-2.0 throughout. Root `license-mappings.xml` declares third-party licences for release compliance only — it gates nothing. | **Yes** — but it is Java/OSGi, so nothing is liftable in practice. Ideas only by circumstance, not by licence. |
| **Chatwoot** | MIT Expat for `app/` and `lib/`. **Chatwoot Enterprise Licence** for `enterprise/` (320 `.rb`, 16,783 LOC) — production use requires a paid seat subscription, modifications assign back to Chatwoot. | **MIT tier yes** (this is where the drops layer and channel abstraction live). `enterprise/` **no**. Note the seam is not license-gated at runtime: `ChatwootApp.enterprise?` merely checks the directory exists (`chatwoot lib/chatwoot_app.rb:14-18`) and `enterprise/app/**` is unconditionally eager-loaded (`chatwoot config/application.rb:43-46`). "Not portable" is a legal statement, not an architectural one. |
| **listmonk** | **AGPLv3** for the entire main tree — Go backend, Vue admin, SQL, everything. `frontend/email-builder/` is separately **MIT** (Waypoint/Metaccountant Inc. 2024). | **Ideas only** for the AGPL tree; the network-use clause triggers on offering a derivative as a hosted service. **The email builder is MIT and takeable** — pull it from upstream `usewaypoint/email-builder-js` rather than out of the fork, for clean provenance. |
| **Formbricks** | Three tiers. **AGPLv3** by default (`formbricks LICENSE:1-9`). Proprietary **Enterprise Edition** for `apps/web/modules/ee/` (433 files, 79,548 LOC), enforced by a **live network check** to `ee.formbricks.com/api/licenses/check` with 24h cache and 3-day grace (`formbricks apps/web/modules/ee/license-check/lib/license.ts:26-44`). MIT for `packages/js-core`, `packages/surveys`, `packages/survey-ui` (self-declared, and consistent with the EE licence's own client-delivered-code carve-out at `apps/web/modules/ee/LICENSE:23-28`). | **MIT slice yes** (widget/SDK/renderer). `apps/web` is **AGPL** — including `lib/utils/validate-webhook-url.ts`, the file §10 wants. `modules/ee/` **no**. ⚠️ The root LICENSE's MIT whitelist names `packages/js/`, `packages/android/`, `packages/ios/`, `packages/api/` — the first has a different name in this tree and the other three **do not exist in it at all**. The umbrella text cannot be read literally against this checkout. |
| **Matomo** | **GPL-3.0+** (`matomo composer.json:12`; `LICENSE` is GPLv3 text). Premium plugins are fetched from an external marketplace and none of their source is in-tree. | **Ideas only.** GPL's copyleft triggers on distribution, not on network use — unlike AGPL — but moot since we ship no PHP. |
| **Mautic** | **GPL-3.0** — *verified in this pass*: `composer.json:3` `"license": "GPL-3.0"` and `LICENSE.txt` carries the GPLv3-or-later header. The Mautic analysis never states its licence. | **Ideas only.** |
| **Inngest** | **SSPL v1** for the whole repository (one `LICENSE.md`, no `ee/`), plus a **Grant of Future License**: every line automatically relicenses to **Apache-2.0 on the third anniversary of the date it was made available** (`inngest LICENSE.md:561-579`). | **Ideas only, today.** Code older than three years is Apache-eligible, but nothing in-tree marks which lines those are — it is a `git blame` archaeology question not worth doing. SSPL §13 targets offering the program's functionality as a service; it does not restrict reading the design and reimplementing. |
| **rudder-server** | **Elastic Licence 2.0** for the whole tree, `enterprise/` included — `LICENSE:1` and `enterprise/LICENSE:1` are byte-identical. | **Ideas only.** ELv2 forbids offering the software as a hosted/managed multi-tenant service and forbids removing licence notices. Strictest posture in the set, and there is no permissive tier to lift from. |

### The seven patterns, named

1. **Permissive throughout** — Jitsu, Dittofeed, Unomi, trigger.dev (Apache root + MIT leaves).
2. **Restricted source shipped in-tree** — Chatwoot's `enterprise/`: you can read it, you cannot use
   it in production.
3. **Enterprise package omitted from the tree entirely** — Dittofeed's `packages/ee/`: referenced by
   compose, zero files. The gap is invisible and therefore unmeasurable.
4. **Enterprise in a separate repository** — Jitsu (documented in one line of `AGENTS.md`) and Novu
   (an uninitialized private submodule whose local `src` entries are dangling symlinks). Different
   mechanisms, identical effect.
5. **Runtime network licence check** — Formbricks: a live call to a vendor endpoint with a cache and
   a grace period, gating real features in the request path. The only genuinely enforced gate in the
   survey.
6. **Infrastructure-gated rather than licence-gated** — trigger.dev's checkpoint/restore: the code is
   Apache/MIT and fully present, but requires CRIU via `crictl`/`buildah` or Docker's experimental
   checkpoint feature, so the vendor's own self-hosting docs mark it Cloud-only. Everything is
   *available*; the flagship capability is not *usable*.
7. **SSPL with an automatic Apache-2.0 relicence after three years** — Inngest. Restrictive today,
   permissive on a rolling schedule, with no in-tree marker of which lines have crossed over.

### Bottom line

- **Code we may take:** Jitsu, Dittofeed, trigger.dev, Unomi (all tiers present); Novu's MIT tree;
  Chatwoot's `app/` and `lib/`; Formbricks' `packages/js-core`, `packages/surveys`,
  `packages/survey-ui`; listmonk's `frontend/email-builder/` (prefer upstream).
- **Ideas only:** listmonk's backend, Formbricks' `apps/web`, Matomo, Mautic, Inngest,
  rudder-server, and every enterprise tier regardless of repo.
- **The practical rule:** since this is a from-scratch TypeScript/Postgres build and mechanisms are
  not copyrightable, reimplementing from the descriptions in these documents sidesteps the entire
  question. Do that by default, cite the source repo in a comment for the reader's benefit, and
  reserve actual code lifts for the two places worth it — the MIT email builder (from upstream) and
  possibly Chatwoot's drops layer (MIT, tiny).

---

## B. The build order

Ranked, with the reason each position is where it is.

**0 — The data spine.** `subject`, `subject_identifier`, `subject_merge`, `attribute_definition`,
`event`, `message_delivery`, `suppression`. Everything else consumes these. `subject_identifier`
specifically (§8) must exist before the first contact is created, because retrofitting merge onto a
`contacts.email`-keyed schema is the migration that eats a quarter.

**1 — Sending, with the per-recipient ledger and a send-time suppression check.** This is what the
product is *for*, and §4 shows what happens to systems that deferred the ledger: Chatwoot and
listmonk permanently cannot answer "what did we send this person, and did it arrive." The ledger is
one table and it must be there from the first send, not added when someone asks.

**2 — Templating with compliance baked into the base layout, plus the signed preference page.**
Ships *with* #1, not after. An email without a working unsubscribe should not be sendable, and the
enforcement point is the base template, not a checklist.

**3 — Segmentation: the typed node tree and one condition→SQL compiler, evaluated live.** No cache.
Live evaluation is fast enough for a long time, and shipping it uncached first gives #5 a correctness
oracle to test against. This is also where the dual-evaluator seam (§2) gets established, before
there is a second implementation to accidentally fork.

**4 — The journey engine.** `journey_run` + poller + the eight node types (§1). This is the step
that turns a bulk mailer into a marketing platform, and it depends on #1 (a message node needs
something to call), #2 (rendering), and #3 (split and entry nodes).

**5 — Incremental recompute.** The watermark table keyed by definition hash, plus materialized
counters for `Performed` nodes (§3). Only when a real segment is slow. Building it earlier means
optimizing semantics that are still moving.

**6 — Deliverability.** Bounce and complaint webhooks → threshold→action → suppression (§5). This
can trail #1 by weeks but not by months: the first hard bounce that keeps getting retried is a
reputation problem that compounds silently.

**7 — Outbound webhooks.** The SSRF-hardened signed dispatcher (§10). Needed the moment anyone
integrates anything, and it is self-contained enough to build in a day once needed.

**8 — Event ingestion endpoint.** (§9.) Only when there is a first-party source of events beyond our
own sends — until then, `event` rows are written internally and no public endpoint is needed.

**9 — Multi-tier preferences.** (§7.) A single boolean per `(subject, group)` covers the first
release. Novu's five-tier merge is the right shape to grow into and the wrong thing to start with.

### Deliberately deferred, and why

| Deferred | Why |
|---|---|
| Any durable-execution dependency (Temporal, Inngest, trigger.dev, hosted) | §1 resolves it — a row with a timestamp and a poller. Revisit only if a measured limit appears. |
| ClickHouse or any columnar store | Postgres until a specific query is measurably too slow. §9 states the threshold. |
| Kafka, or any multi-service topology | Two of the surveyed repos need six-plus stateful services before running a single unit of work. That is a platform, not a feature. |
| A CDP profile builder, warehouse fan-out, connector syncs | Jitsu's territory. Nothing in the product needs it yet. |
| Device fingerprinting | §8 — weak signal, consent liability. |
| Multi-tenant fairness (shadow partitions, DRR, GCRA, per-tenant Redis) | Inngest and rudder-server's most sophisticated machinery exists for thousands of independent tenants. Single-owner partitions cover one. |
| User-authored transformation code and its sandbox | Jitsu's Deno-worker design (`permissions: "none"` + proxied capabilities + hard timeout) is the reference when this is scoped. Not before. |
| In-app inbox / websocket channel | Novu's is built for an embeddable third-party widget. A REST poll gets most of the value. |
| Journey A/B beyond `RandomCohort` | The node covers the split; the analysis to make it meaningful is a separate project. |
| Warm-up scheduling | §5.6. Needed when volume exists, designed for now. |
| An admin UI ported from anywhere | Every doc says skip the dashboard. All five are wrong-framework or wrong-generation. |

---

## C. What nobody solved well

Eight problems the survey does not answer. These are where we will be inventing rather than
adapting, and they are worth knowing before they surprise us.

**1. Journey definition versioning while people are mid-flight.** Dittofeed versions *segment*
definitions and gets a free recompute (§3), but no repo showed a coherent story for "someone is on
step 4 and an editor changes step 6." Novu's workflows are documents with embedded `steps[]` and
`Job` rows already materialized per step at trigger time. trigger.dev has `WorkerDeployment` with
staged promotion — for code, not for a graph a person is standing in. Our answer (§1 rule 2) is to
pin the version at entry and never migrate in-flight runs, offering "cancel and re-enter" instead.
That is a product decision as much as an engineering one and it should be made explicitly.

**2. The three-way relationship between consent, suppression, and audience membership.** Every
system has two of the three; none reconciles all three. Segments are computed from traits and events
(§3). Suppression is a delivery-time fact learned from a provider (§5). Consent is a legal fact with
a timestamp and a provenance (§7). Nobody makes the audience builder consent-aware *and* the sender
suppression-aware *and* guarantees the two cannot disagree. The failure mode is a segment that says
120,000 people and a send that reaches 94,000, with no single place that explains the difference.
Design the reconciliation deliberately: one `sendability` function, called by both, returning a
reason.

**3. Warm-up and per-domain reputation.** Zero implementations across twelve repos. listmonk has two
global throttles and no notion of a recipient domain. Nobody tracks per-domain acceptance rates,
nobody ramps a new sending domain, nobody feeds a reputation signal back into scheduling. This is a
real and well-understood operational problem in the industry, and the open-source marketing stack
simply does not address it.

**4. Preview and test-send fidelity.** Formbricks maintains two independent implementations of its
conditional-logic evaluator — one for the widget runtime
(`formbricks packages/surveys/src/lib/logic.ts`), one for the editor preview
(`formbricks apps/web/lib/surveyLogic/utils.ts`) — with matching cognitive complexity (212/215 and
93/93), which is what identical-by-copy looks like right before it stops being identical. Nobody in
the survey can say "the preview is provably the same code path as the send." §2's dual-dispatch seam
helps for conditions; it does not cover rendering. Build preview as *the same function* with a
mocked recipient, not as a parallel path.

**5. Cross-channel frequency capping.** Novu has per-workflow throttle and digest. Dittofeed's
`RateLimitNode` is an unimplemented stub (verified, §1). Nobody implements "this person receives at
most N marketing messages per week across all journeys, campaigns, and channels" — which is close to
the first thing a marketing team asks for once more than one journey exists. It needs a shared
counter consulted at the send gate, which is architecturally cheap and semantically fiddly (does a
transactional message count? does a suppressed one?).

**6. Analytics that agree with the delivery ledger.** Matomo has the best aggregation model in the
survey (§3) and does not send anything. listmonk sends and has materialized-view dashboards that
cannot attribute anything to a journey step. Nobody joins "what we sent" to "what happened next" in
a way that survives erasure — although §7 shows Matomo handed us the mechanism (deletion as a caller
of invalidation); nobody has applied it to message-level reporting.

**7. The tenancy decision, which the survey shows is expensive to defer.** Roughly half of the
sophistication in Inngest, rudder-server, and trigger.dev exists for multi-tenant fairness. None of
the simple designs recommended here extend gracefully to genuine multi-tenancy — single-owner
partitions, a single poller, and per-workspace-scoped queries all become the wrong shape at once.
Decide the tenancy model before step #4 of the build order, not after.

**8. Testing an engine whose unit of work is three days long.** Dittofeed has genuine journey tests
(`endToEnd.test.ts`, `reEnter.test.ts`, `waitForTest.test.ts`, `randomCohortJourney.test.ts`,
`keyedEventEntry.test.ts`) and they work because Temporal's test environment can skip time on
demand. Our poller design gets no such gift, and listmonk — the closest architectural analogue —
has *zero* Go tests across 94 files. **Expose an injectable clock from the first commit of the
journey engine**, threaded through the poller, the node handlers, and the watermark logic. Retrofit
it later and every one of those tests becomes a `sleep`.

---

## Handoff

**Inputs used.** All twelve architecture documents in `/Users/la/Programming/Open-Marketing/docs/`
(`chatwoot`, `dittofeed`, `formbricks`, `inngest`, `jitsu`, `listmonk`, `matomo`, `mautic`, `novu`,
`rudder-server`, `trigger-dev`, `unomi`), read in full. Plus eight direct source verifications in
`/Users/la/Programming/OSS-Marketing-Repos/` (and one outside it) to fill gaps the docs left thin:

| Verified this pass | Where | Filled which gap |
|---|---|---|
| `SegmentNodeType`, `SegmentOperatorType`, `RelationalOperators` | `dittofeed packages/isomorphic-lib/src/types.ts:232-241, 331-345, 389-393` | §2's exact taxonomy |
| `JourneyNodeType` + the `RateLimitNode` stub body | `dittofeed packages/isomorphic-lib/src/types.ts:879-890`; `dittofeed packages/backend-lib/src/journeys/userWorkflow.ts:1070-1077` | §1's node list, and that `RateLimit` is dead |
| The watermark: read query, write query, and `version = definitionUpdatedAt` | `dittofeed packages/backend-lib/src/computedProperties/periods.ts:66-73, 166-181, 211-227, 258-276`; steps at `packages/isomorphic-lib/src/types.ts:6077-6081` | §3 — the docs said "watermark" without saying what it is, and the definition-change behavior was undocumented |
| Liquid compliance tag implementations, incl. the empty-string failure mode | `dittofeed packages/backend-lib/src/liquid.ts:80-119, 160-240` | §6's mechanics and the bug not to copy |
| `MessageSent`/`MessageFailure`/`MessageSkipped` submission points | `dittofeed packages/backend-lib/src/messaging.ts:1209, 1217, 1286, 1299, 1386, 1397` | §4 — Dittofeed records as events, not rows |
| The bounce CTE in full | `listmonk queries/bounces.sql:1-30` | §5's atomic threshold→action mechanism |
| Chatwoot's one-off campaign send loop and status guard | `chatwoot app/services/twilio/oneoff_sms_campaign_service.rb:19-32`; `chatwoot app/models/campaign.rb:71-78` | §4 — sharper than the doc's claim |
| Webhook URL validator and pinned dispatcher, in full | `formbricks apps/web/lib/utils/validate-webhook-url.ts:1-247`; dispatch at `apps/web/modules/response-pipeline/lib/process-response-pipeline-job.ts:207-315` | §10 — the Formbricks doc explicitly flagged this file as unread |
| Mautic's licence | `composer.json:3`, `LICENSE.txt` at `/Users/la/Programming/delete-later/Open-Marketing-bare/integrations/mautic` | §A — the Mautic doc never states it |

**Output.** `/Users/la/Programming/Open-Marketing/docs/capability-synthesis.md` (this file). One
file created; nothing committed; nothing under `OSS-Marketing-Repos/` modified.

### Where the source docs disagreed

1. **The durable-execution substrate — the sharpest disagreement in the set.**
   `dittofeed-architecture.md` calls the per-user Temporal workflow "the single biggest
   architectural idea to take from this repo, and it is stack-independent."
   `inngest-architecture.md` §12 and `trigger-dev-architecture.md` §10 both conclude, independently,
   to build a row-plus-poller and port no code. **My reading:** the latter two on the substrate,
   Dittofeed on the node taxonomy. They are arguing about different layers and both claims survive
   — but a reader who saw only the Dittofeed doc would adopt Temporal.
2. **Formbricks' webhook pipeline: "port almost verbatim" versus its own licence section.**
   `formbricks-architecture.md` reimplementation note #1 calls the dispatcher "the single
   highest-value near-as-is lift in the repo," while the same document establishes that `apps/web`
   outside `modules/ee/` is AGPLv3. Both cannot hold unless we accept AGPL for the product.
   **My reading:** reimplement from the description (§10); the file is 247 lines.
3. **Whose segment model to copy.** `matomo-architecture.md` §4.4 argues its own grammar is not
   worth copying and points at Dittofeed's typed tree; `listmonk-architecture.md` also points at
   Dittofeed; `unomi-architecture.md` claims its own condition model is "the strongest single idea
   in the 12-repo survey" for a segment engine. **My reading:** these are compatible once shape
   (Dittofeed) is separated from execution architecture (Unomi's dual dispatch) — which is what §2
   recommends, and which no single source doc says.
4. **Chatwoot's per-recipient tracking.** `dittofeed-architecture.md` characterizes Chatwoot's
   one-off campaign as having "no per-recipient ledger"; `chatwoot-architecture.md` never examines
   the send loop. **Verified:** it is worse — send failures are logged and skipped with no row
   written at all, and `mark_processing!` guarantees a crashed campaign is never retried and never
   completes.
5. **Dittofeed's live provider count.** The body of `dittofeed-architecture.md` says nine
   destination adapter files; a coordinator correction in the same document says `fcm` is dead code
   and to count live adapters as email + SMS only. **The correction is authoritative** and §4
   follows it.
6. **cbm `cyclomatic` on Go.** `rudder-server-architecture.md` originally claimed the metric is
   populated on Go; a coordinator correction in that same document says it is not, and
   `listmonk-architecture.md` §0.5 independently found it empty on every Go function. **Not
   populated.** Irrelevant to the build; recorded because it is a factual conflict in the source set.
7. **Mautic's licence** is stated nowhere in `mautic-architecture.md`, and the listmonk doc refers
   in passing to "Mautic's GPL parts." Verified as GPL-3.0 in this pass.

### What I could not verify

- **Mautic**, beyond its licence and bundle count. Its analysis is from 2026-06-30 against a clone at
  a path that no longer exists (`../Open-Marketing-old/integrations/mautic`); the tree survives at
  `/Users/la/Programming/delete-later/Open-Marketing-bare/integrations/mautic`, and I checked only
  `LICENSE.txt`, `composer.json`, and `app/bundles/` (29 bundles, matching the doc). Every other
  Mautic claim in this document is inherited from that older, thinner analysis and was not
  re-verified. Mautic is not in the `OSS-Marketing-Repos/` batch set.
- **PostHog.** A clone exists at `OSS-Marketing-Repos/posthog` but there is no analysis document for
  it in `docs/`. The brief references it "by reference" for identity; **nothing in this document is
  sourced from PostHog**, and §8's recommendations do not depend on it.
- **Dittofeed's `computePropertiesIncremental.ts`** (4,817 lines) — I read the watermark bookkeeping
  in `periods.ts` directly and in full, but not the ClickHouse SQL compiler itself. §3's claims are
  about the watermark and the version key, not about the generated SQL.
- **Novu's `SelectIntegration` condition-matching algorithm** — flagged unverified in its own
  analysis, and still unverified here. §4 describes its inputs, not its evaluation.
- **Formbricks' BullMQ backoff shape** (fixed vs exponential) — `attempts: 3` and a `backoff`
  reference are confirmed at `packages/jobs/src/constants.ts:28-29`; the strategy itself was not
  read, in that analysis or this one.
- **Clone freshness.** Several analyses flag it: Dittofeed's clone is ~5 months behind upstream
  (commit `52b2bee9`, 2026-03-27); Unomi's is an explicitly unstable dev branch mid-rearchitecture
  toward multi-tenancy, so its auth behavior in particular is commit-specific and not
  representative of released Unomi. Line numbers in this document are valid against the commits the
  source docs name.
- **Anything about runtime behavior.** No repo was built, run, benchmarked, or tested to produce
  this document, and no index was constructed. Every performance characterization here is inherited
  from a source comment or a source doc, not measured.
