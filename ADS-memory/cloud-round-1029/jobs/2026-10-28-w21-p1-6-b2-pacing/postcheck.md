### 2026-10-28-w21-p1-6-b2-pacing: verdict READY TO COMMIT (2 optional MINOR fixes)

Checked by Opus post-check (2026-10-29). The four new alert files are untracked, so `git diff HEAD` cannot show what this build changed. I rebuilt the pre-build state from the outputs of `cat`/`sed` commands recorded in B1-run.jsonl (cmd07, cmd10, cmd11, cmd25) and compared it with the current tree. I ran no tests, typecheck or lint.

Ledger (APPROVED SCOPE + COORDINATOR OVERRIDE):
1. Wait for w18 B1 and read the built code: FIXED. The run read the w18 postcheck.md plus the built alerts.ts and p1-alerts.test.ts (cmd07/cmd25). B1's approvals, seed, list and acknowledge are kept unchanged at alerts.ts:28-50. The only change: `sources` now forwards `options` to `confirmations.list`, which does no harm.
2. `readBoundedPages` extraction: FIXED. addon-tools.ts:137-163 matches the pre-build `readAddonCatalog` exactly: abort check → `cancelled`, a repeated cursor → `break` → `limit_exceeded`, 10×100 pages. `kind` is still forwarded. `readAddonCatalog` is a one-line delegate.
3. `withDeadline` extraction: FIXED. reporting.ts:37-45 is moved verbatim from the old `sync`: one controller, injected `schedule({delayMs:25000})`, `AbortSignal.any`, `finally cancel()`. `sync` (reporting.ts:78-94) keeps weekly-report seeding exactly as it was.
4. rules.ts: FIXED.
   - `accountLocalDay` (rules.ts:89-96) uses the same Intl code. Catch → null makes `localDayMatches` (rules.ts:99-101) return false, as it did before.
   - `PACING_MAX_AGE_MS = 30 min`, commented as two intervals (rules.ts:103-104). jobs.ts is not imported.
   - `todayCampaignSpend` (rules.ts:109-116) checks fresh status and `now-30m <= retrievedAt <= now`. A missing row or non-string spend → null.
   - `dailyPacingEvidence` (rules.ts:123-134) builds the exact FIX 9 object and runs `safeParse`, so the 30-digit cap applies to both budget and spend. Month and lifetime are null.
   - Both functions are exported from alerts/index.ts:2.
5. B2 evidence collection in alerts.ts: FIXED.
   - Join (FIX 7): connected-only `listCredentialConnections` (`status:'connected'`), a connectionId→pluginId map, then the paged bindings join (alerts.ts:69-80). No secrets are read.
   - Refresh (FIX 8): `syncId` = sha256 of `[pluginId, connectionId, accountId, start, end, slot]`. Enqueue only; a failure is observed and the status read still happens (alerts.ts:85-97).
   - Status call (FIX 6) and per-account limit / unrequested-ID / host-missing gaps (alerts.ts:103-127).
   - Window (FIX 3): `[UTC yesterday, UTC tomorrow)`, half-open per measure metrics.ts:95-98. The vendor is never asked for a date after the current UTC date (alerts.ts:153-154).
   - One `withDeadline` covers the whole collection. Abort → `cancelled` gap and `break`; a late account is discarded because alerts.ts:158 runs before append (alerts.ts:33-38, 156-163).
   - Every listing, readDays, enqueue and capability call receives the signal. Nothing is cached and no vendor name or ID appears.
6. index.ts wiring: FIXED. index.ts:336 captures `catalogScope`. index.ts:381-382 adds only plain properties: no `?.`, `??`, `&&`, `||`, ternary or `if`, so bootServer gains no increments. The bindAlerts call was already after `reporting`/`pluginBackends` (index.ts:365, 370) and before `createFormWorkers` (index.ts:384). om-tools.ts was not touched (CUT 1 respected).
7. alerts.test.ts B2 cases: FIXED. alerts.test.ts:152-196 covers:
   - a daily budget producing a `today` notice at more than 2×
   - incomplete coverage → no notice
   - 30-digit accepted; 31-digit budget or spend → null
   - stale, 31 min old, retrieved in the future, no row, null or absent spend, and future `observedAt` → null
   - the Los Angeles 03:00Z case picks 2026-10-27
   - lifetime or absent budget → null
8. p1-alerts.test.ts B2 cases: FIXED. p1-alerts.test.ts:246-322 covers:
   - join and call with exact `invokeCapability`, `enqueue` and `readDays` arguments, and the same `syncId` on replay
   - disapproval and pacing end to end through `evaluateAlerts` and the feed
   - isolation for `unavailable` and `protocol_mismatch`: account B and the approval are kept and exactly one gap event is recorded
   - deadline: abort mid-loop, partial evidence, third account never called, `cancel` called once
   These tests can fail; none is a no-op.
