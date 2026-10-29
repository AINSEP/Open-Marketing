# Progress: 2026-10-29-w22-results-followups (Builder B, cloud round 2026-10-29)

Built from review.md APPROVED SCOPE + COORDINATOR OVERRIDE. This job was built after w22-gate-minors (on main) and w22-pacing-month-lifetime (built just before it in this round). Only this job's hunks were added to `rules.ts` and `weekly-report.test.ts`; their work is preserved.

## Scope items

1. DONE: leads reader (FIX 1).
   - `features/leads/src/schemas.ts`:
     - `cohortSchema`: half-open `createdAt`, 0 < span ≤ 32 days.
     - `leadCohortCountsSchema`: ≤5,000 campaign groups plus `unattributed`.
     - `LeadCohortInput` / `LeadCohortCounts` are `z.infer` types.
     - IDs reuse the `campaignKeySchema` shapes (rather than `opaqueId`), so every stored attributed key can be returned.
   - `ports.ts`: `LeadsRepoPort.readCohort`; `LeadsService` inherits it.
   - `service.ts`: delegates to the repo.
   - `index.ts`: exports the schemas and types.
   - `sql.ts`: two parameterized aggregate queries using plain `json_extract`, inside the existing `run` transaction.
     - Spam is excluded; erased and disqualified leads are counted.
     - The query uses `LIMIT 5001`; 5,001 groups return `limit_exceeded`, never a truncated result.
     - Rows are Zod-parsed; a malformed row returns a redacted `unavailable`.
     - No migration and no `created_at` index.
   - `memory.ts`: the same semantics, done in memory.
   - Tests:
     - `tests/port-suite.ts` (memory + SQLite): half-open bounds (`end - 1` in, `end` out, before excluded); spam excluded; erased and disqualified counted; foreign plugin and foreign account excluded; null campaign → unattributed; another workspace isolated; empty cohort → `{ counts: [], unattributed: 0 }`; a range over 32 days or an empty range → `invalid_input`; aborted → `cancelled`.
     - `tests/adapters.test.ts` (SQL): 5,001 leads in one campaign counted exactly (native bulk insert); 5,001 groups → `limit_exceeded`; malformed stored campaign ID → redacted `unavailable`.
   - The leads dist was rebuilt (`pnpm --filter @open-marketing/leads build`).
2. DONE: reporting seam (FIX 2) in `apps/server/src/composition/reporting.ts`.
   - Removed `countLead`, the 50-page `list` loop and the `Lead` import.
   - Added `localDayStart({ day, timezone })`: a bisection over [day−15h, day+13h] using `accountLocalDay` (shape of safety `nextRollover`). An invalid timezone gives null, which maps to `unavailable`. It is exported, as a pure function, so tests can exercise the invalid-timezone path; a stored batch can never carry an invalid timezone.
   - `leadCohort`:
     - computes `createdAt` from the local day starts and calls `readCohort`;
     - requested campaigns start at 0, overlaid by the returned counts; lead-only keys are kept;
     - failures pass through; absent `leads` keeps `not_implemented`.
   - `bindReporting`'s optional type is now `{ leads?: Pick<LeadsService, 'readCohort'> }`. `composition/index.ts` is not edited.
   - Tests in `apps/server/tests/p1-reporting-runtime.test.ts`:
     - (a) the LA DST day calls `readCohort` with `start = 2026-03-08T08:00Z`, `end = 2026-03-09T07:00Z`;
     - (b) explicit 0, and a lead-only row;
     - (c) a reader failure leaves the cells and `workspaceUnattributed` unavailable with the reader's code, and the vendor metrics are kept;
     - (d) absent leads keeps `not_implemented`;
     - (e) `localDayStart` across DST, UTC+14 and UTC−12, and an invalid timezone gives null.
     - The tool/refresh test was switched to a `readCohort` fake. The old `list`-pager fixtures and the 50-page test were removed.
3. DONE: weekly snapshot (FIX 3) in `apps/server/src/alerts/rules.ts`.
   - `weeklyReportSchema.workspaceUnattributed` is optional; `weeklyReportCandidate` copies it in.
   - Tests in `weekly-report.test.ts`: available and unavailable values are carried; a stored candidate without the field still parses; the existing max-size case stays ≤32,768 bytes (passing).
4. DONE: Studio line (FIX 4).
   - `AlertsFeed.hooks.ts`: a shared `leadCountSchema`, optional `workspaceUnattributed`, and a `weeklyDisplay.unattributed` text: the count, `Unavailable (<reason>)`, or `Unavailable` when the field is absent.
   - `AlertsFeed.tsx`: a "Unattributed enquiries (workspace-wide): …" line.
   - Test in `apps/studio/tests/alerts.test.ts`: an available count of 2 shows "2"; an older notice shows "Unavailable".
5. DONE: typechecks (below).
6. DONE: report.md (NEEDS).

## DEFERRED

- Weekly email line: `alerts/email.ts:89` refuses `weekly_report`, and generation sends no email (review CUT 4).
- `created_at` index: none until a measured slow query appears (OWNER DECISION 2).
- PostgreSQL dialect / Kysely / `@jini-ai/db` `jsonText`: CUT 1. The leads schema is SQLite-only today.

## TYPECHECK

- `pnpm --filter @open-marketing/leads typecheck`: PASS.
- `pnpm --filter @open-marketing/studio typecheck`: PASS.
- `pnpm --filter @open-marketing/server typecheck`: src PASS. The tests config has errors only in `tests/ingress-worker.test.ts` (`PublicInput.consent`). That comes from the concurrent consent job's `inbound/public.ts`; it was not touched or fixed. A transient `om-tools.test.ts` error from another builder's in-flight edit cleared on rerun.
- eslint on all touched files: PASS, except one error that was already present: `AlertsFeed.tsx:45` `renderObservation(text: string)` fails `om/two-object-arguments`. HEAD has the same error; it is not this job's line. Recorded as FOLLOW-UP.

## TESTS

- `pnpm exec vitest run tests` (features/leads): 31/31 passed.
- `pnpm exec vitest run tests/p1-reporting-runtime.test.ts tests/weekly-report.test.ts` (apps/server): 15/15 and 12/12 passed.
- `pnpm exec vitest run tests/alerts.test.ts` (apps/studio): 5/5 passed.

## FILES

features/leads/{index.ts, src/schemas.ts, src/ports.ts, src/service.ts, src/memory.ts, src/sql.ts, tests/port-suite.ts, tests/adapters.test.ts}, apps/server/src/composition/reporting.ts, apps/server/src/alerts/rules.ts (weekly hunks only), apps/server/tests/p1-reporting-runtime.test.ts, apps/server/tests/weekly-report.test.ts, apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts, apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.tsx, apps/studio/tests/alerts.test.ts, progress.md, report.md. features/leads/dist was rebuilt (untracked build output).

NET LINES: +217 −92 (excluding progress/report)
