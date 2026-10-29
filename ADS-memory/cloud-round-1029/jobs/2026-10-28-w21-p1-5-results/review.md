# Trim review: 2026-10-28-w21-p1-5-results
VERDICT: APPROVED WITH CUTS

The plan is mostly right-sized: it extends the existing port, join and outbox, and its gap claims hold against the current code. The gaps are the cohort stub at composition/reporting.ts `results()`, the vendor-only join at campaign-results.ts:90 and the oldest-first touch read at web-events/src/sql.ts:83. The cuts are small. The two real fixes are (a) om-tools `featureDefinitions` is already at complexity 10, and (b) the Studio mount and the formatter export must be in-lane, because the page is otherwise unreachable.

PRECONDITIONS (the build must not start until all are true):
- **w21-p1-6-b2-pacing is BUILT.** It is building now and holds `composition/reporting.ts` (it extracts `withDeadline` and edits `sync`) and `composition/index.ts`. Re-read both files after it lands and build on its version. **Add `w14-alerts` to this job's locks.txt.** reporting.ts sits under w14-alerts for pacing and weekly-report. Lock order: w14-alerts < w13-server-composition < w13-om-tools < w14-surface < w20-measure.
- **w21-attachments-cli-tool** (approved, waiting-locks) also edits `om-tool-coverage.ts`. The shared `w13-om-tools` group serializes the two jobs. Whichever builds second rebases on the other's rows.
- Built inputs confirmed:
  - P1-2 runtime (`reporting.enqueue`/`results`/`sync`);
  - P1-4 `forms.leads` (index.ts:340 exposes `leads: forms.leads`; `LeadsService.list`);
  - weekly report (`generateWeeklyReport` calls `reporting.results`, workers.ts:105);
  - consent gate DONE (no touch or visit before consent, so unconsented enquiries freeze with `attribution.campaign = null`).

CUTS:
1. **Repeated-cursor rejection** in the cohort pager. The leads SQL cursor is strictly increasing (`lead_id > $3 ORDER BY lead_id`, features/leads/src/sql.ts:36), and the 50-page cap already bounds the loop. Keep only: ≤50 pages × 100, forward the signal, and return `limit_exceeded` if the cursor is still non-null after page 50.
2. **New weekly-report test** ("demonstrate populated weekly lead counts"). The weekly report gets bound counts automatically through `reporting.results` (workers.ts:105), and the cohort binding is proven in p1-reporting-runtime.test.ts. Only align the weekly-report.test.ts fixtures to the new schema fields: `attributionModel`, `workspaceUnattributed`, and `unattributed` in the inline cohort stubs at :204/:207.
3. **Tool behaviour assertions in om-tools.test.ts.** Put the `om_measure_results`/`om_measure_refresh` regressions in p1-reporting-runtime.test.ts (call `buildOmToolDefinitions` with a `services.reporting` fixture). Touch om-tools.test.ts ONLY if an existing coverage/parity assertion breaks because of the new tools/rows.
4. **The plan's NEEDS for the touch-order fix stays DEFERRED. It is NOT this build.** See DEFERRED. The consent gate is done, so the "serialize with consent-gate" note is moot.
5. **Plan §8 "registry verification" / Jini package checks.** No Jini or package work is in this job. Drop that from the build.

FIXES:
1. **om-tools `featureDefinitions` is at cognitive complexity 10.** It has ten `if (services.x)` lines (om-tools.ts:976-990), so one more `if` breaches the limit. Instead:
   - add `function reportingDefinitions(required: { reporting?: OmFeatureServices['reporting'] }): OmToolDefinition[]`, which returns `[]` when absent;
   - call it unconditionally: `definitions.push(...reportingDefinitions({ reporting: services.reporting }))`, exactly like `trackingDefinitions` (om-tools.ts:925, :985);
   - declare `reporting?: Pick<ReturnType<typeof bindReporting>, 'results' | 'enqueue'>` on `OmFeatureServices`, with `import type { bindReporting } from './composition/reporting.js'` (precedents: om-tools.ts:13 `bindAlerts`, :26 `bindTracking`).
2. **bindReporting signature: `bindReporting(required, optional?: { leads?: Pick<LeadsService, 'list'> })`, not a new required field.**
   - When `leads` is absent, keep today's typed `not_implemented` cohort failure, which shows as unavailable, never zero.
   - Why: pacing (building) and existing tests construct `bindReporting(...)`. A required field would force edits in their locked files. This follows the established `bindIdentity(required, { observedCampaigns })` pattern (index.ts:324).
   - index.ts: pass `{ leads: forms.leads }` as the second argument at the existing `bindReporting(...)` call (index.ts:369), and add ONE statement after it: `services.reporting = reporting;` (precedent `services.alerts = alerts`, :381).
   - No branch, `&&`, `??` or ternary is added, so bootServer stays at exactly 10.
