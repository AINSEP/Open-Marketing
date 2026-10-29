# Trim review: 2026-10-28-w21-p1-6-b2-pacing
VERDICT: APPROVED WITH CUTS

**The build waits for the w18-p1-6-alerts B1 build and its post-check.** B1 is in stage `build`. Its files do not exist yet:
- `apps/server/src/composition/alerts.ts` (bindAlerts with `sources` returning `statuses: []` / `pacing: []`)
- `apps/server/tests/p1-alerts.test.ts`
- the `bindAlerts` / `seed` statements in `composition/index.ts`
- the `rejectedChildAds` change at `alerts/rules.ts:97`

Every B2 step that edits or extends those depends on B1's code. The build must first read the B1 result as built (and its post-check) and adapt to it. It must not assume names beyond B1 review FIXES 2/3. If B1 has not landed, the build stops with NEEDS.

The prerequisite w19-account-bindings is built and verified:
- `listAccountBindings` exists at features/workspaces/src/ports.ts:28-30.
- `WorkspaceRepository` includes it (store.ts:11).
- `bindCatalogScope` returns that repo as `accountBindings` (apps/server/src/composition/catalog.ts:49-50).

The plan's DISPUTED item is correct: account enumeration exists and must not be rebuilt.

Most important corrections:
- **Freshness bound (FIX 4).** The plan's 15-minute bound would reject every refresh. The refresh enqueued in slot N is read in slot N+1, about 15 minutes plus jitter later, so pacing could never fire.
- **Date window (FIX 3).** Use one 2-day UTC window that never requests a date after the current UTC date, instead of the plan's 31-day or future-date windows.

CUTS:
1. **Cut the `apps/server/src/om-tools.ts` edit** (widening `services.accountBindings`).
   - In `composition/index.ts`, capture `const catalogScope = bindCatalogScope({...})` at the existing `Object.assign(services, bindCatalogScope(...), {...})` (index.ts:331), then pass `catalogScope.accountBindings` to `bindAlerts`.
   - The inferred type already includes `listAccountBindings`. The w19 post-check explicitly allows this.
   - This removes B2's only reason to hold w13-om-tools, which w18-p1-4-leads is waiting on.
2. **Cut the lifetime-budget mapping and its tests.**
   - In B2, `evidence.lifetime` is always null (no attested lifetime spend), so `lifetimeRules` can never fire (rules.ts:77).
   - Lifetime evidence would be dead code. Lifetime budgets produce no pacing evidence; they still produce status/disapproval evidence.
   - DEFERRED together with month/lifetime pacing until attested history exists.
3. **Cut re-parsing the status response against `campaignStatusOutputSchema`.**
   - The host's shared execution path already validates catalog output before success (agent-plugin-backends.ts:73-76).
   - `evaluateAlerts` re-parses the whole evidence page (jobs.ts:66).
   - Keep only the unrequested-ID check (FIX 6).
4. **Cut "matching account dimensions/currency" checks from the projection.**
   - `readDays` already filters by plugin/connection/account/grain (sql-metrics.ts:70-78).
   - `comparable()` already enforces currency equality and `complete` (rules.ts:49-51).
   - The projection passes `batch.currency` and `batch.complete` through unchanged.
5. **Cut the dual refresh-window logic** ("stored timezone's local-day window; without stored metadata three UTC dates") and the 31-day lookback. Use one window (FIX 3).
6. **Cut aggregate overflow and listing/cancellation as whole-evaluation failures** (plan steps 11-12). Use FIX 5 instead.
   - B2 evidence problems must never stop B1's approval_waiting notices or the other accounts.
7. **Trim the test list** (plan step 13) to the cases in APPROVED SCOPE 6-7. Drop:
   - currency-mismatch cases (already covered by rules)
   - lifetime cases (CUT 2)
   - per-step paging fault matrices (readAddonCatalog behaviour is unchanged and already tested)

FIXES:
1. **Paging: keep the extraction (rule of two satisfied: catalog + bindings + connections).**
   - Add `readBoundedPages<T>({ readPage }, options?)` in `apps/server/src/addon-tools.ts`, moved from `readAddonCatalog` (addon-tools.ts:137-152) with identical semantics:
     - 10 pages × 100
     - aborted → `cancelled`
     - repeated cursor or overflow → `limit_exceeded`, never truncated
   - `readAddonCatalog` becomes a one-line caller. No new options.
2. **Deadline: keep the extraction (2 callers).**
   - Add `withDeadline<T>({ schedule, work }, options?)` in `composition/reporting.ts`, moved verbatim from reporting.ts:55-63:
     - one AbortController
     - injected `schedule({ delayMs: 25000 })`
     - `AbortSignal.any` with the caller's signal
     - `finally cancel()`
   - `bindReporting().sync` uses it with unchanged behaviour. No delay option.
   - Collision: w18-p3-weekly-report also edits `reporting.sync` (seeding after a successful sync). Both hold w14-alerts, so they are serialized, and the second builder adapts to the other's edit.
