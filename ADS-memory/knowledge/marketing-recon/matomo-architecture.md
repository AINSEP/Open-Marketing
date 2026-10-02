# Matomo — Mechanical Architecture Notes

Target: `matomo` (`/Users/la/Programming/OSS-Marketing-Repos/matomo`, branch `5.x-dev`, read-only clone).
Self-hosted web analytics, PHP, ~3,445 `.php` files, ~15 years old (originally Piwik).
cbm project `matomo`: 311,947 nodes / 439,302 edges, indexed and read-only for this pass — no `graphify`, no `index_repository`, no builds/tests/services were run.

We will not ship PHP. This document exists to extract **mechanical understanding** — how a
tracking pixel becomes a queryable report, how pre-aggregation makes analytics fast, how
segments are expressed, and how the privacy machinery works — for a TypeScript/Postgres
rebuild. It is deliberately not a software-architecture assessment: no complexity metrics,
god-object tables, cycle detection, or hub analysis appear here.

---

## 0. Corrections to the brief, and scope

**Corrections.** Nothing in the brief was factually wrong on the areas I checked. One
clarification: the cbm `get_architecture` "routes" aspect surfaced 20 entries, but on inspection
they are `DeviceDetector`-style user-agent regex fragments (`/opera/`, `/msie 7/`, `/chrome/`)
picked up as pseudo-routes, not real HTTP endpoints — consistent with the standing note that
`Route` nodes are unreliable on every repo in this batch. I read `matomo.php`/`piwik.php` and the
routing table (`config/routes.yml` equivalents don't really exist here — Matomo dispatches by
`module`/`action` query params through `Piwik\FrontController`, not named routes) directly from
source instead of trusting the graph's route list.

**What I analysed** (all confirmed against source, `path:line` cited throughout):
1. The tracking request path: `piwik.php` → `Tracker` → `Handler` → `Visit` → `RequestProcessor`
   chain → exclusion, fingerprinting, visit stitching, action recording.
2. The archiving/aggregation model: `Archive` (read path), `ArchiveProcessor\Loader` (cache-miss
   trigger), `PluginsArchiver` (Day-vs-Period split), `ArchiveProcessor::aggregateDataTableRecords`
   (subperiod summation), `ArchiveInvalidator` (late-data invalidation cascade), `CronArchive` +
   `QueueConsumer` (the batch consumer of invalidations).
3. Segments: `Segment` / `SegmentExpression` grammar, parsing, and SQL generation; how a segment
   is archived as its own hashed record set.
4. Privacy/GDPR: IP anonymization, DNT, pseudonymization of user/order IDs, referrer
   anonymization, GDPR data-subject deletion, retention purging, cookieless mode, client-side
   consent gating.
5. Visitor identity: cookie precedence order, the config-id fingerprint algorithm, and the
   30-minute visit-stitching window.
6. Plugin registration pattern (briefly, as scoped).
7. Data model: `log_*` vs `archive_*` tables, column shapes, indexes.
8. Licence.

**What I deliberately did not analyse, and why** (all substantial, all skipped for scope, not
because they're uninteresting):
- **Ecommerce** (2,477 graph nodes) and **CustomDimensions** (2,689 nodes) plugins — goal/cart/
  order tracking and custom-dimension storage beyond their schema tables. Not read.
- **Live** plugin (1,763 nodes) — the real-time visitor log/segment-live-matching engine. Not
  read at all.
- **`core/DataAccess/LogAggregator.php` and `LogQueryBuilder/`** — the actual SQL-generation layer
  that joins segments and dimensions onto `log_*` tables for Day archiving. This is the natural
  next stop if more budget is available; I traced *that it's called* (`aggregateDayVisitsMetrics`
  in `PluginsArchiver.php:314`) but not its internals.
- **`CliMulti` / process-locking mechanics** inside `CronArchive` (parallel HTTP-based worker
  dispatch, PID files, MySQL advisory locks) — noted as existing, not read.
- **All Vue/TS admin UI** (~700 files: 278 JS, 231 Vue, 162 TS) — irrelevant to backend mechanics
  for this brief, not analysed at all.
