# Trim review: 2026-10-29-w22-newest-first-touch
VERDICT: APPROVED WITH CUTS

Checked against the current code. No coordinator-note.md exists.
- `features/web-events/src/sql.ts:83` sorts ascending (`ORDER BY e.occurred_at, t.touch_id COLLATE BINARY LIMIT $6`).
- `features/web-events/src/memory.ts:97-100` (`compareTouches`) also sorts ascending.
- `apps/server/src/composition/forms.ts:53-62`: `latestPaidTouch` returns null when `touches.length === 100` and otherwise keeps the last paid touch.
- The plan's DISPUTED wording is correct. Today a full page (100 touches) is left unattributed; the code does not pick an old touch. Either way the newest touch can be lost, so the bug is real.

Consumer review (I re-checked it with rg):
- `service.ts:52-61` / `attributedTouches` (`service.ts:83`) keep the order.
- `identity.ts:84-87` only maps fields. The measure `AttributionTouchPort` (`features/measure/src/ports.ts:12`) has no caller that sorts or selects.
- `om-tools.ts:918` passes the result through.
- `ingress-worker.test.ts:211`, `adapters.test.ts:74` and `service.test.ts:170` (uses `arrayContaining`) do not depend on order.
- So `identity.ts` and `om-tools.ts` need no edit.

CUTS:
1. Drop the new port-suite tests for "more than 100 stored touches return exactly the newest 100" and the separate "tie-break at limit boundary" test. The existing test at `features/web-events/tests/port-suite.ts:76-90` already covers all of this once its expectation changes. It stores z@200, b@100, a@100 and end@300 (outside the window), then reads with `limit: 2`. Newest-first, it returns `["z","b"]`: descending time, descending ID on a tie, and the oldest row cut by the limit. It runs on both adapters and would fail on the old order.
2. Drop the ingress test "100 newer direct touches plus an older paid touch outside the page stays null". It checks the existing 100-row read limit, not this fix, and it would pass before the fix too.
3. Drop the standalone ">100 touches, newest paid wins over a newer direct touch" test. Add a row to the existing `it.each` at `apps/server/tests/ingress-worker.test.ts:701-709` instead (see FIX 4).

FIXES:
1. `features/web-events/src/sql.ts:83`: change to `ORDER BY e.occurred_at DESC, t.touch_id COLLATE BINARY DESC LIMIT $6`. Change nothing else.
2. `features/web-events/src/memory.ts:97-100`: invert both comparisons in `compareTouches`, so `right.occurredAt - left.occurredAt` and the reversed lexical comparison. Keep the BINARY-collation comment.
3. `apps/server/src/composition/forms.ts:53-62`:
   - Delete the `length === 100` guard.
   - Loop and `return` the first touch whose `parseCampaignKey` succeeds; return the existing null attribution otherwise.
   - Rewrite the JSDoc to say "first projected paid claim in newest-first repository order; a page without one stays unattributed".
   - Keep the name, signature and model version.
4. `apps/server/tests/ingress-worker.test.ts:701-737`, the regression test:
   - Change the `saturated` row (100 touches) to `attributed: true`, expecting `paid-099`.
   - Add one row, `over-limit` (101 touches), expecting `paid-100`. This row fails before the fix, because the old ascending read returned paid-000..099 and the length-100 guard nulled it.
   - Do not add a new set of cases: parameterize the expected touch ID per row (e.g. `paid-` + padded `total - 1`).
   - Optional, only if it stays one line in the loop: make the newest touch in the `over-limit` row direct (`campaignId: null`) at a later `occurredAt`. That proves the selection takes the first ELIGIBLE touch. Otherwise skip it.
5. `features/web-events/src/ports.ts:14`: add one JSDoc line saying `touchesFor` returns touches newest-first (`occurredAt DESC, touchId DESC`). The order is now part of the contract. Leave types.ts and the measure ports alone (the measure port is out of lane).
6. Port suite: change only the expectation at `port-suite.ts:87` to `["z","b"]` and rename the test to say "newest-first". Add no other repo tests.
7. Typecheck: run ONE package-scoped typecheck each for web-events and server at the end; one re-run is allowed. Never run vitest, builds or `om:check`.

REUSE:
- Touch read → the existing SQL query at `features/web-events/src/sql.ts:78-86` and the memory comparator at `memory.ts:97`. Both already validate scope, binding, window and limit.
- Paid selection → the existing `latestPaidTouch` at `forms.ts:53` plus `parseCampaignKey` from contracts.
- Ordering index → `web_event_subject_time` at `features/web-events/migrations/0001_web_events.sql:44` (`occurred_at` can be scanned backwards). No migration.
- Tests → the `webEventRepoSuite` test at `port-suite.ts:76` and the ingress `it.each` with the `fixture`, `form`, `observedLeadCampaign`, `submit` and `leadService` helpers at `ingress-worker.test.ts:701`.

DUPLICATES:
- Published Jini 0.6.15-rc.2 (`node_modules/.pnpm/@jini-ai+*0.6.15-rc.2*/…/dist`): no `touchesFor`, last-paid or last-touch attribution reader (rg returned nothing).
- Jini rc.3 source (`tovu-integration-clones/ai-traces-jini`, read-only): none found.
- Tovu: no code hits for `touchesFor`, `lastPaidTouch`, `last_paid` or `last-touch` in *.ts/*.tsx/*.sql. Only reports and todos mention them.
- Result: none found. The OM code stays and there is no JINI ASK.

OWNER DECISIONS (defaults):
- Latest-100 cap: if the newest 100 touches in 30 days hold no paid touch, the lead stays unattributed and there is no second read (job.md says so). Default: keep the cap.
- Attributions already frozen as null by the old guard are not repaired. Default: capture time only, no backfill (repair is already DEFERRED in the w21 review).

NEEDS:
- NEEDS: the Coordinator rebuilds the `@open-marketing/web-events` dist after the build, because the server resolves `./dist/index.js`.

APPROVED SCOPE for B1:
1. `features/web-events/src/sql.ts:83`: DESC, DESC order (FIX 1).
2. `features/web-events/src/memory.ts:97-100`: inverted comparator (FIX 2).
3. `features/web-events/src/ports.ts:14`: one JSDoc line on newest-first order (FIX 5).
4. `apps/server/src/composition/forms.ts:53-62`: return the first eligible paid touch, drop the length-100 guard, update the JSDoc (FIX 3).
5. `features/web-events/tests/port-suite.ts:76-90`: change the expectation to `["z","b"]` and rename the test (FIX 6). Write it but do not run it.
6. `apps/server/tests/ingress-worker.test.ts:701-737`: `saturated` row attributes `paid-099`, new `over-limit` row with 101 touches attributes `paid-100` (FIX 4). Write it but do not run it.
7. `progress.md` in the job dir after each item; then one typecheck each for web-events and server (FIX 7).

LOCKS-FILES: features/web-events/src/sql.ts, features/web-events/src/memory.ts, features/web-events/src/ports.ts, features/web-events/tests/port-suite.ts, apps/server/src/composition/forms.ts, apps/server/tests/ingress-worker.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-newest-first-touch/progress.md (lock groups: w13-server-composition, w16-web-events)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted: keep the latest-100 cap; no backfill of attributions frozen by the old guard.
