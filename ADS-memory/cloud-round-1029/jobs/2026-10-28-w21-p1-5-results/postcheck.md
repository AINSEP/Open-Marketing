### 2026-10-28-w21-p1-5-results: verdict SMALL FIXES (one Studio display line; the code is otherwise ready; measure dist rebuild before runtime use)

Method: diffed each LOCKS-FILES path against the job's own `baseline.json` snapshot (not HEAD, which mixes earlier waves). Per-file deltas match B1's inventory, except om-tools.ts (+40) and om-tools.test.ts (+38) and om-tool-coverage.ts (+14/-3). Those extras are w22-grant-surfaces hunks (`measurementGrantDefinitions`, grant coverage rows, one grant `it`), which landed afterwards, so they don't belong to this job.

Ledger:
- APPROVED 1, measure contract + join (FIX 3-5): FIXED.
  - metrics.ts:22 `verifiedLeadCountsSchema` gains `unattributed`; :40 port input gains `pluginId`/`accountId`.
  - campaign-results.ts:15 adds `attributionModel` + `workspaceUnattributed`.
  - :92 keeps the `!timezone` early return and drops the `campaigns.length === 0` one.
  - :100 rejects duplicate and foreign keys.
  - :107-119 `unionCampaigns`: supported cells null, unsupported absent, ratios via `deriveMetricRatios`, 5,000 bound across the union.
  - :98 on cohort failure, keeps vendor rows and marks `workspaceUnattributed` unavailable.
  - metrics.test.ts regressions are present: lead-only with/without vendor rows, unsupported absent, foreign plugin, foreign account, duplicate, union cap, model, unattributed available/unavailable.
- APPROVED 2, cohort adapter + binding (FIX 2, 6): FIXED.
  - reporting.ts:23-34 `countLead` is pure: spam excluded, erased counted, null campaign → unattributed, foreign account → skipped. It builds dates with `formatToParts`, one formatter per call (:43).
  - :40-55 pager: ≤50×100, forwards the signal, `limit_exceeded` on page 50, no repeated-cursor check (CUT 1 honoured).
  - Absent `leads` keeps `not_implemented` (:41).
  - index.ts:370 passes `{ leads: forms.leads }`; :371 sets `services.reporting = reporting;` with no new branch, so bootServer stays at 10.
  - The `services.accountBindings!` at index.ts:372 is pre-existing (it is in baseline.json), not added by this job.
  - Tests at p1-reporting-runtime.test.ts:211-283 cover:
    - the LA DST date 2026-03-08: 06:30Z is in, 07:30Z is end-exclusive, and the 03-08T07:30Z lead is the day before;
    - spam/erased/disqualified, foreign account/plugin, unattributed, lead-only;
    - signal forwarding, explicit zero, the 50-page cap, and the absent binding.
- APPROVED 3, tools + coverage (FIX 1, 7, 10): FIXED.
  - om-tools.ts:958-972 `reportingDefinitions` returns `[]` when absent; it is called unconditionally at :1023, so `featureDefinitions` gets no new `if`.
  - `om_measure_results` is read with `campaignResultsSchema` output.
  - `om_measure_refresh` is write, with no ownerOnly/ownerRoute, and maps to a campaign-grain enqueue.
  - Coverage rows are at om-tool-coverage.ts:86-87 and the Studio label at :160.
  - Test :307-342 covers scoped read, foreign workspace → empty, enqueued→existing replay with one job row, >31 days → invalid_input, and the coverage labels.
- APPROVED 4, Studio (FIX 8, 9): FIXED.
  - pages/measure/{index.ts, model/measure.hooks.ts, ui/MeasurePage.tsx} are present.
  - Readiness comes from `api.addons.integrations` with `integrationListSchema.parse`; reconnect and disconnected show links.
  - Display schema is page-local. Formatters are exported (AlertsFeed.hooks.ts:30,35 + widget index).
  - Shell.tsx:24 mounts it beside TrackingPage. The `syncId` comes from `runtime.ids`, and there is no polling.
  - measure.test.ts covers zero vs Unavailable, the separate conversions column, the attribution/unattributed text, reconnect, tool calls, malformed output and the invalid window.