3. **One window for reading and refresh: `[UTC yesterday, UTC today + 1 day)`** (half-open, 2 days), computed from `clock.now`.
   - Account-local "today" for every timezone west of or at UTC falls inside it.
   - It never asks a vendor for a date after the current UTC date. There is a community report that Meta Insights rejects a future `until`, checked against UTC (unofficial, see the risk note). meta-ads/src/metrics.ts:42 passes the window straight through.
   - Known gap, fail-closed: for UTC+ accounts between local midnight and UTC midnight, the local day is not stored yet, so `today` is null and no pacing alert fires in those hours.
   - DEFERRED: account-local window via the plugin.
   - The same window is used for `readDays` (grain `campaign`) and for the refresh request.
4. **Freshness: the "today" partition qualifies only if all of these hold:**
   - `batch.freshness === 'fresh'`
   - `now - 30 min <= batch.retrievedAt <= now`
   - the age bound is a named constant in rules.ts commented "two evaluation intervals"; do not import jobs.ts, which would be a cycle
   - The 15-minute bound in plan step 9 is wrong. The refresh enqueued at slot N is synced seconds later and read at slot N+1, about 15 minutes plus jitter later, so a 15-minute bound rejects nearly every read.
5. **Gaps are per account and observed, never a `sources` failure.**
   - B2's evidence reader always returns `{ statuses, pacing }` (possibly empty). It records each gap once through the injected observer: payload-free, operation `server.alerts.evidence`, outcome = the error code, inside try/catch like jobs.ts:42-46.
   - Gap cases:
     - bindings/connections listing failure → empty evidence
     - per-account readDays, refresh enqueue or capability failure → skip that account
     - an account whose discovered IDs would push the total past 100 campaigns (or past 100 for that account) → skip with `limit_exceeded`; this keeps evaluation inside alertEvidenceSchema (rules.ts:31) and is not a silent slice
     - deadline/cancellation → stop the loop and return what was collected before the abort (it was validated before the abort, so late evidence is never accepted)
   - B1's approvals behaviour stays exactly as B1 built it.
6. **Status call per connected account** (the only capability used):
   ```ts
   host.invokeCapability({ context, pluginId: connection.pluginId, capabilityId: 'campaign.status.v1',
     connection: { connectionId, accountId: binding.externalAccountId },
     input: { vendorCampaignIds } }, { signal })
   ```
   - `vendorCampaignIds` are the unique, sorted campaign-entity IDs in the stored rows read for that account; skip the account if there are none.
   - `host` undefined → gap `unavailable`.
   - Any returned `vendorCampaignId` not in the request → drop that account's batch, gap `protocol_mismatch`.
   - Push `{ ...status.value, pluginId, accountId }` into `statuses`. Future `observedAt` is already rejected by rules.ts:96.
   - Nothing is cached across calls. No vendor names or IDs appear in core.
7. **Join (w19 OWNER DECISIONS 1).**
   - Page `listCredentialConnections({ context, db, query: { status: 'connected', limit: 100, cursor } })` (features/credentials/src/sql.ts:24). The existing `status` filter replaces manual skipping; precedent: alerts/provider-settings.ts:57-58.
   - Build a `connectionId → pluginId` map, page `listAccountBindings`, and skip bindings whose connection is not in the map.
   - Read no secrets. Dispatch still rechecks currency on the host path.
8. **Refresh.** One `reporting.enqueue` per joined account per evaluation:
   ```ts
   request = { syncId, pluginId, connectionId, accountId, input: { grain: 'campaign', days: window } }
   ```
   - `syncId` = sha256 hex of `[pluginId, connectionId, accountId, window.start, window.end, slot]`
   - `slot = Math.floor(clock.now({}) / ALERT_EVALUATION_INTERVAL_MS)`
   - Replay in the same slot hits the same outbox identity (reportingJob, reporting.ts:22-28).
   - It is enqueued only and never run inline. A failure is a per-account gap that does not block that account's status read.
   - w18-p3-weekly-report relies on these campaign syncs to seed itself.
