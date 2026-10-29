### 2026-10-29-w22-newest-first-touch: verdict READY TO COMMIT (after Coordinator rebuilds the web-events dist)

Ledger (checked against the code, not B1.md):
1. sql.ts:83 DESC/DESC order: FIXED. features/web-events/src/sql.ts:83 now reads `ORDER BY e.occurred_at DESC, t.touch_id COLLATE BINARY DESC LIMIT $6`. Nothing else in the query changed.
2. memory.ts compareTouches inverted: FIXED. features/web-events/src/memory.ts:98-99: `right.occurredAt - left.occurredAt`, then `left > right ? -1 : Number(left < right)`. That is ID DESC, matching BINARY. The sort runs before `slice(0, limit)` (:65-66), so both adapters cut the oldest rows.
3. ports.ts JSDoc: FIXED. features/web-events/src/ports.ts:14 reads "Returns touches newest-first (occurredAt DESC, touchId DESC)."
4. forms.ts latestPaidTouch: FIXED.
   - apps/server/src/composition/forms.ts:53-60: the `length === 100` guard is gone. The function returns the first touch whose `parseCampaignKey` succeeds, otherwise the unchanged null attribution.
   - Name, signature and model version `last_paid_touch_30d.v1` are unchanged, and the JSDoc is rewritten as asked.
   - Complexity 3.
5. port-suite expectation: FIXED. features/web-events/tests/port-suite.ts:76 is renamed "newest-first…", and :87 expects `["z","b"]`. This fails on the old ascending order, which returned `["b","z"]` with `limit: 2`.
6. ingress-worker it.each: FIXED. apps/server/tests/ingress-worker.test.ts:708-709 has `saturated` (100) attributed and the new `over-limit` (101) row. :721-736 parameterize `total` and the expected `paid-<total-1>`. Both rows fail before the fix: the old guard nulls the 100-row page, and the old ASC read returns paid-000..099. The optional "newer direct touch" variant was skipped, which the review allowed.
7. progress.md and the two typechecks: FIXED. B1 reports web-events and server typechecks passing, one run each.
- COORDINATOR OVERRIDE 1 (keep the 100 cap, no backfill): honoured. There is no second read and no repair code.

Consumers: service.ts `attributedTouches` (:83-99) keeps order (it uses `parsed.data.map`). identity.ts:84-87 and om-tools.ts:920 pass the result through. measure's `AttributionTouchPort` (features/measure/src/ports.ts:12) has no caller that relies on order. No edit was needed there.

Outside lane: none. The B1 run's file_change log lists only the 6 lane files plus progress.md. The other dirty hunks in these files (lastHeartbeat, ObservedCampaignPort, storedEventSchema and others) come from earlier waves.

New:
- [MINOR] apps/server/tests/ingress-worker.test.ts:721-729. Every row's touches share one `occurredAt` and all are paid. So at capture level the regression only exercises the touchId tie-break and the "first touch" pick, not "skip a newer non-paid touch". Failure: a future change that returns `touches[0]` without checking eligibility would still pass. Time-DESC is covered by port-suite:87, and the non-eligible path is only covered by the all-null rows (`foreign`). Fix: optional, not required to commit. The review's one-line variant (make the newest row direct) would close this.
- No secrets, vendor names, caching or complexity breaches.

Disputes/deferrals:
- The plan's DISPUTED wording is correct, and the review agreed: the old code nulled full pages; it did not "pick an old touch".
- No backfill of attributions frozen as null: DEFERRED-OK (owner default, w21 deferral).

Typecheck: B1 reports PASS for `--filter @open-marketing/web-events` and `--filter @open-marketing/server`. Nothing to fix.

Duplicates: none. Published Jini 0.6.15-rc.2 dist has no hits for `touchesFor`/`lastPaid` (re-checked with rg). Per the review, Tovu and ai-traces-jini have none either.

Net lines: code/tests +15/−15 (net 0), as B1 reported, consistent with the 7 changed hunks.

Small fixes: none required. NEEDS: the Coordinator rebuilds the `@open-marketing/web-events` dist, because the server resolves `./dist/index.js`.
