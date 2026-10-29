# OM test-quality audit — 2026-10-25

OM has useful behavioral tests for exact approvals, lease fencing, uncertain writes and consent ordering. The inspected suite is not merely mocks asserting against mocks. Its weakest evidence is narrower: some negative cases can fail for the wrong reason, some assertions inspect unrelated fixtures, and a few safety integration scenarios remain unproven.

The owner can use the findings below to assign small test repairs, then commission a bounded cloud run with execution artifacts. No tests, builds, installs, indexing, migrations or vendor calls were performed for this audit. Current passing status and mutation effectiveness are **unverified**.

## Scope and provenance

- Job: W2-TESTQ, B1; approved `ADS-memory/.local-artifacts/codex-runs/2026-10-25-w2-test-quality/plan.md`. Its `review.md` says review was skipped and to build directly from the plan.
- Primary audited revision: `om/cleanup-1025`, `4659d9607032330de5a03342050e728fe224c6f6`, initially clean. Inventory and line references below refer to that revision, not an eventual merged tree.
- Concurrent jobs subsequently changed jobs, policy, server composition/tests, studio and other lanes; HEAD also advanced during inspection. Those edits were preserved. Later changes require a fresh audit delta; they are not certified by this report.
- Method: direct reads and `rg`, following the owner's load rule; no graph/index tools. Suspect-pattern matches were investigation leads, not findings by themselves.
- Deep inspection: selected policy, safety, jobs, credentials, privacy, measure, server dispatch/subject-lane/ingress and Google/Meta cases, together with their implementations and fixtures. The case ledger below makes this sample explicit.
- Scanned only: remaining test-file inventory, scripts, skip/only markers, selected development gates and historical UI/plugin failures. Unreviewed semantically: most studio/desktop/agent cases, other feature suites and other vendor plugins.
- Binding interpretation: October 13 owner decisions, October 25 architecture debate including round 3/owner decisions, `development/COMMON.md` and job ownership. Raw round-2 proposals do not override those decisions. Exact spend remains per call; unrestricted uploaded plugins are not represented as sandboxed.
- Reused input: `ADS-memory/.local-artifacts/codex-runs/2026-10-24-test-quality/tovu-test-guidance.md`; both historical reports discussed below. Adopt behavior-level assertions and independent mutation testing, not Tovu's baselines or hand-written mutation sweep.

## Inventory: files are not executed cases

Read-only source-tree enumeration and the tracked tree at the audited revision both yielded **248 test/spec files**. Dependencies, generated `dist`, coverage and framework/memory repositories were outside this inventory. Helpers such as `generation-suite.ts` register cases through entry files and are not extra test files.

| Area | Files | Selection/runner evidence |
|---|---:|---|
| `features/*` | 94 | Each of 16 feature package scripts uses `vitest run tests` |
| `packages/*` | 10 | contracts 7, om-clock 1, om-db 2; `vitest run tests` |
| `apps/*` | 56 | server 29, studio 20, agent 4, desktop 3; `vitest run tests` |
| `content/agent-plugins/*` | 81 | 21 plugin roots; normally `vitest run io.github.ainsep.openmarketing/tests` |
| `development/tests` | 5 | Root `om:gate-tests` = `vitest run development/tests` |
| `development/parked/*/tests` | 2 | render and segments; outside workspaces/runtime and active test selection |

Of these, **246 are active script candidates**, including 5 development gates; this is not proof of runner discovery or body execution. No literal `it/test/describe.skip`, `.todo` or `.only` marker was found in the inventoried files; dynamic selection and failed collection remain possible.

`pnpm-workspace.yaml` includes only `apps/*`, `packages/*`, `features/*`. Thus workspace recursion alone misses all 81 plugin test files and the root development gates. Root `package.json` has no all-suite `test` script. `om:check` includes gates, not every package/plugin suite.

Google Ads is the runner exception: its root `test` script is `node --test io.github.ainsep.openmarketing/tests/*.test.ts` (6 files). Higgsfield's outer script delegates into its nested package. That nested package is the same suite, not an additional run to count twice. No confirmed active file outside its declared script selection was established statically; actual undiscovered files remain unknown until artifact reconciliation. Desktop was explicitly excluded from the cleanup cloud run, not proved green.