9. **Pure projection in `alerts/rules.ts`:**
   ```ts
   dailyPacingEvidence({ campaign, observation, observedAt, partitions, now }): PacingEvidence | null
   ```
   It returns null unless all of these hold:
   - `observation.currentBudget?.kind === 'daily'` and `observedAt <= now`
   - a partition exists whose `day === accountLocalDay({ timezone: partition.batch.timezone, now })` and passes FIX 4
   - that partition has a campaign row for this `vendorCampaignId` with a string `metrics.spend` (null or undefined → null; a missing row is never zero)

   Otherwise it builds:
   ```ts
   { campaign, localDay, timezone: batch.timezone, budgetCurrent: true,
     budget: { kind: 'daily', currency, dailyMicros: amountMicros, elapsedMonthMicros: null },
     today: { micros: spend, currency: batch.currency, complete: batch.complete },
     month: null, lifetime: null }
   ```
   and returns `pacingEvidenceSchema.safeParse(...)`'s data, or null.
   - This enforces the 30-digit cap (rules.ts:12) on both budget and spend. A 31–38-digit value means unknown and omitted, never truncated, rounded or converted through `Number`.
   - Refactor `localDayMatches` (rules.ts:53-60) to use a new exported `accountLocalDay({ timezone, now }): string | null` (same Intl code, catch → null). Do not write a second date routine.
   - Export `dailyPacingEvidence` from alerts/index.ts.
   - Keep each function ≤10 complexity and ≤3 nesting; split the today-row selection into its own helper.
   - Status evidence for that campaign is kept regardless of the projection's result.