3. **Port contract (metrics.ts:22, :38-40).**
   - Required input becomes `{ context, pluginId, accountId, campaigns, days, timezone }`.
   - `verifiedLeadCountsSchema` becomes `{ counts: [...] (max 5000), unattributed: epochSchema }`.
   - Keep `campaigns`, so requested keys still get explicit zeros and "missing = unavailable" keeps its meaning. The existing test at metrics.test.ts:117-118 still holds.
   - `campaignResults` passes `pluginId`/`accountId` from the parsed query.
4. **Join (campaign-results.ts:89-106).**
   - Drop the `required.campaigns.length === 0` early return at :90 so lead-only campaigns surface when the account has a timezone but no vendor rows. Keep the `!timezone` return; without timezone evidence, OM cells and `workspaceUnattributed` are `unavailable`, never UTC.
   - Validation: reject duplicate keys and any key whose `pluginId`/`accountId` differs from the query (`invalid_input`).
   - Requested keys get their count. Extra keys become lead-only rows:
     - `metrics`: every metric whose name is present in `mapping.grains.campaign` (contracts metrics/index.ts:48) is `null` (unavailable); unsupported names stay absent;
     - `ratios` come from the existing `deriveMetricRatios`;
     - `vendorSource` stays the literal.
   - Keep the 5,000-row bound across vendor and lead-only rows.
   - Split the union into a small helper so each function stays ≤10 and nesting ≤3.
   - On a cohort failure, keep vendor rows (existing :95) and set `workspaceUnattributed: { status: 'unavailable', reason }`.
5. **Result schema (campaign-results.ts:12-17).**
   - Add `attributionModel: z.literal('last_paid_touch_30d.v1')`. It reuses the leads `modelVersion` literal value; do not import the leads package into measure.
   - Add `workspaceUnattributed: leadResultSchema`.
   - Add no other fields. The weekly snapshot picks its fields explicitly (alerts/rules.ts:38-47), so it is unaffected.
6. **Cohort adapter** (module-level in composition/reporting.ts, behind the existing `metricsBoundary` in joinLeads, which turns throws into `unavailable`).
   - Build ONE `Intl.DateTimeFormat('en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' })` per call. Assemble `YYYY-MM-DD` from `formatToParts`; do not rely on the locale's output format.
   - Count a lead when `local(createdAt) >= days.start && < days.end` and `stage !== 'spam'`. Erased leads ARE counted (OWNER DECISION 1).
   - If `attribution.campaign === null`, count it as unattributed.
   - Else, if its plugin/account matches the query, count it per campaign.
   - Requested campaigns start at 0.
   - Keep the pure per-lead counter separate from the pager (each ≤10).
7. **Refresh tool.** `om_measure_refresh`:
   - policy `'write'`, no `ownerOnly`, no `ownerRoute`; it falls under the general write rule. It is an outbox enqueue of the admitted read-only `report.metrics.v1`, with no spend and no new card type.
   - schema `z.strictObject({ syncId: metricSyncRequestSchema.shape.syncId, query: campaignResultsQuerySchema })`;
   - it maps to `reporting.enqueue({ context, request: { syncId, ...ids, input: { grain: 'campaign', days } } })`.
   - It is kept because pacing only refreshes a 2-day window (pacing review FIX 3). Without it, no surface can request the owner's chosen period.
   - `om_measure_results`: policy `'read'`, schema `z.strictObject({ query: campaignResultsQuerySchema })`.
8. **Studio, inside the existing ports.**
   - Connection selector and readiness come from `api.addons.integrations({ query: { limit: 100 } })` (shared/api/types.ts:123; contracts `integrationSummarySchema` status `saved|reconnect_required|disconnected`). Call it in a page-local hook; pages never import `pages/addons`.
   - `reconnect_required` shows "Reconnect required" with a link to `#/addons/integrations`. This reuses existing readiness and adds no new model.
   - Account ID is a text input; start and end are date inputs (end exclusive, ≤31 days).
   - Use a page-local Zod display schema (precedent: AlertsFeed.hooks.ts:7 `weeklySchema`). Studio cannot import `@open-marketing/measure`.
   - The refresh `syncId` comes from `runtime.ids.next({})`. The "Refresh" button acknowledges the enqueue only; "Load" reads persisted results. No polling.
   - Columns: Spend (scaled micros + currency), Impressions, Clicks, "Conversions (reported by platform)", "Leads (OM-verified)". Below the table:
     - a "Workspace unattributed enquiries" line;
     - the attribution-model sentence (see OWNER DECISION 2);
     - coverage, missing days and per-day freshness/restated lines.
   - Formatters: export the existing `metricText`/`scaledMetricText` (AlertsFeed.hooks.ts:30, :35) through `widgets/workspace-canvas/index.ts`. This is the second consumer, so the rule of two applies.
