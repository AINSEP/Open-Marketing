# listmonk Architecture — Reference Analysis

> Reference-only analysis of upstream listmonk, done to decide **what to port** into the
> Open Design–based Open Marketing repo. listmonk is reference material, not a source to
> copy wholesale — see the License section below for why that matters more here than on
> the other repos surveyed.
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/listmonk` (clone of
>   `github.com/knadh/listmonk`, analyzed at commit `e1b0a8bb`, 2026-07-01)
> - **Tools:** codebase-memory-mcp (project `listmonk`, moderate mode) + graphify
>   (`graphify-out/`, Tree-sitter, no LLM) + direct source reads (`rg`/`Read`). Two
>   independent graph engines as a cross-check, plus SQL-file reading since goyesql
>   externalizes nearly all data-access logic out of Go and into `queries/*.sql`.
> - **Date:** 2026-09-06

## Section 0 — Premise corrections and self-corrections

Every premise in the dispatch brief was checked against source. One needs a real
correction; the rest held.

1. **"Vue/TSX admin" is half right — corrected.** The primary admin dashboard is
   **Vue 2.7** (`frontend/package.json:26` `"vue": "^2.7.14"`), not Vue 3, and it is
   **plain JavaScript, not TypeScript**: `grep -rl 'lang="ts"' frontend/src` returns
   zero of the 47 `.vue` files (all use untyped `<script>`), and `frontend/src` itself
   has zero `.ts`/`.tsx` files. The TSX that does exist (66 `.tsx` files) lives entirely
   under `frontend/email-builder/`, a **separate, MIT-licensed React/MUI application**
   (`frontend/email-builder/package.json:2` `@listmonk/email-builder`, vendored from
   `@usewaypoint/editor-sample` per `frontend/email-builder/README.md:1`), built
   independently (own `package.json`, `vite.config.ts`, `yarn.lock`) and loaded into the
   Vue admin at runtime as a UMD script inside an `<iframe>`
   (`frontend/src/components/VisualEditor.vue:3,46-47`). Treat this as two frontends, not
   one — a Vue 2/JS legacy dashboard and a vendored, cleanly separable React email-block
   editor with its own license.
2. **No premise about license was made in the brief, but this is the single most
   important finding of the analysis and belongs here, first.** The root `LICENSE` is
   **GNU AGPLv3** (`LICENSE:1-2`), applying to the entire main tree (Go backend, Vue
   frontend, SQL, everything under `cmd/`, `internal/`, `models/`, `frontend/src`). AGPLv3
   is strong copyleft with a network-use clause: distributing (or offering as a network
   service) a work that **incorporates** listmonk's code obligates releasing the combined
   work's source under AGPLv3-compatible terms. This is a materially different posture
   than Chatwoot (MIT core / proprietary EE) or Dittofeed (MIT throughout) — see
   **License and port strategy** below.
3. **Zero Go test files, discovered rather than assumed.** `find . -name '*_test.go'`
   returns nothing, and no `.go` file imports `"testing"`, across all 94 Go files. This
   holds despite `Makefile:98-99` defining `test: go test ./...` — the target exists,
   there is simply nothing for it to run. Cypress **does** exist (11 specs under
   `frontend/cypress/e2e/`), so the project is not untested, but the entire backend —
   including the SQL-injection-adjacent segment-query feature and the ZIP/CSV importer —
   ships with no automated regression coverage.
4. **cbm `Route` nodes are usable here, but not the way `get_architecture` presents
   them — a genuine trap, not a premise, worth recording precisely.** The `Route` node
   schema (`get_graph_schema`) has no `path` or `full_path` property at all; the route
   path is stored in the **`name`** property (`MATCH (r:Route) RETURN r.name` →
   `"/api/health"`, `"/api/subscribers/:id"`, etc.). `get_architecture(aspects:["routes"])`
   resolves this correctly and returns real method+path pairs (167 routes), but a direct
   Cypher query using `r.path` silently returns empty strings — confirmed both ways. In
   addition, `r.file_path`/`r.start_line` are empty on every Route node and a
   `MATCH (r:Route)-[:HANDLES]->(fn)` query returns **zero rows** despite `HANDLES` being
   a populated edge type (26 instances) elsewhere in the graph — so route→handler mapping
   could not be recovered from the graph at all and was read directly from
   `cmd/handlers.go` instead. Next analyst: don't trust `HANDLES` for Route nodes on this
   tool version, and always check `get_graph_schema` for the actual property name before
   assuming `path`/`full_path` exists.
5. **The answer the batch needs: cbm complexity/loop metrics DO populate on Go, but only
   half of them.** `cognitive`, `loop_depth`, `transitive_loop_depth`, and
   `linear_scan_in_loop` are all non-zero and meaningful on Go functions (e.g.
   `listmonk.cmd.main` → cognitive 13, tld 6; the highest hand-written cognitive
   complexity is `internal/messenger/email.New` at 41, `internal/messenger/email/email.go:64`).
   **`cyclomatic` is an empty string for every single Go function/method checked** — same
   failure mode as Ruby in the Chatwoot run, different metric. Verify `cyclomatic`
   per-language before citing it; `cognitive` and the loop family are safe on Go.

## TL;DR

- **Code quality: 7/10. Marketing port value: 6/10 — but read the license note before
  the score.** The Go backend is small, disciplined, and battle-tested at real scale (the
  SQL comments describe an optimization discovered against a 15M-row subscribers table /
  70M-row `subscriber_lists` table in production). It has clean send, bounce, and import
  pipelines. It has zero Go test coverage and one intentionally risky feature
  (raw-SQL segments). Its port value is capped not by code quality but by scope: listmonk
  is **transactional/broadcast email only** — no journeys, no multi-step sequences, no
  computed properties, nothing Dittofeed-shaped. What it does, it does well and it is the
  best-in-class reference of the three repos surveyed so far for exactly three things:
  **SMTP dispatch mechanics, bounce-to-action wiring, and compliance-tag defaults.**
- **AGPLv3 changes the port calculus more than code quality does.** Chatwoot's
  MIT/proprietary split meant "the MIT 70% is free, the enterprise 30% is not."
  listmonk's AGPLv3 means **the whole tree carries a copyleft, network-triggering
  obligation** if literal code is incorporated into a distributed or hosted product.
  The safe move — consistent with how this batch has already treated Chatwoot's
  enterprise tier and Mautic's GPL parts — is: **read listmonk closely, port the
  *ideas and shapes* (which are not copyrightable), and re-implement the actual code.**
  The one exception is `frontend/email-builder/`, which is a **separate MIT-licensed
  vendored dependency** or, more sensibly, can be pulled directly from its true upstream
  (`usewaypoint/email-builder-js` on GitHub) rather than copied out of this AGPL fork —
  same MIT terms, cleaner provenance.
- **The crown jewel is the send pipeline's simplicity.** One Go process, no external job
  queue, no Kafka/Redis/Temporal: goroutines + buffered channels + a handful of
  Postgres columns (`campaigns.last_subscriber_id`, `max_subscriber_id`, `to_send`,
  `sent`) implement batched, checkpointed, resumable sending
  (`internal/manager/manager.go`, `internal/manager/pipe.go`,
  `queries/campaigns.sql:174-232,318-372`). It is not as durable as Dittofeed's
  per-user Temporal workflow (crash recovery is batch-granular, not per-recipient), but
  it is dramatically simpler to operate and a very approachable model to adapt.

## What it is

listmonk is a **Go 1.26 monolith** (module `github.com/knadh/listmonk`, `go.mod:1,3`)
using the **Echo v4** HTTP framework, **Postgres** as its only datastore (`sqlx` +
hand-written SQL externalized via `goyesql` into `queries/*.sql`), and a **Vue 2.7**
admin SPA (Buefy/Bulma, no TypeScript). 507 tracked files: 94 Go (0 tests), 48 Vue, 74
TypeScript/66 TSX (nearly all in the vendored `email-builder`), 15 SQL query files,
19 versioned Go migration files (`internal/migrations/v2.4.0.go` → `v6.2.0.go`).

cbm indexed 6,142 nodes / 10,687 edges (moderate mode, 13 dirs excluded — notably
`internal/migrations`, `internal/media`, `internal/i18n`, and both Cypress directories,
so anything in those was verified by direct read, not graph query). graphify indexed
2,937 nodes / 4,530 edges / 280 communities from 358 code files (~740k words), 92%
extracted / 8% inferred, $0 LLM cost.

Layout is a flat Go layering, not a plugin system: `cmd/` (28 files, all HTTP handlers +
`main.go`, package `main`) → `internal/core` (DB-backed CRUD, returns `echo.HTTPError`
directly per its own doc comment at `internal/core/core.go:1-4`) → `models/` (structs +
the `goyesql`-loaded `Queries` struct) with `internal/manager` (send engine),
`internal/bounce`, `internal/subimporter`, `internal/auth`, `internal/messenger/{email,postback}`
as independent leaf packages `cmd` calls into directly. There is no dependency-injection
framework and no plugin/extension seam anywhere in the Go tree — the only extension
points are (a) writing a new `Messenger` implementation (`internal/manager/manager.go:64-69`,
two exist: SMTP and generic HTTP postback) and (b) the bounce webhook provider list in
`internal/bounce/bounce.go:20-47` (six providers, each a small adapter file under
`internal/bounce/webhooks/`).

## License and port strategy

| Component | Path | License | Portable? |
|---|---|---|---|
| Go backend, Vue admin, SQL | `cmd/`, `internal/`, `models/`, `frontend/src/`, `queries/` | **AGPLv3** (`LICENSE`) | Ideas/shapes yes, literal code no |
| Email visual block editor | `frontend/email-builder/` | **MIT** (`frontend/email-builder/LICENSE`, Waypoint/Metaccountant Inc. 2024) | **Yes** — but prefer pulling fresh from its true upstream (`usewaypoint/email-builder-js`) over lifting the vendored fork |

There is no enterprise/proprietary split here (unlike Chatwoot) — it is a single-tier
AGPLv3 project, so there is no "which 70% is free" question. The question is simpler and
stricter: **anything copied verbatim from the AGPL tree into Open Marketing carries the
copyleft forward.** Given Open Marketing's stack (Next/Electron) shares almost no
technology with listmonk's (Go/Echo/Postgres-raw-SQL/Vue2), literal porting was never
going to be practical anyway — the real value here is architectural: the checkpoint
design, the bounce-action state machine, the compliance-tag defaults, and the messenger
abstraction are all worth re-implementing from the description in this document, not
worth copying.

## Domain model

```
Subscriber ──┬── SubscriberList (subscriber_lists: per-list status: unconfirmed/confirmed/unsubscribed)
             ├── Bounce (type: soft/hard/complaint; source; meta jsonb)
             ├── CampaignView, LinkClick (open/click analytics, subscriber_id nullable on delete)
             └── attribs (jsonb; freeform custom-attribute bag, no defined-attribute registry)

List (type: public/private/temporary; optin: single/double) ── campaign_lists ── Campaign
Campaign ── Template (base HTML wrapper) ── CampaignMessage (per-subscriber, in-memory only)
Role (type: user/list; permissions text[]; parent_id self-ref) ── User (user_role_id, list_role_id)
Settings (single jsonb-per-key table — the entire app config, no separate config file schema)
```

There is no "segment" entity and no attribute-definition registry (contrast Chatwoot's
`CustomAttributeDefinition`, Dittofeed's `SubscriptionGroup`/segment-node types).
Segmentation is either (a) static list membership, or (b) an ad hoc raw-SQL string typed
per-operation — see **List/subscriber model and segmentation** below. `campaign_type`
(`regular`/`optin`) and `list.optin` (`single`/`double`) together implement double
opt-in as a query-time filter, not a workflow state machine.

## What's good

- **The send engine is the cleanest, most approachable piece of code across the three
  repos surveyed so far.** ~1,200 lines total across `manager.go` (827),
  `pipe.go` (244), `message.go` (107) implement worker pools, per-campaign lifecycle,
  rate limiting (two independent knobs), and crash-checkpointed resumption — no
  framework, no external queue. Readable top to bottom in one sitting.
- **Bounce handling is real, not vestigial.** Six webhook providers (SES, Azure with
  shared-secret header, Sendgrid, Postmark basic-auth, ForwardEmail HMAC, Lettermint
  HMAC) plus POP3 mailbox polling all funnel into one channel
  (`internal/bounce/bounce.go:50-51,130-138`), and the threshold-based action
  (none/blocklist/unsubscribe/delete per bounce type) is implemented as a single atomic
  SQL statement (`queries/bounces.sql:1-30`) — no race between "count this bounce" and
  "act on the count."
- **Compliance tags are defaults, not opt-ins.** `static/email-templates/default.tpl:94-101`
  bakes `UnsubscribeURL`, `MessageURL` (view-in-browser), and `TrackView` (open pixel)
  into the base template every campaign wraps into, plus an optional RFC 8058
  `List-Unsubscribe`/`List-Unsubscribe-Post` header pair
  (`internal/manager/manager.go:530-533`). Every campaign gets these unless an admin
  actively removes them — the inverse of Dittofeed's opt-in Liquid tags.
- **A real defense-in-depth around a risky feature.** The raw-SQL subscriber-query
  segment feature is gated by a *dedicated* permission (`subscribers:sql_query`,
  distinct from `subscribers:manage` — `internal/auth/models.go:53`,
  `cmd/subscribers.go:109-114`) and pre-flighted inside a **read-only transaction**
  before being spliced into the real (possibly mutating) statement
  (`models/queries.go:148-167`). It's still string interpolation, but it is not naive.
- **`ON DELETE SET NULL` with a denormalized name copy, used consistently.** Three
  places (`campaign_lists.list_name`, `campaign_media.filename`, and nullable
  `subscriber_id` on `campaign_views`/`link_clicks`) preserve historical labels/counts
  after the referenced row is deleted, rather than losing analytics history to a cascade.
  A small, worth-copying pattern.
- **Sprig is deliberately defanged.** `internal/manager/manager.go:676-678` deletes
  `env`, `expandenv`, and `getHostByName` from the Sprig template function map before
  exposing it to campaign templates — a real SSRF/info-leak guard that's easy to forget
  when wiring up a general-purpose template function library.

## What's weak

### 1. Zero backend test coverage, and CI doesn't run what tests do exist
No `_test.go` files, no `"testing"` imports, across the whole Go tree (see Section 0.3).
The 11 Cypress specs (`frontend/cypress/e2e/*.cy.js`) are real E2E coverage of the admin
UI, but **none of the five GitHub Actions workflows invoke `go test` or Cypress** —
`build-sanity.yml` runs `make dist` only; `nightly.yml`/`release.yml` build and publish
binaries; `hodor-review.yml`/`issues.yml` are bot workflows. The safety net for the send
pipeline, the bounce state machine, and the importer is entirely manual/production
experience, not CI.

### 2. Segmentation is the least safe of the three repos surveyed
Chatwoot has no segment engine at all (N/A). Dittofeed compiles a structured, typed
14-node-type segment tree into SQL — injection is not structurally possible because
users never write SQL. listmonk's segment mechanism *is* a raw SQL boolean expression,
sanitized only by trimming whitespace and stripping a trailing semicolon
(`internal/core/core.go:191-204`, duplicated almost verbatim as `formatSQLExp` in
`cmd/subscribers.go:844`). The dedicated permission and read-only dry-run (see "What's
good") meaningfully raise the bar, but this remains "trusted admin can run arbitrary
read-scoped, and in the delete/blocklist-by-query paths write-scoped, SQL fragments" —
appropriate for a self-hosted single-tenant tool, **wrong architecture for a multi-tenant
SaaS**, which is Open Marketing's likely shape.

### 3. Checkpoint granularity is coarser than it looks
`campaigns.last_subscriber_id`/`max_subscriber_id` give real crash recovery (a restarted
server resumes a `running` campaign from its last committed checkpoint — see the send
pipeline trace below), but the checkpoint only advances once per `BatchSize` fetch
(default 1,000, `internal/manager/manager.go:166-168`). Messages already pulled into the
in-memory `campMsgQ` channel when a crash happens have no per-recipient send ledger —
they can be silently dropped from the count or, on resume, re-selected and re-sent,
since `last_subscriber_id` only advances after `NextSubscribers` returns
(`internal/manager/pipe.go:81-139`, `queries/campaigns.sql:367-371`). Fine for a
newsletter; not the guarantee a transactional/receipt-critical sender needs.

### 4. No indexes support the one feature that most needs them
`attribs` (subscribers) and `meta` (subscriber_lists, bounces) are all `JSONB` with
**no GIN index anywhere in `schema.sql`**. Every raw-SQL segment that filters on a
custom attribute (`attribs->>'plan' = 'pro'`, the documented use case for the feature)
sequential-scans the full subscribers table. The SQL comment at
`queries/campaigns.sql:323-329` shows the team already fought one query-planner battle
at 15M-row scale for list membership; the JSONB attribute path has no equivalent
optimization on record.

### 5. Single-provider email transport
Unlike Dittofeed's nine destination adapters, listmonk ships exactly one first-class
email transport: SMTP, via `github.com/knadh/smtppool` with from-address/domain-keyed
server-pool round robin (`internal/messenger/email/email.go`). Provider diversity (SES
API, SendGrid API, etc., as opposed to SMTP relay) is left entirely to whatever the
admin points SMTP at, or to the generic HTTP `Postback` messenger
(`internal/messenger/postback/postback.go`) forwarding the fully-rendered message to an
external system to relay onward. Simpler, but there is no adapter shape to borrow the
way there is in Dittofeed's `destinations/`.

## Two-tool cross-check (cbm vs graphify)

cbm: 6,142 nodes / 10,687 edges, moderate mode. graphify: 2,937 nodes / 4,530 edges, 280
communities (41 thin omitted), 92% EXTRACTED / 8% INFERRED — similar extraction quality
to Dittofeed's TypeScript, better than Chatwoot's Ruby.

- **Agree:** `Manager` (internal/manager), `Auth`, `Importer` are core abstractions; both
  tools' fan-in/degree rankings surface `pqErrMsg` (Postgres error-formatting helper,
  called from nearly every DB-touching handler — real hub, not noise) at the top.
- **cbm added:** working per-Go-function `cognitive`/loop-family complexity (the
  batch's open question — see Section 0.5), real `Route` nodes with correct method+path
  once you know to read `.name` not `.path` (Echo's explicit `e.Group().GET(...)`
  registration style extracts as cleanly as Fastify did on Dittofeed, unlike Rails'
  DSL on Chatwoot), and 13 correctly-scoped dir exclusions.
- **graphify added:** cycle detection (**zero Go import cycles**; 12 cycles all confined
  to the vendored `frontend/email-builder` TSX editor core — not our code, and likely
  intentional React context/ref patterns rather than a real problem) and a cheap,
  portable, committable report.
- **Both produced noise worth flagging before quoting it:**
  1. **graphify's god-node list has at least two unverified single-character/common
     names.** `_()` at 156 edges and `n()` at 45, `t()` at 28 — no single Go, Vue, or JS
     function definition named exactly `_`, `n`, or `t` was found via direct grep across
     `internal/`, `cmd/`, and `frontend/src`. These are almost certainly the same
     name-collision artifact flagged on Chatwoot's `.new`/`.create` — likely minified or
     third-party vendor identifiers (TinyMCE/Turndown/CodeMirror bundles, or Go's blank
     identifier used positionally) collapsed onto one node. Do not cite these three as
     real abstractions. `pqErrMsg()`, `Manager`, `Auth`, `Importer`, and `useDocument()`
     (a real email-builder hook, confirmed by file path) are the trustworthy entries in
     that list.
  2. **cbm `Route` node file/line fields and `HANDLES` edges are unusable — see Section
     0.4.** Route→handler mapping had to come from a direct read of
     `cmd/handlers.go:33-307`, which was in any case the better source (it also carries
     the permission string per route, which no graph node captures).
  3. **No dependency-manifest pollution this time** — `go.mod`/`package.json` did not
     appear in either tool's top-connected-node list, unlike Chatwoot (`vue`, 733 edges)
     and Mautic (`composer.json`, 694 edges). Likely because Go's module graph and npm's
     dependency tree are both filtered out of the structural extraction by default here;
     not fully explained, flagged for the next analyst rather than asserted as a rule.
  4. **Cost:** cbm ≈ 45s. graphify ≈ 40s (358 files, smallest corpus of the three repos
     surveyed). Both effectively free; no reason not to run both on every repo in the set.

## HTTP/API surface

All 167 routes are registered in one place, `cmd/handlers.go:33-307` (`initHTTPHandlers`),
in three groups: authenticated non-API pages (admin SPA shell, custom CSS/JS), authenticated
`/api/*` (the bulk of the surface — subscribers, campaigns, lists, bounces, media,
templates, users, roles, settings, tx messages), and public/unauthenticated (health,
public list subscription form, public archive, OIDC callback, bounce webhook receivers,
subscription-management pages reached via UUID links from e-mails). Three orthogonal auth
mechanisms share one `Auth.Middleware` (`internal/auth/auth.go:288-335`): session cookie
(`zerodha/simplesessions` + Postgres-backed store), `Authorization: user:token` API-key
header (`parseAuthHeader` + `GetAPIToken`), and OIDC (exchanges to a session on success).
Authorization is a **declarative per-route permission list** passed straight into the
route registration — `pm(a.Handler, "campaigns:manage_all", "campaigns:manage")`
(`cmd/handlers.go:161-220`) — checked against a role's `permissions TEXT[]` column loaded
into a map (`internal/auth/auth.go:338-369`), with a hardcoded `SuperAdminRoleID` bypass.
Two RBAC axes exist: global user roles and **per-list roles**
(`roles.type='list'`, `roles.list_id`) — a subscriber-list-scoped permission grant that
neither Chatwoot nor Dittofeed has an equivalent of, and a genuinely useful idea for any
product with per-audience or per-workspace access control.

## The send pipeline, traced end to end

This is the highest-value trace in the repo, and every hop below is a direct file:line
citation, not an inference.

1. **Trigger.** `PUT /api/campaigns/:id/status` → `a.UpdateCampaignStatus`
   (`cmd/campaigns.go`, route at `cmd/handlers.go:173`) flips `campaigns.status` to
   `running` (or `scheduled` with a future `send_at`).
2. **Discovery (ticker).** `Manager.Run()` (`internal/manager/manager.go:281-331`)
   launches `scanCampaigns(ScanInterval)` (`manager.go:447-483`) as a goroutine. Every
   tick it calls `store.NextCampaigns(currentlyPipedIDs, sentCounts)`, backed by
   `queries/campaigns.sql:174-232` (`next-campaigns`): a single statement that (a) selects
   campaigns where `status='running' OR (status='scheduled' AND NOW() >= send_at)` and
   not already being processed, (b) computes `to_send` and `max_subscriber_id` as a
   **fixed ceiling** across all the campaign's lists at this instant (so subscribers
   added mid-send are excluded from that run — a deliberate consistency choice), and
   (c) atomically flips status to `running` and stamps `started_at`. This is one SQL
   statement doing discovery, ceiling-fixing, and status transition together.
3. **Pipe creation.** For each discovered campaign, `Manager.newPipe`
   (`internal/manager/pipe.go:27-75`) validates the messenger is registered, resolves
   inline `data-embed` images (`manager.go:707-767`), compiles the Go `html/template`
   body/subject/alt-body/headers (`models/campaigns.go:139-...` `CompileTemplate`),
   attaches media, and creates a `pipe` struct holding a `sync.WaitGroup` pre-incremented
   by 1 (a trick so the completion goroutine blocks immediately until real messages are
   queued). The pipe is registered in `Manager.pipes[campID]` and pushed onto the
   buffered `nextPipes` channel.
4. **Batch fetch loop.** `Manager.Run()`'s main loop (`manager.go:293-330`) pulls pipes
   off `nextPipes` and calls `pipe.NextSubscribers()` (`pipe.go:81-139`), backed by
   `queries/campaigns.sql:318-372` (`next-campaign-subscribers`): keyset pagination
   (`s.id > last_subscriber_id AND s.id <= max_subscriber_id ORDER BY s.id LIMIT
   BatchSize`) with double-opt-in-aware status filtering (optin campaigns only pick
   `unconfirmed` subscribers on double-optin lists; regular campaigns pick `confirmed`
   on double-optin lists and everything-but-`unsubscribed` on single-optin lists), and
   the fetch **atomically advances `last_subscriber_id`** in the same statement. The SQL
   comment at lines 323-329 documents that this exact shape (static list IDs, not a
   dynamic join) was the fix for a query-planner regression discovered at 15M-row scale.
5. **Per-recipient rendering.** For each fetched subscriber, `pipe.newMessage` →
   `Manager.NewCampaignMessage` (`internal/manager/message.go:13-29`) builds a
   `CampaignMessage`, computes its personalized `UnsubscribeURL`, and calls `render()`
   (`message.go:33-88`) which executes the pre-compiled Go templates with the message as
   template data — this is where `TrackLink`/`TrackView`/`UnsubscribeURL`/`ManageURL`
   (`manager.go:373-417`) resolve per-recipient. The rendered `CampaignMessage` is pushed
   onto the buffered `campMsgQ` channel (`pipe.go:109`); if a sliding-window rate limit
   is configured, the pusher itself sleeps here when the window's quota is exceeded
   (`pipe.go:94-135`).
6. **Dispatch workers.** `Manager.Run()` spawns `Config.Concurrency` `worker()` goroutines
   (`manager.go:487-582`), each pulling from `campMsgQ` (and a separate `msgQ` for
   non-campaign transactional messages), building MIME headers (campaign/subscriber UUID
   headers, optional RFC 8058 `List-Unsubscribe*`, custom headers), and calling
   `messengers[campaign.Messenger].Push(msg)`. A simple per-second counter
   (`numMsg >= Config.MessageRate` → `time.Sleep(1s)`) is the **second, independent**
   rate limit, applied per-worker inside the hot loop — so effective max throughput is
   roughly `Concurrency × MessageRate` messages/sec, further capped by the sliding window
   if enabled.
7. **Transport.** `internal/messenger/email.Emailer.Push` (`email.go:132-224`) picks an
   SMTP server pool keyed by the message's From-address or domain (falling back to a
   flat round-robin pool), builds a `smtppool.Email` (attachments, Bcc/Cc from headers,
   auto-generated `Message-Id`, `Return-Path`→envelope-sender), and sends via
   `github.com/knadh/smtppool`, a connection-pooling SMTP client. The alternative
   `internal/messenger/postback.Postback.Push` POSTs the same data as JSON to an external
   HTTP endpoint instead — the escape hatch for any transport not SMTP-shaped.
8. **Per-message accounting.** Back in `worker()`, success increments `pipe.sent`/
   `pipe.rate` and calls `pipe.wg.Done()`; failure calls `pipe.OnError()`
   (`pipe.go:143-156`), which auto-pauses the campaign once `MaxSendErrors` is hit.
9. **Completion and crash recovery.** When a pipe's WaitGroup drains (all queued messages
   processed), `pipe.cleanup()` (`pipe.go:192-244`) writes final `sent`/`last_subscriber_id`
   back to Postgres, flips `status` to `finished` (or `paused` if it auto-paused on
   errors), and sends an admin notification via `internal/notifs`. **On process crash**,
   nothing here runs — but because `last_subscriber_id` was already persisted after every
   completed batch (step 4), the next server start's `scanCampaigns` tick rediscovers the
   still-`running` campaign via `next-campaigns` and resumes from that checkpoint. The
   at-most-one-batch's-worth of in-flight messages (default up to 1,000) is the only
   window where a crash can produce a duplicate or dropped send — there is no
   per-recipient ledger the way Dittofeed's Temporal workflow provides.

**Throttling lives in exactly two places, both in the hot path above**: `MessageRate`
(hard per-second cap per worker, step 6) and the optional `SlidingWindow*` settings
(N messages per duration, checked after each subscriber batch push, step 5) — no
separate rate-limiter service or token-bucket abstraction.

## Bounce and complaint handling

**Real, not vestigial**, and more thorough than either prior repo in this batch — see
"What's good" for the provider list. Structurally: `bounce.Manager.Run()`
(`internal/bounce/bounce.go:125-139`) starts an optional POP3 mailbox scanner
(`runMailboxScanner`, `bounce.go:142-151`, polling on `Mailbox.ScanInterval`) and drains
a single `chan models.Bounce` fed by both the mailbox scanner and every enabled webhook
handler (`cmd/bounce.go`, route `POST /webhooks/service/:service` and the authenticated
`POST /webhooks/bounce`). Every bounce, regardless of source, funnels into
`core.RecordBounce` (`internal/core/bounces.go:60-87`), which looks up the configured
`(count, action)` pair for that bounce `type` (soft/hard/complaint — settings key
`bounce.actions`, defaulted in `schema.sql:287` to soft→none, hard→blocklist@1,
complaint→blocklist@1) and passes it straight to one atomic SQL statement
(`queries/bounces.sql:1-30`) that inserts the bounce row and conditionally blocklists the
subscriber, unsubscribes them from all lists, or hard-deletes them — whichever the
threshold and action dictate — all inside one CTE chain, so there is no window where a
count-then-act race could double-fire. This maps a bounce back to a subscriber via UUID
or plain email (whichever the provider payload carries), and — separately from
type-based auto-action — a manual `PUT /api/bounces/blocklist`
(`blocklist-bounced-subscribers`, `queries/bounces.sql:66-75`) blocklists every subscriber
with *any* recorded bounce, for ad hoc cleanup.

## List/subscriber model and segmentation

Covered in detail in "What's weak" #2 and the domain model above. Summary: list
membership + `subscriber_lists.status` (unconfirmed/confirmed/unsubscribed) is the only
structured segmentation primitive; everything beyond "which lists" is a raw SQL boolean
expression substituted into a `%query%` placeholder
(`models/queries.go:148-194`, `queries/subscribers.sql:280-398`), gated by the
`subscribers:sql_query` permission and a read-only dry-run pre-check. **Not
SQL-injection-safe in the structural sense** (there is no parser, no AST, no allowlist of
columns/operators — it is string splicing) but it is **access-controlled and pre-flight
validated**, which is a meaningfully different risk profile than an unauthenticated
injection point. Double opt-in is represented entirely as enum state
(`list_optin` + `subscription_status`), not as a workflow/state-machine object — the
"send confirmation, wait, flip to confirmed" sequence lives in imperative Go
(`internal/core/subscriptions.go`) rather than as data.

## Import/export

Bulk import (`internal/subimporter/importer.go`) accepts ZIP or bare CSV, extracting ZIPs
with `filepath.Base()` path-traversal protection (`importer.go:416`) and a `.csv`
extension check per entry. CSV parsing enforces a fixed known-header allowlist
(`email`/`name`/`attributes`, `importer.go:131-134` — unknown headers are logged and
ignored, not rejected), validates and canonicalizes email addresses with optional
domain allow/blocklist (wildcard-subdomain aware, `checkInList`/`makeDomainMap`,
`importer.go:670-765`), parses per-row JSON attributes defensively (a malformed
`attributes` cell skips that field, not the row), and commits in 10,000-row transaction
batches (`commitBatchSize`, `importer.go:36,286-334`) with a cooperative stop signal and
admin-notification-on-completion. No file-size or total-row cap is enforced by this code
path itself (only a `maxCSVs` count limit inside ZIP extraction) — worth noting for a
port, since nothing here would stop an accidental multi-GB upload from being fully
buffered/streamed through. Export is simpler: paginated, offset-based SQL queries
(`export-campaign-views`/`export-campaign-link-clicks`, `queries/campaigns.sql:278-307`)
plus a GDPR-style self-service export/wipe pair reachable by subscribers themselves via
UUID link (`GET/POST /subscription/export/:subUUID`, `/subscription/wipe/:subUUID`,
gated by `privacy.allow_export`/`privacy.allow_wipe` settings).

## Templating

Two independent authoring paths converge on one rendering engine. **Richtext/HTML/plain**
content types compile through Go's `html/template` (`text/template` for the subject)
plus a de-fanged Sprig function map (`internal/manager/manager.go:658-683` — `env`,
`expandenv`, `getHostByName` explicitly removed) and custom functions
(`TrackLink`, `TrackView`, `UnsubscribeURL`, `ManageURL`, `OptinURL`, `MessageURL`,
`ArchiveURL`, `RootURL`, `Date`, `L` for i18n, `Safe`) exposed at
`manager.go:371-423`. **Markdown** content type additionally runs through `goldmark`
before that. **Visual** content type (the vendored React block editor) bypasses Go
template compilation entirely for its body (`models/campaigns.go:160`) — the editor
renders HTML client-side and posts it back as `campaign.body`, keeping the original JSON
block schema in `campaign.body_source` for re-editing. Compliance tags are baked into the
shipped `static/email-templates/default.tpl:94-101` unconditionally (see "What's good"),
not opt-in per-template as they are in Dittofeed's Liquid tag set.

## Background/scheduled work

Everything runs as native goroutines inside the single Go process — no external job
queue:

1. **Campaign scanner** — `Manager.scanCampaigns(ScanInterval)`
   (`internal/manager/manager.go:447-483`), a `time.Ticker` loop, the heartbeat of the
   send pipeline (traced above).
2. **Bounce mailbox scanner** — `bounce.Manager.runMailboxScanner`
   (`internal/bounce/bounce.go:142-151`), polls a POP3 mailbox on `Mailbox.ScanInterval`
   (default 15m, `schema.sql:296`) when enabled.
3. **In-process cron** — `cmd/init.go:1001` (`cron.New`, `github.com/gdgvda/cron`),
   validated with `cron.ParseStandard` (`cmd/settings.go:307-308`), drives materialized
   view refresh (`core.RefreshMatViews`, `cmd/init.go:1011`, default schedule from
   `app.cache_slow_queries_interval` = `"0 3 * * *"`) and Postgres `VACUUM`
   (`maintenance.db.vacuum_cron_interval` = `"0 2 * * *"`, `cmd/init.go:1024`).
4. **Import sessions** — one goroutine per active import (`Session.Start`,
   `internal/subimporter/importer.go:274-364`), triggered on-demand, not scheduled.

**On crash mid-send**, see step 9 of the send-pipeline trace: recovery is automatic on
next boot, at batch-checkpoint granularity, via the persisted `last_subscriber_id`.
There is no separate crash-recovery code path — it falls out naturally from the
scan-and-checkpoint design, which is either a strength (nothing extra to build or test)
or a weakness (nothing extra exists to make recovery finer-grained) depending on what a
port needs.

## Data model

`schema.sql` defines 15 base tables, 12 enum types, and 3 materialized views (refreshed
by the cron above): `subscribers` (`attribs JSONB`, functional lower-email unique index
`idx_subs_email`, composite `(id, status)` index supporting the keyset-pagination +
status-filter pattern used by the send pipeline), `lists` (`tags VARCHAR(100)[]`),
`subscriber_lists` (composite PK, `meta JSONB`, doubles as the double-opt-in ledger via
its `status` column), `templates`, `campaigns` (`headers JSONB` as an array-of-maps,
`attribs JSONB`, `archive_meta JSONB`, plus the four progress-checkpoint integer columns
that carry the entire crash-recovery story), `campaign_lists`/`campaign_media` (both
denormalize a name/filename copy so history survives the referenced row's deletion),
`campaign_views`/`link_clicks` (analytics, nullable `subscriber_id` with
`ON DELETE SET NULL`), `bounces`, `roles` (self-referential `parent_id`, optional
`list_id` for per-list role scoping, `permissions TEXT[]`), `users`, `sessions`
(`data JSONB`, backing `zerodha/simplesessions`), and `settings` (one row per config key,
`value JSONB` — the entire application configuration is this one table). **No JSONB
column anywhere has a GIN index** (see "What's weak" #4) — every `attribs`/`meta`
containment query, including the ones the raw-SQL segment feature is explicitly designed
to enable, is a sequential scan at scale. Materialized views
(`mat_dashboard_counts`, `mat_dashboard_charts`, `mat_list_subscriber_stats`) pre-aggregate
dashboard stats as `JSON_BUILD_OBJECT` blobs — a simple, low-effort caching pattern worth
noting for any admin dashboard with similar count/chart widgets.

## Port targets for Open Marketing (ranked)

Given the AGPLv3 constraint, every entry below is "port the idea, re-implement the code"
unless marked otherwise.

1. **The checkpointed batch-send design** — a handful of integer columns on the
   campaign row (`to_send`, `sent`, `max_subscriber_id`, `last_subscriber_id`) plus a
   scan-and-resume loop deliver real crash recovery with zero external infrastructure.
   Far simpler than Dittofeed's Temporal model and a very reasonable starting point if
   Open Marketing doesn't want a durable-execution dependency on day one. Port the
   *shape* closely; the granularity tradeoff (batch, not per-recipient) should be a
   conscious choice, not an accident.
2. **The bounce action state machine** — configurable per-type
   (soft/hard/complaint) threshold → action (none/blocklist/unsubscribe/delete),
   executed as one atomic statement. Small, reusable, worth copying closely regardless
   of what datastore Open Marketing ends up on.
3. **Compliance tags as unconditional template defaults**, not opt-in helpers —
   unsubscribe, view-in-browser, and open-pixel baked into the base wrapper template
   every campaign inherits. Combine with Dittofeed's Liquid tag *names* if a Liquid-style
   templating layer is chosen instead of Go templates.
4. **The email-builder visual block editor — port directly, MIT-licensed.** Best
   sourced from its true upstream (`usewaypoint/email-builder-js`) rather than this
   fork, for cleaner provenance, but functionally this is the same recommendation as
   pulling it fresh: a ready-made, React-based, drag-and-drop email block editor that
   maps directly onto a "compose a campaign" screen.
5. **Per-list (per-audience) RBAC** — `roles.type='list'` scoping a permission grant to
   one list/audience, layered on top of global user roles. Neither Chatwoot nor
   Dittofeed has this; worth having if Open Marketing ever needs audience-scoped team
   permissions.
6. **The messenger interface shape** (`Name()/Push()/Flush()/Close()`, one
   implementation per transport) — small and clean, though thinner than Dittofeed's
   destination adapters; port the interface, not the SMTP-pool internals.
7. **The denormalize-on-delete pattern** for analytics tables (`campaign_lists.list_name`,
   nullable `subscriber_id` + `ON DELETE SET NULL`) — cheap insurance against losing
   historical counts when an admin deletes a list or a subscriber.

**Skip:** the raw-SQL segment feature as an architecture (build a structured segment
model instead — Dittofeed's 14-node-type taxonomy remains the better donor for that);
the Vue 2 admin frontend (wrong framework, wrong version, and AGPL-encumbered even if it
weren't); the single-SMTP-transport messenger internals; the in-process cron/POP3-polling
mechanics (fine for a single-tenant self-host, not how a multi-tenant hosted product
should schedule work).

**Do not assume:** that the lack of a JSONB GIN index here is safe to also skip in a
port — it is a known, documented-in-comments performance gap in the source project
itself, not a deliberate simplification to emulate.

## Reproducing / refreshing this analysis

- **graphify** (installed CLI, `$0` no-LLM):
  `cd /Users/la/Programming/OSS-Marketing-Repos/listmonk && graphify update .`
  → refreshes `graphify-out/{graph.json, graph.html, GRAPH_REPORT.md, manifest.json}`.
  Do **not** pass `--no-viz` to `update` — not a valid option, exits 2. HTML viz
  auto-skips above 5,000 nodes (this repo, at 2,937, is under that limit, so
  `graphify-out/graph.html` was actually rendered here — the first repo in this batch
  small enough for that).
- **codebase-memory-mcp:** project `listmonk`, indexed 2026-09-06 in `moderate` mode at
  commit `e1b0a8bb`. Use `get_architecture(aspects:[...])` for routes/hotspots/clusters
  rather than raw Cypher on `Route` nodes (see Section 0.4 for exactly why). Numeric
  properties are strings — project through `toInteger()` and sort on the projected
  alias, e.g. `RETURN toInteger(f.cognitive) AS cog … ORDER BY cog DESC`, not
  `ORDER BY toInteger(f.cognitive) DESC` (silently ignored, same trap as the other two
  repos in this batch).
- **Reading the SQL directly matters more here than on the other repos**: `goyesql`
  externalizes almost all data-access logic into `queries/*.sql`, which neither graph
  tool indexes as code (cbm counted 11 `.sql` files as a language but did not parse
  statement bodies). Any question about query behavior, indexing, or the send/segment
  pipelines needs a direct read of the relevant `queries/*.sql` file, not just the Go
  call site.
