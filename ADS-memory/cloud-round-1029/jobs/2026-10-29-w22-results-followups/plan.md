Software Architect(Direct): Persona loaded. Read-only plan; no files changed or checks run.

1. **Summary**

Replace reporting’s capped lead scan with a leads-owned SQL aggregate, so having more than 5,000 leads no longer makes campaign counts unavailable. Preserve creation-date filtering, frozen attribution, spam exclusion, and anonymous counts after erasure. Weekly snapshots will retain the same workspace-wide unattributed count beside campaign results. Calendar conversion and the weekly display/email gaps below need Coordinator resolution before complete delivery.

2. **Files**

Worker edit list:

- `features/leads/index.ts` — export cohort schemas and inferred types. (edit)
- `features/leads/src/schemas.ts` — validated range input and bounded aggregate output. (edit)
- `features/leads/src/ports.ts` — add one read method to the existing repository/service contract. (edit)
- `features/leads/src/service.ts` — expose the repository read. (edit)
- `features/leads/src/memory.ts` — reference aggregation behavior. (edit)
- `features/leads/src/sql.ts` — aggregate scoped lead counts inside SQL. (edit)
- `features/leads/tests/port-suite.ts` — shared memory/SQL cohort cases. (edit)
- `features/leads/tests/adapters.test.ts` — large SQL cohort, malformed results, failures, and PostgreSQL query assertions. (edit)
- `apps/server/src/composition/reporting.ts` — replace paging with the cohort read; preserve explicit zeros. (edit)
- `apps/server/src/alerts/rules.ts` — retain `workspaceUnattributed` in weekly snapshots. (edit)
- `apps/server/tests/p1-reporting-runtime.test.ts` — replace paging fixtures and ceiling assertion; preserve existing behavioral coverage. (edit)
- `apps/server/tests/weekly-report.test.ts` — snapshot count, unavailable, byte-bound, and replay regressions. (edit)
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-results-followups/progress.md` — build progress and verification record. (new)

No measure source edit is needed: its existing caller-owned cohort seam already accepts the required counts.

3. **Public contracts**

All new data types derive from Zod schemas.

- `LeadCohortInput = z.infer<typeof leadCohortInputSchema>`
- Input: `{ context, pluginId, accountId, createdAt: { start, end } }`; epoch milliseconds, half-open, maximum 32 elapsed days to accommodate reporting’s 31 calendar days across DST.
- `LeadCohortCounts = z.infer<typeof leadCohortCountsSchema>`
- Output: `{ counts: Array<{ campaign: CampaignKey, count: number }>, unattributed: number }`; at most 5,000 campaign groups.
- `LeadsRepoPort.readCohort(required: LeadCohortInput, optional?: CallOptions): Promise<Outcome<LeadCohortCounts>>`
- `LeadsService` inherits that method.
- `createSqlLeadsRepo(required: { unitOfWork: UnitOfWork }, optional?: { dialect?: StorageDialect }): LeadsRepoPort`; existing SQLite callers remain valid. PostgreSQL query replacement is the concrete second dialect.
- `bindReporting` changes its optional leads dependency to `Pick<LeadsService, 'readCohort'>`.
- `WeeklyReport` gains `workspaceUnattributed`, derived from the existing results schema; historical absence means unavailable.
- No new tool, HTTP route, CLI command, or alert variant.

4. **Approach**

1. **MAJOR:** Extend the existing leads port and its shared suite.
2. SQL filters owner/workspace, `created_at >= start AND created_at < end`, and `stage <> 'spam'`. Group by attributed campaign identity; count null attribution across the whole workspace. Exclude other attributed accounts/plugins.
3. Reuse published Jini JSON extraction for the TEXT attribution column. Compile the single aggregate query through Kysely using the existing `$n` SQL-session convention. Return aggregate rows only; detect group overflow with a sentinel row and never return partial totals.
4. Validate campaign keys and exact safe-integer counts, including PostgreSQL decimal-string counts. Retain erased and disqualified leads. Reuse existing cancellation, transaction, scope-validation, and redacted-failure behavior.
5. Replace `countLead` and the 50-page loop. Convert account-calendar dates to epoch bounds through the resolved published helper described under NEEDS. Merge explicit zeros for requested campaigns while retaining lead-only campaigns.
6. **MINOR:** Copy `CampaignResults.workspaceUnattributed` into `weeklyReportCandidate`. Reuse the existing weekly results read; add no second query.
7. Write regressions for boundaries, scopes, spam/erasure, empty cohorts, lead-only campaigns, more than 5,000 leads, cancellation, storage failures, and weekly zero/unavailable/replay behavior.
8. Finish with one package-scoped typecheck each for leads and server; one corrective rerun per failing package is permitted. Never run tests, builds, or `om:check`.

5. **Reuse**

- Cohort storage: extend `features/leads/src/{sql,memory,schemas}.ts` and `tests/port-suite.ts`; reuse `parseInput`, SQL `run`, `record`, and existing fixture hooks.
- Reporting: extend `leadCohort` in server composition; retain measure’s `VerifiedLeadCountsPort`, validation, campaign union, and unavailable mapping.
- SQL portability: installed `@jini-ai/db@0.6.15-rc.2`, `dist/kernel/dialect.{js,d.ts}`, exports `jsonText`; reuse installed `kysely@0.29.6` for compilation. Reject handwritten JSON extraction and JSON-string matching.
- Weekly snapshots: extend `weeklyReportSchema` and `weeklyReportCandidate`; retain `generateWeeklyReport`, notice persistence, deduplication, and existing tool transport.
- Sibling search: Tovu’s `apps/website/src/platform/db/kernel/dialect.ts` re-exports Jini’s helpers. Jini’s active clone has timezone conversion in `packages/daemon/src/routines/schedule.ts`; no callable equivalent was found in installed rc.2 exports. Do not copy it.
- The stale `/Users/la/Programming/Jini` tree was excluded as an API authority under the latest addendum. npm registry checks failed through both browsing and local DNS; installed distribution files supplied API evidence.

6. **Deliberately left out**

- No new port, factory, registry, cache, paginator, retry mechanism, telemetry, or migration.
- Keep the existing 5,000 **campaign-group** bound; remove the 5,000 **lead** ceiling.
- Preserve the unavailable path for actual failures or missing timezone evidence.
- No attribution repair, tracking/consent changes, charts, polling, or visitor data collection.
- **DEFERRED:** weekly Studio rendering and email enablement. Studio is outside this lane; weekly email currently has no enabled delivery path. Adding delivery/grant behavior would exceed these two small follow-ups.

7. **NEEDS**

- **Coordinator:** add runtime dependencies `@jini-ai/db@0.6.15-rc.2` and `kysely@0.29.6` to `features/leads/package.json`; update `pnpm-lock.yaml`. Worker must not edit either.
- **JINI ASK:** expose the existing DST-safe calendar-date → epoch-range conversion through a lightweight published entry. Coordinator must pin and verify the callable version before the reporting adapter is implemented; no unpublished import or OM copy.
- **Coordinator surface closure:** update `apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts`, `AlertsFeed.tsx`, and `apps/studio/tests/alerts.test.ts` to show “Unattributed leads — workspace-wide,” preserving zero/unavailable.
- **Coordinator scope decision:** weekly email is explicitly refused at `apps/server/src/alerts/email.ts:89`; generation supplies no email at `alerts/jobs.ts:81`. Enablement and its approved definition require separate scope.
- Coordinator rebuilds leads dist before authorized runtime validation. No shared-contract or migration-registration change is proposed.

8. **Unverified facts and risks**

- No vendor API assumptions or calls are involved.
- Calendar conversion is a pre-build dependency gap; the plan must not substitute UTC dates or fixed offsets.
- PostgreSQL execution remains unverified here. Use published dialect helpers and write query/result regressions; malformed or unsafe results return typed failures, never fabricated zero counts.
- **DISPUTED assumption:** an existing weekly email formatter can simply gain a line. Current code explicitly disables weekly email.
- Existing indexes constrain scope but do not index creation time. Start without a migration; database work may grow with workspace size, while application memory remains bounded by aggregate groups.
- Preserve old weekly notices without inventing missing historical counts.

9. **Size estimate**

One ≤90-minute build after prerequisites resolve: 12 source/test files plus the progress record. Approximately 150–190 source lines added and 40 removed; 180–220 test lines added and 60 removed, net approximately +230–310 lines. Weekly Studio/email closure remains explicitly deferred; no runtime or red/green result is claimed.