## Historical cloud reports reconciled with source

Both inputs are under `ADS-memory/.local-artifacts/codex-runs/2026-10-25-test-fixes/`:

| Report | Provenance and limitations | What it establishes |
|---|---|---|
| `2026-10-25-cloud-test-checkpoint.md` | `om/clean-slate`; exact SHA not recorded in that report. Node v24.2.0, pnpm 10.24.0; setup installed dependencies and built only contracts. | Jobs 10/10, measure 7/7, privacy 2/2 and server 23/30 files had collection failures from missing dependency output. Their bodies did not run. x-ads was uncollectable from unresolved `oauth-1.0a`, described as skipped. Package totals 13 passed/11 failed/1 skipped are package outcomes, not case execution totals. |
| `2026-10-25-cleanup-branch-tests.md` | Head `55cf681`, predecessor DC1 `e4c1024`; attribution baseline `5e6e0e2` fully rebuilt separately. Packages/features built; agent plugin bundles not all built. | More bodies became runnable. Historical jobs 197, measure 215 and privacy 42 passed as reported; server had 92/713 failures. Missing Meta bundle remained environmental. Matching failure sets on the rebuilt baseline support that report's DC1/OB2 attribution conclusion only. |

The checkpoint cannot establish regressions in code it never collected. The cleanup report cannot establish results for unselected plugins, desktop, gates or later revisions. Neither input supplies the raw per-case artifacts needed here to independently reconstruct a repository-wide body count.

TF1–TF5 are present before the audited revision (`2b4b172`, `06785e3`, `c175e54`, `040dd54`, `4659d96`). Historical failures are leads, not automatically outstanding defects:

- Credentials now explicitly rejects a populated revoked developer token before decryption (`features/credentials/tests/token.test.ts:178`; `src/token.ts:99`). That is a stronger regression test than the older clear-then-revoke sequence.
- CLI usage now parses the JSON payload instead of asserting property order (`apps/server/tests/cli/cli.test.ts:428`). Preserve that repair.
- Safety SQL tests now preserve/redact driver codes and inject a failed insert (`features/safety/tests/contract/sql.test.ts:68`); this improves diagnosis but does **not** prove the historical seven SQL failures are resolved. TF2 also changes the paid-sending timeout; an increased timeout alone is not correctness evidence.
- TF3–TF5 address media/server fixtures, UI/transport expectations and vendor schema/fingerprint cases. Their commit descriptions are not fresh execution results.
- The cleanup report's x-ads explanation says the test's JSON-body signing expectation disagreed with source. TF1's later commit says the test was correct and fixes query signing. Preserve that provenance conflict; this audit does not adjudicate OAuth correctness or copy the earlier diagnosis as fact.

## Prioritized findings

Severity ranks consequence if the missing protection matters; it does not mean a production failure was reproduced. **Confirmed** means the assertion/fixture limitation follows from source. **Inferred gap** means no matching scenario was found in the inspected suites, not a repository-wide absence proof. Proposed broken implementations below are static counterexamples, not executed mutants.

