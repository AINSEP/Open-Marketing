# Trim review: 2026-10-29-w22-results-followups
VERDICT: APPROVED WITH CUTS

No coordinator-note.md exists. The plan's shape is right:
- one leads-owned aggregate read on the existing port;
- reporting's cohort seam calls it;
- the weekly snapshot copies the existing `workspaceUnattributed`;
- no measure source edit.

The seam is confirmed against the built P1-5 code. `leadCohort` + `countLead` in apps/server/src/composition/reporting.ts:18-55 page `leads.list` ≤50×100 and return `limit_exceeded` at :54. `bindReporting(required, optional?: { leads?: Pick<LeadsService,'list'> })` is at :94-97, and index.ts:370 passes `{ leads: forms.leads }`. measure's `VerifiedLeadCountsPort.cohort` (features/measure/src/reporting/metrics.ts:39-41) already takes `{ context, pluginId, accountId, campaigns, days, timezone }` and returns `{ counts, unattributed }`, so measure needs no change.

The plan over-builds the SQL portability, and it blocks itself on a Jini ask it doesn't need. Both are cut below.

CUTS:
1. **Kysely + `@jini-ai/db` `jsonText` + the new `dialect?: StorageDialect` option on `createSqlLeadsRepo`, and the Coordinator NEEDS to add `@jini-ai/db`/`kysely` to features/leads/package.json and the lockfile.**
   - These add two runtime dependencies and a dialect parameter for ONE query.
   - OM's SQL adapters already read JSON TEXT columns with plain `json_extract`: features/web-events/src/sql.ts:26, features/jobs/src/sql.ts:170, apps/server/src/composition/catalog.ts:123-146, apps/server/src/model-usage.ts:56-57.
   - The leads schema itself is SQLite-only (triggers in features/leads/migrations/0001_leads.sql). No Postgres adapter exists, so a "PostgreSQL query replacement" has no caller.
   - Use plain parameterized SQL with `json_extract` (FIX 1). No package.json or lockfile change.
2. **"PostgreSQL query assertions" in features/leads/tests/adapters.test.ts.** They follow from CUT 1. Also drop the Postgres decimal-string special-casing beyond one `Number(...)` → `epochSchema` parse (FIX 1).
3. **The JINI ASK that blocks the build ("Coordinator must pin and verify the callable version before the reporting adapter is implemented").**
   - Converting account-local dates to epoch bounds needs no new mechanism.
   - The server already exports `accountLocalDay` (apps/server/src/alerts/rules.ts:89-96, re-exported at alerts/index.ts:2).
   - OM already locates a local-day transition by bisection: features/safety/src/state.ts:43-53 `nextRollover`. It isn't exported from safety's public index, so mirror its 6-line loop using `accountLocalDay` (FIX 2).
   - The plan names a Jini source-only helper (ai-traces-jini `packages/daemon/src/routines/schedule.ts`). Under the ctx-wave-1029 JINI SOURCES OF TRUTH, a source-only API is at most a NEEDS note, never a build blocker. Keep it as an optional "JINI ASK / after rc.3" line.
4. **Weekly email line.** DISPUTED correctly by the plan: weekly email is explicitly refused at apps/server/src/alerts/email.ts:89, and generation sends no email (alerts/jobs.ts:62-90). DEFERRED. No email edit.
5. **A separate "replay regression" for the weekly snapshot.** Weekly dedup is by `fingerprint(['weekly', target, days])` (rules.ts:78) and doesn't involve the new field. Keep only the snapshot-content and old-notice-compatibility assertions (APPROVED SCOPE 4).

