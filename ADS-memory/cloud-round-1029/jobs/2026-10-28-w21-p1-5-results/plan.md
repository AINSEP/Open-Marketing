Software Architect(Direct): W21-P1-5-RESULTS — one build run, ≤90 minutes.

**1. Summary**

Measure will show campaign spend, clicks and impressions beside OM lead counts, with platform conversions clearly separate. Lead-only campaigns and an explicit workspace unattributed bucket will appear without inventing zero metrics. Owners will see reporting dates, freshness, missing days, restatements and reconnect guidance. The assistant, HTTP transport, CLI and Studio will use the same reporting operations.

**2. Files**

All paths are relative to the repository root. Implementation edits only these files:

- `features/measure/src/reporting/metrics.ts` — (edit) extend the existing cohort contract.
- `features/measure/src/reporting/campaign-results.ts` — (edit) join lead-only campaigns and expose unattributed counts/model.
- `features/measure/tests/fixtures.ts` — (edit) align cohort fixtures.
- `features/measure/tests/metrics.test.ts` — (edit) reporting-join regressions.
- `apps/server/src/composition/reporting.ts` — (edit) replace the cohort stub using the existing leads service.
- `apps/server/src/composition/index.ts` — (edit) inject `forms.leads` and expose reporting to tools; zero complexity increments.
- `apps/server/src/om-tools.ts` — (edit) register results and campaign-refresh tools.
- `apps/server/src/om-tool-coverage.ts` — (edit) record connected reporting surfaces.
- `apps/server/tests/p1-reporting-runtime.test.ts` — (edit) cohort binding, bounds and restart fixtures.
- `apps/server/tests/weekly-report.test.ts` — (edit) align callers and demonstrate populated weekly lead counts.
- `apps/server/tests/om-tools.test.ts` — (edit) schema, scope and shared-transport assertions.
- `apps/studio/src/pages/measure/index.ts` — (new) export the page.
- `apps/studio/src/pages/measure/model/measure.hooks.ts` — (new) form state, bounded reads and display projection.
- `apps/studio/src/pages/measure/ui/MeasurePage.tsx` — (new) results table and evidence.
- `apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.hooks.ts` — (edit) export existing exact metric formatters.
- `apps/studio/src/widgets/workspace-canvas/index.ts` — (edit) publicly export those formatters for their second consumer.
- `apps/studio/tests/measure.test.ts` — (new) page regressions, using the existing `.ts` React-test pattern.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-28-w21-p1-5-results/progress.md` — (new during build only) completion ledger.

Other-lane changes are listed under NEEDS; this run remains entirely read-only.

**3. Public contracts**

- Extend existing `VerifiedLeadCountsPort.cohort({ context, pluginId, accountId, campaigns, days, timezone }, options?) → Promise<Outcome<VerifiedLeadCounts>>`.
- Derive `VerifiedLeadCounts` from its Zod schema: `{ counts: { campaign, count }[], unattributed: number }`. Counts include requested keys plus additional campaigns belonging to the selected plugin/account.
- Extend `campaignResultsSchema` with `attributionModel: "last_paid_touch_30d.v1"` and `workspaceUnattributed`, using the existing available/unavailable lead-result shape.
- Keep `campaignResults({ context, query, repo, leads, clock }, options?)` and existing campaign-row fields.
- Extend `bindReporting({ database, unit, host, clock, ids, observer, schedule, leads })`; `leads` is `Pick<LeadsService, "list">`.
- `om_measure_results({ query }) → CampaignResults`.
- `om_measure_refresh({ syncId, query }) → JobReceipt`; enqueue campaign grain through existing `reporting.enqueue`.
- `MeasurePage({ api, runtime })`; existing `metricText({ value? })` and `scaledMetricText({ value? })` become public presentation exports.
- HTTP: existing `POST /api/tools/call`. CLI: existing `om tools call <name> --input-file <path|->`. No additional route or command parser.

**4. Approach**

1. **MAJOR — bind cohorts.** Adapt `forms.leads.list`, keeping lead ownership behind its public API. Scan at most 50 pages × 100 leads; forward cancellation, reject repeated cursors and return `limit_exceeded` rather than partial counts.
2. Count leads whose **createdAt**, formatted in the account timezone, falls within the half-open reporting dates. Exclude erased/spam leads; retain other stages. Use frozen attribution, without recollecting identifiers or recomputing historical touches.
3. Return selected-account campaign counts and workspace unattributed enquiries. The latter includes captured enquiries without a consented paid touch; it does not estimate unrecorded visitors. Label its workspace scope and timezone, and never sum it across account views.
4. Extend the current join to union vendor campaigns with cohort campaigns. Validate duplicate/foreign keys and retain the 5,000-campaign bound. Lead-only rows have unavailable supported vendor cells, never fabricated zeros; unsupported cells remain absent.
5. Preserve vendor evidence when cohorts fail. Without an observed account timezone, show OM counts as unavailable and explain that reporting must first sync; never silently substitute UTC.
6. **MAJOR — expose both tools.** Derive inputs from existing reporting schemas. Refresh queues the existing admitted read-only capability; it introduces no approval card, scheduler, worker or spend authority. Expose reporting through straight-line composition assignments.
7. **MAJOR — Studio.** Reuse the integrations connection selector/status, with account ID and date inputs. Show the results table, separate platform conversions, attribution explanation, workspace bucket, coverage and observation evidence. Refresh acknowledges enqueue; a subsequent load reads persisted results. Reconnect links to existing Integrations.
8. **MINOR — weekly report.** Its existing `reporting.results` call automatically receives the bound counts. Update its fixtures/assertions; leave weekly snapshot structure unchanged.
9. Write regressions for timezone/DST boundaries, spam/erasure, lead-only and unattributed rows, explicit zero versus unavailable, scope isolation, pagination failure and malformed output. Finish with one typecheck each for measure, server and Studio; one corrective rerun allowed. Run no tests, builds or `om:check`.

**5. Reuse**

- Vendor evidence/join: extend `campaign-results.ts`; retain its BigInt arithmetic, dimension checks and observation lineage.
- Cohorts: reuse public `LeadsService.list` and its SQL/memory implementations. The existing port gains a production adapter; no new port or direct lead-table reader.
- Pagination: reuse the contracts `Page`/cursor protocol. Checked `readAddonCatalog` and installed Jini declarations; no reusable lead-page walker exists. Keep bounded iteration local to this adapter.
- Refresh: reuse `reporting.enqueue`, `reportingJob`, the jobs outbox and existing worker.
- Surfaces: reuse `serviceDefinition`, generic HTTP/CLI transport, `StudioApiPort.tool` and integrations readiness/status.
- Display: reuse weekly-report exact string formatters through the widget’s public entry; weekly and Results are the two consumers.
- Checked Jini `CAPABILITIES.md` and installed `@jini-ai/core`, `platform`, `ui` **0.6.15-rc.2**. No additional package is needed. Registry verification was attempted but blocked by DNS/tool access.
- No additional OSS dependency: native `Intl`, existing Zod and React suffice.

**6. Deliberately left out**

- New reporting slice, repository, registry, generic paginator, reconnect model or configuration layer.
- Charts, cross-account totals, FX, new CAC calculations, historical stage replay and attribution recomputation.
- Automatic polling/retries and recurring sync scheduling.
- Weekly unattributed-summary redesign and byte-cap changes; these require the alerts lane.
- **DEFERRED:** touch-order correction and page mounting require other-lane changes below.

**7. NEEDS**

- **Coordinator mount:** `apps/studio/src/app/shell/Shell.tsx` imports `MeasurePage` through its public entry and mounts it on `measure` beside existing Tracking setup. Widgets must not import upward into pages.
- **Coordinated last-touch fix:** assign `features/web-events/src/{sql,memory}.ts`, `features/web-events/tests/port-suite.ts`, `apps/server/src/composition/forms.ts`, and `apps/server/tests/ingress-worker.test.ts`. Change both adapters to newest-first and update the selector together; SQL-only reversal would make the current selector choose incorrectly. Include a >100-touch regression and serialize with the consent-gate job.
- No dependency install, manifest, lockfile, shared-contract change, migration or plugin rebuild.
- Coordinator retains the existing real-account reconciliation/release acceptance; fixtures cannot establish that result.

**8. Unverified facts and risks**

- Confirmed current gaps: cohort stub at `composition/reporting.ts:50`; vendor-only aggregation at `campaign-results.ts:66`; oldest-first read at `web-events/src/sql.ts:83`.
- **DISPUTED:** the old audit’s missing reporting-runtime finding is stale. Current `composition/reporting.ts` already implements enqueue/sync; preserve it.
- More than 5,000 workspace leads makes cohorts unavailable until a leads-owned filtered reader is assigned. Never display truncated totals.
- Before the first account observation, timezone-dependent counts remain unavailable. Lead-only rows become countable once reporting supplies account timezone evidence, including an empty metric batch.
- Pre-consent attribution already frozen by older code is not repaired here; coordinate with the consent-gate owner.
- No vendor API changes are proposed. Live reconciliation, tests and builds remain unperformed.

**9. Size estimate**

18 files: 11 source files, 6 test/fixture files and one progress document. Roughly +300–380/−35–60 source LOC and +230–300/−10–20 test LOC; net approximately +450–635 LOC. Budget: 25 minutes cohort/join, 15 tools/wiring, 25 Studio, 15 regressions and 10 typechecks/handoff.