| ID / severity | Source/test and protected behavior | Weakness, confidence and plausible accepted regression | Smallest recommended correction |
|---|---|---|---|
| Q1 / High | `features/safety/tests/acceptance/final-authority.test.ts:5`, “authority expiring during the reservation prevents transport handoff”; fixture `tests/fixtures.ts:63` | **Confirmed adapter gap.** Both backend labels explicitly use `createMemoryConfirmationExchange`; “sql” changes the safety repository only. A SQL confirmation adapter caching an accepted answer past expiry during reservation is not exercised here. Standalone SQL expiry and server tool-operation tests are useful, but do not combine this boundary. | Add this one scenario with real SQL confirmations plus SQL reservations and an injected clock; expire at the exact boundary while reserve is paused; assert zero dispatch and preserved accounting. Do not duplicate the whole acceptance suite. |
| Q2 / High | `apps/server/tests/agent-plugin-jobs.test.ts:411,464,475,586`; `src/composition/privacy.ts:94` and `agent-plugin-backends.ts:258` | **Inferred integration gap.** Actual dispatch races withdrawal/merge; erasure is tested after it already committed. Ingress separately tests atomic erasure/restart. A `requestErasure` implementation bypassing the shared lane while dispatch holds it could pass those separate scenarios. No paused-provider/erasure race was located in this sample. | Adapt the existing admission-to-fetch barrier test to call real `bindPrivacy().privacy.requestErasure`. Verify it cannot commit before the held attempt completes, then commit suppression/cancellation and show a fresh claimed delivery makes zero sends. |
| Q3 / Medium | `features/credentials/tests/token.test.ts:166`, “fails the whole list on malformed or foreign-scope storage rows”; `src/sql.ts:45` | **Confirmed shadowed negative case.** After rejecting a foreign-owner row, the test changes its status to invalid without restoring its owner. Removing status validation while retaining scope validation still satisfies the second denial. The title's malformed-row protection is weaker than implied. | Use separate otherwise-valid rows for invalid status and foreign scope; also assert a valid control returns the complete page. Keep whole-page failure expectations. |
| Q4 / Medium | `features/safety/tests/acceptance/properties.test.ts:5`, “concurrent bounded generations conserve allowance across arbitrary amounts”; `src/repository.ts:49`, `src/state.ts:88` | **Confirmed weak oracle.** The sum is derived from returned reservation amounts. A broken repository that admits every request but returns zero amounts satisfies this property, even when requested totals exceed 1000. Under-cap length assertions do not detect that corruption. Other fixed acceptance tests reduce the overall risk. | Join accepted operation IDs to the generated request amounts, sum that independent oracle, assert each returned reservation matches its request and identities are unique. Retain seed/shrinking and existing fixed contention tests. |
| Q5 / Low | Meta `io.github.ainsep.openmarketing/tests/reporting.test.ts:15`, “preserves append-only restatement lineage without editing the earlier snapshot”; `src/reporting.ts:23` | **Confirmed vacuous sub-assertion/overclaim.** Only a clone with spend `13.00` is passed to the decoder; `expect(row.spend).toBe('12.34')` inspects the untouched original. Mutating the actual supplied row still passes that assertion. No earlier snapshot is persisted by this test. | Describe this as decoder lineage propagation; assert the actual supplied input is unchanged if that is the intended property. Credit append-only storage to measure's existing memory/SQL repository suite, rather than add another fake database. |
| Q6 / Low | Meta `tests/contract/gateway-suite.ts:131`, “has no admitted capability merely because the plugin is enabled”; `src/adapter.ts:43,75` | **Confirmed disconnected observation.** `f.calls` belongs to an unused fixture; the invoked adapter has a different throwing gateway. Its zero length is guaranteed regardless of gateway use. The typed denial assertion still protects behavior, so the entire test is not a tautology. | Count/spy on the gateway actually injected into `adapter`, and assert its call count is zero alongside the typed denial. |
| Q7 / Low | `features/safety/tests/acceptance/properties.test.ts:7` and `spend-suite.ts:122`; `tests/contract/port-suites.ts:118` | **Confirmed failure-path cleanup weakness.** Several harnesses close only after assertions, and some deferred gates release only on the success path. A reservation/assertion failure skips SQL close; a failure before a gate resolves can produce cascading timeout noise. This is consistent with, but does not prove the cause of, the historical timeout. | Use the existing `afterEach` fixture pattern or `try/finally`; release deferred gates and settle launched work in cleanup. No sleeps, timeout inflation or new lifecycle framework. |

Meta shorthand above is rooted at `content/agent-plugins/meta-ads/`; source paths without a package prefix in a row are relative to the named package. These are test-quality recommendations, not authorization to edit those lanes in W2-TESTQ.

### Mocks, tautologies and false positives