FIXES:
1. **Leads reader (features/leads/src/{schemas,ports,service,memory,sql}.ts).**
   - schemas.ts:
     - `cohortSchema = z.strictObject({ context: callContextSchema, pluginId: opaqueId, accountId: opaqueId, createdAt: z.strictObject({ start: epochSchema, end: epochSchema }).refine(r => r.end > r.start && r.end - r.start <= 32 * 86400000) })`. 32 days covers 31 local days plus DST.
     - `leadCohortCountsSchema = z.strictObject({ counts: z.array(z.strictObject({ vendorCampaignId: opaqueId, count: epochSchema })).max(5000), unattributed: epochSchema })`.
     - Return `vendorCampaignId` only. The plugin/account are the query's own, so don't make leads build measure's `CampaignKey`.
     - Types are `z.infer`.
   - ports.ts: add `readCohort(required: z.infer<typeof cohortSchema>, optional?: CallOptions): Promise<Outcome<LeadCohortCounts>>` to `LeadsRepoPort`. `LeadsService` inherits it through the existing `Omit` (ports.ts:20).
   - service.ts:37-40: add `readCohort: (input, options) => repo.readCohort(input, options)`.
   - sql.ts: inside the existing `run` (sql.ts:18-30, one transaction, a consistent snapshot), two parameterized queries:
     - `SELECT json_extract(attribution,'$.campaign.vendorCampaignId') AS campaign, COUNT(*) AS count FROM lead WHERE owner_id=$1 AND workspace_id=$2 AND created_at>=$3 AND created_at<$4 AND stage<>'spam' AND json_extract(attribution,'$.campaign.pluginId')=$5 AND json_extract(attribution,'$.campaign.accountId')=$6 GROUP BY campaign ORDER BY campaign LIMIT 5001`
     - `SELECT COUNT(*) AS count FROM lead WHERE owner_id=$1 AND workspace_id=$2 AND created_at>=$3 AND created_at<$4 AND stage<>'spam' AND json_extract(attribution,'$.campaign') IS NULL`
     - 5001 rows → `failure({ code: 'limit_exceeded' })`. Never truncate.
     - Parse rows with Zod (`count: Number(row.count)` → `epochSchema`); malformed rows fall into `run`'s catch → `unavailable`.
     - Erased and disqualified leads ARE counted (P1-5 OWNER DECISION 1); there is no `erased` filter.
     - No migration. Existing indexes cover owner/workspace only, and a scan inside SQL is acceptable at OM scale. Note it under RISKS.
   - memory.ts: the same semantics over `leads.values()`, filtered by `sameScope`, half-open `createdAt`, `stage !== 'spam'`, and null campaign → unattributed. Add the >5,000-group check.
2. **Reporting seam (apps/server/src/composition/reporting.ts).**
   - Delete `countLead` (:18-34), the 50-page loop (:36-55) and the `Lead` type import (:8).
   - Replace them with:
     - `localDayStart(required: { day: string; timezone: string }): number | null`. Bisect `[Date.parse(day) - 15h, Date.parse(day) + 13h]` for the first instant whose `accountLocalDay(...) >= day`. Use the same loop shape as features/safety/src/state.ts:44-53. Return null on an invalid timezone, which the caller maps to `unavailable`.
     - `leadCohort(required: { leads?: Pick<LeadsService,'readCohort'>; query })`:
       - absent `leads` keeps the `not_implemented` failure at :41;
       - compute `start`/`end` with `localDayStart` for `days.start`/`days.end`;
       - call `leads.readCohort({ context, pluginId, accountId, createdAt: { start, end } }, options)`;
       - pass failures through;
       - map the result to measure's shape: requested `query.campaigns` start at 0, overlaid with returned counts, plus lead-only keys built as `{ pluginId, accountId, vendorCampaignId }`; `unattributed` passes through.
     - Each function ≤10. The existing `metricsBoundary` in measure still converts throws to `unavailable`.
   - Change `bindReporting`'s optional type at :97 to `{ leads?: Pick<LeadsService, 'readCohort'> }`. index.ts:370 already passes `forms.leads`, which is a `LeadsService`, so index.ts is NOT edited and bootServer is untouched.
3. **Weekly snapshot (apps/server/src/alerts/rules.ts:38-46, :67-80).**
   - Add `workspaceUnattributed: campaignResultsSchema.shape.workspaceUnattributed.optional()` to `weeklyReportSchema`. Optional, because notices stored before this change must still parse in `alertCandidateSchema`: email.ts:86, the alert list, and Studio.
   - In `weeklyReportCandidate`, copy `parsed.value.workspaceUnattributed` into `report`.
   - Recheck the byte comment at rules.ts:36-37 against the existing max-size weekly test. The addition is ≤80 bytes.
