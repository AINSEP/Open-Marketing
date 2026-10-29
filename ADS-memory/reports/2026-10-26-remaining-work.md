# OM: remaining work after the 2026-10-26 waves (resume here)

Written 2026-10-26 ~12:15 by open-marketing-f8 when the owner TABLED further work.

## State when tabled
- **Branch:** om/cleanup-1025, HEAD 867bb92. EVERYTHING below is uncommitted in the main checkout: last night's 25-job wave + fix wave (12 jobs) + round-2 (8 jobs) + Coordinator integrator edits. Nothing is committed, pushed, cloud-tested or merged.
- **Reports, in order:**
  - `2026-10-26-opus-review-wave.md` (first review);
  - `2026-10-26-opus-rereview-fixwave.md` (re-review of the fix wave);
  - THIS file (re-check of round 2 + everything left).
- **Typecheck (Coordinator, after round 2):** all 17 ad plugins + studio exit 0; the four messaging plugins + measure exit 0 per their job report. Server/contracts were last checked before round 2: server exit 0, contracts exit 0.
- **r2-oe3 (option A) FINISHED at 12:19.** Per its own report:
  - features/plugins now owns the running add-on lifecycle (upload/enable/disable/remove, with audit + running-job safeguards);
  - om-tools reads call services directly (finding 12);
  - 4 superseded adapters were deleted, net −630 lines;
  - plugins, federation and server typecheck clean after one rerun;
  - **federation consolidation is DEFERRED** (still open).

  Not yet verified by Opus.
- **NOT re-checked yet:** r2-oe3 and r2-server-minors.

## 2026-10-27 update (round 3 running)
- **r2-server-minors, Opus re-check: small fixes.** All 3 items fixed; 4 MINOR findings; typecheck clean (server, contracts, plugins, federation, web-events). Full section: session scratchpad `recheck3-server-minors.md`, to be copied here when the wave lands.
  - `jobUsesAddon` (agent-plugin-backends.ts:952, oe3 code) doesn't treat `alerts.email` as plugin-free, so a pending email job blocks every plugin uninstall. Folded into r3-server.
  - workers.ts:78 reports every email failure as `sender_not_bound`, including malformed input.
  - `0006_alerts.sql` column `utc_day` now stores the owner's local day. The migration is uncommitted, so rename it `local_day`.
  - A notice queued before a sender exists is never emailed later: enqueue dedupes on the old failed row.
- **r2-oe3, Opus re-check: small fixes** (0 BLOCKER, 2 MAJOR, 8 MINOR/RULE, 1 OVERENG; net −621 lines confirmed; fences intact; federation deferral OK). Full section: `codex-runs/2026-10-27-r3-oe3fix/opus-recheck.md`. All of it is assigned to Codex job r3-oe3fix, along with the chart-list item moved out of r3-server.
  - MAJOR: replacing an installed skill or bundled agent plugin turns it off and then fails.
  - MAJOR: `reconcileAgentPluginUpdates` is never called, so a crash mid-update leaves the plugin stuck.
- **Over-engineering report (Codex a-overeng, 10-27): about 1,200 deletable lines.** Full report: `codex-runs/2026-10-27-a-overeng/report.md`. Not yet fixed. Check each fix against what r3-oe3fix and r3-server land.
  1. The retired plugin inspection stack in features/plugins: about 1,100 lines (628 source + 437 tests/fixtures), exported and tested with no production callers.
  2. om-tools vs owner.ts duplicate read models, about 50 lines. Same as r3-oe3fix item 3.
  3. The TikTok invented-factory test duplicates the real-factory test, about 20 lines. r3-server extends that test for settings, so reconcile after it lands.
  4. Two catalog page walkers (agent-plugin-backends.ts:102, addon-tools.ts:132), about 10 lines.
  5. contracts capabilities.test.ts mostly tests its own fixture, about 20 lines.
- **Complexity report (Codex a-complexity, 10-27): 39 GATE failures that will fail om:check.** Full report: `codex-runs/2026-10-27-a-complexity/report.md`. Covers apps, features (except measure) and contracts; plugins not yet analysed.
  - 4 cognitive >10: agent-plugin-backends.ts:670 `guardedFetch` (12), composition/index.ts:351 `definitions` (11), studio integrations.hooks.ts:264 and :275 (11 each).
  - 3 control-depth 4: the two integrations.hooks.ts functions, and studio shell.test.ts:250.
  - 32 `two-object-arguments` signature failures, mostly in studio and server tests.
  - No new eslint-disable directives were added. features/web-events/src/snippet.ts embeds JS in a template string that lint can't see.
  - The report also lists 30 cyclomatic/NLOC hot spots (report-only) and proposes 12 lane-separated fix jobs (A–L). Its advice: start with the gate fixes and the duplication cuts only.
- **Test-gap analysis (a-testgap): stopped by the owner on 10-27 to save Codex credits, no report.** Rerun it later; the prompt is in `codex-runs/2026-10-27-a-testgap/report-prompt.md`.
- **OWNER DECISIONS 2026-10-27:**
  - LINE CSV uses the `csv-parse` library (7.0.3, added to the root manifest and lockfile by the Coordinator with a frozen install). Slow reports: poll inside a 25s budget, else return a retryable `unavailable`.
  - Microsoft canonical metrics follow the Google solution (developer token added server-side, gated to microsoft-ads). The owner deferred the specifics to the Coordinator.
  - Owner alert emails go through Resend.
  - Jobs launched: r3-line, r3-microsoft, r3-alert-resend, r3-reddit-budget, r3-messaging-wiring.
- **More owner decisions 2026-10-27:**
  - Studio `track` now takes `({ name }, { properties })`, mirroring Jini tracker `capture` (0.6.13 shape, unpublished).
  - Alert email recipient comes from env `OM_OWNER_EMAIL` for now; an owner-profile email field comes later.
  - Resend stays not admitted until the cloud tests pass and the bundles are rebuilt.
  - Microsoft ZIP reports use the `fflate` 0.8.3 library (root install, frozen).
  - Microsoft's server half is its own job, r3-microsoft-server.
  - Deferred from messaging wiring: send composition (no broadcast binding or consent authority yet) and WhatsApp webhooks (no inbound plugin webhook route).
  - Deferred from alert-resend: alert sources aren't wired at boot; backfill for notices created before a sender existed.
- **Vendor-neutral audit (Codex a-vendor-neutral, 10-27): 18 findings of hard-coded vendors and providers in core.** Report: `codex-runs/2026-10-27-a-vendor-neutral/report.md`.
  - Worst three: the agent-plugin-backends dispatcher; Google-specific credentials and developer token (contracts, credentials, integrations, backend); the closed model-provider catalogue (contracts AssistantProvider enum, models.ts, model-usage.ts prices).
  - Also: OAuth host code with Meta/Facebook specifics, the LinkedIn-pinned conversion delivery, deployment and stop allow-lists, studio integrations UI unions, sharp in the server, the om-playbook site-guide path, the boundaries.mjs SDK deny-list, the Meta sandbox seed, and core tests importing plugin source.
  - The audit proposes 27 jobs. An Opus design review is cutting that into the binding design `ADS-memory/reports/2026-10-27-vendor-neutral-design.md` (Phases A/B/C).
- **Binding vendor-neutral design written:** `ADS-memory/reports/2026-10-27-vendor-neutral-design.md`.
  - Phase A is 11 jobs, A0 to A7; the credit-short minimum is A0, A1, A2a, A3 and A4.
  - A3 (the dispatcher) is the riskiest.
  - r3-microsoft-server is superseded by A1 + A3 + A2a; r3-alert-resend becomes A5.
  - Handed to peer open-marketing-38 to drive, along with the Jini/Tovu study (`codex-runs/2026-10-27-a-jini-patterns`) and the tovu-45 pointers.
- **NEW, not previously listed: the prebuilt plugin dists (tiktok, linkedin, google, meta; built Oct 14) export no `createCapabilities`.** In production those plugins provide no canonical capabilities until rebuilt. Rebuild every ad plugin dist after round 3 lands; that is a build, not a test. Also rebuild the feature package dists before the cloud test: `@open-marketing/plugins` dist (10-13) still has the old functions that imports load, so the server would fail at import.
- **Round 3 (Codex, 10-27):** r3-plugins-c, r3-plugins-d, r3-messaging-measure and r3-server (fix jobs: plan, Claude trim, build), plus read-only a-overeng and a-complexity reports. Dirs: `codex-runs/2026-10-27-*`. Shared context: `codex-runs/ctx-fix3-1027.md`.