- APPROVED 5, weekly fixture alignment: FIXED. weekly-report.test.ts:205/208 stubs gain `unattributed`, plus a results fixture. No new weekly test.
- APPROVED 6, typecheck: FIXED (indirectly).
  - measure and server PASS (server on the rerun).
  - The job's own studio rerun failed on test compile (typecheck-studio-rerun.txt: TS2322 at measure.test.ts:27, TS2769 `exact` at :50-51). The fixes were applied at 10:08:07.
  - w22-grant-surfaces then ran a full `@open-marketing/studio` typecheck that exited 0 (its typecheck.txt ATTEMPT 4, file at 10:23). tsconfig.tests.json includes tests/**, so that run covers the final measure.test.ts.
- COORDINATOR OVERRIDE 1 (defaults): FIXED. Spam excluded, erased counted (reporting.ts:25), one workspace-wide bucket, >5,000 → `limit_exceeded` (:54), refresh is a general write.
- COORDINATOR OVERRIDE 2 (pacing notes): FIXED.
  - `withDeadline` signature and 25 s budget unchanged (reporting.ts:77-85).
  - The seam is the old stub, replaced by `leadCohort`.
  - No new `services.accountBindings!`; bootServer has plain properties only.
- COORDINATOR OVERRIDE 3 (no features/web-events edits): FIXED. No web-events path is in the job's diff.
- DEFERRED items: newest-first touch, date-filtered cohort reader, weekly unattributed line, attribution repair, charts/FX/CAC/polling are all DEFERRED-OK. The newest-first touch was done by w22-newest-first-touch; the reader and weekly line are now w22-results-followups.

Outside lane: none. All 18 touched paths are in LOCKS-FILES, and om-tools.test.ts is unchanged by this job.

New:
- [MINOR] apps/studio/src/pages/measure/model/measure.hooks.ts:50
  - Defect: the hook renders `new Date(item.dataThrough).toISOString()` unconditionally. The contract says `dataThrough` 0 means "unknown" (packages/contracts/src/metrics/index.ts:63).
  - Failure: a batch without coverage shows "data through 1970-01-01T00:00:00.000Z".
  - Fix: `item.dataThrough === 0 ? 'unknown' : new Date(item.dataThrough).toISOString()`.
- [MINOR] measure.hooks.ts:75
  - Defect: the connection selector lists and preselects EVERY integration (messaging, mail, etc.).
  - Failure: Load on a non-reporting connection returns an empty or `not_implemented` result with no hint.
  - Not wrong (unavailable ≠ zero holds). Follow-up only: filter by a capability flag once integrations expose one.
- [MINOR/rule-of-two] apps/server/src/composition/reporting.ts:26-27 is the third copy of "Intl formatToParts → YYYY-MM-DD".
  - The other two: alerts/rules.ts:89 `accountLocalDay` and features/safety/src/state.ts:36 `localDay`.
  - Acceptable here, because the review mandated one formatter per call for a ≤5,000-lead loop.
  - The w22-results-followups trim removes `countLead` entirely, so no fix is needed in this job.
- [NOTE, runtime] features/measure/dist/index.js (Oct 14) is stale.
  - Runtime imports resolve from dist (features/measure/package.json:12), and the dist lacks `campaignResults`'s new fields, `createSqlMeasurementGrant`, etc.
  - Weekly parsing (alerts/jobs.ts:24) and the server boot will use the old code until the Coordinator rebuilds it.
  - This is the already-listed NEEDS, not a defect of the job.
- Complexity by reading:
  - `leadCohort` = 10 (for +1; nested if/if/for/if at +2 each). At the limit, not over.
  - `act` in measure.hooks.ts:87-101 is about 10 (if+||, if, catch, nested ifs, if/else, finally if). At the limit.
  - All others ≤8. No nesting >3.
- Secrets/vendor names in core: none added. No caching of capabilities.

Duplicates (vs published Jini rc.2 / Tovu): none.
- `rg formatToParts` over `node_modules/.pnpm/@jini-ai+*rc.2*/…/dist` gives no hits, so rc.2 has no timezone-day or cohort helper.
- Pager, join and tools reuse OM's own leads.list, metricsBoundary and serviceDefinition.

Disputes/deferrals: none disputed. All deferrals upheld (see Ledger).

Typecheck: the Studio errors are resolved. A later full Studio typecheck (w22-grant-surfaces, after measure.test.ts's last mtime) exited 0. The cause of the reported errors:
- (a) Studio could not import the internal `metricDaysSchema`; fixed with `reportMetricsInputSchema.shape.days`.
- (b) The test fixture's conditional object union was not `JSONType`; fixed with `boundedJsonSchema.parse` at measure.test.ts:27.
- (c) The `exact` option is not on `ByRoleOptions`; removed.

No further typecheck is needed.

Net lines: +547 / −42 = +505 (feature addition; no reduction promised).

Small fixes:
1. apps/studio/src/pages/measure/model/measure.hooks.ts:50: render `dataThrough === 0` as "unknown", not the 1970 ISO date.
2. Coordinator: rebuild the `@open-marketing/measure` dist before any runtime or test validation. This is shared with w22-grant-surfaces, whose `createSqlMeasurementGrant` import also needs it.
