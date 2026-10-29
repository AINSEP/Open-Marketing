Software Architect(Direct):

**1. Summary**

B2 will connect campaign status and pacing evidence to B1’s existing alert evaluation. Owners will see disapproval notices and daily overspend alerts through the feed and tools B1 supplies. Pacing will use current observed budgets and fresh stored metrics for the account’s local day. Missing evidence stays unknown, and month/lifetime comparisons remain disabled without attested history.

**2. Files**

All paths below are the complete proposed build lock list; no files change during this planning run.

- `apps/server/src/composition/alerts.ts` — (edit, after B1 creates it) join accounts/connections, read evidence, enqueue refreshes, preserve approvals.
- `apps/server/src/composition/index.ts` — (edit) pass existing dependencies into `bindAlerts`, adding zero bootServer branches.
- `apps/server/src/om-tools.ts` — (edit) widen `accountBindings` to the existing lookup/list intersection.
- `apps/server/src/composition/reporting.ts` — (edit) extract its injected 25-second deadline wrapper for reporting and alerts.
- `apps/server/src/addon-tools.ts` — (edit) extract the existing bounded page walk; retain catalog behavior.
- `apps/server/src/alerts/rules.ts` — (edit) add pure budget/metrics projection and reuse its account-local date calculation.
- `apps/server/src/alerts/index.ts` — (edit) export the projection function.
- `apps/server/tests/p1-alerts.test.ts` — (edit, after B1) integration, paging, refresh and deadline regressions.
- `apps/server/tests/alerts.test.ts` — (edit) budget projection and evidence-quality regressions.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-28-w21-p1-6-b2-pacing/progress.md` — (new) implementation ledger and final verification result.

**3. Public contracts**

No shared contracts, endpoints, tools or CLI commands are added.

- Extend `bindAlerts({ unit, clock, ids, confirmations, approver, accountBindings, database, reporting, host, schedule, observer })`; retain B1’s `{ sources, seed, list, acknowledge }`.
- `sources({ context, limit }): Promise<Outcome<AlertEvidence>>` remains the evaluator’s existing callback.
- `pacingEvidenceFromObservation({ campaign, observation, observedAt, days, now }): PacingEvidence | null`.
- `withCapabilityDeadline<T>({ schedule, work }, options?: CallOptions): Promise<Outcome<T>>`; `work({ signal })`.
- `readBoundedPages<T>({ readPage }, options?: CallOptions): Promise<Outcome<readonly T[]>>`; `readPage({ query: PageQuery }, options?)`.
- Types come from existing schemas and published feature exports; no copied status, budget or connection declarations.

The two helpers have current consumers: reporting + alerts for deadlines; catalog + account bindings + connection summaries for paging.

**4. Approach**

1. Wait for B1, then verify its resulting files against the approved review. Preserve its approvals, seed, acknowledgement and surface behavior.
2. Extend the existing page walker rather than introduce another loop. Retain limits of ten pages × 100 rows, cancellation and repeated-cursor detection; overflow returns `limit_exceeded`, never a truncated success.
3. In composition, page `listAccountBindings` and `listCredentialConnections`. Join by scoped connection identity; obtain `pluginId` from the summary and skip missing/non-connected connections. Read no credential secrets.
4. Read stored campaign-grain partitions through `reporting.repo.readDays`, validating them with `metricDaySchema`. Use a bounded 31-day window ending after tomorrow’s UTC date so account-local today is included. Deduplicate campaign IDs from those stored rows.
5. Enqueue one campaign-grain refresh per connected account/window/evaluation slot through `reporting.enqueue`. Derive a stable hashed `syncId` from scope, plugin, connection, account, window and slot. Use the stored timezone’s local-day window; without stored metadata, request the three UTC dates surrounding today. Do not run refreshes inline.
6. Invoke only catalog capability `campaign.status.v1`, with IDs discovered from stored metrics and the bound connection/account. Parse the response, reject unrequested campaign IDs and future observations, and never cache capability objects.
7. Share reporting’s injected deadline pattern. One 25-second budget covers the evidence collection, rather than resetting for each account; release the timer and reject late evidence after cancellation.
8. Map daily budgets exactly to `dailyMicros`, with `elapsedMonthMicros:null`. Map lifetime budgets to `totalMicros`, flight endpoints and `elapsedMicros:null`. Set `budgetCurrent:true` only from a valid status response obtained during this evaluation.
9. Populate `today` only from the selected stored campaign row for account-local today: matching account dimensions/currency, complete coverage, supported non-null spend, `fresh` flag, and recent retrieval/coverage timestamps. Use the existing 15-minute evaluation interval as the age bound. Otherwise keep it null.
10. Schema-check the projection against the existing 30-digit pacing limit. Oversized budget or spend omits that campaign’s pacing evidence; preserve its status evidence. Never truncate, round or convert micros through `Number`.
11. Keep `month` and `lifetime` null. Missing rows never become zero. If combined evidence exceeds the existing 100-campaign bound, return a typed gap instead of slicing.
12. Record per-account capability/evidence gaps through the existing observer, retaining valid approvals and other accounts. Listing failures, cancellation and aggregate overflow remain typed evaluation failures.
13. Write regressions covering paging/join isolation, disconnected skips, exact capability arguments, refresh replay identity, deadline cleanup, daily/lifetime mapping, 30/31-digit boundaries, local-midnight dates, stale/incomplete/mismatched/null spend, and resulting notices.
14. Update progress after each completed item. Finish with one `corepack pnpm --filter @open-marketing/server typecheck`, allowing one correction rerun. Run no tests, builds or `om:check`.

**5. Reuse**

- Enumeration: public workspaces `AccountBindingListPort`; credentials `listCredentialConnections` in `features/credentials/src/sql.ts`.
- Paging: extend `readAddonCatalog`’s existing walk in `apps/server/src/addon-tools.ts:137`.
- Stored evidence: `MetricsRepoPort.readDays`, `metricDaySchema`, and existing whole-day selection in `features/measure/src/adapters/sql-metrics.ts`.
- Refresh identity/outbox: `reporting.enqueue` and `reportingJob` in `composition/reporting.ts`; no second queue.
- Deadline: extend `composition/reporting.ts:52–63`; two actual callers justify extraction.
- Decisions/date/schema validation: existing `alerts/rules.ts`, `pacingEvidenceSchema`, capability catalog and status output schema.
- Fixtures: extend B1’s `p1-alerts.test.ts`; follow the existing reporting-runtime fixture and injected timer pattern.
- Checked Jini capability map and installed `@jini-ai/core` / `@jini-ai/platform@0.6.15-rc.2` declarations. `createDeadlineSignal` uses native timers, so retain the existing injected scheduler. No suitable domain projection was found.
- npm registry verification was attempted but blocked by tool/network access. No dependency addition or sibling-source reuse is proposed.

**6. Deliberately left out**

- **DEFERRED:** historical allocation tracking and month/lifetime alerts; current budgets do not attest past allocations.
- **DEFERRED:** evidence continuation beyond 100 campaigns; it needs evaluator pagination and exceeds this build.
- No new ports, registries, scheduler, settings, retries, vendor adapters or observability framework.
- No Studio/HTTP/CLI changes: B1 already exposes these notice kinds through the shared feed/tools.
- **DISPUTED:** account enumeration is no longer missing—`features/workspaces/src/ports.ts:28–30` provides it. Do not rebuild it.

**7. NEEDS**

- B1 must land and release the overlapping files before implementation.
- Coordinator must reserve every listed file, including the paging/deadline extraction owners.
- Installs, manifest/lockfile changes, shared contracts, migrations and plugin rebuilds: none.
- Existing host-discovery cancellation gap belongs to the host owner; do not expand this lane into `agent-plugin-backends.ts`.

**8. Unverified facts and risks**

- No vendor API behavior is introduced or assumed; malformed, refused or unavailable catalog output yields an evidence gap.
- Stored-only discovery misses campaigns absent from the lookback. Refreshes can discover them on a later evaluation.
- Published plugin freshness/coverage attestations remain upstream evidence; stale timestamps or incomplete coverage cannot trigger pacing.
- Reporting’s postcheck identifies cold module discovery that may outlast cancellation. The shared deadline prevents accepting late evidence but does not repair that host behavior.
- Tests will be written, not executed; runtime regression evidence remains pending permitted execution.

**9. Size estimate**

Ten files: seven source edits, two test edits and one progress file. Approximately **+280/−40 source LOC**, **+200 test LOC**, net **+440 code LOC**. Estimated implementation: **75–90 minutes**, including the server typecheck.