10. **`bindAlerts` additions** (B1's signature `{ unit, clock, ids, confirmations, approver }` plus):
    - `accountBindings: AccountBindingListPort` (from `@open-marketing/workspaces`)
    - `db: CredentialSqlPort` (pass `campaignDb`, the same session integrations uses, index.ts:301)
    - `reporting: Pick<ReturnType<typeof bindReporting>, 'repo' | 'enqueue'>`
    - `host: Pick<ReturnType<typeof bindAgentPluginBackends>, 'invokeCapability'> | undefined`
    - `schedule: HttpEffects['schedule']`
    - `observer: ObserverPort`

    `sources` wraps B2's evidence collection in `withDeadline`, so one 25 s budget covers the whole collection, not each account. Every readDays, enqueue, listing and capability call receives the signal.
11. **bootServer: zero increments.**
    - `const catalogScope = bindCatalogScope({...})` and `Object.assign(services, catalogScope, {...})` (CUT 1).
    - Add plain properties to B1's `bindAlerts({...})` call: `accountBindings: catalogScope.accountBindings, db: campaignDb, reporting, host: pluginBackends, schedule: required.io.schedule, observer: required.observer`.
    - No `?.`, `??`, `&&`, `||`, ternary or `if`.
    - If B1 placed `const alerts = bindAlerts(...)` before `reporting` / `pluginBackends` (index.ts:362-367), move that one statement after them, still before `createFormWorkers` (index.ts:378).
12. **Typecheck.** Run one `corepack pnpm --filter @open-marketing/server typecheck`, with at most one rerun. Run no tests, builds or `om:check`.

REUSE:
- page walk → addon-tools.ts:137-152 `readAddonCatalog` (extract, FIX 1)
- 25 s deadline → composition/reporting.ts:52-63 (extract, FIX 2)
- connections + plugin + status → features/credentials/src/sql.ts:24 `listCredentialConnections` (`status` filter); precedent alerts/provider-settings.ts:57
- bindings → features/workspaces/src/ports.ts:28-30 `listAccountBindings`, via catalog.ts:49-50 (no om-tools.ts edit)
- stored metrics → `reporting.repo.readDays` (features/measure/src/adapters/sql-metrics.ts:18-25); whole-day latest selection and the 5,000-row cap are already enforced
- refresh identity/outbox → reporting.ts:22-28 `reportingJob` and reporting.ts:47-51 `enqueue`
- status read → agent-plugin-backends.ts:71-77 `invokeCapability` (admission, read-only gate and output validation are already server-owned)
- local date → rules.ts:53-60 (refactor into `accountLocalDay`)
- 30-digit cap → rules.ts:12-21 `pacingEvidenceSchema`
- currency and complete gating → rules.ts:49-51 `comparable`
- slot → jobs.ts:11 `ALERT_EVALUATION_INTERVAL_MS`
- gap diagnostics → the observer pattern at jobs.ts:42-46
- tests → B1's p1-alerts.test.ts fixtures, and the `pacing()` fixture at alerts.test.ts:15

OWNER DECISIONS (defaults):
1. **UTC+ early-morning gap** (FIX 3). Default: accept a fail-closed gap with no pacing alert between local midnight and UTC midnight for UTC+ accounts, rather than request future UTC dates that some vendors reject.
   - Follow-up job: plugins clamp an account-local "today" window.
2. **Refresh cost.** Default: one campaign-grain report read per connected account every 15 minutes. These are reads, with no spend.
   - Plugins without `report.metrics.v1` get failed jobs, which are visible in jobs, not alerts.
   - Microsoft's plugin marks every batch `freshness: 'stale'` (microsoft-ads/src/reporting.ts:205), so Microsoft accounts get status alerts but no pacing alerts until that plugin attests freshness.

APPROVED SCOPE for B1:
1. Wait for w18-p1-6-alerts B1 plus its post-check. Read the built `composition/alerts.ts`, `index.ts`, `rules.ts` and `p1-alerts.test.ts`, and record in progress.md what B1 actually wrote. Preserve B1's approvals, seed, list, acknowledge and surfaces.
2. `addon-tools.ts`: extract `readBoundedPages`; `readAddonCatalog` delegates to it (FIX 1).
3. `composition/reporting.ts`: extract `withDeadline`; `sync` uses it (FIX 2).
4. `alerts/rules.ts`: `accountLocalDay` refactor, the pacing age constant and `dailyPacingEvidence` (FIX 4, 9); export from `alerts/index.ts`.
5. `composition/alerts.ts`: add the B2 evidence collection inside `sources` (FIX 3, 5-8, 10).
6. `composition/index.ts`: capture `catalogScope` and add the plain `bindAlerts` properties, with zero bootServer increments (FIX 11).
7. Tests in `apps/server/tests/alerts.test.ts`, written and not run:
   - a daily budget with a fresh, complete today row gives evidence, and `alertCandidates` emits a pacing notice when spend is more than 2× the budget
   - a 30-digit budget is accepted; a 31-digit budget or spend gives null (with no truncated value anywhere)
   - stale freshness, retrievedAt 31 minutes old, null spend, a missing row and future observedAt each give null
   - local midnight: now = 2026-10-28T03:00Z, timezone America/Los_Angeles, partitions for 2026-10-27 and 2026-10-28 → the 2026-10-27 partition is selected
   - a lifetime budget gives null
8. Tests in `apps/server/tests/p1-alerts.test.ts` (extend B1's file), written and not run:
   - **Join and call:** two bindings, one connected and one whose connection is revoked. Expect exactly one `invokeCapability` call with the exact `{ pluginId, capabilityId: 'campaign.status.v1', connection, input: { vendorCampaignIds } }` (IDs from stored rows), and one `enqueue` with the exact request. Running `sources` twice in the same slot gives the same `syncId`.
   - **Disapproval end to end:** a disapproved status → an ad_disapproved notice through `evaluateAlerts`.
   - **Isolation:** account A's capability fails or returns an unrequested ID → account B's statuses and B1's approvals are retained, and a gap is observed.
   - **Deadline:** firing the injected schedule callback mid-loop → partial evidence is returned, later accounts are not called, and `cancel()` is called once.
9. Keep `progress.md` after each item, then run one server typecheck (at most one rerun). Run no tests.

DEFERRED: month-to-date and lifetime pacing (needs attested history); evidence beyond 100 campaigns per evaluation (needs evaluator paging); an account-local refresh window via plugins (OWNER DECISION 1).

NEEDS: none (no package.json, lockfile, contracts, migrations or plugin dists). Server already depends on workspaces, credentials and measure.

Unverified vendor fact (risk, fail-closed): the claim that Meta rejects a future `until` comes from an unofficial community report ("time_ranges.end cannot be in the future", validated against UTC). FIX 3 avoids future UTC dates either way. Source: https://community.openai.com/t/ads-insights-api-time-ranges-validation-not-in-account-timezone/1390361

Locks: B2 no longer edits om-tools.ts.
- Set locks.txt to `w14-alerts w13-server-composition` (in lock-order-rule order); drop w13-om-tools.
- No active job's LOCKS-FILES lists addon-tools.ts.
- w18-p3-weekly-report shares w14-alerts and reporting.ts, so the two are serialized.

LOCKS-FILES: apps/server/src/addon-tools.ts, apps/server/src/composition/reporting.ts, apps/server/src/composition/alerts.ts, apps/server/src/composition/index.ts, apps/server/src/alerts/rules.ts, apps/server/src/alerts/index.ts, apps/server/tests/alerts.test.ts, apps/server/tests/p1-alerts.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-28-w21-p1-6-b2-pacing/progress.md

## COORDINATOR OVERRIDE (open-marketing-74)
1. Defaults accepted: UTC+ accounts get no pacing alerts between local midnight and UTC midnight (fail closed; plugin local-day clamp = follow-up); one campaign report read per connected account per 15 min; Microsoft (stale batches) gets status but no pacing alerts.
2. Build starts only after w18-p1-6-alerts B1 build + post-check (coordinator touches review.approved then). Read B1's actual composition/alerts.ts + p1-alerts.test.ts first.