## 0. Before anything else when resuming
1. Read `codex-runs/2026-10-26-r2-oe3/B1.md` and `2026-10-26-r2-server-minors/B1.md`.
2. Typecheck server, contracts, plugins, federation and web-events.
3. Opus re-check of those two jobs (brief: `recheck2-brief.md` pattern; scratchpad briefs are session-local, so recreate them from this file's structure).

## 1. MAJOR (fix before merge)
1. **Google canonical reads can't work against the real server.**
   - The plugin requires `customerId` in the credential (google-ads read-capabilities.ts:15-18,44-46).
   - The canonical `credentials.access` path returns only `{accessToken, expiresAt?}`; it lacks the developer-token + login-customer enrichment the legacy `googleTransport` path adds (agent-plugin-backends.ts:821-830).
   - Fix: drop the plugin requirement, and the integrator adds the enrichment to the canonical path.
2. **GBP declares report.metrics.v1 but always returns unavailable** (no timezone source; no account/location identity in the credential). Its real-factory test asserts the failure. Remove the row; `createCapabilities` returns `{}`.
3. **Reddit campaign daily metrics read one 100-row page.** Follow `next_url` up to 5,000 rows.
4. **LINE daily metrics not built.** Status works for TW/TH. Owner decisions needed first:
   - (a) add `csv-parse` via a frozen-lockfile importer edit, OR allow a small bounded CSV reader in the plugin;
   - (b) how async report generation fits the server's 30s deadline (partial on a time budget, or resume by report ID).

   LINE's spec states no cost unit and no report timezone, so ship impressions/clicks with spend null until confirmed. Never guess money.
5. **Messaging credential shape (latent until wiring).** Twilio and WhatsApp expect a decoded credential object; the host returns `{accessToken: '<card JSON>'}` for app-credentials (features/credentials/src/jini-oauth-common.ts:50).
   - Twilio would always fail with `unauthenticated`.
   - WhatsApp would send the whole JSON (including appSecret) as its Bearer token to Meta.
   - Fix: `JSON.parse(accessToken)` + the card schema, as the ad plugins do (amazon-ads transport.ts:96); fixtures return the host shape.
6. **`settings` carries host-owned fields** (agent-plugin-backends.ts:207-208): it passes the whole plugin.json OM extension (`admitted`, `enabled`, `capabilities`, `credentialCards`, `servers`). Strip host-owned keys; keep only plugin-owned install options. (Coordinator edit.)

## 2. MINOR / smaller items
- **Server/contracts (Coordinator edits):**
  - The reserved-ID skip and missing-factory fallback have no real regression test (agent-plugin-backends.test.ts:969, 994-1007 pass with the old behaviour too).
  - The chart-plugin list is hand-copied in addons.ts and package-desktop.mjs.
  - ECharts/Chart.js sources sit outside the workspace/lockfile, so the build isn't reproducible from the repo (built in an isolated npm dir with exact pins, zod 3.25.76).
- **Time budgets under the server's 30s deadline:** Reddit (10-27: pagination now follows next_url, so up to 51 sequential reads, still no budget), and X, Kakao and Naver make up to 100 sequential reads with no partial-result budget (X sets its own 60s timeout, x-ads transport.ts:371). Only Microsoft has a 25s budget. Kakao also fetches the credential once per campaign.
- **Yandex deployment** still treats the credential as a plain token (campaign-deployment.ts:27, 158-175), so it sends the JSON bundle as the Bearer token and gets a 401. ~5 lines. Also, the server's generic deployment configuration (agent-plugin-backends.ts:843) omits `clientLogin` and passes `admitted` as a boolean.
- **LinkedIn** fails outright on large reports instead of chunking.
- **TikTok:**
  - the 100 page size caps a call at ~1,500 rows;
  - one report filter is unverified;
  - the status enum isn't fully confirmed (unknown codes fail safe).
- **Google:** a pretty-printed response over 1 MiB hard-fails instead of splitting the window.
- **Reddit:** account-level rows may lack `account_id` (Airbyte fills it in).
- **Snapchat:** a 31-day window across the fall-back DST change is 745 hours.
- **Legacy adapters** (amazon, pinterest, reddit, snapchat) still check `admitted` on non-canonical paths.
- **Dead code/text:** dead `admitted` fields in VK, Naver and X; stale X manifest text; a stale Meta doc comment.
- **WhatsApp:**
  - the preference parser requires `wa_id` (webhooks.ts:27); Meta omits it for username users, and one such event rejects the whole signed batch (including STOP texts). Accept `user_id` or skip the item;
  - localized opt-outs: only Spanish was added (Meta publishes no list);
  - a leftover card-shape test, `whatsapp-business/.../tests/manifests.test.ts:6,22-31`, imports server source; delete it.
- **Measure:**
  - the dispatcher compares the ledger's merged diagnostics to its own pre-merge copy, so an overlapping reconcile returns `conflict` and skips the audit row. Return the ledger's merge instead;
  - `ingestLeadOutcome`'s input type is still hand-written. Codex's fix patch is saved at `codex-runs/2026-10-26-r2-messaging-measure/type-contract.patch` (not applied);
  - HANDOFF.md:234,263,272 are stale (`validateDiagnostics`).
- **Messaging plugins are not wired into the server** and not yet on `pluginConfigurationSchema` + credential identity. All messaging fixes stay latent until a wiring job.
- **om-playbook:** the hub skill doesn't list the six skills.
- **Carried from the earlier reports, still open:**
  - alerts owner email actually sending (needs a server mail path);
  - Microsoft canonical metrics (developer token doesn't fit the ABI);
  - X disapproval reasons;
  - vendor tool switches still hard-coded in agent-plugin-backends (staged migration);
  - `AssistantUsage.costUsd` is a float (contracts, integer-micros rule);
  - P0-2c complexity leftovers (forms.ts:81, agent-plugin-jobs.test.ts:473, store-suite.ts:112, 4 scalar signatures, missing dispatch/withdrawal race test);
  - Jini 0.6.15 swaps: enqueueInlineJob → enqueueWithReceipt; bounded readers; outbox availableAt column in OM's SQLite adapter.

## 3. Owner's larger to-dos (named 2026-10-26, not started)
- **Full tests for everything** (cloud only, Claude cloud env "Open Marketing"), then fixes.
- **Coverage analysis.**
- **Over-engineering analysis** (fresh pass over all the new code).
- **Cognitive AND cyclomatic complexity analysis** (COMMON.md gates cognitive ≤10 / nesting ≤3; cyclomatic reported).
- **Observability:** metrics, logs, traces via Jini's `deps.tracker` facade (`capture`/`error`/`span` → being renamed `trace`), with PostHog/Sentry/OTel as provider plugins. Waits for the Jini release; spec at Tovu `ADS-memory/.local-artifacts/handoffs/2026-10-26-tracker-facade/`.
- **Then:** commit each job's files (explicit paths, kakao-ads tests by hunk), push om/cleanup-1025, one cloud test run, fixes, merge into om/clean-slate.

Detailed per-job ledgers for round 2 follow (C = Google/Meta/GBP/Amazon/Pinterest/Reddit/Snapchat; D = Microsoft/X/Yandex/Kakao/VK/LinkedIn/TikTok/LINE/Naver; M = messaging + measure; S = studio/content + Coordinator edits).

## C2 — Ad plugins C, round 2

Paths are relative to `content/agent-plugins/`. `E` = `io.github.ainsep.openmarketing`. Checked against the working tree (read-only), not against the B1 reports. Fingerprints recomputed with shasum: all declared `schemaFingerprint`s match the current sources (google `9cf917a…`, meta `995d9ab…`, GBP `026ea00…`, reddit `0b123c3…`/`9417cb7…`, snapchat `3080ce7…`, pinterest `5e4b750…`). Coordinator typecheck: all 7 packages exit 0.

Cross-cutting server fact used below: the canonical capability path's `credentials.access` (`apps/server/src/composition/agent-plugin-backends.ts:691-699`) returns `integrations.access`, which ends in `readCredentialAccess` (`features/credentials/src/jini-oauth-common.ts:47-53`). That returns only `{accessToken, expiresAt?, scopes?}`. No customer ID, login customer ID, developer token, or GBP account/location name ever reaches a plugin. The legacy Google path enriches the credential (`agent-plugin-backends.ts:821-830`: developer token plus `loginCustomerId` from metadata), but the canonical path does not.

### r2-plugins-c1: small fixes
Ledger:
- Align google/meta/GBP to `pluginConfigurationSchema`, with no `{binding}` or `admitted` in configuration: **FIXED** for the parse.
  - google `read-capabilities.ts:34`, meta `read-capabilities.ts:31`, GBP `plugin.ts:36` all parse the contract schema and ignore `settings`.
- Account currency/timezone from the vendor:
  - **FIXED** for Google: a `customer` metadata search (`read-capabilities.ts:121-129`) and a per-row currency/timezone match (`metrics.ts:93-96`).
  - **FIXED** for Meta: `act_` metadata gives `currency`/`timezone_name` (`read-capabilities.ts:136-144`).
  - **NOT FIXED** for GBP (see New #2).
- Identity from the credential: **PARTIAL.**
  - The plugins read identity from the credential as the decision says.
  - The server never supplies those fields, so Google and GBP canonical calls cannot succeed (New #1).
- Meta `complete: true` once the effective_status filter is sent: **FIXED.**
  - `metrics.ts:79` is `complete: true`.
  - The filter is sent for every child level (`:41`). The enums match Graph's campaign/adset/ad `effective_status` sets (`:28-33`).
  - Pages fail closed above 5,000 rows (`read-capabilities.ts:123`). 25 insight pages plus the account read fit the 27-request cap.
  - Stale doc comment, see New MINOR.
- Meta object-status evidence: **FIXED (honest).** `evidence/primary-sources.json:322-331` cites the page and says it was review-confirmed, not independently retrieved.
- Google date chunking with a 5,000-row stop and honest truncation: **FIXED.** Code at `read-capabilities.ts:110-159`:
  - The date range is cut into 30-day windows, each a `LIMIT 1001` search.
  - A saturated multi-day window is discarded and split in half, so the parent is never counted.
  - A single-day saturation keeps 1,000 rows with `complete:false`.
  - Rows stop at 5,000, and the request budget is 32 including the metadata read.
  - Coverage is complete only when every window was complete, every row fit, and no window is left pending.
  - Each window rejects out-of-window rows (`:166`).
  - Tests use real `windowRows` fixtures (`tests/read-capabilities.test.ts:253-279`): 12×90 days complete in 4 calls; saturated split gives 1,200 rows with no parent rows; 50 days gives exactly 5,000 complete and 51 days gives 5,000 incomplete with `dataThrough:0`; the budget is exhausted at 32 calls.
- Google `readStatus` cognitive complexity: **FIXED.** The row checks moved into `statusRow` (`:200-207`). `readStatus` (`:184-198`) now counts about 9.
- Delete the orphaned untracked Google `bindings/*.json`: **FIXED.** Only the tracked `conversions/reporting/search/stop.v1.json` remain, as the job asked.
- GBP `main.ts` type errors: **FIXED.** It uses published `@jini-ai/mcp` types, with an `inputSchema` cast at `main.ts:21,27`. Root `package.json:24` has `@jini-ai/mcp`, and typecheck exits 0.
- GBP `runCli` dropped from the server entry: **FIXED** (`src/index.ts` has no `main.ts` export).
- GBP tests moved to the new configuration: **FIXED** (`tests/fixtures.ts:37`).
- GBP reserved `organic.publish.v1` row: **DEFERRED-OK.**
  - It stays declared, and the manifest test asserts it (`tests/boundaries.test.ts:29`).
  - The server skips reserved IDs. `createCapabilities` has no handler for it (`plugin.ts:25-27`).
- One real-factory test per plugin:
  - **FIXED** for google (`tests/read-capabilities.test.ts:208-225`) and meta (`tests/read-capabilities.test.ts:288-303`). Both use `pluginConfigurationSchema.parse({...settings})` and a fixture fetch, and check `metricBatchSchema` output.
  - **WRONG FIX** for GBP. `tests/capabilities.test.ts:111-123` asserts the real factory always returns `unavailable` ("requires vendor timezone"). It never gets a valid catalog output.
  - The Google test only passes because its credential includes `customerId`, which no server credential carries (New #1).

New:
- [MAJOR] `google-ads/E/src/read-capabilities.ts:15-18,44-46`: Google canonical reads cannot work against the real server.
  - `credentialSchema` requires `customerId` in the credential.
  - The server's canonical `credentials.access` returns only `{accessToken, expiresAt?, scopes?}`. It never returns `developerToken` or `loginCustomerId` either, unlike the legacy `googleTransport` (`agent-plugin-backends.ts:821-830`).
  - Failure: every Google `report.metrics.v1`, `campaign.status.v1` and `tracking.tag.v1` call returns `invalid_input`. The test at `tests/read-capabilities.test.ts:281-288` locks this in: a server-shaped `{accessToken}` credential gives `invalid_input`. If the parse were relaxed, Google would reject every request for the missing `developer-token` header.
  - Fix, plugin: drop the `customerId` requirement. `accountId` already is the customer ID, so the credential copy is redundant. Keep only optional `loginCustomerId` and `developerToken`.
  - Fix, integrator (server lane): in the canonical `credentials()` for google-ads, add the same developer-token and `loginCustomerId` enrichment that `googleTransport` does. Otherwise, extend the shared credential result with an identity record.
  - The c1 B1 NEEDS names only the customer/manager IDs, not the developer token.
- [MAJOR] `google-business-profile/E/src/plugin.ts:25-27,49,100` and `capabilities.json` / `plugin.json` `report.metrics.v1`: the declared canonical row can never succeed.
  - `configuredReport` builds a binding with no `reportingContext`, so `reportMetrics` always returns `unavailable "Verified GBP timezone is required"`.
  - The handler also needs `accountName`/`locationName` in the credential (`schemas.ts:30`), which the server never supplies.
  - Failure: the server offers `vendor_google_business_profile_report_metrics_v1` as a read tool that always fails. This is the case the shared decision covers: "don't declare canonical capability rows a plugin can't serve: remove them, or implement the factory". c2 removed Amazon's rows for exactly this reason.
  - The vendor-timezone deferral is justified: the GBP Location and Performance schemas have no timezone field.
  - Fix: remove the `report.metrics.v1` row from `capabilities.json` and `plugin.json`, and have `createCapabilities` return `{}`, as Amazon does. Keep the native MCP reads and `mapPerformanceToReport`. Re-add the row when a timezone source exists, such as an owner-confirmed setting or a latlng lookup approved by the owner.
- [MINOR] `google-ads/E/src/read-capabilities.ts:143-151` with `transport.ts:62` (`maxBytes: 1048576`): a saturated window over 1 MiB is a hard failure, not a split.
  - Google REST pretty-prints JSON by default (`prettyPrint` system parameter). A dense 1,001-row ad-grain page carries resourceNames for customer, campaign, adGroup, adGroupAd and ad, plus indentation, so it can approach or pass 1 MiB.
  - The transport then returns `limit_exceeded` and the whole report fails instead of splitting that window.
  - The 1,001-row test (`tests/read-capabilities.test.ts:182`) uses compact `JSON.stringify`, so it cannot catch this.
  - Fix: add `?prettyPrint=false` to the search URL, and treat `limit_exceeded` on a window longer than one day like a saturated window (split it).
- [MINOR] `meta-ads/E/src/metrics.ts:66`: the doc comment still says "Only account-grain completeness is verified; child inclusion awaits primary semantic evidence". The code now returns `complete:true` for every grain. Fix the comment.

Disputes/deferrals:
- c1 NEEDS "carry Google customer/manager and GBP identity through credential results": a **valid integrator NEED**, but incomplete. It must also cover the Google developer token (New #1).
- c1 "GBP timezone not exposed by Location or Performance": **DEFERRED-OK** as a deferral. That makes the row undeclarable (New #2), not a reason to keep a dead row.
- "Google cancellation-helper extraction after typecheck": the Coordinator's typecheck after round 2 shows google-ads exit 0. **Resolved.**

### r2-plugins-c2: small fixes
Ledger:
- Align amazon, pinterest, reddit and snapchat to `pluginConfigurationSchema`: **FIXED.**
  - pinterest `transport.ts:321`, reddit `transport.ts:276`, snapchat `transport.ts:322`: `pluginConfigurationSchema.extend({accountId: vendorId})`, with settings ignored.
  - amazon has no canonical handlers and returns `{}` (`transport.ts:224`).
- Account facts from the vendor: **FIXED.**
  - reddit: `GET /ad_accounts/{id}` gives `currency` (`transport.ts:212-221`); reports use a fixed UTC `time_zone_id`.
  - snapchat: `GET /adaccounts/{id}` gives `currency` and `timezone` (`transport.ts:263-276`).
  - pinterest: vendor `currency`; UTC as accepted last round (`transport.ts:308`).
  - A foreign account fails before stats are read.
- Identity from the credential: **FIXED** (n/a). These are `api-key` cards whose `{accessToken}` matches the strict credential schemas.
- Reddit daily metrics: **FIXED**, checked against the Airbyte manifest (fetched 2026-10-26).
  - `encodeDailyReport` (`reporting.ts:40-47`) sends `breakdowns ["AD_ACCOUNT_ID"|"CAMPAIGN_ID","DATE"]` with `starts_at`/`ends_at` at `T00:00:00Z` and UTC.
  - Rows come from `data.metrics[]` (`metrics-status.ts:30`; `decodeDailyPage` reads `page.data.data`).
  - `date` is cut with `.slice(0,10)` and then checked as an ISO date (`:27`).
  - The exclusive-end overfetch is validated and then dropped (`:52,66`). This matches Airbyte's `ends_at = end+1d` plus its `date <= slice end` filter.
- Reddit exact micros: **FIXED.**
  - `parseExactIntegerJson` with `numericTextKeys:["spend","impressions","clicks"]` (`transport.ts:113`).
  - Spend is an integer-string regex with no float path (`metrics-status.ts:24`). It is labelled "Account-currency micros".
  - Reddit's indexed v3 schema, cited in the evidence, says spend is microcurrency int64.
  - Tests cover `9007199254740993`, `-1`, `1.5`, `1e2` and 39-digit values (`tests/metrics-status.test.ts:115-121`).
- Reddit evidence citation: **FIXED.** `evidence/primary-sources.json:59-64` cites the official get-a-report schema as indexed by search, plus the Airbyte manifest. The live ads-api.reddit.com page is still unfetchable; I confirmed this.
- Snapchat 31-day window: **FIXED (enforce).** `transport.ts:240` returns `limit_exceeded` above 31 days, before any egress. There are 31-day and 32-day tests (`tests/metrics-status.test.ts:160+`). See MINOR on DST.
- Snapchat `projectEntity` complexity: **FIXED.** `validateEntity` was extracted (`metrics-status.ts:107-113`), and `projectEntity` now counts about 7.
- Amazon not_implemented rows removed: **FIXED.**
  - `report.metrics.v1` and `campaign.status.v1` are gone from `capabilities.json` and `plugin.json`, and `src/metrics-status.ts` is deleted.
  - `createCapabilities = () => ({})`.
  - A manifest test asserts the rows are absent (`tests/metrics-status.test.ts:14-19`).
  - The server card test now excludes amazon and includes GBP (`apps/server/tests/integration-credential-cards.test.ts:148-151`).
- One real-factory test per plugin: **FIXED.**
  - reddit `tests/metrics-status.test.ts:80-93`, snapchat `:149-159`, pinterest `:130-139`. Each calls the plugin's own `createCapabilities` with `pluginConfigurationSchema.parse({..., settings:{version, enabled, capabilities, currency}})`, uses a fixture fetch, checks `metricBatchSchema`, and asserts that the vendor currency wins over the settings `currency`.
  - amazon `:7-13`: the factory returns `{}` with no I/O.

New:
- [MAJOR] `reddit-ads/E/src/transport.ts:204` (`page.size=100`) with `metrics-status.ts:30` (`.max(100)`) and `decodeDailyPage` `:224-230`, which reads one page only: campaign-grain daily reports are almost never complete.
  - 31 days × 4 campaigns = 124 rows, which already exceeds one page. Any account with more than 3 campaigns gets `complete:false` for a 31-day window. This repeats the Google 1,000-row problem the round just fixed.
  - Also, if Reddit ignores `page.size` on the reports POST (Airbyte sets no page size), a default page over 100 rows fails the whole report with `protocol_mismatch` (the `.max(100)` check).
  - Fix: follow the already-validated `next_url` (`nextPage` checks the fixed origin and path) up to 5,000 rows or about 50 requests, and mark the result incomplete only when that budget is exhausted. Alternatively, raise `page.size` to Reddit's documented maximum once verified.
- [MINOR] `reddit-ads/E/src/metrics-status.ts:77`: an account-grain row must carry `account_id === accountId`. The test `[{...dailyMetric, account_id: null}]` → reject (`tests/metrics-status.test.ts:120`) locks this in.
  - Airbyte's `ad_account_report` overwrites `account_id` from config with `AddFields`, which suggests the API row may omit it or leave it null. The evidence calls `account_id` nullable.
  - Failure: if Reddit returns `account_id: null` for `AD_ACCOUNT_ID` rows, every account-grain report fails with `protocol_mismatch`.
  - Fix: accept a null/absent `account_id` on this account-scoped endpoint (reject only a mismatching value), as campaign grain already does.
- [MINOR] `snapchat-ads/E/src/transport.ts:240`: the 31-day check counts calendar days.
  - A 31-local-day window across a fall-back DST change, such as America/Los_Angeles on 2026-11-01, is 745 hours long between the local midnights sent as `start_time`/`end_time`.
  - Failure: if Snap measures 31 days as elapsed time, an exactly-31-day window across fall-back gets a vendor 4xx instead of a local `limit_exceeded`.
  - Fix: compare `Date.parse(end) - Date.parse(start)` of the resolved midnights (`reportPlan`) with `31*86400000`, or cap at 30 days when the window crosses DST.
- [MINOR] Legacy adapters still have plugin-local `admitted` checks, against the shared decision:
  - amazon `transport.ts:28`;
  - pinterest `transport.ts:41,110,147`;
  - reddit/snapchat `ports.ts` `admitted` callbacks.
  - None is on the canonical capability path, and the server passes `admitted: true` (`agent-plugin-backends.ts:836-843`), so this is dead duplication rather than a live gate.
  - Fix: remove them in the next legacy cleanup. This is not blocking.

Disputes/deferrals:
- "Reddit reads one page and marks remaining pages incomplete" (B1 RISKS): **DEFERRED-NOT-OK.** The `next_url` is already validated, so following it is a few lines. See the MAJOR above.
- Amazon OAuth/refresh and canonical prerequisites: **DEFERRED-OK** (recorded as NEEDS; card withdrawn).
- Jini 0.6.15 items: **DEFERRED-OK.**
- "Behavioural/function assessment INCONCLUSIVE pending tests": accepted. Nothing was run, per the rules.

Sources: [Airbyte source-reddit-ads manifest.yaml](https://raw.githubusercontent.com/airbytehq/airbyte/master/airbyte-integrations/connectors/source-reddit-ads/manifest.yaml) (fetched 2026-10-26: `data.metrics` selector, `date[:10]`, `ends_at = end+1d`, `account_id` set from config, `GMT` time zone, no page size); [Reddit get-a-report](https://ads-api.reddit.com/docs/v3/api/get-a-report) (not fetchable 2026-10-26); [Meta object status](https://developers.facebook.com/docs/marketing-api/best-practices/manage-your-ad-object-status).
## D2 — Ad plugins D + LINE/Naver, round 2

Paths are relative to `content/agent-plugins/<plugin>/io.github.ainsep.openmarketing/` unless they say otherwise. Everything below was verified in code, read-only.

**Global checks that pass:**
- Fingerprints: I recomputed every capabilities.json fingerprint with shasum against its stated basis (single file or concatenation) in all 9 plugins, and all of them match.
- Manifests: plugin.json capabilities equal capabilities.json capabilities in all 9.
- Typecheck: per the Coordinator, all 9 exit 0.
- Real-factory tests: every plugin that has a factory has one test that calls its own `createCapabilities` with `pluginConfigurationSchema.parse({scope, connectionId, accountId, pluginDigest, settings})`. Most of these tests seed `settings` with decoy currency, clientLogin or timezone values to prove they are ignored:
  - X: tests/fixtures.ts:158
  - Yandex: tests/capabilities.test.ts:20
  - Kakao: tests/capabilities.test.ts:16
  - LinkedIn: tests/capabilities.test.ts:23 and tests/manifests.test.ts:76
  - TikTok: tests/capabilities.test.ts:33 and tests/manifests.test.ts:67
  - LINE: tests/fixtures.ts:133
  - Naver: tests/capabilities.test.ts:191
- No `admitted` or authority check sits on any canonical capability path. The remaining `admitted` uses are in deployment and conversion backends, which are out of scope, plus the dead fields listed below.

### r2-plugins-d1: small fixes

**Ledger:**
- X `createCapabilities` factory: FIXED.
  - `src/transport.ts:261-284` parses `pluginConfigurationSchema`, maps fetch, credentials, clock, observer and wait, and passes the gateway through.
  - Its `timeoutSignal` is built from `wait` plus an AbortController, and every wait is cancelled in `finally` (:281).
  - The nonce is sha256(correlationId, clock.now, per-factory counter), at :270.
  - TF1 OAuth signing is intact: `git diff HEAD` shows no change to `authorization()` (:119-127) and no change to signer, getNonce or getTimeStamp. The only diff near signing is the DAY-granularity reader at :218.
- X dead `accountTimezone` in MetricsCall: FIXED (:253).
- X windows over 7 days return not_implemented: DEFERRED-OK. This is documented in the docstring (:285-287), in evidence `primary-sources.json:146` and in the README.
- Microsoft canonical rows: FIXED.
  - `report.metrics.v1` and `campaign.status.v1` are gone from capabilities.json and plugin.json. `src/index.ts` exports no factory.
  - `tests/manifests.test.ts:17` asserts that both rows are absent, and its file map still matches the hashes.
- Microsoft deadline gives a truthful partial result: FIXED.
  - `capabilityRpc` (`src/transport.ts:223-238`) runs a 25s soft budget from the start (:197). When the budget is spent it returns `limit_exceeded`, and `runCampaignStatus` (`src/reporting.ts:252`) breaks while keeping completed observations.
  - Regression test: `tests/capabilities.test.ts:81` (160 groups).
  - Caller cancellation and credential expiry still fail (:99).
- Microsoft campaign with more than 1000 ad groups: FIXED. `campaignReview` returns null, so that campaign stays unknown and the loop continues (`reporting.ts:291`). Regression test: `tests/capabilities.test.ts:92`.
- Microsoft canonical factory: DEFERRED-OK. The developer token still has no ABI path (`transport.ts:134`, `connectionId:"developer-token.microsoft-ads"`).
- Yandex `clientLogin` from the credential, currency from the vendor:
  - Reads: FIXED.
    - `src/transport.ts:12-25` parses the `{accessToken, clientLogin}` app-credentials bundle.
    - `src/capabilities.ts:63-82` calls `clients.get` and checks ClientId and Login against the binding and the credential. Currency comes from that response.
    - Timezone is fixed at Europe/Moscow, which is how Yandex reports work.
    - The test's settings decoy is ignored.
  - Deployment: NOT FIXED. See New below.
- Kakao configuration alignment and status-only: FIXED.
  - `src/capabilities.ts:11-41` uses `pluginConfigurationSchema.extend`, and the returned `adAccountId` must equal the binding (:58).
  - The `report.metrics.v1` row is removed. Only `campaign.status.v1` is declared, and its fingerprint matches.
- VK empty factory and canonical rows: FIXED. Both are removed, and `tests/manifests.test.ts:41-48` asserts there is no `createCapabilities`.
- VK plugin-local `admitted` checks: FIXED in the transport (removed from `prepare` and `preflight`). One dead field remains (see New).
- Plugin-local `admitted` in X, Yandex and Kakao capability paths: FIXED. No check remains. X keeps a shim value (see New).
- Copied capability-call scaffolding: DEFERRED-OK. It cannot be deduplicated across plugins without the shared contracts helper the job was told not to invent; this is an integrator item.

**New:**
- [MINOR] Yandex deployment is broken by the new credential bundle (`src/campaign-deployment.ts:27`, `:158-167`, `:173-175`; deferred by B1 as "out of scope", but the file is in lane).
  - Deployment still parses `accessToken` as a plain token.
  - The regex `^[\x21-\x7e]+$` accepts the JSON bundle text, so the plugin sends `Authorization: Bearer {"accessToken":"…","clientLogin":"…"}`.
  - It also takes `clientLogin` from configuration (:24).
  - Failure: every deployment made with a card-saved credential gets 401 from Yandex.
  - Mitigating context: the server's generic deployment configuration (`apps/server/src/composition/agent-plugin-backends.ts:843`) also omits `clientLogin`/`v501` and passes `admitted` as a boolean where Yandex calls `admitted()`. So the Yandex deployment is not server-invocable either way. That integration gap predates round 2.
  - Fix (about 5 lines): reuse `checkCredential` from transport.ts and take `clientLogin` from the bundle.
- [MINOR] VK dead field (`src/ports.ts:34-38`).
  - `VkDependencies.admitted: boolean` is still required, and the doc still says "the adapter additionally rechecks its live admitted getter". Nothing reads it now.
  - Failure: every composer must supply a field that has no effect.
  - Fix: delete the field and the sentence. Deployment has its own input shape.
- [MINOR] X legacy shim (`src/transport.ts:268`).
  - The factory builds `configuration: {…, bindingId: connectionId, admitted: true}` to satisfy the legacy `configurationSchema` (:12).
  - This is the same forwarding-shim pattern the re-review flagged for LINE, and it puts an `admitted` field on the canonical path, even though nothing reads it there.
  - Fix: give the capability reader a narrow configuration type, or make `admitted`/`bindingId` optional in a read-only schema.
- [MINOR] X nonce (`src/transport.ts:270`).
  - The nonce is deterministic per (correlationId, ms, counter), and the counter restarts at 0 in each factory. The server builds a new factory for every call (`agent-plugin-backends.ts:210`).
  - Failure: two concurrent canonical calls in one agent turn share a correlationId. If both sign their first request in the same millisecond, they produce identical nonce and timestamp, and X rejects the second request as a replay (401 → `unauthenticated`). This is rare but non-zero.
  - Fix: mix in `randomBytes(16)` from node:crypto, which is already imported.
- [MINOR] X stale manifest text (`capabilities.json:18`). `fingerprintBasis` still says "canonical factory integration awaits the host dependencies", which is now false. Refresh the text.
- [MINOR] Cross-cutting, same for d2: no soft time budget below the server's 30s deadline (`agent-plugin-backends.ts:186`).
  - X allows up to 100 sequential reads under its own 60s timeout (`transport.ts:371`). Kakao makes up to 100 sequential GETs, each with a fresh `credentials.access` (`capabilities.ts:47-53`, `:66`). Naver allows up to 100 signed reads (`transport.ts:242-245`).
  - Failure: when the server deadline fires, the whole call returns `expired` and completed observations are thrown away. Microsoft is the only one that solved this (25s budget), and it is not invocable.
  - Fix: copy Microsoft's soft budget (stop issuing reads at about 25s and return partial, complete:false). For Kakao, also resolve the credential once per call.

**Disputes/deferrals:**
- Microsoft developer-token factory: OK.
- X currency for an account with no campaigns returns not_implemented: OK, low impact. Such an account has no spend, and `GET accounts/:id/funding_instruments` carries currency if this is wanted later.
- Yandex draft-deployment parser: NOT OK (MINOR above). It is in lane and about 5 lines.
- No DISPUTED items were filed.

### r2-plugins-d2: needs another run (LINE daily metrics, after a Coordinator decision on the CSV dependency)

**Ledger:**
- TikTok `report.metrics.v1` at campaign, ad group and ad grain: FIXED.
  - `src/capabilities.ts:138-148` sets `data_level` AUCTION_CAMPAIGN, ADGROUP or AD, with dimensions `[id, stat_time_day]`. Child grains request parent `campaign_id`/`adgroup_id` as attribute metrics.
  - `src/reporting.ts:132-142` requires that lineage and never synthesizes it.
  - Spend is exact (`decimalToMicros` with reject). Days use account-IANA boundaries.
  - Tests: :203, :215, :219.
- TikTok full status mapping: FIXED.
  - `capabilities.ts:167-185`: DELETE→ended, ADVERTISER_AUDIT_DENY→disapproved, ADVERTISER_AUDIT→pending, DISABLE and BUDGET_EXCEED→paused, ENABLE→active. DISABLE combined with ENABLE evidence becomes unknown.
  - Unmapped codes (for example ADVERTISER_CONTRACT_PENDING and ADVERTISER_ACCOUNT_PUNISH) stay unknown, which fails safe.
  - The filter is `primary_status: STATUS_ALL`, so deleted campaigns are included.
  - I could not confirm the full enum from a primary source by web search either. The evidence (`primary-sources.json:494`, `:530`) honestly records the gap.
- TikTok freshness: FIXED. `freshness` is `fresh` only when the covered local midnight is at or before `retrievedAt`, and `dataThrough` is capped at retrieval (`capabilities.ts:110`).
- TikTok ambient `AbortSignal.timeout` on the canonical path: FIXED. `requestTikTokRead` uses only the caller signal (`transport.ts:130-138`). The one remaining `AbortSignal.timeout` (:44) is on the legacy egress path.
- LinkedIn alignment and freshness: FIXED.
  - `src/capabilities.ts:11` uses `pluginConfigurationSchema.extend`, and currency comes from `GET /adAccounts/{id}` with an ID check (:98-105).
  - Freshness is `fresh` only when the window ends by today's UTC midnight (:121).
- LinkedIn `max(5000)` plus the 1 MiB cap: DEFERRED-NOT-OK, MINOR (see New).
- LINE status for TW/TH: FIXED.
  - `src/transport.ts:225-248` accepts country JP, TW and TH.
  - Country, currency and timezone come from authenticated group-account discovery (`groups/{groupId}/adaccounts`). groupId comes from the credential bundle.
  - Status calls are filtered by IDs with `includeRemoved`.
- LINE legacy shim (`admitted: true`, `createDeadline`): FIXED. `readStatus` calls `capabilityRead` → `requestLineRead` directly (:217-223).
- LINE plugin-local 15s timer: FIXED. The canonical path has no local timer; only the 500ms `wait` pacing remains (:244, :253).
- LINE `report.metrics.v1` row: FIXED. It is removed, and the fingerprints match.
- LINE daily metrics via `pfreports`: NOT FIXED (DEFERRED-NOT-OK, MAJOR, owner said "FINISH it"). No handler, no `pfreports` call and no CSV handling exist. The factory (:187-189) exposes status only.
  - **Was money guessed?** No. Nothing monetary ships.
  - **How spend units and timezone were "resolved":** they were not. B1 and evidence (`primary-sources.json`, round2B1 "deferred") cite three reasons:
    1. `csv-parse@6.1.0` is not installed.
    2. Report-day timezone is undocumented.
    3. Cost scale is undocumented.
  - My own WebFetch of the 3.12.3 reporting spec confirms the gaps:
    - Report `Cost` is described only as "The number of costs". Only entity budget fields say "in micros".
    - No report-date timezone is stated. Entity timestamps say "in adaccount timezone".
    - Download is CSV in UTF-8 or UTF-16LE with a BOM.
  - So withholding spend is correct. But the job explicitly allowed the fallback of impressions and clicks with spend null plus a documented reason, and that was not built.
  - The CSV dependency is a legitimate integrator prerequisite (lockfile, frozen install). The timezone gap is not a blocker: label days in the account timezone, citing the "adaccount timezone" convention, and keep finality provisional.
- Naver 92-day chunking: FIXED.
  - `src/transport.ts:345-358` splits each entity's half-open window into chunks of at most 92 inclusive KST days (`start + 92d`, clamped to the end).
  - Rows are validated per chunk (:362-367, test :214).
  - The shared 100-read budget keeps prior rows and marks the result incomplete (test :218).
  - Tests: 92/93/366 days at :200.
- Naver `credentialCustomerId` from the credential: FIXED.
  - `credentialSchema` holds `{apiKey, secretKey, customerId}` (:13).
  - `/ad-accounts` uses `credential.customerId`, and other calls use the bound target (:251).
  - Currency comes from `/ad-accounts` where `masterCustomerId === accountId`, and it must be KRW (:328-341). Timezone is fixed at Asia/Seoul.
- Naver plugin-local 15s timer: FIXED. "The host owns the deadline" (:226-237). The residual whole-call discard is covered by the cross-cutting MINOR in d1.
- Plugin-local `admitted` in all four: FIXED on the canonical paths.

**New:**
- [MAJOR] LINE daily metrics are missing (`line-ads/.../src/transport.ts:183-189`). See the ledger above.
  - Failure: LINE serves no `report.metrics.v1` in TW/TH, contrary to the owner's "finish LINE".
  - Fix, Coordinator first: add `csv-parse` (frozen-lockfile importer edit) or approve a bounded in-plugin reader that handles quoting and BOM. Then run one build that does create `pfreports` → poll → download, with impressions and clicks only, spend null and a reason in the mapping, days in the account timezone.
  - Design note: `pfreports` is asynchronous, and generation can exceed the server's 30s capability deadline. The handler needs a soft budget that returns an incomplete batch, or a resume-by-report-ID pattern. Decide which before the run.
- [MINOR] TikTok row ceiling (`tiktok-ads/.../src/commands.ts:9`, `:152`; `src/capabilities.ts:139`; `src/reporting.ts:106`). Daily reports use `page_size` 100 under a 16-read budget, so one call returns at most about 1,500 rows, against the contract's 5,000.
  - Failure: 20 campaigns × 90 days (1,800 rows) always comes back complete:false. The result is honest but needlessly partial.
  - Fix: use the report endpoint's larger `page_size` (TikTok's report page_size goes to 1000, per my reading of the docs; confirm on the doc page) and relax the decoder's `=== 100` check.
- [MINOR] TikTok report filter is unverified (`src/capabilities.ts:147`). The `filtering` `[{field_name:"campaign_status", filter_type:"IN", filter_value:'["STATUS_ALL"]'}]` is applied at every `data_level`, including AUCTION_ADVERTISER. Evidence (:494) says the attribute and filter tables could not be read.
  - Failure: if TikTok rejects that filter at a level, every report call returns code≠0 → protocol_mismatch. This would only show up at live acceptance.
  - Fix: record it as a live-acceptance item, or drop the filter for account grain.
- [MINOR] LinkedIn oversize reports fail outright (`linkedin-ads/.../src/capabilities.ts:27`, `:86`; `src/transport.ts:258`). There is one unchunked `adAnalytics` request with `max(5000)` elements and a 1 MiB body cap.
  - Failure: a campaign-grain year for about 14 or more campaigns (5,000+ rows, or about 1.2 MB at around 250 B per row) returns `protocol_mismatch`/`limit_exceeded` instead of partial data. B1's "deferred per plan" gives no vendor-doc reason.
  - Fix: chunk the date range (as Naver now does) and return complete:false when the budget runs out.
- [MINOR] Naver dead legacy field (`naver-ads/.../src/transport.ts:10`). The legacy `configurationSchema` still requires `credentialCustomerId` and `admitted: z.boolean()` from configuration. Nothing checks `admitted`, and the canonical path doesn't use this schema.
  - Failure: the legacy adapter still demands identity and admission from configuration, contrary to the contract.
  - Fix: drop `admitted`, and take `credentialCustomerId` from the credential as the canonical path does.

**Disputes/deferrals:**
- LINE metrics: DEFERRED-NOT-OK.
  - The CSV prerequisite is a real integrator item.
  - The units gap is real (confirmed above), and it justifies only spend=null, not skipping the handler.
  - The timezone gap does not block (use the adaccount-timezone convention, provisional).
- TikTok status-enum completeness: DEFERRED-OK. Unknown codes stay unknown, which fails safe.
- LinkedIn large-response recovery: DEFERRED-NOT-OK (MINOR above).
- No DISPUTED items were filed.
## M2 — Messaging and measure, round 2

### r2-messaging-measure: verdict small fixes

Plugin paths are relative to `content/agent-plugins/`. `E` = `io.github.ainsep.openmarketing`. Everything was checked in the working tree. The Meta `user_preferences` reference (developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences) was fetched on 2026-10-26.

Ledger:
- **WhatsApp `user_preferences` marketing opt-out: FIXED, with one gap (see New).**
  - `whatsapp-business/E/src/webhooks.ts:25-28,68-73,87-93` projects `field:"user_preferences"` items with `category:"marketing_messages"` and `value:"stop"`. Each becomes a `stop` event keyed by the raw `wa_id`, with no fabricated recipient or message ID.
  - The replay ID is a hash of scope, WABA, phone number ID, wa_id and timestamp. Preferences count toward the 100-event bound. `metadata.phone_number_id` is checked against the binding. `resume` is ignored, so it never restores consent.
  - The shape matches Meta's reference: `value.metadata`, `value.user_preferences[]` with `wa_id`, `category`, `value` and an integer `timestamp`.
  - Tests are real: `tests/webhooks.test.ts:92-154` cover replay, identity binding, an unmapped wa_id, foreign assets and the bound.
- **Localized opt-out button payloads: PARTIAL, DEFERRED-OK.**
  - Only `DETENERPROMOCIONES` was added (`webhooks.ts:99`).
  - Meta publishes no authoritative list of localized label translations. The opt-out quick-reply text is set by the business, and only third-party sites list examples ("Se désabonner", etc.), so a complete list cannot be verified.
  - The deferral is acceptable, and the `user_preferences` path now catches withdrawals made in WhatsApp's own UI.
  - A durable fix belongs to the template author: when OM creates marketing templates, set the opt-out button payload to a fixed OM token and match that.
- **Twilio MMS STOP (`MM…`): FIXED.** `twilio-sms/E/src/webhooks.ts:17` accepts `^(SM|MM)[0-9a-fA-F]{32}$`. `tests/webhooks.test.ts:81-93` has a signed MMS STOP that includes media fields, plus negative cases for malformed IDs.
- **Resend reserved headers: FIXED.** `resend-email/E/src/mail.ts:69` uses SES's regex verbatim, after lowercasing. It runs before `authority` and before any HTTP call (`:103`). `tests/mail.test.ts:222` covers 14 headers in mixed case.
- **Leftover card-shape tests in Resend/SES: FIXED.**
  - `resend-email/E/tests/manifests.test.ts` and `amazon-ses/E/tests/manifests.test.ts` no longer assert card shapes. SES `:20-21` tests the credential schema, which is legitimate.
  - WhatsApp still has a card-shape test (see New MINOR).
- **Plugin-local `admitted` removed: FIXED.**
  - No `admitted` field or check remains in any src configuration schema: `twilio-sms/E/src/commands.ts:16`, `twilio transport.ts:28-41`, `whatsapp transport.ts:8,33-45`.
  - WhatsApp `ports.ts:7` now derives `WhatsAppConfiguration` from the Zod schema instead of a hand-copied interface. Good.
  - The remaining `admitted:false` entries are manifest/capability metadata, which is fine.
  - The fixture `state.admitted` models gateway denial, not a plugin check.
- **Server consent `authority` callback kept: FIXED.**
  - `twilio broadcast.ts:27,62`, `whatsapp broadcast.ts:28,59`, `resend mail.ts:106`.
  - Fingerprint refresh is correct. Twilio `commands.ts` sha256 is `ab5263…` and appears in both capabilities.json and plugin.json. Resend and WhatsApp are unchanged and still match.
- **Measure: `ingestConversion` refuses qualified/won: FIXED.**
  - `features/measure/src/service.ts:26` rejects before authentication or storage.
  - `ingestLeadOutcome` derives `leadId + ":" + definitionId` (`:34`), and the strict schema rejects a caller-supplied eventId (`delivery/input.ts:12-13`).
  - Tests: `tests/ingestion.test.ts:34` uses arbitrary IDs and sources and asserts zero inbox/outbox writes.
  - Nit: the literal `["qualified","won"]` at service.ts:26 duplicates the enum at input.ts:13. Use `leadOutcomeInputSchema.shape.event.shape.definitionId.options`.
- **Measure: a disagreeing vendor diagnostic no longer fails the ledger write: FIXED.**
  - `validateDeliveryTransition` (`delivery/ledger-rules.ts:8-15`) no longer checks diagnostics.
  - `mergeDeliveryDiagnostics` (`:20-31`) keeps a confirmed `true`, keeps prior values where the new one is null, and takes `max(observedAt)`.
  - It is applied in the memory ledger (`memory.ts` append), the SQL ledger (`sql-delivery.ts` append) and the dispatcher (`dispatcher.ts` perform).
  - Merging is idempotent when the dispatcher pre-merges and the ledger merges again (checked by hand). Tests: `tests/delivery.test.ts:33-41` and `tests/contract/port-suites.ts:321-376`.
  - See the New MINOR on the dispatcher's equality check.
- **Measure: ledger `read` kept: FIXED (correctly kept).** It is implemented in both adapters (`memory.ts`, `sql-delivery.ts` read) and is scoped.
- **Measure: HANDOFF.md stale lines: FIXED.** Lines 181 and 183 now state that the boundary rule is implemented. A leftover nit is under New.
- **Measure: `ingestLeadOutcome` type derived from Zod (re-review New MINOR/RULE): NOT FIXED, DEFERRED-OK.**
  - `types.ts:76` is still `{ source; leadId: string; event: Omit<ConversionInput,"eventId"> }`.
  - The reason is real: a type-only import of `delivery/input.ts` into `types.ts` would make reporting reach delivery, and the transitive boundary rule counts type-only edges.
  - The prepared patch (`/tmp/om-r2-type-contract.patch`) moves `conversionSchema`/`sourceSchema` into `types.ts` and re-exports them from `rules.ts`. That is correct and small; the Coordinator should apply it or authorize `rules.ts`.
  - The eventId-bearing `leadOutcomeConversionSchema` exports are gone (index.ts:12-13). FIXED.

New:
- **[MAJOR, latent; not changed this round] Credential shape mismatch: Twilio and WhatsApp expect a decoded object, but the host returns `{ accessToken: <JSON string> }`.**
  - **Where:**
    - `twilio-sms/E/src/transport.ts:8,51-54` and `twilio-sms/E/src/broadcast.ts:30,54-55`;
    - `whatsapp-business/E/src/transport.ts:12,96-99` and `whatsapp-business/E/src/broadcast.ts:20,55,80`.
  - **This round:** nothing changed this behavior. Neither plugin calls `JSON.parse` on the credential. The test fixtures (`twilio tests/fixtures.ts:26,49`, `whatsapp tests/fixtures.ts:29,69`) return pre-decoded objects, which hides the mismatch.
  - **What the host returns:** the only host credential path is `credentials(required).access`, which calls `integrations.access`, then `accessCurrent`, then `readCredentialAccess`:
    - `apps/server/src/composition/agent-plugin-backends.ts:692-698`;
    - `apps/server/src/integrations.ts:249`;
    - `features/credentials/src/jini-oauth-common.ts:47-50`.
  - An app-credentials plaintext is the exact JSON of the card fields (`apps/server/src/integration-credential-cards.ts:4`). It does not start with `om.oauth.`, so it comes back as `{ accessToken: '{"accountSid":"AC…","apiKeySid":"SK…","apiKeySecret":"…","authToken":"…"}' }`. The ad plugins handle this with `JSON.parse(accessToken)`, for example `amazon-ads/E/src/transport.ts:96` and `naver-ads campaign-deployment.ts:141`.
  - **Runtime today:** nothing executes.
    - No server code references `createTwilioSmsAdapter`, `createWhatsAppBusinessAdapter`, the `deliver*BroadcastRecipient` functions or the `ingest*Webhook` functions (rg across apps/ and features/ finds none).
    - `capabilityContributions` skips `sms.read.v1` and `whatsapp.read.v1`, which are not catalog IDs, and neither plugin exports `createCapabilities`.
    - `contributions()` returns `[]` for these plugin IDs (`agent-plugin-backends.ts:556-559`).
    - Both plugins are `enabled:false`. Net result: zero tools, and no credential access.
  - **Runtime once wired through that path:**
    - **Twilio:** the strict `credentialSchema` (transport.ts:8) sees the unknown key `accessToken` and a missing `accountSid`, so `safeParse` fails and every read returns `unauthenticated` with zero HTTP. The non-strict broadcast schema (broadcast.ts:30) also lacks `accountSid`, so every send returns `unauthenticated` before `authority`. The result is a deterministic 100% failure.
    - **WhatsApp:**
      - Only the app-credentials card is actionable; the oauth card has `actionSupported:false` because `credentialCardAction` allows OAuth only for google/linkedin/meta-ads.
      - The JSON blob contains no spaces or control characters, so it passes `secretValue = /^[\x21-\x7e]+$/` (transport.ts:9; broadcast.ts:20).
      - Each read therefore sends `Authorization: Bearer {"wabaId":…,"accessToken":"EAA…","appSecret":"…"}` to graph.facebook.com and gets a 401, which surfaces as `unauthenticated`.
      - Each send makes the same POST after `authority` has approved it, and gets a 4xx refusal.
      - Besides the failure, the webhook `appSecret` is transmitted to Meta in a bearer header on every call.
  - **Fix (in lane, rule-of-two with the ad plugins):**
    - Parse `z.strictObject({accessToken: z.string()})`, then `JSON.parse(accessToken)`, then the plugin's card schema, in both transport.ts and broadcast.ts of both plugins. Keep one shared credential schema per plugin so the read and send parsers stop disagreeing (WhatsApp: strict `max(4096)` vs non-strict `max(8192)`).
    - Make the fixtures return the host shape.
    - Alternatively, the Coordinator could decide that the broker decodes app-credentials JSON for every plugin. Then the ad plugins' `JSON.parse` must go, so pick one.
- **[MINOR] `whatsapp-business/E/src/webhooks.ts:27,90` requires `wa_id` on preference items.**
  - Meta's reference says `wa_id` is omitted when the user has enabled usernames (identity is then `user_id`/BSUID).
  - **Failure:** a username user stops marketing. `preferenceSchema.parse` throws, `ingestWhatsAppWebhook` returns `invalid_input` for the whole signed batch, and any other events in that POST (for example a text "STOP" that Meta does NOT enforce) are lost with it, while Meta retries and eventually drops the webhook.
  - `tests/webhooks.test.ts:134` codifies this rejection.
  - **Fix:** accept `wa_id` or `user_id`, carry whichever is present, and leave resolution to `apply`. At minimum, skip items without a usable identity instead of rejecting the batch.
  - The same pre-existing shape risk applies to `messages[].from` (`:22`, strict phone regex).
- **[MINOR] `features/measure/src/delivery/dispatcher.ts` (perform; the equality check on the appended evidence) compares the ledger's returned `diagnostics` with the dispatcher's own pre-merge using `JSON.stringify` equality.**
  - The pre-merge is based on the claim-time record (`claimed.value.record`). If another reconcile appended newer diagnostics in between, the ledger re-merges against that newer record and returns different values.
  - **Failure:** concurrent reconciles of one delivery. The append succeeds, but the dispatcher returns `conflict` ("Delivery outcome evidence mismatch") and skips the audit row. This is the "diagnostic disagreement fails the delivery" symptom on a narrower path. The serial pump arriving with Jini 0.6.15 mitigates it.
  - **Fix:** don't compare diagnostics. Return `evidence.value.diagnostics`, which is the ledger's authoritative merge.
- **[MINOR] `whatsapp-business/E/tests/manifests.test.ts:6,22-31` is still a card-shape copy, and it imports server source from a plugin.**
  - It does `import … from "../../../../../apps/server/src/integration-credential-cards.js"`. That breaks the rule that plugins import only contracts or bundled published dependencies, and it duplicates the server's `it.each` real-parser test (`apps/server/tests/integration-credential-cards.test.ts:148-151`).
  - The re-review missed this one; it is the same class as the Resend/SES deletions.
  - **Fix:** delete that `it`.
- **[MINOR/doc] `features/measure/HANDOFF.md:263,272` are stale.** They still describe "extended existing validateDeliveryTransition" and a `validateDiagnostics` function that "guards" confirmed stages. That function does not exist (rg finds none); the behavior is now `mergeDeliveryDiagnostics`. Line 234 says "original APIs … preserved", but the `leadOutcomeConversionSchema` exports were removed. Delete or correct these lines.
- **[INFO, out of lane, Coordinator NEEDS] The whole messaging lane is still unreachable from the server.**
  - The server has no composition for any of the 4 plugins' reads, sends or webhooks.
  - Their configurations still take connection identity from configuration (Twilio `accountSid`/`messagingServiceSid`/`phoneNumberSid`; WhatsApp `wabaId`/`phoneNumberId`) instead of `pluginConfigurationSchema` plus the credential.
  - plan.md section 6 excluded this explicitly. Every fix above stays latent until an integrator job wires these plugins (and fixes the credential MAJOR at the same time).

Disputes/deferrals:
- **Localized button vocabulary deferred: DEFERRED-OK.** Meta documents no translation list, and the `user_preferences` path now covers withdrawals made in WhatsApp's UI. The B1 claim that "Meta's preference reference returned 429" was true for that run, but the page is fetchable now. The implementation matches it anyway, apart from the wa_id-optional MINOR above.
- **Keep ledger `read`: AGREE.** It is consumed by `apps/server/tests/agent-plugin-jobs.test.ts`, and both adapters now implement it.
- **`ingestLeadOutcome` derived type (`rules.ts` out of scope): DEFERRED-OK.** The Coordinator should apply `/tmp/om-r2-type-contract.patch`; it is self-contained and keeps the reporting boundary intact.
- **Typecheck:** B1 reports all 5 packages at exit 0. Not re-run here, per the brief.
## S2 — Studio/content round 2 + Coordinator edits

### r2-studio-content: verdict ready to commit
Ledger:
- Meta Ads Guide limits (Facebook feed 50–150 / 27; Instagram feed 125 / 40 / ≤30 hashtags): FIXED. I re-fetched both pages without logging in on 2026-10-26:
  - https://www.facebook.com/business/ads-guide/update/image/facebook-feed says "Primary Text: 50-150 characters; Headline: 27 characters". It gives no description figure.
  - https://www.facebook.com/business/ads-guide/update/image/instagram-feed says "Primary Text: 125 characters; Headline: 40 characters; Maximum Number of Hashtags: 30".
  - SKILL.md table rows (`Rec:` primary/headline; description and maximums Unknown) and platform-limits.md:9-10,15 match these figures exactly and cite the guide URLs. The false "redirected to login" claim is gone: `rg redirect` finds nothing in om-playbook.
- ad-copy re-pin to 7868cb92: FIXED. ad-copy-variants/PROVENANCE.md:4-7 now uses `7868cb9251fad80a73d26e488a5ad5f6c4a9f335` for all three source URLs and the raw LICENSE URL, and the "pin alignment pending" line is deleted. `e85f3` appears nowhere in content/ or apps/. All six PROVENANCE files use the common revision.
- Remove `.slice(1)` / `it.todo`: FIXED. apps/server/tests/bundled-skill-content.test.ts:52-64 loops over all six skills, asserts that the set of blob revisions equals {7868cb92} with at least 2 links, and checks the ad-copy raw LICENSE URL. No todo remains.
- Move the test to apps/server/tests: FIXED. The apps/studio copy is gone. In the new file, `new URL('../../../content/agent-plugins/', import.meta.url)` resolves from apps/server/tests/ to the repo root. Server `test` is `vitest run tests`, so the suite picks it up.
New:
- [MINOR] content/agent-plugins/om-playbook/skills/om-playbook/SKILL.md (hub) — still lists none of the six marketing skills. This carries over from the re-review's w2-skills2 note ("2-line edit that can ride along"). It was not in this job.md, so it isn't the job's fault.
  - Failure: discovery from the hub skill misses the six skills. The per-skill frontmatter still works.
  - Fix: add a 6-line list to the hub skill.
Disputes/deferrals: none. The B1 "TYPECHECK failed in alerts-jobs.test.ts" is out of lane and belongs to another job. Studio typecheck passed.

### Coordinator edits (afternoon): verdict small fixes
Ledger:
- packages/contracts/src/capabilities/index.ts:75-79 `pluginConfigurationSchema` and contracts test: FIXED.
  - The schema is strict {scope, connectionId, accountId, pluginDigest, settings: record}. `PluginConfiguration` is derived with z.infer, `PluginCapabilityDependencies.configuration` is typed with it, and both are exported from src/index.ts:40-41.
  - The test (capabilities.test.ts, "parses exactly the plugin configuration the server sends") checks exact round-trip, rejects an extra `currency`, and rejects missing settings. The @ts-expect-error checks confirm there is no authority on the ABI.
- agent-plugin-backends.ts:141-145, reserved-ID skip and missing-factory fallback: FIXED in code.
  - Reserved rows (`input: null`) are filtered after envelope/package/duplicate validation.
  - When `createCapabilities` is absent the function returns [], so `contributions()`/`deploymentContribution()` tools still load (:539).
  - The regression tests are weak; see New.
- agent-plugin-backends.ts:207-212, `capabilityCall` configuration: FIXED (shape).
  - The server parses `{scope: context.scope, connectionId, accountId, pluginDigest: state.revision, settings: state.metadata}` with the contracts schema before calling the factory.
  - The real TikTok source factory test (agent-plugin-backends.test.ts:891-920) drives this end to end through the guarded invoker and checks the real vendor URL, params and Access-Token header. The settings content issue is under New.
- twilio-sms / whatsapp-business credentialSchema plus tests: FIXED at the plugin port.
  - Twilio transport.ts:8 adds optional `authToken`. WhatsApp transport.ts:12 adds optional `wabaId`, `phoneNumberId` and `appSecret`, matching the plugin.json card fields exactly.
  - Local `admitted` checks are removed from both, and configuration types are derived from the schema (whatsapp ports.ts).
  - New tests: twilio dispatch.test.ts:20-25 and whatsapp dispatch.test.ts:24-27. Host-denial tests now assert that the gateway was consulted.
  - The host credential shape still doesn't match; see New.
- resend-email/package.json `@jini-ai/platform: 0.6.12`: FIXED. src/mail.ts:4 and tests/fixtures.ts:1-2 import `@jini-ai/platform/mail`, and manifests.test.ts:14 asserts the pin. The root importer already carries @jini-ai/platform 0.6.12, so the out-of-workspace plugin resolves via root node_modules (present).
- integration-credential-cards.test.ts:148-151 list: FIXED. It covers all 21 carded plugins and excludes amazon-ads (0 cards, withdrawn). GBP is included (2 cards, saveTarget google-business-profile), and every listed plugin.json has ≥1 card with saveTarget = pluginId.
- apple-search-ads copied card test deletion: FIXED. "declares identity-bound credential fields" is gone from apple tests/manifests.test.ts (the file equals HEAD), and apple stays covered by the server it.each.
- agent-plugin-jobs.test.ts:222 `read`: FIXED. `read: input => ledger.read(input)`, and createMemoryConversionDeliveryState implements `read` (features/measure/src/memory.ts:177).
- Root package.json + pnpm-lock.yaml: FIXED.
  - Root importer `@jini-ai/mcp 0.6.12`: the specifier matches, and its snapshot key exists at lock:5284. node_modules/@jini-ai/mcp is present.
  - apps/server importer `@open-marketing/plugins: link:../../features/plugins`: matches apps/server/package.json:47, and features/plugins has its own importer (lock:603).
  - features/brand and features/leads importers match their package.json deps/devDeps exactly. Every apps/*, packages/* and features/* package has an importer.
- GBP index.ts `runCli` removal: FIXED. index.ts re-exports only plugin.ts/schemas.ts/transport types, so the library entry no longer pulls in `@jini-ai/mcp`. bin/mcp-server.mjs and tests import runCli from main.ts directly.
- Chart plugins, package.json zod pin: FIXED. Both pin `zod: 3.25.76` (Jini ui's zod-3 peer), `echarts 6.1.0` / `chart.js 4.6.1` exact.
- Chart 0.1.0 artifacts: FIXED.
  - I recomputed sha256 for client/provider.js, client/styles.css, server/index.mjs and NOTICE in both packages, and all eight match `jini.plugin.json.integrity`.
  - NOTICE lists every bundled package with its license text:
    - echarts: @jini-ai/ui, echarts 6.1.0 (including the ASF NOTICE), tslib 2.3.0 0BSD, zod 3.25.76, zrender 6.1.0 BSD-3;
    - chartjs: @jini-ai/ui, @kurkle/color 0.3.4, chart.js 4.6.1, zod.
  - The server entry is import-free, and the provider bundles export `mount`.
- addons.ts:39,169,188-200 `bundledChartPlugins` seeding: FIXED. All three are seeded disabled through the ordinary installer, existing rows win, and a missing source dir is skipped via the ENOENT guard (:464-469). The boot HTTP test (chart-assets.test.ts:288+) now installs all three from the real projectRoot.
- development/scripts/package-desktop.mjs:102-106,140: FIXED. All three charts' integrity-listed files are required, and each 0.1.0 dir is staged.
- chart-assets.test.ts:234-242 new it.each: FIXED. It snapshots each package through `snapshotSitePluginPackage`, checks the extension id, exact file set and `verifyPluginSnapshotIntegrity`, and confirms the server entry has no imports.

New:
- [MINOR] apps/server/src/composition/agent-plugin-backends.ts:207-208 — `settings: required.state.metadata` passes the whole plugin.json OM extension.
  - For every plugin listed, that means `admitted`, `enabled`, `capabilities`, `version` and `credentialAssets`. Most also send `credentialCards`, and google-ads/GBP/higgsfield send `servers`.
  - This goes against the binding shared decision "No admitted/authority/admission fields in configuration". `settings.admitted` is the manifest's static `false`, not the computed admission (addons.ts:159).
  - The extension is also where the server reads `currency`/`timezone`/`loginCustomerId` (:798, :820, :828), so a plugin can get account facts through `settings`. The decision requires them from the vendor API/credential.
  - Failure: no plugin reads settings today, so nothing breaks yet. A plugin that refines `settings.admitted` refuses forever, and a plugin that reads `settings.currency` bypasses the vendor-API rule without anyone noticing.
  - Fix: build settings as the extension minus host-owned keys (admitted, enabled, capabilities, credentialCards, credentialAssets, servers, provides, version), or as an explicit `settings` sub-object. Add one assertion to the TikTok real-factory test that `configuration.settings` lacks `admitted`.
- [MINOR] apps/server/tests/agent-plugin-backends.test.ts:969 and :994-1007 — neither the reserved-ID skip nor the missing-factory fallback has a regression test.
  - :969 declares only `brand.extract.v1` and asserts that invoking `campaign.status.v1` fails. :997 `{ module: {} }` asserts that invocation fails. Both pass with the old throw-and-drop-whole-plugin code too.
  - Failure: someone re-introduces the throw and GBP (`organic.publish.v1`, capabilities.json:17) or a factory-less plugin disappears again, with tests green.
  - Fix: the 2 cases should declare [reserved row, valid campaign.status row] and expect invocation ok, and for `{module:{...otherTools}}` expect `definitions()` to still list the plugin's non-capability tools.
- [MINOR] content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts:53 and whatsapp-business/.../src/transport.ts:98 — both parse `credential.value` as the decoded card object (accountSid/apiKeySid/…). The host's `accessCredential` doesn't return that shape.
  - For app-credentials it returns `{ accessToken: <JSON plaintext> }` (features/credentials/src/jini-oauth-common.ts:50; integration-credential-cards.ts:4 "exact JSON of declared public/password"). Every ad plugin JSON-parses `accessToken` (yandex-direct transport.ts:22, line-ads transport.ts:101).
  - No host bridge for messaging exists yet (no twilio/whatsapp reference in apps/server/src), and the new tests use mocks that return the object form.
  - Failure: once wired, Twilio always gets `unauthenticated`. WhatsApp's token card passes the JSON blob as `accessToken`: `JSON.stringify` output has no spaces, so the `[\x21-\x7e]+` regex accepts it, and it is sent as the Bearer token, so Meta returns 401.
  - Fix: pick one convention, decoding in the plugin like the ad plugins or in the messaging host adapter, and add one test using the host's real `{accessToken: JSON}` shape.
  - Also: WhatsApp doesn't compare credential `wabaId`/`phoneNumberId` with configuration, unlike Twilio's accountSid check at :55.
- [MINOR] content/plugins/charts-{echarts,chartjs} — they are not workspace members and have no lockfile importers.
  - The re-review asked for both. The artifacts were built from an install that is not recorded in the repo, and transitive bundled versions (tslib 2.3.0, zrender 6.1.0, @kurkle/color 0.3.4) are pinned nowhere.
  - Their provider tests and typecheck cannot run from the repo.
  - Failure: a rebuild can silently produce different bytes or licenses. build-artifact.mjs:46-47 checks only direct pins.
  - Fix: add both as workspace members with importers (frozen offline install), or record the build lock beside the source like Recharts does in Jini.
- [MINOR] addons.ts:39 and package-desktop.mjs:102 — the chart list is hand-copied in two places. Rule of two: a third chart needs both edits, and missing the desktop one means the desktop build lacks it. Fix: derive it from `content/plugins/*/0.1.0/jini.plugin.json`, or export one list.
- Note (not a defect): `@open-marketing/plugins` in apps/server has no importer in src yet. It was pre-provisioned for r2-oe3, which has not produced a B1. Recheck after oe3.

Disputes/deferrals: none filed by the Coordinator.
- Chart workspace/lockfile provisioning was effectively deferred: the artifacts were built outside the repo. I rule this acceptable for now, since the bytes and integrity are verified, but the build is not reproducible from the repo (MINOR above).