No whole-test tautology or mocked unit under test was confirmed in the selected safety/policy/jobs cases. `toBe(true)`, call counts and injected failures are not inherently bad: a zero-egress assertion is exactly the relevant observable for denial. Q5/Q6 identify specific disconnected assertions, not a heuristic condemnation of every similar pattern.

`features/jobs/tests/contract/memory.test.ts` precomputes the transport-result-to-state mapping before configuring a memory dispatcher. Its shared `JobDispatchPortSuite` mapping case alone therefore cannot validate the production mapping. The same suite also runs against `createJobHandlerRegistry` in `contract/handlers.test.ts`; that is the meaningful production mapping evidence. Count the memory run as double conformance, not independent proof of worker retry policy.

Likewise, measure capability adapters wrapped around memory capabilities prove adapter validation/forwarding, not vendor correctness. The server conversion fixture (`agent-plugin-jobs.test.ts:183`) loads real policy/contacts and calls the real decision adapter, but supplies in-memory grants, a memory delivery ledger and synthetic erasure status. Preserve those seams; do not present them as durable production grant/erasure-evidence wiring.

Development source/manifest checks legitimately test architectural artifacts, not runtime egress. The selected Google catch path deliberately injects receipt loss; no catch-and-ignore assertion failure was confirmed. No suite-wide mock/tautology percentage is justified by this sample.

## Selected case ledger and useful counterexamples

These 22 entries record static inspection, not 22 executed cases; parameterized/shared cases expand at collection. Paths are relative to each named package. Related implementation/fixture files were inspected to distinguish production behavior from a test-owned model.

| # | Package, test location / case | Production seam and assessment |
|---:|---|---|
| 1 | policy `tests/dispatch.test.ts:26`, durable processing suppression | `src/dispatch.ts`, `gates.ts`: compares suppression against sharing-only control; valuable |
| 2 | policy `tests/dispatch.test.ts:54`, alias withdrawal order/expiry | Real pure decision with consent/lineage permutations; valuable aggregate adversary |
| 3 | policy `tests/dispatch.test.ts:120`, malformed evidence matrix | Real boundary schema/lineage validation; explicit denied reasons |
| 4 | jobs `tests/outbox.test.ts:115`, authorization outlives lease | `src/outbox.ts`: injected clock reaches exact expiry; stale result plus zero transport |
| 5 | jobs `tests/outbox.test.ts:194`, unknown/idempotent retry exhaustion | `src/retry.ts`: asserts retry then reconcile; useful distinction from permanent failure |
| 6 | jobs `tests/contract/store-suite.ts:69`, token/tenant/state/expiry fences | `src/adapters/memory-store.ts`, `src/sql.ts`: unchanged shared suite, both beginDispatch and completion |
| 7 | jobs `tests/contract/intent-suite.ts:44`, writer exception rollback | `src/transactions.ts`, `src/adapters/memory-transactions.ts`; `tests/transactions.test.ts` checks intent and claim state |
| 8 | jobs `tests/sql-faults.test.ts:74`, file-backed pre/post-dispatch restart | Real SQLite close/reopen, uncertain states cannot be reclaimed; stronger than factory recreation |
| 9 | safety `tests/acceptance/spend-suite.ts:8`, distinct exact cards | `src/service.ts`, confirmation/repository; card reuse cannot authorize changed operation |
| 10 | safety `tests/acceptance/spend-suite.ts:39`, reviewed values at transport | Real withDispatch plus captured outbound request, digest/argument tampering denied |
| 11 | safety `tests/acceptance/spend-suite.ts:99`, concurrent approvals | One winner and reserved balance 600; protects observable accounting, not merely calls |
| 12 | safety `tests/acceptance/properties.test.ts:5`, arbitrary amounts | Real repo/storage adapters with fast-check, but Q4 oracle and Q7 cleanup limits |
| 13 | safety `tests/acceptance/final-authority.test.ts:5`, expiry during reserve | Real final recheck and zero callback; Q1 limits the SQL label |
| 14 | safety `tests/contract/port-suites.ts:118`, competing answers | `src/confirmation.ts`, `sql-confirmation.ts`: caller/callback mutation, one winner, immutable evidence |
| 15 | credentials `tests/token.test.ts:166`, foreign/malformed page | Real `src/sql.ts` with injected DB rows; Q3 masks independent malformed-row protection |
| 16 | credentials `tests/token.test.ts:178`, populated token revoked | Real `src/token.ts`/broker/repo, both backends; decrypt trap and subsequent writes denied |
| 17 | privacy `tests/service.test.ts:113`, lost checkpoint replay | Real `src/service.ts`; participant caches effects in test fixture. Proves stable replay identity, not a restarted external adapter's durability |
| 18 | measure `tests/delivery.test.ts:207`, “rechecks consent after the last asynchronous audit boundary” | `src/delivery/dispatcher.ts`, service fixture: real worker decision, zero delivery after injected withdrawal |
| 19 | server `tests/subject-lane.test.ts:32`, stale lineage during merge | Real contacts/lane; effects remain zero; later retry sees the complete family |
| 20 | server `tests/agent-plugin-jobs.test.ts:411`, dispatch/alias withdrawal race | Real SQL and shared lane around actual injected fetch; order plus subsequent denial, not only a mutex unit test |
| 21 | Google `tests/capabilities.test.ts:11`, shared lifecycle/scoping | `src/plugin.ts`, REST transport, MCP adapter; helpers use injected HTTP and a genuine local stdio child, with cleanup |
| 22 | Meta `tests/reporting.test.ts:15`, restatement | Real pure decoder with independent expected amount; persistence claim/input mutation assertion limited by Q5 |