9. Progress kept and one typecheck run: FIXED. progress.md was updated after each step; there was a single typecheck invocation (cmd39).
- OVERRIDE 1 (UTC+ gap, refresh cost, Microsoft stale batches): respected. The window never goes past UTC today; refresh runs once per account per slot; the freshness gate excludes stale batches.
- OVERRIDE 2 (build after w18 B1 and its post-check): respected (cmd07).
- DEFERRED-OK: month/lifetime pacing, more than 100 campaigns per evaluation, and the account-local window from plugins, exactly as review.md DEFERRED lists.

Outside lane: none. The run's file_change events and python writers touched only the 8 LOCKS-FILES paths plus progress.md. The `observedCampaignMembership` line at index.ts:371 was there before the build (cmd11) and belongs to another job.

New:
- [MINOR] alerts.ts:18: the `@example` still shows B1's 5-argument call. Since this build, the call needs `accountBindings`, `db`, `reporting`, `host`, `schedule` and `observer`. Failure: the documentation is wrong; a copy-paste call does not typecheck. Fix: see small fix 1.
- [MINOR] p1-alerts.test.ts:229-231: the foreign-owner `connection-foreign` row is inserted, but no binding references it. So the test does not show that a binding pointing at another scope's connection is skipped. Only the revoked case is really exercised. Failure: a regression that drops the owner/workspace predicate from the join would not be caught by this test. Fix: see small fix 2.
- [NOTE, no fix] alerts.ts:103-127: `accountEvidence` has sonarjs own-complexity exactly 10 (9 `if` + 1 `catch`; try adds no nesting, and the nested arrows count separately per S3776 rule.js:182-201). There is zero headroom. Any added branch must go into a helper.
- [NOTE, accepted risk already in progress.md] alerts.ts:34: `withDeadline` awaits the work rather than racing it. If a plugin host ignores the abort signal, `sources` (and therefore approval notices) waits until the host settles. This is the same pre-existing pattern as `reporting.sync` and needs no change in this lane.
- Checks: no secrets echoed, no capability or token caching, no vendor names in core (`fixture-ads` appears only in tests). No reduction was promised; net +406 was expected for new behaviour.

Duplicates:
- Deadline: published `@jini-ai/platform` 0.6.15-rc.2 has `createDeadlineSignal` (node_modules/.pnpm/@jini-ai+platform@0.6.15-rc.2_…/node_modules/@jini-ai/platform/dist/fetch-with-timeout.js:102-108). It is only a partial overlap: it uses native `AbortSignal.timeout`, has no injected scheduler and returns no cancel handle. That breaks the deterministic injected-timer tests (p1-alerts.test.ts:302-322, reporting deadline tests). `withDeadline` is pre-existing OM code moved verbatim (FIX 2), not new hand-rolled code. Not a duplicate.
- Paging: none found in published rc.2 index exports. `@jini-ai/cms` dist/core/keyset-cursor.d.ts:16-22 is only a cursor encode/decode codec, not a page walker.
- Local-day and micros helpers: none found (no `formatToParts` or micros helpers in the platform/core/db/integrations dists).
- Tovu: none found (searched `AbortSignal.any(` and cursor-cycle patterns, excluding node_modules).
- Unpublished source-only APIs were not considered.

Disputes/deferrals:
- DISPUTED "account enumeration already exists": upheld. features/workspaces/src/ports.ts:28-30 is reused through `catalogScope.accountBindings`.
- DEFERRED items: all OK (see ledger).
- UTC+ midnight gap: accepted by OVERRIDE 1. alerts.ts:153-154 fails closed.

Typecheck: B1.md and cmd39 report `corepack pnpm --filter @open-marketing/server typecheck` PASS (tsc src + tests), exit 0, on the first run. No failure to explain. The builder's in-process ESLint run (cmd36) reported zero diagnostics on all 8 files.

For the next job (w21-p1-5-results; touches reporting.ts and index.ts). No blocker; nothing needs fixing before it starts. Notes for it:
- `withDeadline` (reporting.ts:37-45) is now shared with alerts. Do not add a delay option or change its signature or return shape.
- P1-5's seam is the `leads.cohort` not_implemented stub at reporting.ts:62-69.
- `catalogScope` (index.ts:336) is now a local and can be reused. If P1-5 needs bindings, use `catalogScope.accountBindings` rather than adding another `services.accountBindings!`.
- bootServer is still at complexity exactly 10, so any new wiring must be plain properties.
- B2 now enqueues one campaign-grain `report.metrics.v1` sync per connected account every 15 minutes (alerts.ts:85-97). Results reads will see these fresher batches.

Small fixes (optional; neither blocks commit):
1. apps/server/src/composition/alerts.ts:18: replace the example with
   `* @example const alerts = bindAlerts({ unit, clock, ids, confirmations, approver, accountBindings, db, reporting, host, schedule, observer }); await alerts.seed({ context });`
2. apps/server/tests/p1-alerts.test.ts:213-214, in `evidenceFixture`: add one binding `{ id: 'binding-foreign', scope: context.scope, connectionId: 'connection-foreign', externalAccountId: 'account-foreign' }` to `bindings` without inserting a row for it. In the join test (p1-alerts.test.ts:247-273), have the paged mock return it and keep `expect(f.invokeCapability).toHaveBeenCalledTimes(1)`.