- **DeviceDetector** internals (UA/bot parsing) — treated as an opaque third-party dependency
  (it's a separate Composer package, `matomo/device-detector`), not read.
- **The API framework** (`core/API`, `plugins/API`) and **BotTracking** plugin beyond the one
  branch already covered in `Tracker::trackRequest`.
- **Goals** plugin (1,379 nodes) conversion-matching logic beyond its schema tables.
- **Marketplace** plugin beyond confirming premium plugins are fetched externally, not vendored.

**What I could not verify:**
- The JS-side cookieless fallback (localStorage-based re-identification) — I confirmed the
  server-side `forceCookielessTracking` config flag and the JS API name `disableCookies`, but did
  not read the minified JS Tracker's cookieless code path in detail.
- The production default value of `getTodayArchiveTimeToLive()` — I read the getter/setter
  (`core/ArchiveProcessor/Rules.php:166-209`) but not the shipped `config.ini.php` default.
- The exact consent-cookie name — inferred from heavily minified variable names in
  `js/piwik.min.js`, not confirmed against a readable identifier.

Confirmed: **no `graphify`, no `index_repository`, no builds/tests/services were run** at any
point in this pass. All navigation was `search_graph`/`query_graph` against the pre-built index,
`rg`, and direct file reads.

---

## 1. What Matomo is

Matomo (formerly Piwik) is a self-hosted web/app analytics platform — the thing you install on
your own server instead of pointing traffic at Google Analytics. A user gets:

- A tracking script (`js/piwik.js` / `matomo.js`) they paste on their site, or a raw pixel/HTTP
  API for server-side tracking, both of which POST/GET to `matomo.php`.
- A PHP application (this repo) that receives those requests, records raw visit/action rows, and
  periodically pre-aggregates them into report data.
- A web UI (Vue-based admin/reporting app, not analysed here) that queries pre-aggregated reports,
  falling back to on-demand aggregation when nothing is cached yet.
- ~98 bundled plugins (`ls plugins/` = 98 entries) covering core reporting (Referrers, UserCountry,
  DevicesDetection, Goals, Ecommerce…), infra (PrivacyManager, UsersManager, SitesManager,
  CronArchive support), and extensibility surfaces (CustomDimensions, SegmentEditor).

Distribution model: install-once, GPLv3, no SaaS lock-in, with an optional paid plugin
marketplace layered on top (see §9).

---

## 2. The tracking request, traced end to end

Entry point is `matomo.php` (a one-line shim, `matomo.php:1-11`), which just includes
`piwik.php:1-73`. `piwik.php` does the following, in order:

1. Bootstraps a `tracker`-flavoured application environment (`piwik.php:57-61`) — a narrower boot
   than the main app, explicitly commented "we try to include as little files as possible" (`core/
   Tracker.php:32-33`), for latency.
2. Handles CORS preflight and applies `CORSHandler` (`piwik.php:64-65`).
3. Builds a `Tracker`, a `RequestSet`, a `Handler` (via `Handler\Factory::make()`), and calls
   `$tracker->main($handler, $requestSet)` (`piwik.php:68-73`).

**`Tracker::main`** (`core/Tracker.php:112-141`):
- Short-circuits CORS preflight `OPTIONS` requests (`core/Tracker.php:117-124`).
- Calls `$handler->init(...)`, then `$this->track($handler, $requestSet)` inside a try/catch that
  routes exceptions to `$handler->onException(...)` (`core/Tracker.php:126-133`).
- Always calls `$handler->finish(...)` and disconnects the DB before returning the response body
  (`core/Tracker.php:135-140`).

**`Tracker::track`** (`core/Tracker.php:143-156`):
- `shouldRecordStatistics()` gates on `record_statistics` config and whether Matomo is installed
  (`core/Tracker.php:66-75`) — a global kill switch.
- `$requestSet->initRequestsAndTokenAuth()` (`core/Tracker/RequestSet.php:93-120`) is where
  `$_GET + $_POST` becomes an array of `Request` objects (one per bulk-tracked hit — a single HTTP
  POST can carry many tracking requests via the BulkTracking plugin, which hooks
  `Tracker.initRequestSet` to inject its own array instead of `$_GET+$_POST`).
- `$handler->process($tracker, $requestSet)` (`core/Tracker/Handler.php:52-57`) just loops
  `$requestSet->getRequests()` and calls `$tracker->trackRequest($request)` per request — **each
  request in a bulk POST is processed synchronously, one at a time, in the same PHP process**;
  there is no async queue in the open-source tracker.

**`Tracker::trackRequest`** (`core/Tracker.php:161-209`), per individual hit:
- Bot detection runs first and unconditionally: `isBotRequest()` (`core/Tracker.php:211-215`)
  instantiates a `DeviceDetector` from the UA + client hints and calls `->isBot()`. This result is
  filterable via the `Tracker.isBotRequest` event (`core/Tracker.php:179`) but is *not* itself the
  exclusion check (that's separate, see below) — it only decides whether the deprecated
  `recMode`-driven `BotRequest` path runs (`core/Tracker.php:193-197`).
- The default path (no `recMode`) builds a `Visit\Factory`-made `Visit`, sets the request on it,
  and calls `$visit->handle()` (`core/Tracker.php:199-203`) — this is where visit/action recording
  actually happens.

**`Visit::handle`** (`core/Tracker/Visit.php:105-184`) is the real state machine, and it is a
pipeline over a plugin-supplied list of `RequestProcessor`s
(`StaticContainer::get('Piwik\Plugin\RequestProcessors')`, `core/Tracker/Visit.php:74-75`), each of
which implements up to five lifecycle hooks in a fixed order (documented in
`core/Tracker/RequestProcessor.php:34-77`):
`manipulateRequest` → `processRequestParams` → `afterRequestProcessed` →
(`onNewVisit` xor `onExistingVisit`) → `recordLogs`.

Concretely, in `Visit::handle`:
1. `checkSiteExists($request)` (`core/Tracker/RequestHandlerTrait.php:29-42`) — throws
   `UnexpectedWebsiteFoundException` for a bad/missing `idsite`, logging a `Failures` row first if
   the site ID at least looked like a valid positive integer.
2. Every processor's `manipulateRequest()` runs (`core/Tracker/Visit.php:109-113`).
3. `validateRequest()` checks that auth-gated fields (`city`, `region`, `country`, `lat`, `long`)
   aren't smuggled in unauthenticated, and forces timestamp resolution
   (`core/Tracker/RequestHandlerTrait.php:44-53`).
4. Every processor's `processRequestParams()` runs against a fresh `VisitProperties`
   (`core/Tracker/Visit.php:117-127`); **any processor returning `true` aborts the whole request**
   — this is how `VisitRequestProcessor` implements exclusion (see below): it's not a separate gate,
   it's a processor that can abort the pipeline.
5. `isNewVisit` metadata is read/derived and every processor's `afterRequestProcessed()` runs
   (`core/Tracker/Visit.php:129-143`), which can again abort.
6. Branch on `isNewVisit`: `handleExistingVisit()` (`core/Tracker/Visit.php:195-235`, catches
   `VisitorNotFoundInDb` and falls back to treating it as unmatched) or `handleNewVisit()`
   (`core/Tracker/Visit.php:263-288`).
7. The third-party cookie is (re)written (`core/Tracker/Visit.php:172`), then every processor's
   `recordLogs()` runs — except `ActionsRequestProcessor`, whose `recordLogs` was already invoked
   inside `handleExistingVisit()` for a known visit, specifically to write the
   `log_link_visit_action` row *before* the `log_visit` UPDATE, for lock-ordering reasons
   documented inline (`core/Tracker/Visit.php:174-182`, citing
   `github.com/matomo-org/matomo/issues/17173`).
8. Finally `markArchivedReportsAsInvalidIfArchiveAlreadyFinished($request)`
   (`core/Tracker/RequestHandlerTrait.php:55-76`) — **this is the tracking→archiving bridge**: if
   the tracked hit's timestamp is not today (by the site's timezone), it calls
   `ArchiveInvalidator::rememberToInvalidateArchivedReportsLater($idSite, $date)`
   (§3) so that a late-arriving hit for a past day gets that day's (and its parents') archives
   marked stale, rather than silently under-counting forever.