9. **Shell mount is IN scope, not NEEDS.** Make one edit at apps/studio/src/app/shell/Shell.tsx:23: `{shell.target === "measure" && <><TrackingPage …/><MeasurePage api={props.api} runtime={props.runtime} /></>}` plus one import line. This is the same in-lane precedent the leads job used (Shell.tsx:24). Without it, the Studio leg of parity is not closed.
10. **Coverage.** Replace the `'Live vendor reports', null, … 'I-2_REPORTING'` row (om-tool-coverage.ts:82) with two rows: `om_measure_results` (read) and `om_measure_refresh` (write). Studio label: "Measure page and chat via execute_tool".
11. **NEEDS (coordinator):** `@open-marketing/measure` resolves at runtime from `./dist/index.js` (features/measure/package.json:12), while types come from source. Rebuild the measure dist before any runtime verification or tests. No manifest, lockfile, contracts or migration change.

REUSE:
- Vendor join, BigInt sums, ratios, observation lineage → features/measure/src/reporting/campaign-results.ts:24-106 (extend `joinLeads`/`withLeadCount`)
- Cohort port → metrics.ts:38 `VerifiedLeadCountsPort` (extend; no new port)
- Lead reads → `LeadsService.list` via `forms.leads` (features/leads/src/sql.ts:35; index.ts:340)
- Boundary/throw→unavailable → metrics.ts:48 `metricsBoundary` (already wraps the cohort call at campaign-results.ts:91)
- Refresh identity/outbox → composition/reporting.ts `reportingJob` + `enqueue`
- Tools → om-tools.ts:736 `serviceDefinition`; the absent-service pattern → `trackingDefinitions` (:925)
- HTTP/CLI → existing `POST /api/tools/call` and `om tools call` (no new route/command)
- Studio tool calls → `api.tool` (pattern pages/leads/model/leads.hooks.ts:14-19); readiness → `api.addons.integrations`; formatters → AlertsFeed.hooks.ts:30-39
- Studio test → `.ts` + `createElement` pattern (tests/tracking.test.ts)

OWNER DECISIONS (defaults):
1. **Cohort membership:** a lead counts on its `createdAt` local date in the account timezone. `spam` is excluded. `disqualified` and **erased leads are counted**: an aggregate count holds no personal data, and dropping erased leads would silently restate past periods. Alternative: exclude erased leads, which is one condition.
2. **Attribution model shown:** "Last paid touch within 30 days (`last_paid_touch_30d.v1`), frozen when the lead is captured. Visitors are tracked only after consent; enquiries without a consented paid touch appear as unattributed." Attribution is never recomputed.
3. **Unattributed bucket is workspace-wide**, counted in the viewed account's timezone. It is labelled as such and never summed across account views.
4. **More than 5,000 leads in the workspace:** OM counts show `unavailable (limit_exceeded)` until a leads-owned date-filtered reader exists (follow-up). Truncated totals are never shown.
5. **Lead-only campaigns:** supported vendor cells show "Unavailable" (null), never 0.
6. **`om_measure_refresh` follows the general write rule** (no spend, so no exact spend card).

APPROVED SCOPE for B1 (priority order; update progress.md after each item; stop and mark DEFERRED if time runs out):
1. **Measure contract + join (FIX 3-5).**
   - Edit metrics.ts and campaign-results.ts, and align `metricsLeads` in features/measure/tests/fixtures.ts.
   - metrics.test.ts regressions:
     - a lead-only row has null supported cells and absent unsupported cells;
     - a foreign plugin/account key or a duplicate key gives `invalid_input`;
     - explicit 0 stays available and a missing requested key stays unavailable;
     - `workspaceUnattributed` is available, and is unavailable on cohort failure and without a timezone;
     - `attributionModel` is present;
     - zero vendor rows plus a known timezone still yields lead-only rows.
   - Update the existing call assertion at metrics.test.ts:81 for the new port input.