Google shorthand is rooted at `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/`; Meta ledger shorthand at the analogous plugin inner directory. Repository source names above identify the implementation, not a claim that every branch in those files was assessed.

Additional strong evidence: measure's `tests/contract/port-suites.ts:72` runs immutable snapshot lineage checks through both memory/SQL registrations; `tests/reporting.test.ts:75` checks both retained observations. Server `tests/ingress-worker.test.ts:367,392,416` covers family erasure/restart, three atomic rollback faults and crash-state recovery. SQL confirmation `tests/contract/sql.test.ts:135` checks answer/audit rollback together. These protections must not be removed to improve scores.

## Safety-path coverage assessment

| Invariant | Existing useful evidence | Remaining limit / next focused evidence |
|---|---|---|
| Exact card, digest, identity and per-call spend | Safety spend/confirmation suites; server durable tool operations | Q1 integration case; existing SQL tool-operation tests do not substitute for delayed-reservation expiry |
| Expiry/revocation at dispatch | Final-authority expiry, confirmation revoke/reopen, populated credential revocation | Mutate final checks; obtain fresh execution evidence before release |
| Halt versus normal write/conversion | safety spend suite; server `agent-plugin-jobs.test.ts:260,298,340` | Account barrier tested with injected transport, not a real account; preserve zero-egress assertions |
| Generation allowance contention | Fixed concurrent winner/balance cases plus seeded property | Q4 independent amount oracle; memory and SQLite are serializable local adapters, not cloud multi-process proof |
| Lease expiry and stale acknowledgement | Outbox/shared-store fence suites; server final-evidence expiry case | Exercise in cloud after dependency builds; no current pass claim |
| Unknown outcomes, no blind retry | Jobs outbox/SQL-faults, Google reconciliation and one-write assertions | Mutation testing supplements these; vendor reconciliation remains fixture evidence |
| Atomic intent plus sole outbox | Jobs domain-intent suite, server transactional acceptance | Strong local fault injection; no second queue proposed |
| Withdrawal, erasure and merge lineage | Policy permutations, subject-lane conflicts, server withdrawal/fetch ordering and ingress erasure rollback/restart | Q2 real erasure/active-dispatch race; supplied erasure values do not prove a future durable evidence loader |

The accepted guarantee is “no send starts after withdrawal commits,” not recall of an in-flight request. Subject lanes are single-process. Hosted/multi-process safety, owner-account Google/Meta ±1% reconciliation and a correctly attributed lead remain outside these fixtures and outside this job; they cannot be replaced by a mutation score.