**Exclusion** (`VisitRequestProcessor::processRequestParams`,
`plugins/CoreHome/Tracker/VisitRequestProcessor.php:98-121`) constructs a
`VisitExcluded($request)` and, if `isExcluded()` is true, returns `true` to abort. `VisitExcluded::
isExcluded()` (`core/Tracker/VisitExcluded.php:66-173`) checks, in order:
non-human bot (DeviceDetector `isBot()` **or** the visitor IP falling in a hardcoded Google/Bing/
Yahoo bot CIDR range list, `core/Tracker/VisitExcluded.php:192-270`) → missing `rec=1` param (the
signal that the hit came from JS, not a bare `<img>` crawl) → the `Tracker.isExcludedVisit` plugin
event → config-excluded request patterns → the Matomo "ignore" cookie
(`IgnoreCookie::isIgnoreCookieFound`) → excluded IP list → excluded user-agent
list (literal substring or regex) → referrer-spam list (only if `enable_spam_filter`) → unknown-URL
exclusion (via `SiteUrls`) → browser-prefetch header detection (`X-Purpose`/`X-Moz`). This is a
strictly synchronous, in-request gate — nothing here is deferred.

**Everything above is synchronous** within the single tracker PHP request/process — DB writes to
`log_visit`/`log_link_visit_action`/`log_conversion*` happen inline, on the request thread, with no
message queue in the open-source core. The one asynchronous-feeling piece is archiving of
*reports*, which is decoupled (§3) — but raw log writes are not.

---

## 3. The archiving / aggregation model (flagship)

This is Matomo's answer to the hard problem in analytics: don't scan raw event rows on every
dashboard load. The model has two halves — a **read path** that resolves a report request to
either a cached blob or a freshly-triggered aggregation, and a **write path** (cron or
browser-triggered) that actually computes and stores archives.

### 3.1 Two fundamentally different aggregation strategies, chosen by period type

`PluginsArchiver`'s constructor sets one flag that governs everything downstream:

```
$shouldAggregateFromRawData = $this->params->isSingleSiteDayArchive();
```
(`core/ArchiveProcessor/PluginsArchiver.php:81`, filterable via the
`ArchiveProcessor.shouldAggregateFromRawData` event, line 91)

- **Day period, single site** → `shouldAggregateFromRawData = true` → `callAggregateDayReport()` on
  each plugin's `Archiver`, which runs SQL directly against `log_visit`/`log_link_visit_action`/etc
  via `LogAggregator` (`core/ArchiveProcessor/PluginsArchiver.php:183-186`,
  `aggregateDayVisitsMetrics()` at line 314-322 calls
  `$this->archiveProcessor->getLogAggregator()->queryVisitsByDimension()`).
- **Every other period** (week, month, year, range, or multi-site) → `false` →
  `callAggregateMultipleReports()`, which sums the **already-stored subperiod archives** — a week
  sums 7 day-archives, a month sums its weeks or days, a year sums its months
  (`core/ArchiveProcessor/PluginsArchiver.php:187-190`).

The actual summation is `ArchiveProcessor::aggregateDataTableRecords`
(`core/ArchiveProcessor.php:214-276`): for each named report (e.g. `Referrers_type`), it loads and
recursively sums the DataTable blobs of every subperiod (subtables summed too), truncates to
`maximumRowsInDataTableLevelZero`/`maximumRowsInSubDataTable`, re-serializes, and stores it as the
record for the *current* period. `aggregateNumericMetrics` does the same for scalar metrics (with
`sum`/`min`/`max` operations, `core/ArchiveProcessor.php:298-...`). **This is genuinely
recursive/compositional**: a Year archive is built from Month archives which were built from Week
or Day archives which were built from raw log rows — raw logs are touched exactly once, at the Day
level, ever.

### 3.2 The read path: resolve-or-trigger

`Archive::get()` (`core/Archive.php:552-625`) is the entry every report API call goes through:
1. Resolve `[$archiveIds, $archiveStates] = $this->getArchiveIdsAndStates($archiveNames)`.
2. If empty, fire `Archive.noArchivedData` and return an empty result — **no synchronous
   archiving is triggered here** if it turns out there's nothing to launch (see 3.3's guard).
3. Otherwise pull rows from `archive_numeric`/`archive_blob` via `ArchiveSelector::getArchiveData`
   — with a documented retry: if the cached in-memory archive-id set returns nothing (because a
   nested/recursive archiving run pruned an older archive), it clears the id cache and retries once
   (`core/Archive.php:609-617`).