2. **Cohort adapter + binding (FIX 2, 6).**
   - Edit composition/reporting.ts (optional `{ leads }`, the pager and the pure counter) and index.ts (second argument plus `services.reporting = reporting;`).
   - p1-reporting-runtime.test.ts regressions:
     - a lead at 23:30 local on the last day is counted, and one at 00:30 local on the end date is not (non-UTC zone, including a DST-transition date);
     - spam is excluded and erased is counted;
     - a lead attributed to another account is excluded, and a null campaign is unattributed;
     - a fake `list` that never ends gives `limit_exceeded` after 50 pages, and OM cells show as unavailable;
     - without `leads`, cells stay `not_implemented`/unavailable.
3. **Tools + coverage (FIX 1, 7, 10).** Edit om-tools.ts and om-tool-coverage.ts. p1-reporting-runtime.test.ts:
   - `om_measure_results` returns the scoped result;
   - `om_measure_refresh` enqueues one campaign-grain job, and a replayed `syncId` gives `existing` with no second job;
   - an invalid range of more than 31 days gives `invalid_input`.
4. **Studio (FIX 8, 9).**
   - Add pages/measure/{index.ts, model/measure.hooks.ts, ui/MeasurePage.tsx}, export the formatters, and add the Shell.tsx mount.
   - tests/measure.test.ts:
     - renders a row with 0 vs "Unavailable" and the separate platform-conversion column;
     - shows the unattributed line and the attribution text;
     - a `reconnect_required` connection shows the Integrations link;
     - Refresh calls `om_measure_refresh` with a `syncId`, and Load calls `om_measure_results`;
     - malformed tool output shows an error and no rows.
5. **Weekly fixture alignment (CUT 2).** weekly-report.test.ts `results()` fixture and the inline cohort stubs at :204/:207 only.
6. **Typecheck once each:** `@open-marketing/measure`, `@open-marketing/server`, `@open-marketing/studio`, with one corrective rerun allowed. NO tests, builds, `om:check` or dist rebuild.

DEFERRED (explicit):
- **Newest-first touch read for last-touch capture.** Follow-up job, lanes w16-web-events + w18-leads:
  - features/web-events/src/{sql,memory}.ts: `ORDER BY occurred_at DESC, touch_id DESC`;
  - apps/server/src/composition/forms.ts `latestPaidTouch`: take the FIRST eligible touch; a saturated page with no paid touch stays unattributed;
  - web-events tests/port-suite.ts and ingress-worker.test.ts.
  - Check the other `touchesFor` consumers (identity.ts:84 measure attribution port, the om-tools.ts:918 tool) for order assumptions first.
  - It changes capture-time attribution, not results reading.
- Leads-owned, created-at-filtered cohort reader (removes the 5,000-lead ceiling).
- Weekly snapshot unattributed line and weekly email (alerts lane, rules.ts).
- Repair of attributions frozen before the consent gate (owner/migration decision).
- Charts, cross-account totals, FX, CAC, automatic polling, scheduled backfill.

LOCKS-FILES: features/measure/src/reporting/metrics.ts, features/measure/src/reporting/campaign-results.ts, features/measure/tests/fixtures.ts, features/measure/tests/metrics.test.ts, apps/server/src/composition/reporting.ts, apps/server/src/composition/index.ts, apps/server/src/om-tools.ts, apps/server/src/om-tool-coverage.ts, apps/server/tests/p1-reporting-runtime.test.ts, apps/server/tests/weekly-report.test.ts, apps/server/tests/om-tools.test.ts, apps/studio/src/pages/measure/index.ts, apps/studio/src/pages/measure/model/measure.hooks.ts, apps/studio/src/pages/measure/ui/MeasurePage.tsx, apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts, apps/studio/src/widgets/workspace-canvas/index.ts, apps/studio/src/app/shell/Shell.tsx, apps/studio/tests/measure.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-28-w21-p1-5-results/progress.md (lock groups: w14-alerts, w13-server-composition, w13-om-tools, w14-surface, w20-measure)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted: spam leads excluded; erased leads stay in aggregates; one workspace-wide unattributed bucket; >5,000 leads → counts unavailable (a follow-up job removes the ceiling); om_measure_refresh kept under the general write rule.
2. Pacing post-check notes (2026-10-28-w21-p1-6-b2-pacing/postcheck.md): keep withDeadline's signature and 25 s budget (alerts uses it); the seam is the leads.cohort not_implemented stub at reporting.ts:62-69; use catalogScope.accountBindings (index.ts:336), not another services.accountBindings!; bootServer stays at complexity 10 (plain properties only).
3. Do NOT edit features/web-events (w22-newest-first-touch owns the newest-first read).
