# Dittofeed Behavioral Site Map

> How the system actually *works* at runtime, not how its files are arranged.
> Audience: an engineer deciding which flows to reimplement in Open Marketing
> (Next/Electron, no Temporal or ClickHouse by default).
>
> - **Source:** `/Users/la/Programming/OSS-Marketing-Repos/dittofeed`, commit `52b2bee909744d07dd5d409fd3974d4b95c66766`
>   (2026-03-27). **This clone is ~5 months stale** relative to today (2026-09-06); anything
>   below may have moved upstream since.
> - **Predecessor doc treated as a claim, not ground truth:** `docs/dittofeed-architecture.md`
>   (structural analysis, same commit). Section 0 records where this behavioral pass
>   contradicts or sharpens it. Its content is not repeated here except where needed for
>   context.
> - **Tools used:** codebase-memory-mcp (project `dittofeed`, default `HOME`, 9,344
>   nodes / 22,104 edges — see tool note below) for complexity/loop-metric validation only;
>   everything else is direct source reading (`Read`/`grep`). No test suite, build, install,
>   `docker`, or `yarn` command was run; Temporal/ClickHouse/Postgres were not started. Any
>   runtime-only fact is explicitly labeled "inferred."
> - **Tool note:** the capability script's suggested `HOME=<ADS-memory>/.local-artifacts/...`
>   override produced an *empty* cbm project store for this repo. The real indexed project
>   (`dittofeed`, matching the predecessor doc's node/edge counts and git SHA exactly) lives
>   under cbm's **default** `HOME` (`~/.cache/codebase-memory-mcp/dittofeed.db`). If you
>   re-run queries, do not pass a `HOME` override.

## Section 0 — Premise corrections

The brief and the predecessor doc handed me several claims. Two survived verification
outright (listed at the end of this section for completeness); the rest needed correction —
several of them materially, because they bear on what actually works at runtime, which the
predecessor doc's structural framing couldn't see.

### 0.1 The `/api/*` "standard authorization" surface has **no authentication in the OSS
build, in every runnable path, by default**

Neither the brief nor the predecessor doc mentions this — it's a pure discovery, but it
changes how "authenticated" should be read everywhere else in this doc, so it leads.

- `router.ts` guards the whole standard resource block (`/api/journeys`, `/api/segments`,
  `/api/events`, `/api/users`, `/api/broadcasts`, `/api/computed-properties`, 15 more) with an
  *optional, injectable* hook: `if (opts?.registerAuthentication) { await
  opts.registerAuthentication(f); }` — `packages/api/src/buildApp/router.ts:47-49`.
- **No caller in the entire tree ever supplies `registerAuthentication`.** Both real process
  entry points call `buildApp()` with zero arguments: `packages/api/scripts/startServer.ts:31`
  and `packages/lite/scripts/startLite.ts:62`. `grep` for `registerAuthentication` across
  `packages/` turns up exactly its type declaration
  (`packages/api/src/types.ts:10`) and the one conditional call site — no implementation, no
  wiring, anywhere in source.
- The block also runs a second plugin, `requestContext`
  (`packages/api/src/buildApp/router.ts:51`), which *does* enforce something — but what it
  enforces is gated by `config().authMode` (`packages/backend-lib/src/requestContext.ts:418-454`),
  which defaults to `"anonymous"` (`rawConfig.authMode ?? "anonymous"`,
  `packages/backend-lib/src/config.ts:552`). In `"anonymous"` mode,
  `getAnonymousRequestContext()` (`packages/backend-lib/src/requestContext.ts:387-416`) does
  `db().query.workspace.findFirst()` — literally the first workspace row in Postgres — and
  returns a synthetic `member: { id: "anonymous", role: "Admin" }` with **zero credential
  check of any kind**.
- `"single-tenant"` mode adds exactly one gate: a session cookie set by
  `POST /api/single-tenant/login` against **one shared password** in config
  (`packages/api/src/controllers/singleTenantController.ts:9-37`) — not per-user, and it still
  resolves to the same `getAnonymousRequestContext()` afterward
  (`packages/backend-lib/src/requestContext.ts:430-437`).
- Only `"multi-tenant"` mode does real per-member authorization
  (`getMultiTenantRequestContext`, bearer token + configurable `authProvider`,
  `packages/backend-lib/src/requestContext.ts:439-452`).
- This lines up with — and gives a concrete mechanism for — the predecessor doc's own "EE gap"
  observation (`packages/ee/` is 0 tracked files, confirmed again below): `registerAuthentication`
  is exactly the kind of seam an EE/SSO layer would fill. That EE could supply it is inference;
  that nothing in OSS does is directly verified.

**Practical read:** in the OSS tree as shipped, distinguishing "authenticated" vs "public"
Fastify blocks is close to cosmetic in the default deploy mode. The *real* access controls
present in source are: public write-keys (ingest), admin API keys (`/api/admin/*`), and
per-provider webhook signatures — all covered in Section 1.

### 0.2 "13 delivery destinations" — the count is wrong and, more importantly, one whole
channel is a stub

The predecessor doc's own destination list only has 9 items (`amazonses`, `sendgrid`,
`resend`, `postmark`, `mailchimp`, `smtp`, `twilio`, `signalwire`, `fcm`) despite the "13"
headline — and the real picture is more specific and more consequential than a miscount:

- `packages/backend-lib/src/destinations/` has exactly 9 files (confirmed via `find`):
  `amazonses.ts`, `sendgrid.ts`, `resend.ts`, `postmark.ts`, `mailchimp.ts`, `smtp.ts`,
  `twilio.ts`, `signalwire.ts`, `fcm.ts`.
- A 10th, `gmail.ts`, lives at `packages/backend-lib/src/gmail.ts` (top-level, not in
  `destinations/`) and is deliberately excluded from the auto-provisioned
  `WorkspaceWideEmailProviderType` set (`packages/backend-lib/src/messaging/email.ts:183-188`,
  comment: `// Impossible, but TypeScript doesn't know that. if (type ===
  EmailProviderType.Gmail) { continue; }`) — Gmail is member-scoped OAuth, not a
  workspace-wide provider like the other 7 email types.
- **`ChannelType.MobilePush` is unimplemented in the generic send dispatcher**: `sendMessage()`
  — the single function every channel routes through — has
  `case ChannelType.MobilePush: throw new Error("not implemented");`
  (`packages/backend-lib/src/messaging.ts:2414-2415`). `destinations/fcm.ts` does contain a
  working-looking `sendNotification()` (`packages/backend-lib/src/destinations/fcm.ts:31`), but
  `grep -rn "sendNotification\b" packages --include=*.ts` outside its own test file returns
  **zero call sites** in the whole repo. It is dead code: written, never wired.
- Real inventory: 4 channel types (Email, Sms, MobilePush, Webhook); provider enums are 8 email
  types (`EmailProviderType`, `packages/isomorphic-lib/src/types.ts:137-146`, one of which —
  Gmail — is member-level), 3 SMS types (`SmsProviderType`, `:180`, including a `Test` stub),
  2 mobile-push types (`MobilePushProviderType`, `:173-176`, `Firebase` + `Test`, and Firebase
  is unreachable per above), and Webhook has no provider concept at all (one generic HTTP send,
  implemented inline in `messaging.ts`, not a `destinations/` file).

**Practical read:** treat "12 named provider integrations, 3 fully wired channels
(Email/SMS/Webhook), 1 channel that's a signature with a stub body (MobilePush)" as the real
shape, not "13 delivery destinations."