## Three-target mutation pilot, deferred to a separate cloud job

Use StrykerJS's existing [Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/), not a custom mutator. Its documentation requires a separately installed compatible Vitest and notes related-test selection can miss indirectly invoked integration paths. Verify exact published Stryker/Vitest/TypeScript/Node versions and peer ranges before any integrator-owned dependency change; compatibility with pinned Vitest 3.2.4 is not established here.

| Priority | Initial mutation scope | Existing tests / representative mutation and expected signal |
|---|---|---|
| 1 | `features/policy/src/dispatch.ts`, then `src/gates.ts` | `tests/dispatch.test.ts`, `gates.test.ts`: remove durable suppression, change half-open expiry, ignore alias withdrawal or accept duplicate/foreign lineage; explicit denied/allowed controls should kill them |
| 2 | `features/safety/src/service.ts`, `src/confirmation.ts`; limit pilot to authority checks | final-authority, spend and shared confirmation suites: remove final confirmation recheck, skip argument binding, allow broad spend grants or treat expiry as inclusive; require zero-egress tests and Q1 before interpreting SQL confidence |
| 3 | `features/jobs/src/retry.ts`, `src/outbox.ts`; then bounded fence logic in `src/sql.ts`/`src/adapters/memory-store.ts` | outbox/shared-store/SQL-fault suites: unknown becomes retry, ignore idempotency, remove lease recheck, change due/expiry equality or token comparison; expect state and transport assertions to fail |

Begin with target 1 in isolation, one mutation worker, a clean baseline and captured selected-file/case inventory. Proceed to the next target only after reviewing survivors and runtime cost. Use package-local tests and verify the mutator loads instrumented source rather than stale exported `dist`. Disable related-only selection for a pilot relying on indirect server invocation, or explicitly prove the integration tests were selected.

Exclude tests, fixtures, generated bundles, vendor code and parked applications from the **mutation target**, not from normal test/coverage scope. Start small without declaring unmutated first-party source exempt. No new coverage ignores, reduced validation or changed behavior to kill mutants.

Publish killed, survived, no-coverage, timeout, compile-error and runtime-error counts, target files, selected tests, tool versions and exclusions beside any score. Review possible equivalent mutants explicitly; do not silently drop survivors or treat timeout/compile failure as an assertion kill. Mutation testing does not prove schedule interleavings, process recovery, account reconciliation, complete requirements or vendor behavior. Keep deterministic barrier/fault tests.

Reuse check: Jini `CAPABILITIES.md` lists `@jini-ai/devops/checks/coverage`, but no installed `node_modules/.pnpm/@jini-ai+devops@0.6.12*/.../dist` exists here. That working-tree map is not proof of a published usable export. No helper was copied/installed, and registry/version suitability remains deferred. Existing Vitest reporting and OM shared port suites suffice for this report.

## Count cases that completed in a later authorized cloud run

This is a procedure to hand off, not commands executed here. Reuse runner reports; do not build another runner or count `it(` strings.

1. Freeze the reviewed SHA and record dirty state, Node/pnpm versions, lockfile hash, command, cwd, selection filters and each exit status. Re-enumerate expected test files at that SHA; keep parked, deferred and unselected files in separate lists with reasons. Current parallel work makes the 248-file baseline unsuitable as a permanent threshold.
2. In that separately authorized cloud environment, use the frozen lockfile and prepare dependencies/required plugin artifacts. Build dependency packages needed by public exports, not just contracts. `om:build-plugins` currently covers only five plugins; it is not proof that all selected plugin artifacts exist. Confirm prerequisites before attributing collection errors to tests.
3. Run each selected package/plugin once sequentially, with bounded Vitest workers and Node test concurrency. Record the nested Higgsfield delegation only once. Keep default console diagnostics, stderr and JSON for Vitest; keep TAP plus stderr for Google. Artifacts must have unique absolute paths, never one shared output filename.
4. For example, with an existing writable absolute `ARTIFACT_ROOT`, from the repository root the Vitest command can be:

   ```sh
   corepack pnpm --filter @open-marketing/safety exec vitest run tests --maxWorkers=2 --no-file-parallelism --reporter=default --reporter=json --outputFile.json="$ARTIFACT_ROOT/safety.json"
   ```

   Use each package's actual script selection, including root `development/tests`, explicit plugin directories and an explicit desktop decision. From `content/agent-plugins/google-ads`, retain its existing Node runner with TAP output:

   ```sh
   node --test --test-concurrency=1 --test-reporter=tap --test-reporter-destination="$ARTIFACT_ROOT/google-ads.tap" io.github.ainsep.openmarketing/tests/*.test.ts
   ```

