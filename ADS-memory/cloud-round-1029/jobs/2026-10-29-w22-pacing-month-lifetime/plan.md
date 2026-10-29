Software Architect(Direct):

**1. Summary**

Add lifetime-budget pacing alerts to the existing Alerts feed when complete spend history projects above the budget before flight end. Calculations use integer micros and account-local reporting dates; missing evidence produces no alert. Monthly pacing and plugin-local refresh windows lack the required declarations today. Continuation beyond 100 campaigns is deferred because it conflicts with the instruction to leave `accountEvidence` unchanged.

**2. Files**

- `apps/server/src/alerts/rules.ts` — (edit) lifetime evidence projection and strict projected-overspend comparison.
- `apps/server/src/alerts/index.ts` — (edit) export the lifetime projection alongside the existing daily projection.
- `apps/server/src/composition/alerts.ts` — (edit) bounded flight-history reads, refresh enqueueing and lifetime evidence collection.
- `apps/server/tests/alerts.test.ts` — (edit) projection, precision and missing-evidence regressions.
- `apps/server/tests/p1-alerts.test.ts` — (edit) history collection, refresh, failure isolation and persisted-notice regressions.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-pacing-month-lifetime/progress.md` — (new) implementation progress and verification record.

No other files are included in this build.

**3. Public contracts**

- Add `lifetimePacingEvidence({ campaign, observation, observedAt, partitions, now }): PacingEvidence | null`.
- Reuse the existing `PacingEvidence` schema, including lifetime `totalMicros`, `elapsedMicros`, `flightStart` and `flightEnd`.
- Keep `bindAlerts(required)` and all HTTP, tool, CLI and Studio contracts unchanged.
- No new port, factory, registry, dependency or shared type.

**4. Approach**

1. Implement lifetime pacing first, within one ≤90-minute build. Keep `accountEvidence` and `bootServer` unchanged.
2. Extend collection after existing daily/status evidence has been retained. Helpers own history reads and failures; a history failure must preserve daily, disapproval and pending-approval notices.
3. For lifetime observations, derive flight-start and current reporting dates using existing `accountLocalDay`. Reuse `reporting.repo.readDays` for campaign-grain history.
4. Adapt history reads to `readBoundedPages`: each page covers ≤31 calendar days, with the next date as its cursor. Its existing ten-page bound permits ≤310 days; older flights remain unknown, never partially summed.
5. Share history reads across eligible lifetime campaigns in the account. Reuse `refreshAccount` to enqueue those same bounded windows through reporting’s existing outbox and slot-based identities. Do not execute reports inline or request dates beyond the accepted UTC window.
6. Keep all work inside the existing single 25-second `withDeadline`. Forward cancellation throughout; discard late history and stop collection. Keep changed functions at complexity ≤10 and nesting ≤3.
7. Require every flight-to-date local day, a present campaign spend row, matching currency/timezone and complete coverage. Require historical coverage through each completed day and fresh current-day evidence with a known, recent `dataThrough`. Missing rows, null spend, stale evidence, inconsistent metadata and schema overflow remain unknown.
8. Sum spend with `bigint`. At reporting cutoff `T`, calculate `elapsedMicros = floor(totalMicros × (T − flightStart) / (flightEnd − flightStart))`. Comparing integer spend strictly above this allocation is equivalent to projecting above the total budget, without floating-point rounding.
9. Replace the existing lifetime 110% allocation threshold with that strict projected-excess comparison. Require an ongoing flight and positive elapsed coverage. Preserve daily rules and campaign/local-day deduplication.
10. Write regressions for equality versus one-micro excess, values beyond safe integers, missing days/rows, null versus explicit zero, currency/timezone inconsistency, local midnight/DST, stale or unknown coverage and flight boundaries.
11. Extend existing integration fixtures to demonstrate paged history, stable refresh identities, a lifetime notice through `evaluateAlerts` and the feed, and preservation of approvals/daily notices after history failure or cancellation.
12. Update progress after each completed item. Run only `corepack pnpm --filter @open-marketing/server typecheck` at completion; one correction rerun is allowed. Tests are written, never run.

**5. Reuse**

- History storage and validation: public `@open-marketing/measure` exports `MetricDay`, `metricDaySchema` and `MetricsRepoPort.readDays`; existing adapter enforces 31-day reads and 5,000 selected rows.
- Pagination: `apps/server/src/addon-tools.ts:149` `readBoundedPages`; no second pager or cursor codec.
- Deadline: `apps/server/src/composition/reporting.ts:37` `withDeadline`; no new timer mechanism.
- Refresh: `composition/alerts.ts:85` `refreshAccount`, plus existing reporting enqueue/outbox identities.
- Decisions: existing `accountLocalDay`, `comparable`, lifetime evidence schema and `lifetimeRules`; no parallel money/date library.
- Delivery: existing `evaluateAlerts`, notice persistence and `om_alerts_list` already feed HTTP, assistant tools, CLI and Studio.
- Searched Tovu application/packages and the current Jini integration tree for lifetime-budget projection, bounded paging and deadline implementations. Found no reusable lifetime projection; model-catalog pagination is provider-specific.
- Checked installed `@jini-ai/platform`, `core` and `cms` **0.6.15-rc.2** dist. Platform’s deadline helper lacks the injected scheduler/cancel handle required here; retain existing OM `withDeadline`. Source-only rc.3 APIs are excluded.
- npm registry verification was attempted but blocked by DNS/tool access. No new dependency is proposed; existing OM mechanisms suffice.

**6. Deliberately left out**

- **DEFERRED — campaign continuation:** `accountEvidence` discovers all IDs, rejects overflow and submits one status request (`composition/alerts.ts:114–121`). Leaving it unchanged prevents splitting that request. The evaluator also accepts only 100 campaigns, and notice append accepts 300 candidates; simply raising a limit is insufficient.
- **DEFERRED — monthly pacing:** `currentBudget` has only daily/lifetime arms (`packages/contracts/src/capabilities/index.ts:45`). Daily budgets do not establish monthly authority.
- **DEFERRED — plugin-local refresh windows:** no current plugin manifest declares a reporting freshness window. Do not invent metadata or vendor branches.
- **DEFERRED — history beyond ten 31-day pages:** retain the existing pager bound and report unknown coverage.
- No budget mutations, automatic stopping, new approvals, migrations, UI redesign or observability framework.
- **DISPUTED:** none of the specified deferred findings is already resolved.

**7. NEEDS**

- No installs, manifest changes, lockfile changes, migration registration or plugin dist rebuilds for the proposed lifetime build.
- **Coordinator follow-up — continuation:** reconcile “keep `accountEvidence` unchanged” with permission to replace its single status invocation/overflow path with helper delegation, then plan evaluator continuation while retaining bounded evidence and append batches. Do not add a bypass adapter.
- **CONTRACTS follow-up — exact proposed monthly arm:**
  `z.strictObject({ kind: z.literal("monthly"), amountMicros: metricValuesSchema.shape.spend.unwrap().unwrap(), currency: moneySchema.shape.currency, days: metricDaysSchema })`
  Document `days` as the exact account-local calendar month and the amount as its campaign-attributable whole-month budget. This build skips monthly support.
- Serialize the listed files against other alerts jobs.

**8. Unverified facts and risks**

- Google documents campaign-total budgets using `CUSTOM_PERIOD`, `total_amount_micros`, explicit flight dates and non-shared attribution. Consume the existing normalized contract. [Google documentation](https://developers.google.com/google-ads/api/docs/campaigns/budgets/create-budgets)
- Microsoft documents `LifetimeBudgetStandard` as a budget distributed across campaign duration. Do not infer lifetime budgets from daily or calculated monthly limits. [Microsoft documentation](https://learn.microsoft.com/en-us/advertising/campaign-management-service/budgetlimittype?view=bingads-13)
- Meta’s primary campaign references returned rate-limit/timeout failures; exact lifetime-field semantics remain unverified here. No new Meta mapping is proposed. Missing or invalid normalized lifetime budget/flight evidence suppresses pacing. [Meta campaign reference](https://developers.facebook.com/docs/marketing-api/reference/ad-campaign-group/)
- Projection is an OM linear forecast, not a claim that vendor delivery is linear or will exceed its enforced cap.
- History may initially be absent; refresh jobs make later evaluations eligible. Preserve the accepted UTC+ midnight gap.
- Runtime verification remains pending. No files were edited and no tests or typechecks were run during planning.

**9. Size estimate**

Six files: three source, two test, one progress record. Approximately **220–280 source LOC** and **140–180 test LOC**, replacing roughly **10–20 lines**; net approximately **+340–450 code/test LOC**. One ≤90-minute build; continuation and the conditional monthly/window work remain deferred.