### 0.3 Two computed-properties orchestration engines coexist, selected by a per-workspace
feature flag — not one engine

The predecessor doc describes "the segment/computed-property engine" as a single thing. The
*compute* logic (`computePropertiesIncremental.ts`) is indeed singular, but there are **two
different, fully-implemented Temporal orchestration layers around it**, and which one runs for
a given workspace is a runtime decision:

- **Legacy: one continuously-polling workflow per workspace.**
  `computePropertiesWorkflow` (`packages/backend-lib/src/computedProperties/computePropertiesWorkflow.ts:49-154`)
  is an infinite `while(true)` loop: call `computePropertiesIncremental`, then
  `wf.condition(() => wokeUpEarly, period)` where `period` = `computePropertiesInterval` +
  jitter (`:101-119`), `continueAsNew` every `computePropertiesAttempts` iterations. Started at
  workspace bootstrap: `startComputePropertiesWorkflow()` called from
  `packages/backend-lib/src/bootstrap.ts:504` and from `packages/backend-lib/src/features.ts:183`.
- **Newer: a scheduler + priority queue shared across workspaces.**
  `computePropertiesSchedulerWorkflow` (`packages/backend-lib/src/computedProperties/comutePropertiesSchedulerWorkflow.ts:43-`)
  periodically calls `findDueWorkspacesV3`, checks queue depth via `getQueueSize`, and signals
  a single long-running `computePropertiesQueueWorkflow` with new work
  (`addWorkspacesSignalV2`) rather than starting one workflow per workspace.