`getArchiveIdsAndStates()` (`core/Archive.php:666-708`) is where the cache-miss trigger actually
lives: for each plugin group not already resolved, if `Rules::isArchivingEnabledFor(...)` is true
(archiving isn't globally/segment-disabled) it calls `cacheArchiveIdsAfterLaunching(...)` — which,
per site/period, constructs an `ArchiveProcessor\Loader` and calls `prepareArchive($pluginName)`.
**This is the on-demand trigger**: a report request for a period that has never been archived
causes archiving to run inline, in the same request, before the API can respond. This is
"browser-triggered archiving" and it's the default; `core:archive` cron exists to pre-warm this
cache so end users never pay that latency (§3.4).

### 3.3 `Loader::prepareArchiveImpl` — the actual cache-miss decision tree

(`core/ArchiveProcessor/Loader.php:128-182`)
1. If invalidate-before-archiving is requested and browser-triggering is enabled, first check for
   and apply any pending invalidations (`invalidatedReportsIfNeeded()`).
2. `loadArchiveData()` (`core/ArchiveProcessor/Loader.php:230-277`) queries
   `loadExistingArchiveIdFromDb()` for the latest `DONE_OK`/`DONE_INVALIDATED` archive plus any
   newer partial archives. If a usable (non-invalidated, fresh-enough, not-missing-requested-report)
   archive id exists, **return it immediately — no computation.** Two more escape hatches:
   - `canSkipThisArchive()`: if there were provably 0 visits for the whole period (an optimization
     specifically called out in a comment for large-period/segment queries — no need to recurse
     into every month/week/day of an empty year, `core/ArchiveProcessor/Loader.php:257-269`).
   - Otherwise, it falls through to actually computing.
3. Only the **root** archiving request (not one triggered by `core:archive` itself, and only at the
   top of the recursion) takes a named MySQL lock (`LoaderLock`, keyed by site+period+segment+plugin
   done-flag, `core/ArchiveProcessor/Loader.php:215-225,155-178`) around a second `loadArchiveData()`
   check-then-compute, to prevent duplicate concurrent computation of the same archive under
   concurrent report requests.
4. `insertArchiveData()` (`core/ArchiveProcessor/Loader.php:190-209`) runs
   `prepareCoreMetricsArchive` (visit counts — day from raw logs, else summed) then
   `prepareAllPluginsArchive` (delegates into `PluginsArchiver::callAggregateAllPlugins`, §3.1).

### 3.4 Invalidation: how late data gets corrected

Two invalidation entry points, one deferred, one immediate:

- **Deferred** (`ArchiveInvalidator::rememberToInvalidateArchivedReportsLater`,
  `core/Archive/ArchiveInvalidator.php:111-140`) — called from the tracker itself
  (`RequestHandlerTrait::markArchivedReportsAsInvalidIfArchiveAlreadyFinished`, §2) when a tracked
  hit lands on a non-today date. It just writes a row to the `option` table (a lightweight
  "remember this site+date needs reprocessing" marker, deliberately *not* an immediate
  archive-table UPDATE, because that would run expensive queries on the hot tracking path) —
  explicitly documented as the point of this two-phase design
  (`core/Archive/ArchiveInvalidator.php:44-55`).
- **Immediate** (`ArchiveInvalidator::markArchivesAsInvalidated`,
  `core/Archive/ArchiveInvalidator.php:272-358`) — used by explicit user actions (API calls,
  GDPR deletion, `core:invalidate-report-data` console command). It flips the archive's done-flag
  to `DONE_INVALIDATED` in `archive_numeric`/`archive_blob` and **cascades**:
  `getAllPeriodsByYearMonth()` (`core/Archive/ArchiveInvalidator.php:360-390`) walks the requested
  period both down (`addChildPeriodsByYearMonth` — invalidating a month also invalidates its weeks
  and days, `core/Archive/ArchiveInvalidator.php:398-414`) and up
  (`addParentPeriodsByYearMonth` — invalidating a day also invalidates its week/month/year, since
  those parent aggregates now contain stale summed data, lines 416+), but **only within the same
  calendar year+month** — a period spanning multiple months is dropped from parent propagation on
  the theory that cross-month periods aren't used as an input to any other aggregate anyway
  (`shouldPropagateUp`, line 392-396). Archive rows are physically split into monthly tables
  (§8), which is exactly why invalidation buckets by year-month.

### 3.5 `CronArchive` / `QueueConsumer`: the batch consumer

`core:archive` (`core/CronArchive.php:41-44`) is a maintenance/pre-warming cron, explicitly
documented as existing "for a Fast dashboard rendering" — i.e. its job is to make sure the
browser-triggered path in §3.2/3.3 almost never has to compute anything live. `QueueConsumer`
(`core/CronArchive/QueueConsumer.php`) drains the `archive_invalidations` table (§8) per site:
`getNextArchivesToProcess()` (lines 141-240+) pulls one invalidation at a time and skips/defers it
if: the period predates the site's creation date (deletes the stale invalidation outright), its
plugin was deactivated since, it's a duplicate already in the current batch, a
`isSimilarArchiveInProgress()` check finds another process already computing it, or it has an
*intersecting period* with something already queued in this batch (different periods for the same
site aren't processed concurrently to avoid archive-id races). `shouldSkipArchiveBecauseLowerPeriod
OrSegmentIsInProgress` (line 397) encodes ordering: lower periods (day) must resolve before higher
ones (week/month/year) that depend on them, and no-segment archives shouldn't race in-progress
segment archives for the same period.

### 3.6 Freshness policy

`ArchiveProcessor\Rules` (`core/ArchiveProcessor/Rules.php`) is the rulebook: `getTodayArchiveTimeToLive()`/
`setTodayArchiveTimeToLive()` (lines 166-183) govern how long an archive for **today** (an
inherently still-changing period) is considered fresh before being recomputed — this is the "how
stale can 'today' be" dial; closed past periods, once `DONE_OK`, are treated as immutable and never
re-triggered by staleness alone (only by explicit invalidation). `isArchivingEnabledFor` /
`isArchivingDisabledFor` (lines 216-255) let admins turn off browser-triggered archiving per
site/period/segment entirely (forcing cron-only pre-computation, avoiding the latency spike of an
end user's page load triggering a cold aggregation).

### 3.7 On a cache miss

Concretely, if a user requests a report for a period with no existing archive and browser-triggered
archiving is enabled: the API call blocks, `Loader::prepareArchiveImpl` runs synchronously inline
(§3.3), which for a Day period queries raw `log_*` tables directly, or for a larger period
recursively triggers (and blocks on) archiving of each of its subperiods first — this can cascade
arbitrarily deep (a Year cache-miss can transitively trigger 12 Month archivings, each of which can
trigger ~30 Day archivings if none of those exist either). This recursion depth is tracked via
`Loader::$archivingDepth` (`core/ArchiveProcessor/Loader.php:112-121`) purely for lock-scoping (only
depth-1, i.e. the outermost call, takes the concurrency lock).

---

## 4. Segments

### 4.1 Grammar

A segment definition is a flat two-level boolean expression: `;` = AND, `,` = OR, with backslash
escaping for literal `;`/`,` in values (`SegmentExpression::parseTree`,
`core/Segment/SegmentExpression.php:467-489`). Critically **there is no arbitrary nesting or
parentheses** — the grammar is exactly "OR-groups joined by AND", e.g.
`countryCode==US;browserName==Chrome,browserName==Firefox` means
`country=US AND (browser=Chrome OR browser=Firefox)`, and that's the ceiling of expressiveness;
you cannot write `(A OR B) AND (C OR D) OR E` because OR only distributes within one AND-slot.

Each operand is `name<operator>value`, parsed by regex against a fixed operator set
(`core/Segment/SegmentExpression.php:19-28,115-156`): `==`, `!=`, `>=`, `<=`, `>`, `<`, `=@`
(contains), `!@` (does not contain), `=^` (starts with), `=$` (ends with), plus empty-value sugar
for IS NULL / IS NOT NULL (`==` / `!=` with no right-hand side, lines 140-149).

### 4.2 Parsing → SQL

`getSqlMatchFromDefinition()` (`core/Segment/SegmentExpression.php:205-366`) is a direct
operator-to-SQL-fragment switch: `==`→`%s =`, `=@`→`%s LIKE '%value%'` (value escaped for LIKE
wildcards, `escapeLikeString`), `!=`→`%s <>` but *also* matching NULL rows (`alsoMatchNULLValues`,
since SQL `<>` doesn't match NULL by default and users expect "not equal" to include "absent"),
`=^`/`=$` are LIKE with the wildcard on one side only. A segment name doesn't map 1:1 to a raw
column — `Segment::getCleanedExpression()` (referenced but not the primary read target here)
resolves logical segment names (e.g. `pageUrl`) to their backing SQL, including cases that need a
**subquery injected via `MATCH_ACTIONS_CONTAINS`/`MATCH_ACTIONS_NOT_CONTAINS`** (lines 296-313) —
segments over action-table data (URLs, page titles) compile to `col IN (SELECT ... log_action ...)`
rather than a direct column comparison, because the value lives in a normalized `log_action` table,
not inline in `log_visit`/`log_link_visit_action` (see §8). Every resolved column is validated
against `$availableTables` (`checkFieldIsAvailable`, line 347) — a segment can only reference
columns from tables actually joined into the current query, which is how Matomo prevents
a segment definition from becoming a SQL-injection or cross-table-leak vector while still
supporting free-text segment strings.

`getSql()` (lines 498-519) does the final assembly: each OR-group of ≥2 operands becomes
`( a OR b )`; the AND-groups are joined with plain `AND`. The whole thing returns
`{where: string, bind: array}` for use in the same parameterized-query helper
(`Segment::getSelectQuery`, `core/Segment.php:604+`) that every log-aggregating SQL query in the
codebase goes through.

### 4.3 Segments are archived as fully separate, hash-keyed records

A segmented report is not a runtime filter over a shared cached aggregate — it is its own
completely separate archive. `Rules::getDoneFlagArchiveContainsAllPlugins(Segment $segment)`
returns `'done' . $segment->getHash()` (`core/ArchiveProcessor/Rules.php:107-110`), and
`Segment::getHash()`/`getSegmentHash()` (`core/Segment.php:534-584`) is an MD5 of the
(URL-decoded) segment definition string, resolved against any saved/named segment's stored hash if
one matches. Every `archive_numeric`/`archive_blob` row is scoped by this `done<hash>` flag
alongside site/period, meaning **N segments materialize N independent copies of every archived
report** for the periods they're actually queried against — there's no shared base aggregate that
segments subtract from. This is a real cost (segment archiving is opt-in/pre-computed per
auto-archived segment, `Rules::getSegmentsToProcess`, `core/ArchiveProcessor/Rules.php:89-100`) in
exchange for O(1) report reads once computed, same as the unsegmented case.

### 4.4 Contrast with a typed node tree

Dittofeed (a prior repo in this batch) expresses equivalent boolean logic as a typed, arbitrarily
nestable node tree with a JSON Schema/Zod-validated shape — you can express any boolean formula,
the AST is directly introspectable and transformable by code, and there's no string-escaping
concern. Matomo's segment grammar is the opposite: a flat, unparenthesized, string-delimited DSL
that must be regex-parsed and where AND/OR nesting is structurally capped at two levels. This is a
15-year-old design constraint from needing segments to be compact and shareable as a single URL
query parameter (`&segment=...`) — a constraint a Postgres/TypeScript rebuild does not have. **The
grammar itself is not worth copying**; the worthwhile ideas are (a) resolving logical
dimension names to physical SQL through a name→column/join table rather than hardcoding column
names into every filter call site, and (b) treating "segment" as a first-class archiving dimension
with its own hash-keyed cache rather than a runtime-only filter.

---

## 5. Visitor identity

Three identity signals, tried in a strict precedence order inside `Request::getVisitorId()`
(`core/Tracker/Request.php:756-819`):

1. **User ID** (`&uid=`), if `enable_userid_overwrites_visitorid` is on for the site — hashed via
   `getUserIdHashed()` and truncated to the 8-byte visitor-id width (line 769-778). This is the
   strongest signal: an app-authenticated user ID always wins if present and enabled.
2. **Forced visitor ID** (`&cid=`, from the Tracking API's `setVisitorId()`) — a raw 16-hex-char ID
   the caller asserts directly (lines 781-790); used for server-side tracking integrations that
   maintain their own identity.
3. **Third-party cookie**, if `shouldUseThirdPartyCookie()` (cross-domain linking is configured) —
   read via `getThirdPartyCookieVisitorId()` (lines 796-805).
4. **First-party cookie** — the `_id` request param (which `piwik.js` populates from its own
   `_pk_id`-prefixed browser cookie) (lines 807-811).

If **none** of these resolve (no cookie sent, no user/forced ID — e.g. first-ever visit, or cookies
blocked), `$idVisitor` is `false`, and identity falls back entirely to the **fingerprint**:
`Settings::getConfigId()` (`core/Tracker/Settings.php:36-116`) computes a 64-bit MD5 hash
(`getConfigHash`, lines 142-191) over: OS short-name + `BOT` sentinel if bot-detected, browser
name+version, six plugin-presence flags (Flash/Java/QuickTime/RealPlayer/PDF/WindowsMedia/
Silverlight/Cookie — mostly vestigial today), the visitor's IP, browser language (truncated to 20
chars), a per-installation salt (`SettingsPiwik::getSalt()`, to prevent fingerprint correlation
*across* separate Matomo instances), and optionally a **rotating daily salt**
(`FingerprintSalt`) if `create_new_visit_after_midnight` is configured, plus the site ID unless
cross-site fingerprint sharing is enabled. This `config_id` is then used by
`VisitorRecognizer::findKnownVisitor()` (`core/Tracker/VisitorRecognizer.php:92-145`) as the
fallback lookup key when no cookie-derived `idvisitor` was available — it's a heuristic, explicitly
documented as best-effort ("maintaining some privacy by default", `Settings.php:124-126`), not a
durable identity.

**Visit stitching** — same visitor, is this a new visit or a continuation? —
`VisitRequestProcessor::isVisitNew()` (`plugins/CoreHome/Tracker/VisitRequestProcessor.php:176-217`):
not-known-visitor ⇒ new; explicit `&new_visit=1` ⇒ new; debug config
`tracker_always_new_visitor` ⇒ new; else compare `visit_last_action_time` of the last known visit
to now — **more than `visit_standard_length` seconds (default window, commonly 30 min) ⇒ new**
(`isLastActionInTheSameVisit`, lines 223-230); optionally, `create_new_visit_after_midnight` forces
a new visit purely because the last action was a different calendar day in the site's timezone even
if within the 30-minute window (lines 202-209); and if a `user_id` was previously set and the
current request's forced user ID doesn't match it, that also forces a new visit (`lastUserIdWasSet
AndDoesMatch`, lines 293-308) — i.e. logging in as a different user ends the anonymous session
even mid-window. The lookback window itself is configurable and can be widened independently of
the visit-length window via `window_look_back_for_visitor`
(`VisitorRecognizer::getWindowLookupThisVisit`, lines 235-247), for more accurate (but slower)
unique-visitor counting across long gaps.

---

## 6. Privacy and GDPR machinery

This is genuinely the deepest, most production-hardened subsystem in the codebase, and it's
distributed across three points: the **tracking write path** (inline anonymization), a
**data-subject API** (right-to-erasure), and **scheduled purging** (retention).

**IP anonymization** — `IPAnonymizer::setVisitorIpAddress()`
(`plugins/PrivacyManager/IPAnonymizer.php:39-54`), hooked on the `Tracker.setVisitorIp` event fired
from `VisitRequestProcessor::afterRequestProcessed`
(`plugins/CoreHome/Tracker/VisitRequestProcessor.php:147-165`) — masks `ipAddressMaskLength` octets
(IPv4) or partial bits (IPv6, per doc comment in `plugins/PrivacyManager/Config.php:28-32`) via
`IP::anonymize()`. Runs **before the IP is persisted**, not as a later scrub — the raw IP is never
written to `log_visit` at all if this is on. A parallel setting,
`useAnonymizedIpForVisitEnrichment`, controls whether GeoIP/reverse-DNS lookups (which happen
during the same request) see the anonymized or the raw IP.

**Do Not Track** — `DoNotTrackHeaderChecker` (`plugins/PrivacyManager/DoNotTrackHeaderChecker.php`)
checks `DNT: 1` / `X-Do-Not-Track: 1` headers (lines 116-120), and if `doNotTrackEnabled` and the
header is present, sets `$exclude = true` on the visit (wired via the same
`Tracker.isExcludedVisit` event used for bot/IP/UA exclusion in §2), deletes any existing
third-party cookie UID, and responds with `Tk: N` per the (now largely dead) Tracking Preference
Expression spec. A `PrivacyManager.shouldIgnoreDnt` event lets a plugin override DNT compliance
per-request (lines 75-81) — an explicit extension point for "respect DNT except for these cases."

**Pseudonymization on write** — `PrivacyManager\Tracker\RequestProcessor`
(`plugins/PrivacyManager/Tracker/RequestProcessor.php:40-127`), running in
`manipulateRequest()` (before any DB write):
- `anonymizeUserId`: replaces `&uid=` with `sha1($userId . $salt)` where the salt is a
  per-installation option (`PrivacyManager::OPTION_USERID_SALT`) — deliberately **stable** ("pseudo
  anonymization ... always generate the same UserId for the same original UserID", lines 105-110)
  so cross-visit identity is preserved for reporting while the raw ID is never stored.
- `anonymizeOrderId`: replaces `&ec_id=` with `sha1(randomInt . orderId . time() . salt)` —
  deliberately **not** stable (includes `time()` and a fresh random int per call), because unlike
  user ID, order ID doesn't need to be re-derivable/joinable later.
- Referrer anonymization (`onNewVisit`/`onExistingVisit`, lines 61-103) strips/masks referrer URL,
  name, and search keyword via `ReferrerAnonymizer`, applied after referrer *type* detection (so
  anonymization doesn't break the "was this a search engine" classification, comment at
  lines 67-68) but before persistence.

**GDPR erasure** — `DataSubjects::deleteDataSubjects($visits)`
(`plugins/PrivacyManager/Model/DataSubjects.php:110-147`):
1. Fires `PrivacyManager.deleteDataSubjects` so third-party plugins storing their own per-visit data
   outside core log tables can delete their rows too (an extension point specifically because core
   can't know about arbitrary plugin storage).
2. Computes the calendar dates affected (`getDatesToInvalidate`, lines 165-193, a direct
   `SELECT visit_last_action_time FROM log_visit WHERE idvisit IN (...)` per site, converted to the
   site's timezone).
3. Deletes the underlying log rows across **every** registered log table (`LogTablesProvider`,
   sorted so FK-adjacent tables delete in a safe order, `sortLogTablesToEnsureDataErasureFromAllTablesIsPossible`,
   lines 249-296).
4. **Re-invalidates every archive that could contain the deleted visit's contribution**
   (`invalidateArchives`, lines 149-163) — this reuses the exact same
   `ArchiveInvalidator::rememberToInvalidateArchivedReportsLater` deferred mechanism from §3.4.
   **Deletion is not "delete raw row, hope aggregates catch up" — it explicitly forces every
   downstream pre-aggregated report to recompute**, so a deleted visitor's data actually
   disappears from historical dashboards, not just from future raw-data queries. This is the single
   most valuable pattern to port: privacy deletion and the aggregation-invalidation system are the
   same mechanism, not two parallel ones that can drift out of sync.

**Retention / scheduled purge** — two purgers with different targets:
- `LogDataPurger::purgeData($deleteLogsOlderThan, $deleteUnusedLogActions)`
  (`plugins/PrivacyManager/LogDataPurger.php:65-121`) deletes **raw** `log_*` rows older than a
  configured age (and orphaned `log_action` rows no visit references anymore).
- `ReportsPurger::purgeData()` (`plugins/PrivacyManager/ReportsPurger.php:108-166`) deletes
  **aggregated** `archive_numeric`/`archive_blob` rows per a separate retention policy
  (`getReportPeriodsToKeep`, line 386) — you can keep aggregate reports far longer than raw logs
  (the normal analytics posture: raw PII-adjacent data has a short retention window, rolled-up
  numbers can be kept indefinitely), and it separately tracks which numeric tables' matching blob
  rows to also drop (`getBlobTableWhereExpr`, line 296) since numeric and blob archives are
  independent tables (§8) keyed only by shared `idarchive`.
Both are driven by `PrivacyManager\Tasks` as scheduled (cron-timed) jobs, not synchronous requests.

**Cookieless mode** — `Config::$properties['forceCookielessTracking']`
(`plugins/PrivacyManager/Config.php:33,58`) is checked directly in `Request::getVisitorId()`
(`core/Tracker/Request.php:795`) to skip *all* cookie-based lookup, forcing every visitor onto the
fingerprint-only identification path (§5) — a genuine no-cookies mode, not a UI toggle that merely
suppresses a banner.

**Client-side consent gating** (`js/piwik.js`) — `requireConsent()` (line 7395+) flips the tracker
into a mode where tracking calls are queued rather than sent; `setConsentGiven()` flushes the queue
and (optionally) also enables cookie writes; `forgetConsentGiven()` reverses this and re-arms
`requireConsent()`. This is enforced entirely in the browser before any network request is made —
the server-side pieces above (DNT, IP anon, pseudonymization) are a second, independent layer that
applies regardless of what the client claims about consent.

---

## 7. Plugin architecture (brief)

Convention over configuration, no manifest file: `Plugin\Manager::makePluginClass()`
(`core/Plugin/Manager.php:1345-1374`) looks for `plugins/<Name>/<Name>.php`, requires it, and
instantiates the namespaced class, which must extend `Piwik\Plugin`
(enforced at line 1370-1372) — if the file doesn't exist, a bare minimal `Plugin` stub is
constructed instead (used for asset-only "plugins" like themes, line 1356-1359).

Hook registration is a single method, `registerEvents()`, returning an
`'Event.name' => 'methodName'` map — e.g. `plugins/Actions/Actions.php:30-40` wires
`ViewDataTable.configure`, `AssetManager.getJavaScriptFiles`, etc. Dispatch is a global
`Piwik::postEvent('Event.name', [...])` / `EventDispatcher`, string-keyed, with no compile-time
check that a listener's signature matches what a caller passes — every example seen in this pass
(`Piwik::postEvent('Tracker.isExcludedVisit', ...)`, `'Archiving.getIdSitesToMarkArchivesAsInvalidated'`,
etc.) is essentially a WordPress-style action/filter hook.

Tracker-specific extensibility is a separate, narrower mechanism: `RequestProcessor` subclasses are
collected via DI (`StaticContainer::get('Piwik\Plugin\RequestProcessors')`,
`core/Tracker/Visit.php:74-75`) rather than the generic event bus, giving them a typed five-method
lifecycle contract (§2) instead of arbitrary event names — this is the one place the plugin system
uses interface-based extension instead of stringly-typed hooks, and it's the more copyable half of
this section. **The registration pattern (one file, one class, one directory = one feature) is fine
to imitate structurally; the untyped global event-name map is strictly worse than what a TypeScript
rebuild gets for free from typed event emitters or a DI container, and is not worth replicating.**

---

## 8. Data model

Two clearly separated table families (`core/Db/Schema/Mysql.php`), matching the raw-vs-aggregated
split throughout this document:

**Log tables** (raw, per-event, append-mostly):
- `log_visit` (`Mysql.php:208-220`): one row per visit session. Key columns: `idvisit` (BIGINT PK,
  auto-increment — the visit-count high-water mark), `idsite`, `idvisitor BINARY(8)` (the resolved
  identity from §5), `config_id BINARY(8)` (the fingerprint from §5, kept *alongside* idvisitor, not
  instead of it — used as a secondary matching key), `visit_last_action_time`, `location_ip
  VARBINARY(16)` (binary-packed to hold both IPv4 and IPv6 in one column). Indexes:
  `(idsite, config_id, visit_last_action_time)` and `(idsite, idvisitor, visit_last_action_time
  DESC)` — both exist because visitor lookup happens by *either* key depending on what's available
  (§5's precedence chain), plus a plain `(idsite, visit_last_action_time)` for date-range scans.
- `log_link_visit_action` (`Mysql.php:267-279`): the per-hit fact table, one row per pageview/event
  within a visit, PK `idlink_va` auto-increment, FK-like `idvisit`, `idaction_url_ref`/
  `idaction_name_ref` pointing at normalized action rows. Only index besides PK is `(idvisit)` — this
  table is written far more often than queried by anything except "all hits for visit X."
- `log_action` (`Mysql.php:197-206`): a **deduplication table** for URLs/page titles/event
  names — `name VARCHAR(4096)` with a `hash INTEGER` + `(type, hash)` index for fast
  exact-match lookup before insert (classic "intern the string, reference by int ID everywhere
  else" pattern, which is exactly why segments on URL/title fields compile to a subquery against
  this table, §4.2).
- `log_conversion` / `log_conversion_item` (`Mysql.php:222-265`): goal conversions and their
  ecommerce line items, keyed by `(idvisit, idgoal, buster)` / `(idvisit, idorder, idaction_sku)`
  respectively — `buster` exists specifically to allow multiple conversions of the *same* goal in
  one visit without violating the natural key.

**Archive tables** (aggregated, monthly-partitioned, effectively write-once per period):
- `archive_numeric` / `archive_blob` (`Mysql.php:309-336`): identical shape —
  `(idarchive, name, idsite, date1, date2, period, ts_archived, value)`, PK `(idarchive, name)`,
  differing only in `value DOUBLE` vs `value LONGBLOB` (scalar metrics vs serialized DataTables).
  Both are **physically split into one table per calendar month**
  (`archive_numeric_YYYY_MM` / `archive_blob_YYYY_MM`,
  `core/DataAccess/ArchiveTableCreator.php:208`, `getYearMonth`-formatted `'Y_m'`) — this is *why*
  §3.4's invalidation cascade buckets everything by year-month, and it bounds any single table's
  row count to one month of one metric's history across all sites/periods/segments, which is what
  keeps `(idsite, date1, date2, period, name(6))` a usable index even at large scale
  (`index_idsite_dates_period`, line 319) rather than needing to scan years of data.
- `archiving_metrics` (`Mysql.php:338-356`): archiving-run telemetry (`ts_started`, `ts_finished`,
  `total_time`, `is_temporary`) — separate from the data tables, purely observability.
- `archive_invalidations` (`Mysql.php:358-375`): the literal work queue `QueueConsumer` drains
  (§3.5) — `idinvalidation` PK, `status` (queued/in-progress), `processing_host`/`process_id` for
  claim-tracking across a multi-worker cron fleet, indexed on `(idsite, date1, period)`.

The split is the whole point: `log_*` tables are optimized for high-frequency narrow writes and
identity-keyed lookups; `archive_*` tables are optimized for coarse, wide, infrequently-written,
frequently-read rows scoped to exactly the query shape the reporting UI needs (site+period+segment+
metric-name) — no report ever does an aggregate `GROUP BY` over `log_visit` at read time in the
happy path; that work was already paid for at archive time.

---

## 9. Licence

**GPL-3.0+** (`composer.json:12`: `"license": "GPL-3.0+"`; `LICENSE:1-2` header text is the GNU GPL
v3). This is a copyleft licence but **not AGPL** — the distinction matters for a SaaS use case:
GPLv3's copyleft obligation triggers on *distributing* the software (or a derivative), not on
*running it as a network service*. AGPLv3 (which listmonk uses, per that repo's own analysis in
this batch) closes exactly that "SaaS loophole." Since we are not shipping any Matomo PHP code at
all — this is a from-scratch TypeScript/Postgres rebuild informed by reading the mechanism, not a
fork or derivative — GPLv3 vs AGPLv3 is close to moot either way: **nothing here is a licence risk
because nothing here is being reused as code.** Matomo lands in the same "ideas-only" bucket as
listmonk, just for a slightly different licensing reason (we're not distributing *or* running their
code, rather than "we could run it but not distribute it").

**Premium plugins**: the `Marketplace` plugin (`plugins/Marketplace/API.php:26`,
`plugins/Marketplace/Controller.php:270`) is a client for browsing/installing **paid** plugins from
`matomo.org/shop` — a license-key-gated install-on-demand mechanism. None of those premium plugins'
source is present in this tree; only the marketplace client that would fetch them is. This is worth
noting only insofar as it confirms the open-source core is intentionally incomplete by design
(monetization via optional paid extensions), not that any premium code leaked into what we read.

---

## 10. What's worth taking

Ranked by transferability to a TypeScript/Postgres analytics rebuild:

1. **The Day-vs-Period aggregation split (§3.1)** — raw-log aggregation happens exactly once, at
   the smallest period granularity, and every larger period is pure summation over already-stored
   results, recursively. This is the single highest-value idea in the whole codebase and maps
   cleanly onto Postgres: a `period_archives` table (numeric + jsonb/bytea blob columns, mirroring
   §8's split) with a "compute from raw events" path gated strictly to the day/hour grain and a
   "sum child periods" path for everything above it.
2. **Deferred, cascading invalidation (§3.4)** — recording an "this needs recompute" marker is O(1)
   and happens inline on write; the actual expensive recompute is a queue consumer's job, and it
   knows to walk both up (day→month→year) and down (month→its days) from whatever was invalidated.
   Directly portable: a `pending_invalidations` table plus a worker that computes the affected
   period ancestor/descendant set before recomputing.
3. **Segments as first-class, hash-keyed archive dimensions (§4.3)** — treating "no segment" as
   just another segment (empty-string hash) and caching every segment's aggregates exactly like the
   unsegmented case, keyed by a content-hash of the segment definition, is a clean, low-code way to
   get "any ad hoc segment becomes fast after its first computation" without a special case in the
   query layer.
4. **TTL-for-open-periods, immutability-for-closed-periods (§3.6)** — cheap and correctness-
   preserving: "today" is allowed a short staleness window because it's still changing; a closed
   past period is trusted forever once done, and only explicit invalidation (not staleness) ever
   recomputes it. Avoids the common analytics-system bug of a "cache TTL" applied uniformly that
   either recomputes closed history needlessly or serves genuinely stale data for the current day.
5. **GDPR deletion and archive invalidation are the same mechanism (§6)** — the most
   under-appreciated design decision here. Building the erasure feature on top of the *existing*
   "mark stale, let the aggregator fix it" pipeline instead of a bespoke reconciliation job means
   deletion correctness is inherited "for free" by every future report type, forever, with zero
   extra code per report. Worth replicating exactly as a design principle, independent of language.
6. **Layered identity resolution, cookie/user-id-first, fingerprint as degrade-gracefully fallback
   (§5)** — the *layering* (try strong signals first, fall back to a weak heuristic only when
   nothing else is available, and never let the weak signal silently overwrite a strong one) is
   worth keeping. The specific fingerprint formula (MD5 of UA+IP+plugin flags) is dated, weak, and
   arguably itself a privacy liability worth reconsidering rather than porting verbatim — most of
   its inputs (Flash/Java/Silverlight presence) are vestigial in 2026 browsers.

**Not worth taking:**
- The untyped, string-keyed global event bus for plugin hooks (§7) — a TypeScript codebase gets
  strictly better ergonomics and safety from typed event emitters or DI-based extension points; the
  *directory-per-plugin* convention is fine, the *hook dispatch mechanism* is not.
- The flat, unparenthesized, string-DSL segment grammar (§4.4) — a typed, arbitrarily-nestable node
  tree (as Dittofeed uses) is strictly more expressive, more testable, and avoids an entire class of
  string-escaping bugs (`\;`, `\,`) that this grammar has to carry.
- `CronArchive`'s PHP-process-specific concurrency control (MySQL named locks, PID-file-adjacent
  `processing_host`/`process_id` claim columns, `CliMulti` HTTP-based worker fan-out) — this is
  15 years of working around not having a real job queue. A modern job queue (or Postgres
  `SELECT ... FOR UPDATE SKIP LOCKED`) replaces all of it with less code and fewer edge cases.
- The bot-exclusion IP-range allowlists hardcoded in `VisitExcluded`
  (`core/Tracker/VisitExcluded.php:232-270`) — a maintained, regularly-updated bot-detection
  library/service is a better foundation than a static CIDR list frozen at whatever point someone
  last edited this file.
