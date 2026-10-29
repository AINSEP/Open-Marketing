# Progress: 2026-10-29-w22-pacing-month-lifetime (Builder B, cloud round 2026-10-29)

Built from review.md APPROVED SCOPE + COORDINATOR OVERRIDE (defaults: strict linear projection after the first full day; a missing day is unknown; history re-requested at most once per UTC day; >100-campaign continuation DEFERRED).

## Scope items

1. DONE: pure projection, threshold and export (FIXES 3-6).
   - `apps/server/src/alerts/rules.ts`:
     - `lifetimePacingEvidence({ campaign, observation, observedAt, partitions, now })` requires a lifetime `currentBudget` with `flight.start <= now < flight.end`.
     - Today's spend counts only through the existing `todayCampaignSpend` freshness rule.
     - Every account-local day from the flight start to yesterday needs a covered partition with an explicit string campaign `spend` row, in the same currency and timezone as today's batch. "Covered" means `batch.complete`, and the `dataThrough` cutoff reaches the next local day; `dataThrough` 0, which means unknown, never qualifies. Anything missing returns null (unknown, never zero).
     - A flight that started more than 310 days ago returns null.
     - Spend is summed with bigint. `elapsedMicros = floor(total * (now - start) / (end - start))`.
     - Helpers: `shiftDay`, `historyDayCovered`, `historyDaySpend`, `flightHistorySpend`, `LIFETIME_HISTORY_DAYS = 310`.
   - `lifetimeRules`: whole-budget excess (`spent > total`) still alerts inside the flight. Otherwise the rule is `spent > elapsedMicros` (strict). That projection needs `now - flightStart >= 86_400_000`. It replaces the earlier 110% tolerance.
   - `apps/server/src/alerts/index.ts`: exports `lifetimePacingEvidence`.
   - Tests in `apps/server/tests/alerts.test.ts`:
     - equal is no alert, +1 micro alerts;
     - whole-budget excess;
     - the first-day guard;
     - missing day, absent row, null spend, explicit "0" counted, currency/timezone drift, incomplete/uncovered/unknown `dataThrough`;
     - more than 310 days, out of flight;
     - totals above 2^53 stay exact.
     - The existing 110% test was rewritten for the strict rule.
2. DONE: composition (FIXES 1, 2) in `apps/server/src/composition/alerts.ts`.
   - `accountEvidence` is unchanged. `collectEvidence` has no new branches; it now `await`s `appendAccountEvidence`.
   - `appendAccountEvidence` is async and calls `lifetimeEvidence`. Lifetime evidence that arrives after an abort is discarded.
   - `lifetimeEvidence` derives one account history range: the earliest active-flight local start day, bounded at 310 days, up to the current window start. The current window's partitions already cover `[days.start, days.end)`.
   - The history read is done once per account, through `readBoundedPages`, as 31-day windows of `reporting.repo.readDays` (grain campaign, at most 10 pages). It runs under the existing single `withDeadline` signal.
   - A read failure, throw or abort observes `evidenceGap` and returns no lifetime evidence. Status, disapproval, daily and approval evidence are kept.
   - Refresh: `refreshAccount` runs only for windows that contain a day without a covered partition, with `now` = UTC day start. Its slot-based `syncId` is therefore stable all day: one enqueue per missing window per day. `refreshAccount` itself is unchanged.
   - Small extension of FIX 2 (noted): a window counts as missing if any day is absent OR uncovered (incomplete, or `dataThrough` before the next local midnight). Without this, a partially fetched old day would suppress the flight's alert forever.
   - Tests in `apps/server/tests/p1-alerts.test.ts`:
     - a lifetime notice goes through `evaluateAlerts` → feed, beside the daily notice, with exactly one history read and no history refresh when the history is covered;
     - a history read failure keeps the approval, disapproval and daily notices and observes one `unavailable` gap;
     - with a missing day, only that window is refreshed; the history `syncId` is identical across two 30-minute slots on the same UTC day, while the current-window `syncId` changes.
3. DONE: design note and DEFERRED reasons (below).
4. DONE: typecheck (below). Tests were also run, as this round permits.

## DEFERRED