- **The switch is `triggerWorkspaceRecompute`**
  (`packages/backend-lib/src/computedProperties/periods.ts:626-645`): if the workspace has the
  `ComputePropertiesGlobal` feature flag, it calls `enqueueRecompute` (queue path); otherwise it
  calls `signalComputePropertiesEarly` (legacy per-workspace workflow's early-wake signal). Both
  start functions (`startComputePropertiesWorkflow` and the scheduler/queue starters) live
  side by side in `packages/backend-lib/src/computedProperties/computePropertiesWorkflow/lifecycle.ts:36-`
  and both workflow modules are registered on the same worker
  (`packages/backend-lib/src/temporal/workflows.ts:2-4`).

**Practical read:** this is a live migration in progress inside the OSS code, not a design
accident — "global" (queue-based, amortizes scheduling overhead across many small workspaces)
vs. legacy (simple, one workflow history per workspace, presumably fine at low workspace count).
Port the *queue* model; it's the one built for scale.

### 0.4 Two broadcast versions coexist; only V2 is reachable from the live create-flow

`db/schema.ts`'s `Broadcast` table has **both** `status` (`dbBroadcastStatus`, legacy) and
`statusV2` (`dbBroadcastStatusV2`) columns plus a `version` enum defaulting to `"V1"`
(`packages/backend-lib/src/db/schema.ts:401-408`). A `packages/backend-lib/src/computedProperties/broadcastWorkflow.ts`
(legacy) and `broadcastBatchWorkflow.ts` exist and are still registered on the worker
(`export * from "../computedProperties/broadcastWorkflow";`,
`packages/backend-lib/src/temporal/workflows.ts:3`), but the only controller path that starts a
broadcast — `packages/api/src/controllers/broadcastsController.ts:197` →
`startBroadcastWorkflow` (`packages/backend-lib/src/broadcasts/lifecycle.ts:62-98`) —
unconditionally starts `broadcastWorkflowV2`
(`packages/backend-lib/src/broadcasts/broadcastWorkflowV2.ts:53`). V1 appears to be kept for
reading old rows, not for creating new broadcasts. Section 6 below documents V2 only.

### 0.5 `RateLimitNode` is not a working throttle — it's an unimplemented stub

The predecessor doc's node table lists `RateLimitNode` at `userWorkflow.ts:1070` as "throttle."
The actual code at that line:
```
case JourneyNodeType.RateLimitNode: {
  logger.error("unable to handle un-implemented node type", { ...defaultLoggingFields, nodeType: currentNode.type });
  nextNode = definition.exitNode;
  break;
}
```
(`packages/backend-lib/src/journeys/userWorkflow.ts:1070-1077`). Selecting this node type in a
journey logs an error and immediately routes to the exit node — no rate limiting occurs. (Rate
limiting *does* exist for broadcasts — see Section 6 — but that's a separate, working
implementation; it does not back this journey node.)

### 0.6 "Watermark" is a specific, inspectable mechanism, not a metaphor — and definition
edits force a full recompute, not an incremental one

The predecessor doc says the engine "recomputes from a watermark rather than rescanning." True,
but the mechanism is precise and has a sharp edge worth knowing before porting:

- The watermark lives in **Postgres**, not ClickHouse: table `ComputedPropertyPeriod`
  (`packages/backend-lib/src/db/schema.ts:885-916`), columns `(workspaceId, type,
  computedPropertyId, version, from, to, step)`.
- `version` is the segment/user-property's `definitionUpdatedAt` timestamp, stringified
  (`packages/backend-lib/src/computedProperties/periods.ts:214, 233`). The next period's `from`
  is the previous period's `to` **for that same version key**
  (`packages/backend-lib/src/computedProperties/periods.ts:215-229`).
- **Editing a segment/user-property definition changes `definitionUpdatedAt`, which changes the
  version key, which means the "previous period" lookup finds nothing, so `from = null`** — the
  next compute pass has no lower bound and effectively recomputes from scratch. This is visible
  end to end: `computeState()`'s ClickHouse query lower-bounds on `processing_time >=
  toDateTime64(period/1000, 3)` where `period` is 0 (no bound) when no prior period exists for
  the current version (`packages/backend-lib/src/computedProperties/computePropertiesIncremental.ts:3076-3097`).
- This is a real cost characteristic to carry into a reimplementation: incremental compute is
  incremental *between* edits, not incremental *across* an edit.

### 0.7 Cognitive-complexity figures — verified correct after a query-syntax false start

Worth recording precisely because it's a live example of the "verify before citing" cbm trap
from the brief: cbm's `Function` nodes have **two separate properties**,
`complexity` and `cognitive` (`get_graph_schema` output: `...,"cognitive","complexity",...`).
My first query used `f.complexity` and got numbers 2-3x lower than the predecessor doc's cited
"cognitive complexity" figures (e.g. `userJourneyWorkflow`: 95 vs. 331) — which looked like a
discrepancy worth flagging. Re-querying with `f.cognitive` reproduced the predecessor doc's
numbers **exactly**: `userJourneyWorkflow` cognitive=331, `segmentToResolvedState`=170,
`segmentNodeToStateSubQuery`=161, `journeyDefinitionFromStateBranch`=197,
`journeyBranchToState`=172 (all confirmed via `query_graph` against project `dittofeed`). No
correction needed on the numbers themselves — recorded here so a future analyzer doesn't repeat
the wrong-property query and wrongly "correct" a doc that was right.

### 0.8 Minor, non-material discrepancies (confirmed, not worth re-litigating)

- **Controller count:** predecessor doc says "29." `find packages/api/src/controllers -maxdepth
  1 -name "*.ts"` returns 29 files, but one is a test file misnamed without `.test.ts`
  (`endToEndWebhooks.deprecated-test.ts`) — real controller count is **28**.
- **pgTable count:** predecessor doc says "32 `pgTable`s." `grep -c "pgTable(" schema.ts` = **31**.
- **`packages/ee/` absence:** re-confirmed independently (directory does not exist;
  `git ls-files packages/ee` returns 0 lines). Predecessor doc's claim stands.
- The `(330)`, `(159)`, `(645)` parentheticals next to `computePropertiesQueueWorkflow.ts`,
  `comutePropertiesSchedulerWorkflow.ts`, and `periods.ts` in the predecessor doc are **file line
  counts** (`wc -l` confirms all three exactly), not complexity scores — flagging only because
  it's easy to misread them as complexity given the surrounding "cognitive N" figures in the
  same paragraph.

---

## Section 1 — HTTP surface

Single Fastify app (`packages/api/src/buildApp.ts:153`), mounted in four independent prefix
blocks by `packages/api/src/buildApp/router.ts`:

| Block | Prefix | Auth (as shipped, OSS, default config) | Contents |
|---|---|---|---|
| Standard | `/api/*` | **None** by default — see §0.1. `requestContext` plugin resolves to an unconditional anonymous Admin identity unless `authMode=multi-tenant` | 20 resource controllers: journeys, segments, events, users, groups, resources, broadcasts, deliveries, computed-properties, user-properties(+indices), subscription-groups, subscription-management-template, secrets, settings, integrations, permissions, admin-keys, analysis, content, plus a redundant `webhooks` mount |
| Public | `/api/public/*` | Per-endpoint: public write-key (ingest), per-provider webhook signature (provider callbacks), signed-hash query params (subscription-management/view-in-browser, not independently verified this pass), single-tenant password (`/single-tenant/login`) | `apps` (identify/track/page/screen/group/alias/batch), `webhooks` (sendgrid/amazon-ses/resend/postmark/mailchimp/twilio/segment), `subscription-management`, `view-in-browser`, `single-tenant` (conditional on `authMode`) |
| Admin | `/api/admin/*` | Bearer admin API key, checked in a `preHandler` hook (`packages/api/src/buildApp/adminAuth.ts:214-304`) against `AdminApiKey`+`Secret` rows scoped to a workspace or its parent (`packages/backend-lib/src/auth.ts:20-211`) | Re-mounts a subset of the standard resources for server-to-server automation |
| Internal | `/internal-api/*` | **None at all** — no plugin, no hook | `debug` controller only: `/boom` (throws, for telemetry testing), `/ok` (`packages/api/src/controllers/debugController.ts:8-40`) |

Size: 28 controller files (`packages/api/src/controllers/*.ts`, excluding one misnamed test
file — see §0.8), cbm-indexed at 49 nodes for the `api` package (consistent with predecessor
doc). `indexController` under `/api` is a bare health/root endpoint, not separately detailed
here.

**What's public and why:** the `/api/public/apps/*` ingest endpoints are meant to be
internet-facing (client SDKs call them directly) and are the one part of the surface with a
real, if simple, credential (write-key). The provider webhook endpoints are necessarily public
(providers call them) and each independently verifies a provider-specific signature scheme
(SNS signature, Twilio's `validateRequest`, svix HMAC for Resend, a custom HMAC for
Mailchimp/Mandrill, a shared-secret header compare for Postmark) — see
`packages/api/src/controllers/webhooksController.ts`. `/internal-api/debug` has no
justification in source for being unauthenticated beyond "presumably not internet-routed in
production" — nothing in the app enforces that.

---

## Section 2 — Event ingestion path, traced

Entry: `POST /api/public/apps/track` (also `/identify`, `/page`, `/screen`, `/group`,
`/batch`) — `packages/api/src/controllers/publicAppsController.ts:69-108`.

1. **Auth:** `validateWriteKey({ writeKey: authorization header })`
   (`packages/backend-lib/src/auth.ts:75-` — decodes a `Basic`-style
   `base64(secretKeyId:secretKeyValue)`, looks up a `Secret` row, resolves to a `workspaceId`).
   Failure → `401`.
2. **Write path selection:** `submitTrackWithTriggers({ workspaceId, data })`
   (`packages/backend-lib/src/apps.ts:48-90`).
   - If the payload carries file attachments, `persistFiles` runs first
     (`packages/backend-lib/src/apps.ts:56-63`, blob storage) and file references are folded
     into `properties`.
   - `submitTrack()` (`packages/backend-lib/src/apps/track.ts:7-31`) wraps the payload as
     `{ type: "track", properties, timestamp, ...rest }`, JSON-stringifies it as
     `InsertUserEvent.messageRaw`, and calls `insertUserEvents()`.
3. **`insertUserEvents`** (`packages/backend-lib/src/userEvents.ts:90-145`) branches on
   `config().writeMode`:
   - `"kafka"` — produce to `userEventsTopicName`. A Kafka-consuming materialized view
     (`user_events_queue_v2` → `user_events_mv_v2` → `user_events_v2`) exists in
     `packages/backend-lib/src/userEvents/clickhouse.ts:602-657` but is only created when
     `writeMode === "kafka"` — this path is **infra-optional**, not the default.
   - `"ch-async"` — **the production/development default**
     (`packages/backend-lib/src/config.ts:543-545`: `writeMode = rawConfig.writeMode ??
     (nodeEnv === Test ? "ch-sync" : "ch-async")`) — direct ClickHouse insert into
     `user_events_v2` with `async_insert=1, wait_for_async_insert=1`
     (`packages/backend-lib/src/userEvents.ts:76-87`). Note `wait_for_async_insert=1`: the
     HTTP handler still blocks until ClickHouse acknowledges the buffered insert — this is not
     fire-and-forget, just server-side batched.
   - `"ch-sync"` — synchronous insert (`wait_end_of_query: 1`), used in tests.
4. **Rest-of-request work happens in the same HTTP request, synchronously — this is the
   detail the predecessor doc's structural framing couldn't surface:** after the insert,
   `submitTrackWithTriggers` immediately calls
   `triggerEventEntryJourneys({ workspaceId, event, userId })`
   (`packages/backend-lib/src/apps.ts:81-88`) if a `userId`/`anonymousId` is present.
   `triggerEventEntryJourneysFactory` (`packages/backend-lib/src/journeys.ts:725-812`) looks up
   (and caches per-workspace, `NodeCache`) all `Running` journeys whose entry node is
   `EventEntryNode`, matches the tracked event name against each journey's entry pattern
   (`doesEventNameMatch`), and for each match calls `startKeyedUserJourney` — which does a
   Temporal `signalWithStart` (`packages/backend-lib/src/journeys/userWorkflow/lifecycle.ts:70-95`)
   before the HTTP handler returns `204`.
5. **Table:** `user_events_v2` (MergeTree, `ORDER BY (workspace_id, processing_time,
   user_or_anonymous_id, event_time, message_id)`,
   `packages/backend-lib/src/userEvents/clickhouse.ts:299-365`) is the source of truth. Columns
   are largely `DEFAULT JSONExtract(message_raw, ...)` — the raw JSON blob is stored once and
   every structured column is a ClickHouse-side computed default over it, not populated by the
   application.

**Guarantees against loss/duplication:**
- *Duplication:* none at the ClickHouse-insert layer — a retried HTTP POST inserts a second row
  (no dedup key enforced on `user_events_v2` beyond a bloom-filter index on `message_id` used
  for lookups, not uniqueness).
- *Duplication for journey starts specifically:* handled, via Temporal. `startKeyedUserJourney`
  derives a **deterministic workflow ID** from `(workspaceId, journeyId, userId, key, keyValue)`
  (`getKeyedUserJourneyWorkflowIdInner`, `packages/backend-lib/src/journeys/userWorkflow.ts:83-95`,
  a `uuidV5` hash) and treats `WorkflowExecutionAlreadyStartedError` as a benign no-op
  (`packages/backend-lib/src/journeys/userWorkflow/lifecycle.ts:96-107`) — a retried track call
  cannot double-start the same journey instance for the same user+event-key.
- *Loss:* none within the HTTP request (the insert is awaited); if the API process dies between
  insert and journey-trigger, the event is durably stored but that specific `EventEntryNode`
  trigger opportunity is lost — there is no outbox/retry for the trigger step itself, only for
  the insert. Segment-entry journeys are unaffected by this gap since they're driven by the
  separate computed-properties pipeline (Section 4), not by this synchronous call.

---

## Section 3 — Journey execution, traced

Core: `userJourneyWorkflow` (`packages/backend-lib/src/journeys/userWorkflow.ts:206-1134`), one
Temporal workflow execution per (journey, user) **for segment-entry journeys**, or one
per (journey, user, event-key) **for event-entry journeys** — these are not the same
instantiation model, which matters for re-entry (below).

**Node types confirmed present and at the cited lines** (predecessor doc's table is accurate
here): `SegmentEntryNode` (wire name `EntryNode`, `:627`), `EventEntryNode` (`:650`),
`DelayNode` (`:664`), `WaitForNode` (`:756`), `SegmentSplitNode` (`:824`), `MessageNode`
(`:852`), `ExitNode` (`:1030`), `RandomCohortNode` (`:1033`), `RateLimitNode` (`:1070`, **stub
— §0.5**).

**What starts a workflow:**
- Segment-entry: `triggerSegmentEntryJourney`
  (`packages/backend-lib/src/journeys.ts:814-892`), called from the computed-properties
  pipeline when a segment assignment flips true. Uses `workflowClient.signalWithStart` with
  workflow ID `user-journey-{userId}-{journeyId}` (`getUserJourneyWorkflowId`, `:146-152`) and
  signal `segmentUpdateSignal`.
- Event-entry: `startKeyedUserJourney` (Section 2) — workflow ID
  `user-journey-keyed-{workspaceId}-{journeyId}-{uuidV5(userId,eventKey,eventKeyValue)}`.

**What makes delay/wait-for durable:** `sleep(delay)` for `DelayNode` (`:739`) and
`wf.condition(() => segmentAssignedTrue(cn.segment))` for `SegmentEntryNode`'s initial wait and
`WaitForNode` are Temporal SDK primitives — every await point is recorded in the workflow's
persisted event history on the Temporal server. This durability is inherent to the Temporal
model and is not something Dittofeed's own code implements; nothing in this repo re-derives
state from ClickHouse/Postgres to "resume" a workflow. **On worker crash**, Temporal detects the
lost workflow task via timeout and dispatches it to any other worker polling the same task
queue; that worker deterministically replays the persisted history to reconstruct in-memory
state (including `segmentAssignments`, `keyedEvents`, `currentNode`) and continues from exactly
the suspended point. *(This mechanism itself is inferred from Temporal's documented execution
model — verified in this repo only by observing that the workflow code contains no bespoke
recovery/checkpoint logic, which is consistent with relying on the SDK.)* Long-running node
types (`WaitForNode`, `DelayNode`, `SegmentEntryNode`) additionally get a liveness check after
resuming: `if (workspace?.status !== "Active") break;` (`:1101-1111`) — an inactive workspace
kills the journey rather than letting it run forever.

**Re-entry — two different mechanisms depending on entry type:**
- *Segment-entry journeys loop via `continueAsNew`, not new instances.* After the node loop
  exits, `shouldReEnter()` (`packages/backend-lib/src/journeys/userWorkflow/activities.ts:777-838`)
  checks `journey.canRunMultiple`, `journey.status === "Running"`, and whether the user is
  *currently* segment-true with `entryNode.reEnter === true`; if so,
  `continueAsNew<typeof userJourneyWorkflow>(props)` (`:1127-1133`) restarts the same logical
  workflow (fresh event history, same workflow ID) rather than exiting for good.
- *Event-entry journeys never `continueAsNew`* (`shouldReEnter` returns `false` immediately for
  any non-`SegmentEntryNode` entry, `:829-831`); instead, each new matching event gets its own
  brand-new workflow ID (the key-value hash), so "re-entry" here means "a new, independent
  workflow instance," gated only by the workflow-ID collision check in step 2 of Section 2.
- *Before either kind of entry even starts,* `isRunnable()`
  (`packages/backend-lib/src/journeys/userWorkflow/activities.ts:396-470`) checks for a prior
  exit event for this (journey, user, eventKey) and requires `journey.canRunMultiple` to allow
  a second run, plus `workspace.status === "Active"`.
- A separate **`restartUserJourneysActivity`**
  (`packages/backend-lib/src/restartUserJourneyWorkflow/activities.ts:18-`) exists for a
  different case: when a segment-entry journey's status is turned back on, it pages through
  users currently in the entry segment (`findRecentlyUpdatedUsersInSegment`) and re-signals each
  one's workflow — this is an operator-facing "resume everyone who should be running" tool, not
  a crash-recovery mechanism.

**Real limits of this engine, observed in code, not inferred:**
- The node-processing loop is explicitly bounded: `for (let i = 0; i < nodes.size + 1; i++)`
  (`:610`) — a "safety stopgap" comment acknowledges this is a defense against malformed graphs
  with cycles, not a semantic feature.
- `RateLimitNode` and the `MobilePush` message channel are unimplemented (§0.5, §0.2) —
  selecting either in a journey silently degrades to exit/failure rather than erroring at
  design time.
- Message sends retry via the Temporal *activity* retry policy
  (`maximumAttempts: currentNode.retryCount ?? 3`, `:955-960`), not inside the send code itself;
  a `MessageNode` with `skipOnFailure: false` (default) ends the journey on final failure
  (`:963-970`).
- `userJourneyWorkflow` is confirmed the most cognitively complex function in the codebase
  (cognitive complexity 331, transitive loop depth 9 — verified via cbm, §0.7) — one 930-line
  function is a `switch` covering entry, durability, retries, versioning (three wire-format
  versions coexist, `UserJourneyWorkflowVersion.V1/V2/V3`, `:150-183`), and localized-time delay
  math. There is no seam inside it; porting means rewriting the state machine, not extracting
  pieces.

---

## Section 4 — Segment / computed-property execution, traced

**Three-step pipeline**, named explicitly by an enum
(`ComputedPropertyStepEnum = { ComputeState, ComputeAssignments, ProcessAssignments }`,
`packages/isomorphic-lib/src/types.ts:6076-6079`), all inside one call,
`computePropertiesIncremental` (proxied as a single Temporal activity from both orchestration
layers in §0.3):

1. **Compile + ComputeState** — `computeState()`
   (`packages/backend-lib/src/computedProperties/computePropertiesIncremental.ts:3006-3255`).
   For every segment, `segmentNodeToStateSubQuery(segment.definition.entryNode, ...)`
   (`:1767-2181`, recursive descent over the segment's boolean tree — `And`/`Or`/`Trait`/
   `Performed`/`LastPerformed`/`KeyedPerformed`/`Broadcast`/`Email`/`Manual`/`Everyone`/
   `Includes`/`RandomBucket`/`SubscriptionGroup`/`SubscriptionGroupUnsubscribed`, all 14 types
   named in the predecessor doc — not independently re-verified line-by-line this pass, but the
   dispatch structure and function name are confirmed) compiles each node into a ClickHouse
   `INSERT ... SELECT` against `user_events_v2`, aggregated with `argMaxState`/`uniqState`/
   `groupArrayState` combinators into `computed_property_state_v3` (an `AggregatingMergeTree` —
   the ClickHouse-native way to keep a running aggregate that a later `argMaxMerge`/`uniqMerge`
   can cheaply finalize). Each state row is keyed by a `state_id` — a `uuidv5` hash of
   `(definitionUpdatedAt, nodeId)` (`userPropertyStateId`, `:150-168`; `segmentNodeStateId`
   analog at `:394`) — **so a definition edit doesn't just bump a version column, it changes
   which state rows the query even reads.**
   - **The watermark, concretely:** per-`(computedPropertyId, version)` periods come from
     Postgres (`getPeriodsByComputedPropertyId`, `packages/backend-lib/src/computedProperties/periods.ts:138-193`);
     the lower bound fed into the ClickHouse query is
     `processing_time >= toDateTime64(period/1000, 3)` where `period` is that row's `maxTo`, or
     `0` (no bound → full scan) if no period exists yet for the current version
     (`computePropertiesIncremental.ts:3092-3097`; watermark-reset mechanics in §0.6).
2. **ComputeAssignments** — `computeAssignments()`
   (`packages/backend-lib/src/computedProperties/computePropertiesIncremental.ts:3255-3589`,
   not read in full this pass, name and step position confirmed) resolves the per-node state
   into a final boolean (segment) or JSON value (user property) per user, written to
   `computed_property_assignments_v2`.
3. **ProcessAssignments** — `processAssignments()` (`:4049-`) is what turns a new assignment
   into external effects: replication to Postgres for row-wise reads
   (`userPropertyAssignment`/`segmentAssignment` tables), triggering journeys via
   `triggerSegmentEntryJourney` (Section 3), and marking rows in
   `processed_computed_properties_v2` so a retry after partial failure only replays pending
   effects (comment at `packages/backend-lib/src/userEvents/clickhouse.ts:398-406` states this
   explicitly).
4. **Pruning** — `pruneComputedProperties()` (`:4669-`) removes state for computed properties
   that no longer exist/are archived; `canPrune()` (`:4644`) gates it.

**What triggers a run:** either orchestration layer from §0.3 (legacy per-workspace poll every
`computePropertiesInterval` + jitter, or the scheduler+queue path checking `findDueWorkspacesV3`
— due when `now - min(per-property max(to)) > interval`, `packages/backend-lib/src/computedProperties/periods.ts:560-605`),
or an early wake via `enqueueRecompute`/`signalComputePropertiesEarly` from
`triggerWorkspaceRecompute` (called at least from broadcast segment recomputation, §0.3).

**What happens when a definition changes:** documented precisely in §0.6 — full recompute from
`from=null`, not an incremental delta.

**ClickHouse tables that matter here** (all in `packages/backend-lib/src/userEvents/clickhouse.ts`):
`computed_property_state_v3` (AggregatingMergeTree, partitioned by `(workspace_id,
toYear(event_time))`, `:131-157`), `computed_property_assignments_v2` (ReplacingMergeTree,
`:380-397`), `processed_computed_properties_v2` (ReplacingMergeTree, `:407-428`),
`resolved_segment_state` (per-tree-node boolean state for And/Or segment trees, `:485-503`),
`computed_property_state_index` (numeric index for `Within`-style trait operators, `:463-481`),
`updated_computed_property_state` / `updated_property_assignments_v2` (24-hour-TTL "changelog"
tables — `MergeTree ... TTL toStartOfDay(...) + interval 24 hour`, `:429-459` — used to detect
what changed since the last pass rather than diffing full tables), and the `user_property_idx_
{num,str,date}` tables + materialized views (`:189-278`) that exist purely to make sortable
user properties queryable without a full scan.

---

## Section 5 — Outbound message path

`MessageNode` (Section 3) builds channel-specific params and calls the Temporal activity
`sendMessageV2` (`packages/backend-lib/src/journeys/userWorkflow.ts:955-961`), retried up to
`currentNode.retryCount ?? 3` times by Temporal's activity retry policy — **retries live at the
Temporal-activity layer, not inside the destination adapters.**

The activity dispatches into the single shared function `sendMessage()`
(`packages/backend-lib/src/messaging.ts:2397-2420`):
```
Email    -> sendEmail(params)      (:839)
Sms      -> sendSms(params)        (:1782)
MobilePush -> throw "not implemented" (:2415, see §0.2)
Webhook  -> sendWebhook(params)    (:2167)
```

**Templating → provider call:** `sendEmail` resolves the message template + subscription-group
state + secrets in parallel (`getSendMessageModels`, `getEmailProvider`, view-in-browser secret
lookup — `:852-871`), renders via LiquidJS (Section 7), then dispatches to the resolved
provider's file under `destinations/`. `getSendMessageModels()`
(`packages/backend-lib/src/messaging.ts:401-`) is the **one centralized subscription-enforcement
chokepoint** shared by every channel — see Section 7.

**Delivery/failure/bounce status — where it's handled and where it isn't:**
- Every send path emits one of three `InternalEventType`s as a result:
  `MessageSent` / `MessageFailure` / `MessageSkipped` (grep across `messaging.ts` shows ~20 call
  sites across the email/sms/webhook branches). `isNonRetryableError()`
  (`packages/backend-lib/src/messaging.ts:849-859` region, exact fn at `:2517-2528`) classifies
  `MessageFailure` as non-retryable and `MessageSkipped` as retryable, feeding the broadcast
  pause-on-error logic (Section 6).
- These are recorded as `track` events with a `DF`-prefixed event name and land, via a
  materialized view, in `internal_events`
  (`packages/backend-lib/src/userEvents/clickhouse.ts:45-69`) — a ClickHouse table with
  pre-parsed columns (`template_id`, `broadcast_id`, `journey_id`, `channel_type`,
  `delivery_to/from`, `origin_message_id`) extracted from the event's JSON `properties` via
  `JSONExtractString`. This is the query surface behind `deliveriesController.ts`.
- **Provider-side delivery/bounce/complaint status is handled entirely separately, per
  provider, in `webhooksController.ts`** (Section 1 table) — six independent signature schemes,
  six independent `submit*Events` functions
  (`handleSendgridEvents`, `handleSesNotification`, `submitResendEvents`,
  `submitPostmarkEvents`, `submitMailChimpEvents`, `submitTwilioEvents`), each converting
  provider payloads into more internal track events feeding the same `internal_events` table.
  **This half of the pipeline is not centralized** — see Section 7 for the contrast with
  subscription enforcement, which is.
- What's *not* handled: MobilePush has no delivery-status path at all (channel doesn't send);
  generic Webhook sends have no bounce-equivalent concept (fire, get an HTTP response,
  `MessageSent`/`MessageFailure` based on that response — no async provider callback loop).

---

## Section 6 — Broadcasts

Confirmed live path is **V2** (`broadcastWorkflowV2`, §0.4) — one Temporal workflow **per
broadcast**, not per recipient (contrast with journeys). Key operational differences from
journeys:

- **Signals for control, not entry:** `pauseBroadcastSignal` / `resumeBroadcastSignal` /
  `cancelBroadcastSignal` (`packages/backend-lib/src/broadcasts/broadcastWorkflowV2.ts:18-20`,
  handlers at `:114-136`) let an operator pause/resume/cancel a running broadcast; state is
  persisted via `markBroadcastStatus` (Postgres `Broadcast.statusV2`), not just in-memory, so a
  status query (`getBroadcastStatus`) reflects reality even mid-workflow.
- **Cursor-paginated batch sending**, not one activity per user: `sendAllMessages()`
  (`:138-275`) loops calling the `sendMessages` activity with a `cursor`/`limit` (`batchSize`,
  default 100, `:279`) until the cursor is exhausted (`:171-274`). This keeps the workflow's
  event history small regardless of audience size — the opposite trade-off from journeys, which
  accept per-user workflow overhead for per-user durability.
- **Segment membership is (re)computed once per broadcast run**, not continuously: a single
  `recomputeBroadcastSegment` activity call (`:162-170`) precedes the send loop, using the
  segment engine's `computedPropertiesActivityTaskQueue` rather than the default queue.
- **Rate limiting is real here** (contrast §0.5's journey stub): after each batch,
  `sendAllMessages` computes `targetCycleTimeMillis = (messagesSent / rateLimit) * 1000` and
  sleeps the remainder of that window if the batch finished early (`:238-267`) — a
  token-bucket-by-sleep approach, not a queue-level limiter.
- **Scheduling, including per-recipient timezone fan-out:** an immediate broadcast just runs;
  a scheduled one either sleeps until one shared UTC instant (`defaultTimezone` path, `:349-386`)
  or, with `useIndividualTimezone`, computes each user's local delivery instant
  (`computeTimezones` + `getZonedTimestamp`), buckets users by resulting UTC timestamp, and runs
  one `sendAllMessages` per bucket **in parallel** after sleeping to that bucket's time
  (`:295-348`) — meaningfully more complex than "send now" and worth close reading if timezone
  scheduling is in scope.
- **Partial failure:** a `MessageSkipped`/`MessageFailure` mix that trips
  `includesNonRetryableError` in the `sendMessages` response **pauses** the broadcast
  (`:230-236`) — it doesn't fail the whole run over one bad recipient. A genuinely repeated
  Temporal activity failure (`ActivityFailure` with `RetryState.MAXIMUM_ATTEMPTS_REACHED`) marks
  the broadcast `"Failed"` and returns cleanly rather than crashing the workflow (`:407-421`).

---

## Section 7 — Subscription groups and compliance

**Representation:** `SubscriptionGroup` is a first-class Postgres resource
(`packages/backend-lib/src/db/schema.ts:317-`) of type `OptIn` or `OptOut`, with its own segment
node types (`SubscriptionGroup`, `SubscriptionGroupUnsubscribed` — Section 4) so subscription
state can be referenced inside arbitrary segment definitions, not just at send time.

**Enforcement at send time is centralized, in one function, shared by every channel:**
`getSendMessageModels()` (`packages/backend-lib/src/messaging.ts:401-`) is called from
`sendEmail`, and the equivalent path is shared by `sendSms`/`sendWebhook` (same module, same
`SendMessageParameters` shape) — it checks `inSubscriptionGroup(subscriptionGroupDetails)`
(`packages/backend-lib/src/subscriptionGroups.ts:83-90`) **before** template rendering or a
provider call, and returns `MessageSkipped` / `SubscriptionState` on failure
(`packages/backend-lib/src/messaging.ts:422-434`). The default-safety semantics are asymmetric
by design: for `OptIn` groups, an unresolved (`null`) action defaults to **not sending**
(`:86-88` — must positively subscribe); for `OptOut` groups, `null` defaults to **sending**
(only an explicit `Unsubscribe` blocks) — the standard implied-consent default. This is one
answer, not scattered logic re-implemented per channel.

**Exposed to template authors via LiquidJS custom tags** — this genuinely is "compliance
plumbing, not templating sugar," confirmed by reading the tag implementations:
`unsubscribe_link` / `unsubscribe_url` / `subscription_management_link` /
`subscription_management_url` / `view_in_browser_url`
(`packages/backend-lib/src/liquid.ts:160-`, registered on a shared `liquidEngine` instance,
`:47-`), each calling into `generateSubscriptionChangeUrl`/`generateUnsubscribeUrl`
(`packages/backend-lib/src/subscriptionGroups.ts:453-`, `liquid.ts:80-`) to produce
signed URLs (a `generateSubscriptionHash`, `subscriptionGroups.ts:426-452`, HMAC-style,
not fully traced this pass) rather than leaving link construction to the template author.

**What is *not* centralized:** ingesting the provider-side signal that changes subscription
state (a hard bounce, spam complaint, or manual unsubscribe click) is per-provider, in
`webhooksController.ts` (Section 5/1) — six separate signature-verification and event-mapping
implementations feeding the same downstream `updateUserSubscriptions`/segment-assignment
pipeline. So: **enforcement is centralized, ingestion of the signals that drive it is not.**

---

## Section 8 — Data model

### Postgres (Drizzle, `packages/backend-lib/src/db/schema.ts`, 31 `pgTable` calls — §0.8)

Tables that matter for a marketing product, with what's notable about each:

- **`Workspace`** (`:97-`) — tenancy root; has a `parentWorkspaceId` self-reference (used by
  admin-API-key scoping, §Section 1) and a `status` enum gating almost every runtime check
  (journeys, computed properties, broadcasts all bail if `status !== "Active"`).
- **`Journey`** (`:851-883`) — `definition: jsonb()` (the whole node graph as data — this is
  what makes the visual editor possible, per the predecessor doc's "types as the contract"
  point, independently confirmed here), a separate `draft: jsonb()` column (edit-in-progress
  without touching the live definition), `canRunMultiple: boolean` (the re-entry gate, Section
  3), `statusUpdatedAt` (used by `restartUserJourneysActivity` to bound which recent segment
  members to re-signal).
- **`Segment`** (`:736-780`) — `definition: jsonb()`, plus **`definitionUpdatedAt`, a column
  doing two jobs**: it's a normal audit timestamp *and* it is the literal cache-invalidation
  version key for the entire incremental-compute engine (§0.6) — an edit to `definition` isn't
  just data, it silently forces a full recompute downstream in a different datastore.
  `resourceType` distinguishes `Declarative` (user-authored) from other origins (e.g. broadcast-
  or subscription-group-derived segments, per `broadcastSegmentToPerformed`-style helpers in
  the compute engine, Section 4).
- **`Broadcast`** (`:385-447`) — the dual-version columns from §0.4 (`status`/`statusV2`/
  `version`), plus `config: jsonb()` (rate limit, batch size, timezone options — everything
  read by `broadcastWorkflowV2`, Section 6) and `scheduledAt` stored as a **naive
  string timestamp, `withTimezone: false`** (`:403-407`) — timezone is resolved separately via
  `defaultTimezone`/`useIndividualTimezone` in `config`, not carried on the column itself.
- **`ComputedPropertyPeriod`** (`:885-916`) — the Postgres-side watermark table, Section 4/§0.6;
  indexed on `(workspaceId, type, computedPropertyId, to)`.
- **`UserPropertyAssignment` / `SegmentAssignment`** — the row-wise Postgres replica of
  ClickHouse's `computed_property_assignments_v2`, for fast per-user reads without hitting
  ClickHouse on every dashboard/API call (per the comment at
  `userEvents/clickhouse.ts:401`).
- **`Secret`** — generic encrypted-config store keyed by `(workspaceId, name)`, referenced by
  `EmailProvider`, `SmsProvider`, `AdminApiKey`, webhook-signing keys, and the write-key itself
  — one table backing many concerns via a `name` discriminator rather than one table per
  concern.
- **`WorkspaceMember` / `WorkspaceMemberRole` / `WorkspaceMembeAccount`** *(sic — typo is
  upstream, not mine)* — the multi-tenant identity model, only exercised when
  `authMode="multi-tenant"` (§0.1); otherwise vestigial at runtime.

### ClickHouse (`packages/backend-lib/src/userEvents/clickhouse.ts`)

Fully enumerated in Section 4 for the compute-engine tables; the two additional tables that
matter beyond that are `user_events_v2` (Section 2 — the single source of truth for all raw
events, computed columns as `DEFAULT JSONExtract(message_raw, ...)` over one JSON blob column)
and `internal_events` (Section 5 — the pre-parsed delivery-status/analytics table, itself a
materialized view *filter* over `user_events_v2` rather than a separately written table:
`WHERE event_type = 'track' AND startsWith(event, 'DF')`,
`packages/backend-lib/src/userEvents/clickhouse.ts:45-69`). `group_user_assignments` /
`user_group_assignments` similarly are materialized-view projections of specific internal
event types (`GroupUserAssignment`/`UserGroupAssignment`), not independently written tables
(`:71-129`) — a recurring pattern in this schema: write one append-only fact table
(`user_events_v2`), derive everything else via materialized views rather than multiple
write paths.

**Column doing more than one job, ClickHouse side:** `computed_property_state_v3.state_id`
(`LowCardinality(String)`) is simultaneously a partition key for aggregation *and* a version
marker, since it's derived from `uuidv5(definitionUpdatedAt + nodeId)` — the same "definition
change invalidates via a derived id" pattern as the Postgres side, just implemented as a hash
instead of a nullable `from` column.

---

## Section 9 — Worker/workflow topology

**One generic worker binary** (`packages/worker`, 3 files — confirmed, matches predecessor
doc): `packages/worker/src/buildWorker.ts:23-124` builds a single `Worker` from
`@temporalio/worker`, pointed at `workflowsPath: require.resolve("backend-lib/src/temporal/workflows")`
(a barrel re-exporting **every** workflow module, `:16-16` per file) and `activities:
* as activities` (a barrel of **9** activity modules, `packages/backend-lib/src/temporal/activities.ts:1-11`).
Temporal resolves workflow/activity implementations by string type name at execution time, so
this one worker binary can run any registered workflow — there is no per-workflow-type worker
process in source.

**Workflow types registered** (`packages/backend-lib/src/temporal/workflows.ts`):
`broadcastWorkflowV2`, `recomputeBroadcastSegmentWorkflow`, `broadcastWorkflow` (legacy V1,
§0.4), `computePropertiesQueueWorkflow`, `computePropertiesWorkflow` (legacy per-workspace poll,
§0.3), `computePropertiesSchedulerWorkflow`, `globalCronWorkflow` (Temporal *cron* schedule,
`*/5 * * * *`, started via `client.start(globalCronWorkflow, { cronSchedule: ... })`,
`packages/backend-lib/src/computedProperties/computePropertiesWorkflow/lifecycle.ts:76-88` —
this one just emits telemetry/observability signals,
`packages/backend-lib/src/resiliency.ts:216-232`, not a compute trigger), `hubspotUserWorkflow`
/ `hubspotWorkflow`, `journeys/bootstrap` (workspace-bootstrap workflow, not traced this pass),
`userJourneyWorkflow`, `manualSegmentWorkflow`.

**Task-queue topology is a configuration knob, not a structural split, by default:**
`taskQueue`, `computedPropertiesTaskQueue`, and `computedPropertiesActivityTaskQueue` all
independently default to `"default"` (`packages/backend-lib/src/config.ts`, confirmed via the
`??` fallbacks around `:543-605`) — so out of the box every workflow and activity lands on one
queue, polled by however many copies of the one worker binary an operator runs. The separate
config names exist so an operator *can* route compute-properties-heavy activities to a
dedicated worker pool at scale (e.g. `recomputeBroadcastSegment` explicitly takes
`taskQueue: computedPropertiesActivityTaskQueue` as an override,
`broadcastWorkflowV2.ts:162-165`) — this is a scaling lever present in code, not a requirement.

**Failure/retry policy:** set per-activity-group via `proxyActivities({ startToCloseTimeout,
retry: { maximumAttempts } })` at each call site rather than one global policy — e.g. journey
node-processing activities get `defaultUserJourneyMaxAttempts` (`userWorkflow.ts:225-236`),
message sends get `currentNode.retryCount ?? 3` (`:955-960`), broadcast sends get
`broadcastSendMessagesMaxAttempts` (`broadcastWorkflowV2.ts:146-160`), and `waitForComputeProperties`
gets a long `startToCloseTimeout: "20 minutes"` with a `heartbeatTimeout: "30 seconds"`
(`userWorkflow.ts:253-260`) — the heartbeat is what lets Temporal detect a stalled/crashed
*activity* worker mid-long-poll and reassign the activity, distinct from workflow-level replay.

---

## Section 10 — Reimplementation notes

Per section, blunt call, with the honest cost of the durable/analytical dependencies this repo
leans on (we are targeting Next/Electron, no Temporal or ClickHouse by default).

1. **HTTP surface (§1).** *Adapt, don't port.* The write-key + per-provider-webhook-signature
   pattern is worth copying structurally (simple, provider-idiomatic, no shared secret leakage
   across providers). **Do not copy the auth posture** — §0.1's finding that the standard
   resource block ships unauthenticated by default in OSS is a trap, not a feature; if
   reimplementing, wire real auth from day one rather than leaving a pluggable hook unplugged.

2. **Event ingestion (§2).** *Port the idea, not the mechanism.* Single source-of-truth
   append-only event table + JSON-blob-with-computed-columns is a good pattern independent of
   ClickHouse — it's implementable on Postgres (`jsonb` + generated columns) at the volumes a
   Next/Electron-hosted product will see for a long time. The synchronous-insert +
   synchronous-in-request journey-trigger design (§2 step 4) is simple and worth copying
   directly; it does mean an API-process crash between insert and trigger silently drops that
   trigger opportunity for event-entry journeys — acceptable if segment-entry journeys (driven
   by the separately-durable compute pipeline) are the primary mechanism, worth an explicit
   decision if not.

3. **Journey engine (§3).** *Port the idea and the node taxonomy closely; do not port Temporal.*
   This remains the single highest-value idea in the repo: one durable state machine per
   (user, journey), with delay/wait-for that survives a process crash, and idempotent,
   deterministically-keyed (re-)entry. What Temporal actually buys: automatic replay-based crash
   recovery, and built-in per-activity retry/backoff — both non-trivial to hand-roll correctly.
   **Cheapest honest substitute:** a persisted state-machine row per (user, journey) in your own
   DB (`current_node_id`, `context` JSON, `wake_at` timestamp for delays) plus a poller/cron that
   advances due rows and a signal/webhook path that advances event-waiting rows on matching
   events — you lose "replay of arbitrary in-flight logic," which you don't need if the state
   machine's state is fully captured in the row (which it should be, by design, if you're
   porting the node-taxonomy-as-data idea from Section 8/§3 anyway). Skip `RateLimitNode`
   entirely — it isn't implemented upstream either; if rate-limiting a journey channel is a
   requirement, look at the *broadcast* rate limiter (§6) instead, which is real.

4. **Segment/computed-property engine (§4).** *Port the node taxonomy and the watermark
   concept closely; do not port the ClickHouse SQL compiler.* The 14-node segment taxonomy and
   the Postgres-side watermark-per-(id,version) design (§0.6) transfer directly to a Postgres-
   only implementation: same periods table, same "definition-edit changes the version key"
   semantics, same three-step (state → assignments → process) pipeline — just compiling to
   Postgres CTEs/window functions over an events table instead of ClickHouse `AggregatingMergeTree`
   combinators. **What ClickHouse actually buys here:** cheap incremental aggregation at OLAP
   scale (`argMaxState`/`uniqState` combinators merge cheaply without rescanning). **Cheapest
   honest substitute:** if event volume per workspace stays in the low millions, a
   well-indexed Postgres events table with the same watermark-bounded queries will work fine and
   avoid running a second database engine; only reach for ClickHouse (or DuckDB embedded, a
   lighter middle ground) if/when a specific workspace's volume makes Postgres scans too slow.

5. **Outbound message path (§5).** *Port the shape, treat MobilePush as a placeholder to design
   properly rather than copy.* The single-`sendMessage()`-dispatcher-with-per-channel-function
   pattern, and the `MessageSent`/`MessageFailure`/`MessageSkipped` internal-event convention
   feeding a queryable delivery-status table, are both worth copying directly. Copy the
   provider-webhook pattern (Section 1) for delivery status but budget for it being genuinely
   per-provider work, not centralizable.

6. **Broadcasts (§6).** *Port closely.* The cursor-paginated single-workflow-per-broadcast
   design, the sleep-based rate limiter, and the per-recipient-timezone bucketing are all
   directly reusable ideas independent of Temporal — in a hand-rolled state machine, a broadcast
   is just a row with a cursor and a status, advanced by a cron/worker loop; pause/resume/cancel
   become status-column writes checked at the top of each loop iteration instead of Temporal
   signals.

7. **Subscription groups (§7).** *Port directly, this is small and high-value.* The
   OptIn-fails-closed / OptOut-fails-open default-safety split, the single shared
   pre-send-check chokepoint, and the five Liquid compliance tags are all straightforward to
   reimplement without any of Dittofeed's infra dependencies. Pairs naturally with whatever
   templating-drops layer exists on the Chatwoot side of this survey (per the predecessor doc's
   own cross-reference) as the two halves of a templating story.

8. **Data model (§8).** *Port the shape; the JSON-definition-as-data pattern for
   journeys/segments is the load-bearing idea, not any particular column list.* Keep the
   `definitionUpdatedAt`-as-version-key trick (§0.6) if you keep the watermark design — it's a
   small, well-understood piece of a design that otherwise (see §3, §4) transfers cleanly to a
   Postgres-only stack.

9. **Worker/workflow topology (§9).** *Skip.* This entire section is Temporal-specific
   plumbing (one generic worker resolving workflow types by string, task-queue routing as a
   scaling knob). Nothing here is portable independent of the decision (already made, per this
   engagement's framing) not to run Temporal.

10. **Overall:** the predecessor doc's ranked port list stands up well against this behavioral
    pass and needs one addition and one demotion: **add** "the watermark-based incremental
    recompute design, specifically" as its own line item distinct from "the segment node
    taxonomy" (they're separable — you could port the taxonomy with a naive full-rescan compute
    and still get most of the value, cheaper, if incremental correctness-on-edit (§0.6) isn't
    worth the complexity yet); **demote** "destination adapter shape" slightly — with MobilePush
    confirmed dead code (§0.2) and only 2 real SMS providers, the adapter *count* the predecessor
    doc cites overstated how much working reference material exists; the shape is still worth
    copying, there's just less of it working than advertised.

---

## Handoff contract

**Inputs used:** the brief; `docs/dittofeed-architecture.md` (predecessor structural doc, read
in full, treated as a claim); direct reads of ~35 source files across `packages/api`,
`packages/backend-lib` (`journeys/`, `computedProperties/`, `broadcasts/`, `destinations/`,
`messaging.ts`, `messaging/email.ts`, `subscriptionGroups.ts`, `liquid.ts`, `apps.ts`,
`apps/*.ts`, `userEvents.ts`, `userEvents/clickhouse.ts`, `db/schema.ts`, `requestContext.ts`,
`auth.ts`, `config.ts`, `resiliency.ts`, `temporal/workflows.ts`, `temporal/activities.ts`) and
`packages/worker`; `grep`/`find` sweeps for call-site verification (write-key/auth wiring,
`sendNotification` dead-code check, controller/pgTable counts); ~10 `codebase-memory-mcp`
`query_graph`/`search_graph`/`get_graph_schema` calls against project `dittofeed` (default
`HOME`) for cognitive-complexity/loop-depth validation only. No test run, no build, no
Temporal/ClickHouse/Postgres started, per instructions — every runtime-mechanism claim (Temporal
replay-on-crash, in particular, §3) is labeled where it's inferred from Temporal's documented
model rather than directly observed.

**Output:** this file, `/Users/la/Programming/Open-Marketing/docs/dittofeed-sitemap.md`.

**Risks / uncertainties beyond the "could not verify" list below:**
- The V1 broadcast workflow's exact current reachability was checked one level deep (no
  controller starts it) but not exhaustively — e.g., an admin-cli backfill/upgrade script could
  theoretically still touch it. Low risk given `admin-cli` is already a "skip" per the
  predecessor doc's port ranking.
- Section 8's ClickHouse/Postgres coverage is thorough for the tables that feed the traced flows
  (Sections 2/4/5) but not a full 31-table Postgres audit; tables outside the traced flows
  (`Integration`, `OauthToken`, `ComponentConfiguration`, `WorkspaceOccupantSetting`,
  `UserPropertyIndex`, `SubscriptionManagementTemplate`) were named from the `pgTable` listing
  but not individually opened.

**What I could not verify this pass:**
- The exact signed-URL/hash scheme behind `subscription-management` and `view-in-browser`
  public endpoints (named in Section 1's table as "not independently verified") —
  `generateSubscriptionHash`/`generateViewInBrowserHash` exist and were seen only by name/import,
  not read.
- Full bodies of `computeAssignments()` (`computePropertiesIncremental.ts:3255-3589`) and
  `processAssignments()` (`:4049-`) — confirmed their role and position in the pipeline via
  signatures, call sites, and surrounding code, but did not read every line given the file's
  size (4,817 lines total).
- Whether `journeys/bootstrap` (a registered workflow, Section 9) does anything beyond
  workspace-creation-time setup — named, not opened.
- `hubspotUserWorkflow`/`hubspotWorkflow` internals — out of scope per the predecessor doc's
  "skip unless CRM sync is scoped" ranking, and not reopened here.
- Whether any deploy-time wrapper (reverse proxy, EE package, hosted-Dittofeed-specific glue)
  supplies `registerAuthentication` in a way this OSS clone can't show — §0.1's finding is
  airtight for *this source tree*, but "OSS Dittofeed as typically deployed" could differ if an
  operator adds their own gateway auth, which would be invisible to a source-only analysis.

**Suggested next assignee:** whoever owns the Open Marketing journey-engine design spike should
read Section 3 + §0.5/§0.6 closely before writing the state-machine schema (Reimplementation
note 3); whoever scopes the segment/compute engine should read Section 4 + §0.3/§0.6 before
choosing Postgres-only vs. adding an OLAP engine (Reimplementation note 4). Both can be done in
parallel; neither depends on re-cloning the (stale) upstream repo first, since every citation
above is line-anchored against the commit already on disk.