5. Read Vitest `testResults[].name` and leaf `assertionResults[]`, keyed by package + relative file + full name + location/occurrence. Count parameter rows as cases; count nested suites separately. Tally passed, failed, skipped and todo from leaf results, with collection/module errors separately from case failures. Do not count a file status or `numTotalTestSuites` as a body.
6. Inspect file/suite/hook diagnostics before calling failed leaves executed bodies. A beforeAll/beforeEach failure can leave cases unstarted; an after-hook failure differs. Report `runner_completed_leaves = passed + failed`, then separately report confirmed body completions and ambiguous hook-related leaves. Never label their sum “tests actually ran” without that qualification. Duration alone does not prove body execution. Vitest JSON cannot by itself prove every failed leaf entered its body.
7. Parse TAP structurally: leaf tests only; do not add parent suite/file summaries again. Respect SKIP/TODO directives, cancellation/timeout and child-process/collection failures. A file crashing before defining tests is a collection failure, not one executed behavioral case. Preserve diagnostic YAML and compare footer counts; do not grep every `ok`/`not ok` line into a total.
8. Reconcile expected files against artifact files and command selection. A selected file missing from output, a malformed/missing report, unexpected duplicates, incomplete/bailout process, collection errors or zero completed cases makes evidence **incomplete**, even with exit 0. Unselected files are “not run,” not passed or silently skipped. Keep retries as separate attempts; never add attempts to unique-case counts.
9. Deliver one per-package table: expected/selected/reported files, registered leaves, passed, failed, skipped, todo, cancelled, collection errors, hook-ambiguous leaves, confirmed body completions, unselected files, exit status and artifact paths. Unknown counts stay unknown; runner-reported outcomes and confirmed body execution remain separate columns. Reconcile the leaf totals with raw runner summaries before aggregating.

The installed `vitest@3.2.4/dist/chunks/index.VByaPkjc.js` `JsonReporter` was read directly: it emits `assertionResults`, file errors in `message`, and suite/leaf totals separately; its `onFinished` ignores its `_errors` argument. Keep process status/stderr for unhandled errors. The [Vitest v3 reporter documentation](https://v3.vitest.dev/guide/reporters) also describes JSON artifacts; prefer the pinned implementation over newer-version defaults. No new reporter dependency is needed.

## Handoff and verification limits

- Changed output: this report only; source LOC 0, test LOC 0. Documentation classification: standalone audit evidence. No contracts, adapters, manifests, composition, dependencies, fixtures, migrations or coverage rules changed.
- Architecture/scope audit: PASS for the report-only lane; recommendations preserve public feature entries, injected seams, one outbox and owner policy. This is not a runtime architecture certification.
- Tests written: none, as required by the single-report scope. Tests run: none. Red/green, coverage percentages and mutation scores: unavailable, not claimed.
- Supplied final check: `ls ADS-memory/reports`. It lists files only; it is not a TypeScript typecheck and establishes no compiler/test result.
- NEEDS: Coordinator to assign Q1–Q4 focused follow-up ownership, consider the lower-priority assertion/cleanup repairs, then request cloud execution and artifact reconciliation at a frozen SHA. Stryker installation/version verification belongs to a separate integrator job.
- Deferred: all repairs and new tests, execution artifacts/count implementation, Stryker setup/runs, exhaustive semantic audit, external-adapter/process guarantees and owner-account reconciliation. No additional files or session/progress artifacts were created by this job.