- **Monthly pacing.** `currentBudget` (`packages/contracts/src/capabilities/index.ts:45-48`) has only daily and lifetime arms. No shipped plugin exposes a campaign-level monthly budget:
  - Google: DAILY or CUSTOM_PERIOD.
  - Meta: daily or lifetime.
  - Microsoft BudgetLimitType: daily standard/accelerated or LifetimeBudgetStandard.
  An unused contracts arm would be speculative (review CUT 1), so there is no NEEDS text. Daily budgets do not establish monthly authority.
- **Plugin-local refresh windows.** No reporting plugin manifest (`content/agent-plugins/*/plugin.json`, `*/io.github.ainsep.openmarketing/*.json`) declares a reporting freshness or refresh window today. The only "freshness" hit is a fixture output value in google-business-profile `capabilities.json`. No metadata was invented and no vendor branch was added.
- **History older than 310 days** (ten 31-day pager pages): stays unknown.
- **Continuation beyond 100 campaigns per account:** see the design note.

## DESIGN NOTE: continuation beyond 100 campaigns (follow-up job)

Today:
- `accountEvidence` discovers stored campaign IDs and rejects more than `remaining` (100 − count).
- It makes one `campaign.status.v1` call with up to 100 IDs.
- `alertEvidenceSchema` caps statuses/pacing at 100 campaigns per evidence page.
- The evaluator (`alerts/jobs.ts`) runs `alertCandidates` once; `appendAlerts` accepts at most 300 candidates.

Follow-up shape (no new pager or deadline mechanism):
1. **Status chunking:** add a helper `statusChunks({ host, ids })` that calls `campaign.status.v1` per 100-ID chunk and concatenates the results. Each chunk is checked for unrequested IDs. `accountEvidence` delegates to it in place of its single invocation and its `remaining` overflow return, with zero new branches. The overflow check moves to the evidence pager.
2. **Evaluator paging:** in `jobs.ts`, `sources` becomes a cursor-paged `readPage({ query: { limit, cursor } })`, where the cursor is an opaque "account index + campaign offset". `evaluateAlerts` loops `alertCandidates` + `appendAlerts` per page under `readBoundedPages` (≤10 pages → ≤1,000 campaigns), inside the SAME single 25-second `withDeadline`.
3. Each page stays within the existing 100-campaign `alertEvidenceSchema` and 300-candidate append bounds. Pending approvals are emitted on page 0 only.
4. **Cancellation:** pages appended before an abort persist (they are independent dedup-keyed notices). The abort is observed once via `evidenceGap('cancelled')`.
5. **Lifetime history:** stays per account (it is read once per account, not per page).
6. **Tests:** 101 and 250 campaigns across one account; chunked status calls; abort mid-page keeps earlier pages; dedup across replays.

## Vendor semantics (from plan §8; this round did not re-verify them, no web access was used)

- Google campaign-total budgets (CUSTOM_PERIOD, `total_amount_micros`, explicit flight dates): https://developers.google.com/google-ads/api/docs/campaigns/budgets/create-budgets
- Microsoft `LifetimeBudgetStandard`: https://learn.microsoft.com/en-us/advertising/campaign-management-service/budgetlimittype?view=bingads-13
- Meta lifetime budget (unverified in planning; the normalized contract is consumed as-is): https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/
- The projection is an OM linear forecast, not a claim that vendor delivery is linear.

## TYPECHECK

- `pnpm exec tsc --noEmit -p .` in apps/server: PASS.
- `pnpm --filter @open-marketing/server typecheck` (src + tests): src PASS. tests: 6 errors, all in `apps/server/tests/ingress-worker.test.ts` (`PublicInput` now requires `consent`). They come from the concurrent consent job's `inbound/public.ts` change. That file is not touched by this job and was not fixed.
- `pnpm exec eslint` on rules.ts, index.ts, composition/alerts.ts, alerts.test.ts, p1-alerts.test.ts: PASS (complexity ≤10, nesting ≤3).

## TESTS

- `pnpm exec vitest run tests/alerts.test.ts` (apps/server): 25/25 passed.
- `pnpm exec vitest run tests/p1-alerts.test.ts` (apps/server): 15/15 passed.

## FILES

apps/server/src/alerts/rules.ts, apps/server/src/alerts/index.ts, apps/server/src/composition/alerts.ts, apps/server/tests/alerts.test.ts, apps/server/tests/p1-alerts.test.ts, this progress.md.

NET LINES: +310 −19 (excluding progress.md)