4. **Studio parity (owner rule: Studio, HTTP, om-tool and CLI close together).** The alert list's HTTP, tool and CLI output carry the candidate JSON automatically. Studio needs one line:
   - apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts:8-14 `weeklySchema` (non-strict `z.object`): add `workspaceUnattributed: <the same available/unavailable union already used for verifiedLeads at :13-14>.optional()`.
   - `weeklyDisplay` (:41): add `unattributed`, showing the count, `Unavailable (<reason>)`, or `Unavailable` when absent (old notice).
   - AlertsFeed.tsx `WeeklyReport` (:32-43): one `<p>Unattributed enquiries (workspace-wide): {…}</p>`.
   - It is a small in-repo extension of an existing display, with no new page. Precedent: the P1-5 review made its Shell mount in scope for the same parity reason.

REUSE:
- Aggregate read transaction, scope parse and redacted failures → features/leads/src/sql.ts:18-30 `run`, schemas.ts:31-38 `parseInput`/`failure`.
- JSON column reads → plain `json_extract`, precedents features/web-events/src/sql.ts:26 and apps/server/src/model-usage.ts:56-57.
- Account-local day → apps/server/src/alerts/rules.ts:89 `accountLocalDay`; bisection shape → features/safety/src/state.ts:44-53 `nextRollover`.
- Cohort port and union/zero/unavailable semantics → features/measure/src/reporting/metrics.ts:39-41 and campaign-results.ts:91-125 (unchanged).
- Shared repo tests → features/leads/tests/port-suite.ts `leadsRepoSuite` (memory + SQL).
- Weekly display → AlertsFeed.hooks.ts `weeklyDisplay` and its existing verifiedLeads union.

DUPLICATES:
- Grouped JSON aggregate / cohort counter: none in published rc.2 besides `@jini-ai/db` `jsonText`.
  - jsonText is at node_modules/.pnpm/@jini-ai+db@0.6.15-rc.2*/…/dist/kernel/dialect.d.ts:11. It is a Kysely `RawBuilder`, so reusing it requires Kysely and a dialect object (CUT 1).
  - It solves Postgres portability that OM's leads schema doesn't have.
  - Not adopted. OM's in-repo `json_extract` precedent is used instead.
