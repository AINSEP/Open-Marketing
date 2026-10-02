# Open Marketing, full scope — fable-architect

## Contested points, verified against `/Users/la/Programming/Jini/packages`

**1. `@jini-ai/capability-providers`.** `DbProvider` (`src/db.ts:29`) is `insert/get/update/delete/query` over `(collection, id)` records: no joins, no row locks, no partial unique indexes. It cannot hold the delivery ledger, `journey_run`, or `budget_envelope`. Astra is right that the package is usable, and wrong if usable means "as the data layer." What is genuinely consumable: the `RealtimeProvider` port with `./adapters/ws` (live node counts on the journey canvas, pacer alerts), and the `AuthProvider` port shape. What is not: `JwtAuthProvider` keeps users in process memory ("pair it with a real store"), so the operator-login implementation is new Postgres code bound to that port; `./adapters/blob-storage` only wraps `@jini-ai/platform`'s `BlobStorage`, which OM should call directly; `PaymentsProvider`/Stripe is irrelevant unless commerce lands. README says it was "built without a current in-repo consumer." Verdict: JINI for the realtime adapter and the auth port; nothing from it under the spine.

**2. `media-providers` async tier — Opus is right, Gemini is over-building, and I under-read it last round.** The files exist under `dispatch/`: `async-operation-store.ts`, `sqlite-async-operation-store.ts`, `polling-adapter.ts`, `operation-runtime.ts`, all exported through `dispatch/index.ts` and re-exported from the package barrel. What is there: `AsyncOperationRecord` with `attempts`, `maxAttempts`, `nextPollAt`, `leaseOwner`, `leaseExpiresAt`, `deadlineAt`, `schemaVersion`, and statuses `submitted|polling|succeeded|failed|unknown` with an enforced transition table. `startOperation` persists the row before the first HTTP call, then races the submit against a 4 s grace window (`expectedLatencyClass` per vendor). `pollDueOperations` is one leased tick: `claimDue` is a single `UPDATE … WHERE id IN (SELECT … LIMIT ?) RETURNING *`, every write is fenced on the lease. `recoverAfterRestart` releases dead leases and routes crashed-before-submit-confirmed rows to `unknown` unless the adapter declares `submitIsIdempotent` ("reconcile manually rather than risk a duplicate charge"). Credentials never persist: `RequestSigner` re-signs on every tick and `assertNoCredentialMaterial` rejects secrets in `state`. `OperationRuntimeDeps.now` is injectable. Explicitly absent by design: a scheduler ("a single leased tick a host drives from whatever timer or queue it already runs") and any durable adapter other than SQLite. So OM's `creative-jobs` is: one host tick calling `pollDueOperations` every 5 s from the shared poller loop; one `PollingVendorAdapter` per new vendor (Seedance, Higgsfield); optionally a ~200-line Postgres `AsyncOperationStore` so `apps/server` has no SQLite file; and the product-side `creative_job` row that links an operation id to a brief, a cost envelope, and asset provenance. That is a thin binding, not a new job engine. My earlier line "use its engine and adapters, not its store" was aimed at `MediaTaskStore` and is wrong for `AsyncOperationStore`; use it.

**3. `@jini-ai/mcp` — Opus is right; there is no trust boundary and no client.** `McpServerConfig` (`core/config.ts:38`) is `{id, label, transport, enabled, authMode, command, args, env, url, headers}`; grep for `allowedTools|disabledTools|blockedTools` returns nothing; nothing filters tool results. `client/client.ts` is, per its own module doc, "runtime primitives for a stdio MCP *server*" (idle-exit controller, reference extractor, MIME classifier), not an MCP client. No file under any `packages/*/src` imports `@modelcontextprotocol/sdk/client`. `agent-install/install.ts` "wires a stdio MCP server into a coding agent's own configuration," meaning calls go CLI → server, bypassing `ToolExecutor` and `ToolPolicy` entirely. What the package does give: sanitized config, 0600 atomic secret files (`secure-write.ts`), OAuth 2.1 + PKCE with a per-server token store. `mcp-broker` is new code.

**4. `@jini-ai/cms` forms.** `ls packages/cms/src` → `content-types core entries identity media navigation presentation server settings taxonomy workspace`; no `forms`; `package.json` exports carry no `./forms`. Opus is right. `forms` is new code.

## 1. Module list

**One product, one loop, three engines.** An ad buys a click id, a form turns it into a `subject` with an email, journeys monetize it for years, and `conversions` reports the sale back so the platform buys better clicks. The join is `subject_identifier` with kinds `fbclid|gclid|ttclid|li_fat_id|anonymous_id|email|phone|sha256_email|order_id`. One product. But sending (ledgered, mostly recallable), spending (continuous, external state, irreversible) and generating (slow, async, priced per call) have different physics, so three pollers share one spine, one `Clock`, one `audit_log`. Cut v1 to Meta only, image only, ledger-only analytics; the loop still closes.

