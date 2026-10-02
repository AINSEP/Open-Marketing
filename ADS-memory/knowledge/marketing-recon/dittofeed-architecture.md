# Dittofeed Architecture — Reference Analysis

> Reference-only analysis of upstream Dittofeed, done to decide **what to port** into the
> Open Design–based Open Marketing repo.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/dittofeed` (clone of
>   `github.com/dittofeed/dittofeed`, analyzed at commit `52b2bee9`, 2026-03-27)
> - **Tools:** codebase-memory-mcp (project `dittofeed`, moderate mode) + graphify
>   (`graphify-out/`, Tree-sitter, no LLM) + `rg`.
> - **Date:** 2026-09-06
> - **⚠ Clone is ~5 months stale.** Upstream HEAD is 2026-03-27; anything below may have
>   moved. Re-pull before committing to a port.

## TL;DR

- **Code quality: 7/10. Marketing port value: 9/10.** This is the inverse of Chatwoot.
  Dittofeed *is* a marketing-automation platform — journey engine, segment engine, broadcast
  engine, subscription groups, and a real multi-provider delivery layer — all **MIT**.
- **The crown jewel is the pairing of two engines:** a Temporal-durable journey workflow
  (`userWorkflow.ts`, 9 node types) and an incremental segment/computed-property engine on
  ClickHouse (`computePropertiesIncremental.ts`, 14 segment node types). Chatwoot had
  neither. Mautic had the segment half but not the durable-execution half.
- **The pain is concentrated in exactly those two files** — 4,817 and 1,135 lines, with the
  three highest cognitive-complexity functions in the repo. Good news for porting: the value
  and the rot are the same code, so you read it once and rewrite deliberately.
- **Watch the licensing inversion.** The repo is MIT end to end, but `packages/ee/` — which
  `docker-compose.ee.yaml:24` boots as `./packages/ee/dist/scripts/startLite.js` — is
  **entirely absent from the source tree** (0 tracked files). Chatwoot ships EE source under
  a restrictive license; Dittofeed doesn't ship EE source at all. What's here is genuinely
  free; what's missing is invisible.

## What it is

A **TypeScript / Node monorepo** (Yarn workspaces), MIT, 1,473 tracked files — 465 `.ts`,
240 `.tsx`, 390 `.mdx` (docs). cbm indexed 9,344 nodes / 22,104 edges; graphify 6,250 nodes /
14,435 edges / 641 communities.

**Stack:** Fastify API · **Temporal** for durable workflow execution · **ClickHouse** for the
event/computed-property store · Postgres + **Drizzle** (31 `pgTable`s) for resources ·
Kafka (optional) · Next.js + MUI dashboard · LiquidJS templating · OpenTelemetry.

### The 9 packages

| Package | Role | cbm nodes |
|---|---|---|
| `dashboard` | Next.js UI — journey builder, segment editor, template editor | 1,246 |
| `backend-lib` | **the product** — journeys, segments, computed properties, messaging, destinations | 802 |
| `emailo` | email block editor → MJML | 140 |
| `isomorphic-lib` | shared types (TypeBox schemas), result handling | 80 |
| `api` | Fastify controllers (28 of them) | 49 |
| `admin-cli` | bootstrap, upgrades, backfills | 33 |
| `worker` | Temporal worker host (3 files — just wiring) | 4 |
| `lite` | single-process all-in-one bundle | 3 |
| `docs` | Mintlify `.mdx` | (excluded) |

Dependency direction is clean and one-way: `dashboard`/`api`/`admin-cli`/`worker` →
`backend-lib` → `isomorphic-lib`. graphify found **no multi-file import cycles** — every
cycle it reports is a 1-file self-reference (8 of them, all `types.ts`-style barrel
self-imports). Layering is real, not aspirational.

## The two engines (this is why the repo matters)

### 1. Journey engine — `packages/backend-lib/src/journeys/userWorkflow.ts` (1,135 lines)

One **Temporal workflow per user per journey**. `userJourneyWorkflow` (`:206`) is a
`switch` over 9 declared node types — **8 of which actually work** (`RateLimitNode` is a
stub) — each a `case` in the main loop:

| Node type | Line | What it does |
|---|---|---|
| `SegmentEntryNode` (wire name `EntryNode`) | `:627` | enter on segment membership |
| `EventEntryNode` | `:650` | enter on a tracked event |
| `DelayNode` | `:664` | durable sleep |
| `WaitForNode` | `:756` | wait for a segment/event with timeout |
| `SegmentSplitNode` | `:824` | branch on segment membership |
| `MessageNode` | `:852` | send via a channel template |
| `ExitNode` | `:1030` | terminate |
| `RandomCohortNode` | `:1033` | A/B / percentage split |
| `RateLimitNode` | `:1070` | **unimplemented stub** — logs an error and routes to `exitNode` |

**Why Temporal matters here:** delay, wait-for, and retry are *durable* — a worker crash
resumes mid-journey rather than stranding it. Compare Chatwoot's one-off campaign, which a
crash strands in `processing` forever with no per-recipient ledger. This is the single
biggest architectural idea to take from this repo, and it is stack-independent.

`userJourneyWorkflow` is also the **most complex function in the codebase**: cognitive **331**,
transitive loop depth **9**. Read it, understand it, then rewrite it — don't transliterate.

### 2. Segment / computed-property engine — `computePropertiesIncremental.ts` (4,817 lines)

Compiles a declarative segment tree into **incremental ClickHouse SQL**. 14 segment node
types (`isomorphic-lib/src/types.ts`): `And`, `Or`, `Trait`, `Performed`, `LastPerformed`,
`KeyedPerformed`, `Broadcast`, `Email`, `Manual`, `Everyone`, `Includes`, `RandomBucket`,
`SubscriptionGroup`, `SubscriptionGroupUnsubscribed`.

The two hot functions are `segmentToResolvedState` (cognitive **170**) and
`segmentNodeToStateSubQuery` (cognitive **161**). Supporting cast:
`computePropertiesWorkflow.ts`, `computePropertiesQueueWorkflow.ts` (330),
`comutePropertiesSchedulerWorkflow.ts` (159, sic — typo is upstream), `periods.ts` (645).

**Incremental** is the key word: it recomputes from a watermark rather than rescanning, which
is what makes segments viable at volume. Mautic's QueryBuilder generates a full query each
time; this does not.

### Supporting pieces worth naming

- **Broadcasts** (`backend-lib/src/broadcasts/`) — `broadcastWorkflowV2.ts` plus
  `recomputeBroadcastSegmentWorkflow.ts`. A one-shot send that still runs on Temporal.
- **Destinations** (`backend-lib/src/destinations/`) — adapter files for `amazonses`,
  `sendgrid`, `resend`, `postmark`, `mailchimp`, `smtp`, `twilio`, `signalwire`, `fcm`.
  Small, uniform, individually testable. **Correction: `fcm` is dead code** — the generic
  dispatcher throws `"not implemented"` for MobilePush (`messaging.ts:2415`) and
  `fcm.ts`'s `sendNotification` has zero call sites outside its own test. Count the live
  adapters as email + SMS only.
- **Liquid** (`backend-lib/src/liquid.ts`, 297 lines) — LiquidJS plus five custom tags that
  are the interesting part: `unsubscribe_link`, `unsubscribe_url`,
  `subscription_management_link`, `subscription_management_url`, `view_in_browser_url`, and a
  `markdown` filter. **This is compliance plumbing, not templating sugar** — it is how
  unsubscribe survives contact with a template author.
- **Subscription groups** — a first-class resource with its own controllers
  (`subscriptionGroupsController`, `subscriptionManagementController`) and its own segment
  node types. Chatwoot has no equivalent concept at all.
- **HubSpot integration** (`integrations/hubspot/activities.ts`, 1,051 lines) — the only
  CRM, but non-trivial and Temporal-native.

## What's good

- **Layering is real.** One-way package dependencies, no multi-file import cycles, 345 fan-in
  into `isomorphic-lib` with zero fan-out. The shared-types package is genuinely shared.
- **Types as the contract.** TypeBox schemas in `isomorphic-lib/src/types.ts` are the single
  source of truth for journey and segment definitions, validated at the boundary
  (`schemaValidateWithErr`, fan-in 87). Journey/segment definitions are *data*, which is what
  makes the visual editors possible.
- **Durable execution end to end.** Journeys, broadcasts, computed properties, and manual
  segment updates are all Temporal workflows — not cron jobs praying for idempotency.
- **Real test coverage on the risky parts** — `endToEnd.test.ts`, `reEnter.test.ts`,
  `waitForTest.test.ts`, `randomCohortJourney.test.ts`, `keyedEventEntry.test.ts` sit beside
  the journey engine; `periods.test.ts` (483 lines) beside the incremental compute.
- **`assertUnreachable`** (fan-in 75) — exhaustiveness checking on every discriminated union.
  A small discipline that makes adding a 10th journey node type safe.

## What's weak

### 1. Two files hold the whole product
`computePropertiesIncremental.ts` (4,817 lines) and `userWorkflow.ts` (1,135) are the
platform. Both are top-3 by cognitive complexity. There is no seam inside either — the
journey engine is one `switch`, the segment compiler one recursive descent. Porting means
rewriting, not extracting.

### 2. The dashboard is heavier than the backend
`dashboard` carries 1,246 cbm nodes vs `backend-lib`'s 802, with `segments/editor.tsx` at
3,108 lines, `journeys/store.ts` at 2,330, `settings.page.tsx` at 2,376. Two of the top-4
cognitive-complexity functions are dashboard state code (`journeyDefinitionFromStateBranch`
197, `journeyBranchToState` 172) — the round-trip between visual graph and stored definition.
**We are not porting this UI**, but that round-trip is the hard part of any journey builder
and is worth reading before we build ours.

### 3. Frontend hub coupling
graphify's top god nodes are `logger()` (281), `useAppStorePick()` (249), `unwrap()` (123),
`db` (116), `useAuthHeaders()` (116), `useBaseApiUrl()` (115) — i.e. **three dashboard hooks
in the top six**, the rest cross-cutting utilities. Betweenness bridges
are flat and mostly cross-cutting utilities (`ChannelType` 0.032, `logger()` 0.031,
`assertUnreachable()` 0.026) — no single domain chokepoint, which is a good sign for the
backend and a shrug for the frontend.

### 4. The EE gap is unmeasurable
`packages/ee/` is referenced by `docker-compose.ee.yaml` and absent from the tree. We cannot
tell what functionality is missing, so we cannot tell whether an OSS-only Dittofeed is
feature-complete for our purposes. Assume gaps exist; do not assume they're small.

### 5. The Postgres assignment tables are vestigial — ClickHouse is not optional
`SegmentAssignment` and `UserPropertyAssignment` still exist in Postgres, and a ClickHouse
DDL comment (`userEvents/clickhouse.ts:394-397`) claims assignments are "replicated to
postgres … for rapid row-wise reads". **That is no longer true.** `getSegmentAssignmentDb`
(`segments.ts:1042`) queries ClickHouse despite the name; `insertSegmentAssignments` writes
to ClickHouse; the surviving Postgres references are `DELETE`s only. There is **no row-wise
Postgres mirror of segment membership** — every membership read is a ClickHouse query. This
materially raises the cost of dropping ClickHouse in a port.

### 6. The OSS build ships with no authentication by default
`authMode` defaults to `"anonymous"` (`backend-lib/src/config.ts:563`), which resolves every
request to a synthetic admin identity. `registerAuthentication` is an *optional* hook
(`api/src/types.ts:10`, called at `api/src/buildApp/router.ts:47-49`) that **nothing in the
tree ever supplies** — presumably `packages/ee/` does, and it is absent. The only real gates
in this source tree are public write-keys on ingest, admin API keys, and per-provider webhook
signatures. Do not read the `/api/*` surface as an authenticated design; the auth story lives
in the code we don't have.

### 7. Stale clone
Commit `52b2bee9` is 2026-03-27 — ~5 months old. Every line reference above is against that
commit.

## Two-tool cross-check (cbm-mcp vs graphify)

cbm: 9,344 nodes / 22,104 edges, 12 Leiden clusters at cohesion **0.54–0.82**.
graphify: 6,250 nodes / 14,435 edges, 641 communities, **99% EXTRACTED / 1% INFERRED**
(vs 92/8 on Chatwoot — TypeScript resolves far more cleanly than Ruby).

- **Agree:** `logger`, `db`, `useAppStorePick`, `schemaValidateWithErr`, `assertUnreachable`
  are the top hubs. cbm's clusters and graphify's communities both isolate the journey-editor
  state code (cbm cluster 98, cohesion 0.82) and the ClickHouse query layer (cluster 71).
- **cbm added:** cognitive complexity **and loop metrics** — `userJourneyWorkflow` tld=9,
  `linear_scan_in_loop`=1. Unlike Ruby, **TypeScript gets the full metric set**, so the
  hot-path lever from the Mautic analysis is available again on this repo.
- **graphify added:** cycle detection (none multi-file) and a cheap portable report.

### Tool calibration deltas vs the Chatwoot run

1. **cbm loop metrics work here.** Ruby returned 0 for every function; TypeScript returns
   real values. Confirms the metric gap is **per-language**, not per-repo. Check it explicitly
   on each remaining target before citing.
2. **graphify's `--no-viz` flag does not exist on `update`** — it is a `cluster-only` flag.
   `graphify update . --no-viz` exits 2 with `unknown update option`. Just run
   `graphify update .`; it auto-skips the HTML above 5,000 nodes.
3. **cbm `Route` nodes are usable here** (139 nodes, several with real `method` + `path`)
   where they were 93% empty on Chatwoot's Rails DSL. Fastify's explicit route registration
   extracts cleanly. **Verify per-framework, not per-tool.**
4. **graphify god-node noise was absent** — no `package.json` dependency keys in the top-10,
   unlike Chatwoot (`vue`, 733 edges) and Mautic (694 `composer.json` nodes). The noise is a
   function of how the manifest is parsed per ecosystem.
5. **Cost:** cbm ≈ 40s, graphify ≈ 3 min / 9.6 MB output, $0 LLM. Cheaper than Chatwoot.

## Port targets for Open Marketing (ranked)

1. **The durable-journey model** — one workflow instance per user per journey, with durable
   delay/wait-for. Port the *idea and the node taxonomy*; pick our own execution substrate.
   This is the highest-value idea across all repos surveyed so far.
2. **The segment node taxonomy + incremental compute strategy** — 14 node types and the
   watermark-based recompute. Port the taxonomy closely; rewrite the SQL compiler.
3. **Liquid compliance tags** (`unsubscribe_*`, `subscription_management_*`,
   `view_in_browser_url`) — small, high-value, directly liftable. Pairs with Chatwoot's
   drops layer as the two halves of a templating story.
4. **Subscription-group model** — first-class opt-in/opt-out as both a resource and a segment
   node. Chatwoot has nothing here; we need it for anything email.
5. **Destination adapter shape** — 9 adapter files (4 with tests beside them), of which
   `fcm` is dead. The live provider surface from the type unions is **7 email + 2 SMS +
   a generic Webhook channel**, and Gmail is handled inline in `messaging.ts` rather than
   in `destinations/`. Port the shape, implement the providers we need.
6. **TypeBox-schema-as-contract discipline** + `assertUnreachable` exhaustiveness. Free, and
   it is what keeps a node-type union safe to extend.

**Skip:** the Next.js/MUI dashboard, `emailo`, `admin-cli` upgrade scripts, `lite`,
the HubSpot integration (unless/until CRM sync is scoped).

**Do not assume:** that OSS Dittofeed is feature-complete — `packages/ee/` is missing entirely.

## Reproducing / refreshing this analysis

- **graphify** (`$0`, no LLM): `cd /Users/la/Programming/OSS-Marketing-Repos/dittofeed &&
  graphify update .` → `graphify-out/{graph.json, GRAPH_REPORT.md, manifest.json}` (9.6 MB).
  Do **not** pass `--no-viz` to `update` — it is not a valid option there.
- **codebase-memory-mcp:** project `dittofeed`, indexed 2026-09-06 `moderate` at commit
  `52b2bee9`.
  **`ORDER BY` trap, sharpened (verified both ways on this repo):** numeric node properties
  are stored as strings, so they must be projected through `toInteger()` — but the `ORDER BY`
  must then reference **the projected alias**. `RETURN toInteger(f.cognitive) AS cog … ORDER
  BY cog DESC` sorts correctly; `… ORDER BY toInteger(f.cognitive) DESC` is **silently
  ignored** and returns insertion order. A repeated function call in `ORDER BY` is dropped,
  not evaluated. Also: function calls in `WHERE` are unsupported
  (`unexpected operator at pos N`), so you cannot filter your way to a top-N either — project
  an alias and sort on it.