- Local-date → epoch: no published rc.2 export (the plan's own search agrees). There is a source-only helper in ai-traces-jini `packages/daemon/src/routines/schedule.ts`. OM already has the bisection pattern (safety `nextRollover`), so FIX 2 reuses OM code. Optional NEEDS: "JINI ASK (after rc.3): publish a DST-safe local-date → epoch helper; OM's reporting `localDayStart` can then switch."
- Tovu: `apps/website/src/platform/db/kernel/dialect.ts` only re-exports Jini's helpers. Nothing new.

OWNER DECISIONS (defaults):
1. **Cohort semantics stay exactly P1-5's.** Creation date in the account timezone; spam excluded; erased and disqualified counted; one workspace-wide unattributed bucket. The 5,000 cap now applies to campaign GROUPS (rare), never to leads.
2. **No created_at index migration.** Default: none. Add one only if a measured slow query shows up (it would then need migrations.ts registration NEEDS).
3. **Old weekly notices** without the field show "Unavailable", never 0.

APPROVED SCOPE for B1 (priority order; update progress.md after each item):
1. Leads reader (FIX 1): schemas.ts, ports.ts, service.ts, memory.ts, sql.ts, index.ts (export `cohortSchema`/`leadCohortCountsSchema` and the inferred types).
   - Tests (written, not run) in tests/port-suite.ts, run on both adapters:
     - half-open boundaries (a lead at `end - 1` is in, a lead at `end` is out);
     - spam excluded; erased and disqualified counted;
     - foreign plugin and foreign account excluded;
     - null campaign → unattributed;
     - another workspace isolated;
     - an empty cohort gives `{ counts: [], unattributed: 0 }`;
     - a range of more than 32 days gives `invalid_input`;
     - aborted signal → `cancelled`.
   - Tests in tests/adapters.test.ts (SQL only):
     - more than 5,000 LEADS in one campaign count exactly. Insert the rows through the fixture's native handle, not 5,001 captures;
     - 5,001 campaign groups give `limit_exceeded`;
     - a malformed row gives `unavailable`.
2. Reporting seam (FIX 2): apps/server/src/composition/reporting.ts. In apps/server/tests/p1-reporting-runtime.test.ts, replace the `list`-pager fixtures and the 50-page test (:211-283) with `readCohort` fakes:
   - (a) America/Los_Angeles, days 2026-03-08 → 2026-03-09: `readCohort` is called with `createdAt.start = Date.parse('2026-03-08T08:00:00Z')` and `end = Date.parse('2026-03-09T07:00:00Z')`. This is the DST-day regression.
   - (b) A requested campaign absent from the reader shows an explicit 0; a lead-only key becomes a row.
   - (c) A reader failure leaves the cells and `workspaceUnattributed` unavailable with that code.
   - (d) Absent `leads` keeps `not_implemented`.
   - (e) An invalid timezone gives `unavailable`.
   - Keep the tool/refresh test (:307+) and switch its fake to `readCohort`.
3. Weekly snapshot (FIX 3): apps/server/src/alerts/rules.ts. In apps/server/tests/weekly-report.test.ts:
   - the snapshot carries available and unavailable `workspaceUnattributed`;
   - a stored candidate WITHOUT the field still parses;
   - the existing max-size case stays ≤32,768 bytes.
   - Align the :204/:208 cohort stubs only if their types change (they don't: the measure port is unchanged).
4. Studio line (FIX 4): apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts and AlertsFeed.tsx. In apps/studio/tests/alerts.test.ts: a weekly notice with `{ status:'available', count: 2 }` shows "2"; one without the field shows "Unavailable".
5. Typecheck once each, with one corrective rerun allowed: `@open-marketing/leads`, `@open-marketing/server`, `@open-marketing/studio`. NO tests, builds, om:check or installs.
6. report.md, with these NEEDS:
   - Coordinator rebuilds the leads dist before runtime validation (runtime resolves ./dist/index.js, features/leads/package.json:12);
   - the optional JINI ASK line above;
   - DEFERRED: weekly email (email.ts:89 refuses weekly_report), created_at index.

LOCK OVERLAP (Coordinator):
- **apps/server/src/alerts/rules.ts and apps/server/tests/weekly-report.test.ts are also edited by w22-gate-minors.** That job changes the `weeklyReportCandidate` comparator at rules.ts:75, deletes the weekly re-exports at alerts/index.ts:4-5, and adds a 'Z'/'a' tie test.
- **rules.ts is also edited by w22-pacing-month-lifetime** (lifetime pacing evidence/rules, :16-18 and :126-164).
- Both are approved and waiting on w14-alerts. Build this job AFTER both, then re-read rules.ts and weekly-report.test.ts and add only this job's hunks. This job does not touch alerts/index.ts.
- reporting.ts sits under w13-server-composition, and P1-5 also took w14-alerts for it. The lock order below covers both.

LOCKS-FILES: features/leads/index.ts, features/leads/src/schemas.ts, features/leads/src/ports.ts, features/leads/src/service.ts, features/leads/src/memory.ts, features/leads/src/sql.ts, features/leads/tests/port-suite.ts, features/leads/tests/adapters.test.ts, apps/server/src/composition/reporting.ts, apps/server/tests/p1-reporting-runtime.test.ts, apps/server/src/alerts/rules.ts, apps/server/tests/weekly-report.test.ts, apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts, apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.tsx, apps/studio/tests/alerts.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-results-followups/progress.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-results-followups/report.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-results-followups/typecheck.txt (lock groups: w14-alerts, w13-server-composition, w16-studio-chat, w18-leads)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted (5,000 cap on campaign groups only; P1-5 cohort rules unchanged).
2. w22-gate-minors and w22-pacing-month-lifetime also edit apps/server/src/alerts/rules.ts and weekly-report.test.ts: re-read those files at build start and merge on top; never revert their work.
3. Typecheck: drop the leads/measure package typechecks if those packages are not edited; server + studio typechecks once each.