**Spine (NEW):**
- `om-schema` — Postgres DDL, migrations.
- `identity` — `subject`, `subject_identifier`, `subject_merge`, `attribute_definition`. Recognizes one person across a click, a form, and an email.
- `consent` — `consent`, `suppression`, `sendability()`, plus `shareability(subject, platform, purpose)`. Decides whether a hashed email may leave the building.
- `events` — `event`, `POST /v1/track`, browser snippet. The raw material for segments and conversions.
- `audit` — `audit_log` with principal `human|agent:<runId>|mcp:<serverId>` on every mutation.
- `secrets` — server-side encrypted-at-rest vault for platform tokens. (`@jini-ai/tokens` is CSS design tokens; `@jini-ai/mcp`'s 0600 store covers only MCP OAuth tokens.)
- `erasure` — deletion as invalidation caller: subject rows go, daily aggregates stay.
- `holdout` — a `holdout_group` membership that `sendability` returns as `skipped_by_holdout`. Proves marketing caused anything (see §5).

**Lifecycle (NEW, settled):** `segments`, `journeys`, `templates`/`render`, `send` + `message_delivery`, `preferences` (signed page), `deliverability` (bounce/complaint intake, per-domain reputation, warm-up ramp), `frequency` (cross-channel cap at the send gate), `webhooks-out`.

**Acquisition join:**
- `forms` (NEW) — hosted `POST /v1/forms/:id/submit` + embed snippet; captures the click id from the landing URL and writes `subject` + `subject_identifier` + `consent` in one transaction. The moment a click becomes a person.
- `landing` (EXTERNAL) — Tovu, the sibling `@jini-ai/cms` product, or any site; OM stores only `landing_page{url, utm_template, form_id}`. Do not build a page builder. The destination an ad points at.
- `links` (NEW) — UTM builder, signed redirect for click attribution.

**Paid media (NEW unless noted):**
- `ad-accounts` — OAuth connections, account health, suspension detection. EXTERNAL: Meta Marketing API, Google Ads API, TikTok, LinkedIn.
- `ad-mirror` — `ad_campaign`, `ad_set`, `ad`, `ad_creative_ref`, `ad_sync` poller; platform owns state, OM holds desired-state and last-observed. One screen instead of four dashboards.
- `budgets` — `budget_envelope`, `spend_snapshot`, pacer job, kill-switch. Stops a bad bid burning money overnight.
- `platform-audiences` — segment → hashed upload / lookalike, only through `shareability`. Targets your customers and people like them.
- `conversions` — `conversion_event{subject_id, kind, value, currency, click_ids, occurred_at}` derived from `event` + consent; `conversion_dispatch` ledger; Meta CAPI and Google Enhanced Conversions adapters with `event_id` dedup. Teaches the platform who converts and what they are worth.
- `ad-review` — mirror of platform review status. Knows an ad was disapproved before spend silently stops.

**Creative:**
- `assets` (NEW DAM) — `asset`, `asset_version`, `asset_variant`, `asset_provenance{prompt, model, seed, provider, operation_id, source_asset}`, `asset_rights`; bytes in `@jini-ai/platform` `BlobStorage` (JINI, Local/S3). The library of everything that can go in an ad or email. `@jini-ai/artifacts` is not this: `ArtifactStore` is `create/get/list`, in-memory reference only, built for run outputs (HTML/Markdown/SVG) with placeholder and stub-regression guards; no update, delete, versioning, or renditions.
- `creative-jobs` (JINI + thin NEW) — `@jini-ai/integrations/media-providers` `startOperation`/`pollDueOperations`/`recoverAfterRestart` + `MediaPolicy` allowlist (deny by default) + SSRF guard; NEW: the host tick, a Postgres `AsyncOperationStore`, `creative_job` metadata, and `PollingVendorAdapter`s for Seedance (Volcengine has an image adapter only) and Higgsfield. EXTERNAL: Higgsfield, Seedance, OpenAI images.
- `variants` (NEW) — `platform_creative_spec` + rendition generation (`@jini-ai/cms/media` image transformers or sharp). An ad is six shapes.
- `brand` (NEW) — brand kit, brand check. Keeps generated output on-brand.
- `fatigue` (NEW) — `creative_performance` rollup, decay detection, auto-requests replacements. The treadmill paid media runs on; agree it is the differentiator.

**Analytics (NEW):** `ledger-rollups` (ours, exact), `platform-metrics` (theirs, restated, append-only by `fetched_at`), `attribution` (`attribution_touch`), `reporting` (screens + `om report`).

**Agent and host (JINI):** `daemon` (run lifecycle, `ToolExecutor`, agent executor), `agent-runtime`, `chat`, `agentic` (canvas handles), `http-kit`, `sqlite` (run event log only), `desktop-host`, `cli`, `mcp` (OM's own MCP server for outside agents; config and OAuth store), `memory` (operator notes), `capability-providers` (realtime adapter, auth port), `tokens`/`ui`. **NEW engine:** `@jini-ai/approvals` (settled). **NEW OM:** `mcp-broker`, `om-tools`, `om-contracts`, `apps/server`, `apps/web`, `apps/desktop`, `apps/cli`.

**Astra's extras.** Commerce context: defer the module, reserve the spine. No `product`/`order`/`refund` tables in v1, but `conversion_event.value` and `currency` from day one (CAPI value-optimization and ROAS both need revenue) and `order_id` as an identifier kind so orders can be attached later without a merge. Margin: deferred; ROAS on revenue first. Experimentation: `RandomCohort` and `RandomBucket` already give splits; the one thing worth shipping early is the global `holdout`, because it is the only honest answer to "platform numbers never reconcile." Stopping rules and sequential tests: Phase 6, they need volume and statistics the first build will not have.

## 2. Tool surface

The gate unit is the **plan**, not the action. `campaign_plan{segment_ids, journey_id, template_ids, ad_campaign_ids, budget_envelope_id, creative_set_id, landing_page_id, conversion_config_id, period}` gets one durable approval; inside it the agent works within envelopes. Target: single-digit approvals per week.

- **identity/events/segments/analytics — autonomous:** `subjects.search|timeline`, `segments.draft|estimate|explain`, `events.query`, `report.run`, `attribution.compare`. `subjects.merge` confirm-in-run.
- **templates/journeys — autonomous in draft:** `templates.draft|preview|test_send` (allowlist recipients), `journeys.draft|simulate(clock)`, `journeys.pause`, `broadcasts.cancel`. `journeys.publish`, `broadcasts.launch`, `journeys.resume` are covered by the plan approval.
- **consent — asymmetric:** `suppression.add`, `consent.record_optout` autonomous; `suppression.remove`, `consent.record_optin` always durable.
- **assets/creative — autonomous within `creative_budget_envelope`:** `creative.generate(brief, spec)`, `assets.variant|tag`, `brand.check`, `fatigue.report`. `assets.set_rights`, `brand.update_kit` confirm-in-run.
- **ads — autonomous inside an approved envelope:** `ads.pause` (always), `ads.resume` (within envelope and period), `ads.rotate_creative` (approved `creative_set` only), `ads.adjust_bid` (±20 %/day), `ads.shift_budget` (sum unchanged), `ads.exclude_placement`, `ads.insights`. Durable: `budgets.raise`, `ads.create_campaign` (unless inside a plan), `audiences.upload`, `ads.change_objective`, `ads.expand_targeting`, `accounts.connect`.
- **mcp-broker — read tier only:** `mcp.<server>.<tool>`, `risk:'read'`, per-tool grant required.

**On "exactly five."** Agree with the discipline, disagree with the number as the invariant. The rule is: every durable gate is an *envelope*, never an action, and `ApprovalKind` is a closed enum in `om-tools` so adding one is a reviewed PR, not a config toggle. Today that enum is five: `plan.publish`, `budget.envelope`, `identifiers.export` (audience upload, CAPI config), `consent.increase` (suppression removal, opt-in recording), `account.connect`. Measure gates per week; above roughly ten, widen an envelope rather than add a gate.

## 3. Money

Tokens live only in `apps/server`'s `secrets`; the agent never sees a credential and `apps/desktop` never holds one. `budget_envelope{platform, account_id, cap_total, cap_daily, start, end, pace_mode, hard_stop}`. The pacer pulls `spend_snapshot` from the platform insights API every 15 minutes; at `cap_daily` it pauses every ad set in the envelope via the platform API; if spend cannot be read for two consecutive hours it pauses anyway (fail closed). Belt and braces: at approval time OM also sets the platform-side account spending limit (Meta account spend cap, Google account budget) so a dead `apps/server` still cannot overspend. Kill-switch: `om ads halt <account>` and one red button, both writing `hard_stop=true` and calling the platform pause endpoint directly. The three-week approval object: `{plan_id, definition_hash, envelope, account_ids, audiences[] with shareability_result, creative_set_hash + sample renders, landing_url, conversion_config_hash, expires_at: end+1d, approved_by}`. Execution refuses on hash drift; only a cap increase triggers re-approval.

## 4. Creative and MCP

Generation jobs run on `media-providers`' `AsyncOperationStore` (§ verified above), driven by one tick in the shared poller loop, with a Postgres store adapter so `apps/server` carries no SQLite file, and `creative_job{operation_id, brief, spec, cost_estimate, envelope_id, asset_id}` as the product row. Not Jini runs (a run is an agent session; a generation outlives it) and not the journey table (different lease and budget semantics). Bytes land in `BlobStorage` at `assets/<sha256[0:2]>/<sha256>`, addressed `om://asset/<id>@<version>/<variant>`. Higgsfield and Seedance become `PollingVendorAdapter`s (typed, SSRF-guarded, policy-gated, `RequestSigner` re-signing per tick), not MCP servers invoked by the model; the fatigue loop needs generation as a server-side job with a budget, not a chat-driven tool.

**Trust boundary.** Never `agent-install` a third-party server for OM runs; that path routes calls CLI → server around `ToolExecutor`. `mcp-broker` in `apps/server` is the only MCP client (`@modelcontextprotocol/sdk` client, new); it mounts each remote tool as a `ToolRegistration` whose `ToolPolicy` returns `deny` unless a row exists in `mcp_tool_grant(server_id, tool_name, risk)`; stdio servers are spawned via `@jini-ai/platform` `spawnBackgroundProcess` with only their own `env` (no `DATABASE_URL`, no OM secrets, no `JINI_*` tokens); results are size-capped and stamped `provenance: mcp:<id>` in the run event log. Structurally no MCP-derived handler can reach `send.*` or `ads.*`: those are separate registrations whose server-side checks (`sendability`, envelope, approval hash) hold regardless of principal. Residual risk is the confused deputy, an injected instruction making the agent *propose* a send; the approval's sample recipients and hash exist for exactly that.

## 5. Analytics truth

Two stores, both Postgres, both labeled, never summed. `ledger_*` (ours, exact, from `message_delivery`, `conversion_dispatch`, `event`) and `platform_metric_daily(platform, entity_id, date, fetched_at, …)`, append-only so a restatement is a new row and every report is as-of. Attribution lives in OM: `attribution_touch` from click ids on `subject_identifier`, delivery opens/clicks, and `event`; last-touch with a configurable window; platform-claimed conversions sit in an adjacent column flagged "claimed by N sources." The `holdout` group is what turns two truths into one defensible number: conversion rate among marketed minus conversion rate among held-out is incrementality, and neither platform can restate it. Erasure keeps daily aggregates via the Matomo mechanism. ClickHouse: no. 120k subjects at ~50 events/month is 6M rows/month; `platform_metric_daily` is ads × days; monthly partitioning on `event` holds past 10^8 rows.

## 6. Build order

- **0** spine + `Clock` + `audit_log` + `secrets` + `holdout`. **Tell:** `0001_subject_identifier.sql` whose `kind` enum already includes `fbclid`, `gclid`, `ttclid`, `order_id`.
- **1** send + ledger + templates + preference page + `forms` + `/v1/track`. The acquisition join exists before ads.
- **2** segments + journeys + `@jini-ai/approvals` + `campaign_plan` + the closed `ApprovalKind` enum.
- **3** `assets` + `creative_job` over `AsyncOperationStore` (Postgres adapter) + image generation + `variants`. Ads need creatives first.
- **4** Meta only: `ad-accounts`, `ad-mirror`, `budgets` pacer and kill-switch, `conversions` CAPI with `shareability` and `value`, `platform-audiences`. **Tell:** `budget_envelope` and `conversion_dispatch` migrations in the same PR as the first `ads.*` tool.
- **5** two-store analytics + attribution + incrementality report + reporting.
- **6** Google, TikTok, LinkedIn; Seedance/Higgsfield polling adapters; `fatigue`; `mcp-broker`; stopping rules.
- **7** deliverability warm-up, `frequency`, `webhooks-out`, commerce context if orders exist.

## 7. What goes wrong

The paid-media half will be built against sandbox accounts and APIs the team does not control, and the two pieces that make paid media function, the spend pacer and the conversion loop, will be built last because they are invisible plumbing while the ad mirror is a visible screen. Meta app review for `ads_management` takes weeks and needs business verification; the mirror will "work" for months against test accounts while the tool surface grows against it unvalidated. The first real campaign then runs with a polished mirror, no pacer, and no CAPI: spend burns unpaced overnight and the platform optimizes blind, and the team calls the platform's numbers "wrong" because the two-store rule and the holdout were skipped. The tell is Phase 4's: if `budget_envelope` and `conversion_dispatch` do not land with the first `ads.*` tool, this is what happens.
