### 2026-10-29-w22-pacing-month-lifetime: verdict READY TO COMMIT (committed in ca2d393 together with w22-results-followups; FOLLOW-UPs only)

Reviewer R2, 2026-10-29. Hunks attributed by LOCKS-FILES: alerts/rules.ts L134-217 (lifetime part), alerts/index.ts, composition/alerts.ts, tests/alerts.test.ts, tests/p1-alerts.test.ts. The weekly hunks in rules.ts (L46-82) belong to w22-results-followups.

Ledger:
1. `lifetimePacingEvidence` + `lifetimeRules` threshold + export + alerts.test.ts cases (FIXES 3-6): FIXED.
   - Projection (rules.ts:180-196): flight bounds; today counts only through `todayCampaignSpend`; every local day from the flight start to yesterday must be covered with an explicit string spend row (:153-176).
   - Currency and timezone must match, and the 310-day floor is enforced (:165).
   - Sums use bigint; `elapsedMicros` uses floor division (:191).
   - Rule (:211-218): `spent > total` alerts; otherwise `spent > elapsed`, only after one full day. The 110% tolerance is replaced, as COORDINATOR OVERRIDE requires.
   - Test cases: every listed FIX 6 case is present and can fail (equal vs +1 micro, missing day, absent row, "0" counted, currency/timezone drift, >310 days, <1 day, >2^53).
2. `lifetimeEvidence` helper, the history read via `readBoundedPages` under the existing deadline, the missing-window refresh with a day-stable ID, and the p1-alerts cases (FIXES 1, 2): FIXED.
   - Placement: `accountEvidence` is unchanged, and `collectEvidence` gains only an `await` (no new branch).
   - History read: once per account, in ≤10 windows of 31 days (alerts.ts:150-178). Each window is ≤31 days, which satisfies `reportingDaysSchema` (measure metrics.ts:7).
   - Refresh: only uncovered windows are refreshed, with `now` set to the UTC day start (:181-189). Same syncId all day, so the enqueue is idempotent.
   - A read failure observes the gap and keeps the daily, approval and disapproval notices (test p1-alerts "keeps daily…").
   - Extension (accepted): "uncovered" also counts a day as missing when it is incomplete or its `dataThrough` cutoff is short. Without this, a partial day would suppress the flight forever.
3. DESIGN NOTE for >100 campaigns, plus the monthly and plugin-window DEFERRED reasons: FIXED (progress.md).
   - The design matches review CUT 4: status chunking in a helper, and evaluator paging under the same `withDeadline`.
4. Typecheck: FIXED. Server src + tests PASS on R2's re-run.
   - The ingress-worker errors that progress.md mentions came from the concurrent consent job and are gone at HEAD.
5. COORDINATOR OVERRIDE 1 (strict linear projection after one day; a missing day is unknown; history re-request once per UTC day; continuation DEFERRED): FIXED.

Outside lane: none.

New:
- [MINOR] composition/alerts.ts:195 + :222: an abort during the LAST account's history read is never observed.
  - Failure: the 25 s deadline fires during `readFlightHistory` for the final joined account. `lifetimeEvidence` returns [] without `evidenceGap`, and `appendAccountEvidence` silently drops the lifetime evidence. `collectEvidence` has no next iteration to observe `cancelled`.
  - Before this change, the post-`accountEvidence` check observed it. Effect: telemetry shows a clean run that lost lifetime evidence. This partly drops the guarantee in FIX 1, "a history … abort observes evidenceGap"; non-final accounts are still observed on the next loop pass.
  - FOLLOW-UP fix: observe `cancelled` once in `lifetimeEvidence` and stop `collectEvidence` from double-observing. That needs a collectEvidence edit, which the review froze, so it is out of scope here.
- [MINOR] composition/alerts.ts:131 vs rules.ts:165: the two history floors differ.
  - The composition floor is `days.start` (UTC yesterday) − 310; the pure floor is local today − 310.
  - Effect: for a flight starting 311-312 days ago, one extra window is read, and possibly refreshed once a day, that the projection will always reject. Harmless, bounded by the 10-page pager. No fix needed.
- Checked and clean:
  - No vendor names in core.
  - No capability or token caching.
  - All micros use bigint/string, with no `Number` money arithmetic.
  - eslint (sonarjs cognitive ≤10, max-depth 3) PASS on rules.ts and composition/alerts.ts (R2 re-run).
  - Types are Zod-derived (`PacingEvidence`, `MetricDay`).
  - `bootServer` untouched.

Disputes/deferrals:
- Monthly pacing DEFERRED-OK: there is no contracts arm and no shipped plugin has a monthly budget (review CUT 1).
- Plugin-local refresh windows DEFERRED-OK: no manifest declares one.
- >100-campaign continuation DEFERRED-OK (CUT 4, override), and a design note is present.
- Vendor URLs were not re-verified (no web access in this round). That is acceptable: the projection consumes the normalized contract only.

Typecheck: server `pnpm run typecheck` PASS (R2). Tests re-run by R2: alerts.test.ts, p1-alerts.test.ts, p1-reporting-runtime.test.ts and weekly-report.test.ts, 67/67 pass.

Small fixes: none.
