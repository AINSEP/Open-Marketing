# Trim review: 2026-10-29-w22-pacing-month-lifetime
VERDICT: APPROVED WITH CUTS

I checked the plan against the current code; there is no coordinator-note.md.
- `lifetimeRules` (`apps/server/src/alerts/rules.ts:157-164`) and the lifetime evidence schema (`:16-18`) exist. No producer fills `lifetime` spend or `elapsedMicros`: `dailyPacingEvidence` (`:126-138`) returns null for non-daily budgets. So the gap is real.
- Google (`google-ads/.../read-capabilities.ts:243`) and Meta (`meta-ads/.../read-capabilities.ts:207`) already emit `currentBudget.kind = 'lifetime'` with a flight.
- `currentBudget` has only daily and lifetime arms (`packages/contracts/src/capabilities/index.ts:45-48`).
- The evaluator takes one ≤100-campaign page (`alerts/jobs.ts:128,138`; `rules.ts:31`), and append takes ≤300 (`store.ts:17`).

CUTS:
1. The monthly contracts arm NEEDS (plan §7). No campaign-level monthly budget is exposed by the plugins we ship: Google has DAILY or CUSTOM_PERIOD, Meta has daily or lifetime, and Microsoft BudgetLimitType has daily standard/accelerated and LifetimeBudgetStandard (plan's URL). An unused contracts arm is speculative. Monthly stays DEFERRED with that reason and no NEEDS text.
2. Re-enqueuing flight-history refreshes every 30-minute slot (plan §4.5). That means up to 10 × 31-day vendor pulls per lifetime account per slot. FIX 2 replaces it.
3. Regression cases that re-test existing helpers (local midnight/DST via `accountLocalDay`, schema overflow). Keep the list in FIX 6.
4. Continuation beyond 100 campaigns stays DEFERRED. The reason is size, not the plan's "conflict": a lifetime build plus evaluator paging won't fit in one 90-minute run. It needs `jobs.ts` paging (sources → cursor; loop `alertCandidates` + append per page under `readBoundedPages` + the same `withDeadline`) and a helper that chunks status calls by 100 IDs, delegated from `accountEvidence` with zero new branches there. Write that as a DESIGN NOTE in progress.md for a follow-up job.

FIXES:
1. Placement: keep `accountEvidence` (`composition/alerts.ts:103-128`) and `collectEvidence`'s branch count unchanged.
   - Add one helper `lifetimeEvidence({ account, status, now, ... })` in `composition/alerts.ts`, called from `appendAccountEvidence` (`:133-143`) for observations whose `currentBudget.kind === 'lifetime'`. Otherwise keep the existing `dailyPacingEvidence` path.
   - History is read ONCE per account for the union of eligible flights, through `readBoundedPages` with a 31-day window per page (≤10 pages), using `reporting.repo.readDays` (grain `campaign`).
   - Everything runs inside the existing single `withDeadline` signal. A history failure or abort observes `evidenceGap` and keeps the account's status, disapproval and daily evidence.
   - `appendAccountEvidence` becomes async, or the helper returns evidence that the caller pushes. Either is fine if complexity stays ≤10.
2. Refresh of history: call the existing `refreshAccount` (`:85-99`) ONLY for history windows that lack a stored partition for any flight day. Pass `now: <UTC day start>`, so its `slot`-based `syncId` stays stable for the whole day: at most one enqueue per missing window per day, with no signature change. Current-day freshness keeps the existing 30-minute refresh.
3. Pure projection in `alerts/rules.ts`: `lifetimePacingEvidence({ campaign, observation, observedAt, partitions, now }): PacingEvidence | null`.
   - It requires `flight.start <= now < flight.end`, flight start ≤310 days ago, and every account-local day from the flight start to yesterday present with a campaign row whose `spend` is a string, in matching currency and timezone.
   - Today counts only through the existing `todayCampaignSpend` freshness rule (`:113-121`).
   - Anything missing returns `null` (unknown, never zero).
   - Sum the spend with `bigint`; `lifetime.complete = true` only when all of the above hold.
   - `elapsedMicros = (BigInt(total) * BigInt(now - start)) / BigInt(end - start)`, using floor division.
   - Export it from `alerts/index.ts` beside `dailyPacingEvidence`.
4. Threshold, `lifetimeRules` (`rules.ts:157-164`). Per job.md ("projects to exceed the lifetime budget", linear from the flight start), replace `spent * 10n > elapsed * 11n` with `spent > elapsed`. Keep `spent > total` and the flight bounds, and require `now - flightStart >= 86_400_000` (one full day) so a first-hour blip cannot alert. See OWNER DECISION 1.
5. Money and dates: integer micros as strings into `bigint` only. Days come from `accountLocalDay` with the batch timezone, and no `Number` arithmetic on micros.
6. Tests (written, not run):
   - `alerts.test.ts`:
     - spent == elapsed → no alert; elapsed + 1 → alert;
     - a missing flight day → null;
     - an absent campaign row → null; an explicit "0" row counts;
     - currency mismatch → null;
     - a flight starting more than 310 days ago → null;
     - < 1 day elapsed → no alert;
     - totals above 2^53 use bigint.
   - `p1-alerts.test.ts`: lifetime notice through `evaluateAlerts` → feed; the history read failure keeps daily and approval notices; the history refresh `syncId` is identical for two slots on the same UTC day and enqueued only for missing windows. **Serialize with w22-gate-minors, which also edits this file (same w14-alerts lock).**

REUSE:
- Pager: `readBoundedPages` (`apps/server/src/addon-tools.ts:146`).
- Deadline: `withDeadline` (`composition/reporting.ts:37`), the existing single call in `bindAlerts.sources`.
- Refresh: `refreshAccount` (`composition/alerts.ts:85`).
- Today freshness: `todayCampaignSpend` (`rules.ts:113`).
- Local day: `accountLocalDay` (`rules.ts:93`).
- Comparison: `comparable` (`rules.ts:88`).
- Evidence schema: `pacingEvidenceSchema` lifetime arm (`rules.ts:16-25`).

DUPLICATES:
- None found. The plan checked Jini rc.2 `platform`/`core`/`cms` (its deadline helper has no injected scheduler, so OM's `withDeadline` stays) and Tovu (no lifetime projection). No JINI ASK.

OWNER DECISIONS (defaults):
1. Lifetime threshold: strict linear projection (spend above the elapsed share, after the first full day), per job.md, replacing the earlier 110% tolerance. Alternative: keep 110% to cut noise from vendor front-loading. Default: strict, as specified.
2. A complete partition with no row for the campaign = unknown (consistent with the daily rule). This suppresses lifetime alerts for campaigns with no-delivery days. Default: unknown, never zero.
3. Flights older than 310 days are unknown (pager bound). Default: accept.

NEEDS: none. No contracts, manifests, lockfile, migrations or dists.

APPROVED SCOPE for B1 (priority order; update progress.md after each item):
1. `lifetimePacingEvidence` + the `lifetimeRules` threshold + export + `alerts.test.ts` cases (FIXES 3-6).
2. The `lifetimeEvidence` helper: history read via `readBoundedPages` under the existing deadline, plus the missing-window day-stable refresh (FIXES 1, 2) + `p1-alerts.test.ts` cases.
3. Write the continuation DESIGN NOTE (CUT 4) and the monthly/plugin-window DEFERRED reasons in progress.md. Plugin windows: no reporting plugin's manifest declares a freshness window today.
4. One server typecheck (one re-run allowed). No tests, builds or om:check.

LOCKS-FILES: apps/server/src/alerts/rules.ts, apps/server/src/alerts/index.ts, apps/server/src/composition/alerts.ts, apps/server/tests/alerts.test.ts, apps/server/tests/p1-alerts.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-pacing-month-lifetime/progress.md (lock groups: w14-alerts)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted (strict linear projection after first full day; missing day = unknown; history re-request once per UTC day). >100 campaigns continuation DEFERRED with design note.
