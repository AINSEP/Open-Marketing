### 2026-10-29-w22-results-followups: verdict READY TO COMMIT (committed in ca2d393 together with w22-pacing-month-lifetime; FOLLOW-UPs only)

Reviewer R2, 2026-10-29. Hunks attributed by LOCKS-FILES:
- features/leads/**
- composition/reporting.ts
- the weekly hunks of alerts/rules.ts (L46-47, L72, L82)
- p1-reporting-runtime.test.ts and weekly-report.test.ts
- the Studio AlertsFeed files and alerts.test.ts

Ledger:
1. Leads reader (FIX 1): FIXED.
   - schemas.ts:26-32: `cohortSchema` is half-open with 0 < span ≤ 32 d. `leadCohortCountsSchema` allows ≤5,000 groups. Types are `z.infer`.
   - ports.ts:14-16 adds `readCohort`. service.ts:40 delegates to it. index.ts exports it.
   - sql.ts:54-65: plain parameterized `json_extract` aggregates inside `run`, with `LIMIT 5001` → `limit_exceeded` (never truncated). Rows are Zod-parsed, and a malformed row gives a redacted `unavailable`.
   - Erased and disqualified leads are counted. There is no migration.
   - memory.ts:76-91 has the same semantics.
   - Tests:
     - port-suite (memory + SQL): every listed case is present.
     - adapters.test.ts: 5,001 leads in one campaign are counted exactly, 5,001 groups give `limit_exceeded`, and a malformed row gives `unavailable`.
2. Reporting seam (FIX 2): FIXED.
   - `countLead`, the 50-page loop and the `Lead` import are deleted.
   - `localDayStart` bisection (reporting.ts:24-33) returns null for an invalid timezone, which maps to `unavailable`.
   - `leadCohort` (:40-52): requested campaigns are explicitly 0, lead-only keys are kept, and failures pass through. Absent leads keeps `not_implemented`.
   - `bindReporting` takes `Pick<LeadsService,'readCohort'>`. index.ts is not edited.
   - Tests (a)-(e) are present. The DST assertion pins 08:00Z/07:00Z exactly.
3. Weekly snapshot (FIX 3): FIXED.
   - The `workspaceUnattributed` field is optional and is copied in `weeklyReportCandidate`.
   - Tests: an old notice without the field still parses, and the max-size test still passes.
4. Studio line (FIX 4): FIXED.
   - AlertsFeed.hooks.ts: the shared `leadCountSchema` and `unattributedText` show "Unavailable" for old notices, never 0.
   - AlertsFeed.tsx: one line.
   - alerts.test.ts covers both cases.
5. Typecheck: FIXED. leads PASS (progress.md). R2 re-ran server (src + tests) and studio: both PASS.
6. report.md NEEDS: FIXED. It covers the leads dist rebuild, the optional JINI ASK, and the DEFERRED items (weekly email, `created_at` index).
7. COORDINATOR OVERRIDE (the 5,000 cap on groups only; merge on top of the gate-minors and pacing hunks in rules.ts; typecheck scope): FIXED. The pacing and gate-minors work in rules.ts is preserved.

Outside lane: none. No features/measure edit, no index.ts edit, no package.json or lockfile change.

New:
- [MINOR] features/leads/src/sql.ts:54-63: no `created_at` index.
  - Both aggregates scan every row of the workspace that matches owner and workspace, once per (account × cohort read). With many accounts and large lead tables, each results/weekly read costs O(workspace leads) inside SQLite.
  - This is accepted per OWNER DECISION 2. FOLLOW-UP only if a measured slow query appears.
- [MINOR] features/leads/src/memory.ts:89 vs sql.ts:63: the two adapters sort differently.
  - The memory adapter sorts by JS UTF-16 code units; SQL `ORDER BY campaign` uses BINARY (UTF-8 bytes). The order differs only for campaign IDs with astral-plane characters.
  - Result content is unaffected, and the measure join is by key. No fix.
- [MINOR] reporting.ts:24: `localDayStart` is exported from composition only so tests can reach it.
  - It runs about 27 `Intl.DateTimeFormat` constructions per bound, through `accountLocalDay`. That is acceptable at one cohort read per account.
  - FOLLOW-UP covered by the optional JINI ASK in report.md.
- Checked and clean:
  - No vendor names in core; "google-ads" appears only in leads test fixtures.
  - No caching.
  - Complexity and nesting are within limits (R2 eslint run: PASS; the only error, AlertsFeed.tsx:45 `renderObservation`, predates this job).
  - Counts use `epochSchema` integers, not money.
  - `bootServer` untouched.
  - The tests can fail, for example on exact createdAt bounds and exact counts.

Disputes/deferrals:
- The weekly email line is DEFERRED-OK: email.ts refuses `weekly_report` and generation sends no mail (review CUT 4).
- Postgres/Kysely is DEFERRED-OK per CUT 1. Note that job.md asked for "Postgres-safe" SQL. `json_extract` is SQLite syntax, but the leads schema is already SQLite-only, so that requirement is consciously waived by the review.
- The `created_at` index is DEFERRED-OK (OWNER DECISION 2).
- Leads dist: it is gitignored and was rebuilt locally. The Coordinator NEEDS stays: rebuild on the target machine, because runtime resolves `./dist/index.js`. Without it, `forms.leads.readCohort` is undefined at runtime and every cohort read throws, which surfaces as `unavailable`.

Typecheck: server and studio PASS (R2 re-run); leads PASS (progress.md). Tests re-run by R2:
- features/leads: 31/31;
- server p1-reporting-runtime and weekly-report: pass (within 67/67, together with the pacing files);
- studio alerts: 5/5.

Small fixes: none.
