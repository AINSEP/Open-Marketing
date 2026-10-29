# Programmer(Direct): j08 safety handoff

Safety reviews exact tool arguments, requires a separate owner response for every distinct spend call, rechecks current evidence and authority at final handoff, and holds an account barrier through transport so completed halt blocks later normal writes. Only a configured authenticated backend can obtain a closed pause/stop permit. Generation defaults to USD $10/day in the owner's injected local timezone, atomically counts pending exposure, and appends observed costs and linked corrections.

Public usage and complete configuration are in [README.md](README.md): `prepareApproval` → `ConfirmationExchangePort.confirm` → `withDispatch`; `haltAccount`; `getGenerationAllowance`/`assessGeneration`; `reserveGeneration`/`settleGeneration`. `authorizeDispatch` is admission evidence, not a transport bypass. No vendor call is built into the feature.

## CHANGED FILES

- `index.ts`, `src/types.ts`, `src/ports.ts`: retained initial public methods and added the minimal safety-owned confirmation, allowance, quote/stop verification, settlement and transport-barrier seams.
- `src/service.ts`: all service methods, immutable boundary snapshots, exact approval and final authority rechecks, cap admission, typed backend stop, scope generation/settings/cost barrier and trace propagation.
- `src/memory.ts`, `src/confirmation.ts`, `src/memory-store.ts`: every owned domain port's scoped double, explicit owner responses, bounded FIFO lock/cancellation, append-only audit and transactional state.
- `src/rules.ts`, `src/state.ts`, `src/state-schema.ts`, `src/repository.ts`: bounded canonical digests, decision rules, local-calendar/DST rollover, retry/concurrency accounting, strict durable parsing and append-only corrections/settings history.
- `src/sql.ts`, `migrations/0001_safety.sql`: injected DB adapter, portable parameterized SQL, CAS snapshot and atomic journal writes.
- `tests/fixtures.ts`, `tests/contract/{port-suites,memory.test,sql.test}.ts`, `tests/acceptance/{baseline.test,behavior.test,spend-suite,generation-suite,stop-suite,properties.test,final-authority.test,boundary.test}.ts`: shared behavioral B1/acceptance suites, real ephemeral SQLite, race barriers, property tests and regression evidence.
- `package.json`, `tsconfig.json`: Node 24 promise typing, integrity-aware build wrapper; removed unused pg/PGlite dependencies.
- `README.md`, `PROGRESS.md`, `HANDOFF.md`: API, integration obligations, progress/constraints and evidence.

Manual edits are confined to `features/safety`. Required tools generated scoped dist/receipts; the workspace metric command also generated its standard `.tmp/om-metrics.json`. No source edits occurred in other lanes, root tooling, apps, shared contracts or the lockfile. Temporary bootstrap test resolution configuration was removed.

## TESTS

Final command evidence and coverage are recorded below after the final run. All Corepack commands used `COREPACK_HOME=/private/tmp/om-corepack` because the default cache was not writable.

Shared B1 runs against memory and actual ephemeral SQLite; the entire spend/generation/halt-stop service acceptance suite also runs unchanged against both. Test-only SQLite uses Node's bundled driver; production is an injected server port intended for better-sqlite3. Tests capture transport arguments and call counts, and use deterministic barriers rather than timing sleeps. Property tests use seed 8008, 30 runs per adapter, 1–12 competing reservations/run.

RED → GREEN regressions retained: j00 halt/read-policy/lock stubs; future matching generation grant; approval expiring during SQL/memory reservation; duplicate settlement ledger entries; backend run ID forwarding; SQL observer throw escaping typed outcomes; contradictory owner scope at the repo; mismatched quote argument/configuration or understated upper bound becoming an exact-spend bypass. No certified tests were deleted/weakened. Absence stubs were extended into behavior suites per dispatch.

## CONTRACTS

The required `createSafetyService` dependency object remains unchanged. Optional injected policy/TTL/service identity configuration was added. Existing exported service methods remain, plus `withDispatch`, `getGenerationAllowance`, `reserveGeneration`, and `settleGeneration`. A permit-only API cannot enforce a barrier at actual transport; the callback seam is necessary to close that ordering gap.

`EffectRequest` adds optional `operationScope` and `generation: { request, quote }`; omitted operation scope cannot create broad grants. This fixes the missing admitted-tool scope and frozen quote/configuration linkage without modifying shared DTOs. `FrozenGenerationRequest` remains unchanged.

`ConfirmationExchangePort` adds `confirm` and `verify` and optional server classification/policy revision on `present`; presenting a card alone must never be authority. `VerifiedEffectResolverPort` adds verified quote provenance and backend stop checks; self-reported plugin metadata cannot establish either. `SafetyRepoPort` adds durable halt/settings/allowance/reservation/settlement reads and mutations; reserve requires independently verified admission and otherwise fails closed. New reservation/settlement/admission types and SQL/digest exports are exposed only at `index.ts`.

Memory factories now require injected time/IDs where needed, and the repo requires explicit owner timezone. The old `{}` constructors could not safely implement expiry, accounting or local-midnight semantics. The confirmation and audit doubles expose narrowly scoped fixture helpers. No envelope/reallocation authority API or table was introduced. Initial input contracts were reread before verification and no conflicting j00 update was found.

## MIGRATIONS

`migrations/0001_safety.sql` adds `safety_state`, `safety_journal` and a scoped journal index. Snapshot updates are projections; journal evidence appends. Corrections reference original observations; setting edits preserve before/after values. State and journal writes commit atomically. Migration was applied only to new ephemeral test databases, never any live/persistent product database. Owner's never-applied-schema decision permits this table organization.

## RISKS

- Production auth, plugin/cap/quote admission, durable confirmation exchange, credential checks and final transport are injected integration responsibilities. Doubles confer no real vendor authority. Service contexts must originate in authenticated server code; a client-supplied service ID is not authentication.
- SQL serializes/clones one scope aggregate, bounded at 4 MiB/10,000 journal records. This is a deliberate MVP tradeoff; capacity fails closed. A normalized/archive adapter can replace it through B1. No ledger deletion/retention policy was invented.
- Account locks must be shared by the always-on server. Callbacks cover bounded handoff, not a full long-running generation; all production transport needs caller-controlled deadlines/cancellation and stable jobs idempotency.
- Halt receipt remains local `pending` until remote worker evidence is integrated. Generation unknown/timeout outcomes retain exposure; excess costs stay blocked until reconciliation. Ad-flight settlement/release is not exposed by the initial contract and remains conservatively reserved. No fake remote stop, refund, or release is reported.
- The shared card DTO does not carry financial review metadata. The production exchange receives the full frozen effect and must display exposure/window/account information; HTTP/studio/CLI integration needs that same full review, not only arguments/classification.
- SQLite SQL behavior is tested; a better-sqlite3 shim and future PostgreSQL row codecs/isolation still need their integration suites. SQL versions must decode to safe integers.

## NEEDS

- Integrator: bind `SafetySqlDatabase` to published Jini kernel or documented `jini-compat/db`, owned by the server with better-sqlite3 and transaction isolation. No PGlite/pg driver is used by safety. Reconcile `pnpm-lock.yaml` for the removed unused safety dependencies.
- j02/j03/j04/j06 composition: authenticated scope/account contexts; canonical `SpendPolicyPort`; durable audited confirmation/grant bridge; authoritative current effect/quote/stop/cap evidence; one shared barrier and final credential checks. The added owned methods must be implemented by those integration adapters.
- Jobs/creative/campaigns integration: invoke `withDispatch` at final normal egress, use stable idempotency and reconcile unknown outcomes; link reservation/quote/observed cost IDs. Add explicit ad-flight exposure reconciliation and remote-stop observation if those workflows need to update safety projections.
- Server/studio/CLI: wire the feature's APIs and complete financial review metadata. If transport uses `ConfirmationCard` alone, extend its shared DTO or add a scoped server review lookup; this lane did not edit packages/contracts or applications.
- Media-library lane: regenerate integrity receipts and finish its memory/service methods; the exact external gate errors are recorded below.

## HANDOFF / architecture and quality

Suggested next routing: Coordinator → Code Inspection/Security → server/Jini integrator, then jobs/creative/campaigns and UI/CLI wiring. No commit/push performed.

Architecture Audit: PASS for lane boundaries, public imports, DI, decision/effect separation, no driver/vendor imports, injected clock, exact authority, independent cap proof, halt ordering, closed stop, atomic generation, append-only evidence and configured complexity/signatures. Integration completeness is PARTIAL until the NEEDS above are connected. The DB shape is explicitly a removable compatibility seam, not a claim that a released Jini query API is already installed.

Pre-completion: active acceptance reread; index/types/ports reread; fresh evidence run; no certified assertions removed; unrelated dirty work preserved; no live effects or live migrations. Product HTTP/studio/CLI self-validation is outside this lane. Package self-validation exercises real ephemeral SQLite plus the real service with captured transport, including fault rollback, forbidden paths and concurrent ordering. No unbounded retries were used. Reports are kept inside the permitted lane; raw logs are offloaded to /private/tmp.

Function-quality assessment (tiny non-branching constructors/key helpers inherit their parent assessment):

| Units | Disposition | Findings and local fix |
| --- | --- | --- |
| digestArguments (canonical JSON from contracts `canonicalizeArguments`)/sameValue/freezeJson | NO_RECORDED_FINDINGS | Bounded JSON/depth; canonical stable values; frozen handoff; direct malformed/bounds tests. |
| validContext/serviceContext/asServiceContext | FIXED | Required:scope/trace — contradictory owner and dropped backend run IDs rejected/preserved; red/green retained. |
| choices/classify/eligibleGeneration | NO_RECORDED_FINDINGS | Spend/destructive never downgraded; grantable tool scope required. |
| matchesAuthority/matchesGrant/confirmation present-confirm-verify | FIXED | Required:authority — future matching grants supported without waiving exact spend; explicit responses/fingerprint/scope binding. |
| boundary/prepare/validCard/verifyEffect/approvalClassification | NO_RECORDED_FINDINGS | Typed errors; tainted output parsed; reviewed value/digest equality. |
| dispatchAdmission/evidenceMatches/fitsAdmission/accountReserved | NO_RECORDED_FINDINGS | Cap age/currency/window/semantics and safe aggregate sums checked independently. |
| admit/recheckAuthority/dispatchLocked | FIXED | Required:irreversible-ordering — storage cannot outlive approval before handoff; barrier held through transport. |
| haltLocked/stop | NO_RECORDED_FINDINGS | Durable local barrier; configured backend; strict existing-entity binding; closed payload/digest. |
| setAllowanceLocked/settleLocked/allowanceBarrier | NO_RECORDED_FINDINGS | Setting/cost updates serialize with generation transport; current revision/provenance preserved. |
| localDay/nextRollover/activeCycle | NO_RECORDED_FINDINGS | Explicit timezone, next rollover activation and DST; no hidden time. |
| generationUsage/generationExposure/quoteIsCurrent/validQuoteBinding/assessInState | FIXED | Required:financial-binding — malformed quote/config/bound cannot become a spend bypass; pending across days; safe sums. |
| reserveGenerationInState/generationRetry/admitGeneration/reserveGeneration | NO_RECORDED_FINDINGS | Atomic current classification/revision/quote; idempotent reservation; settled/drifted operation denied. |
| settleInState/repository mutations/appendJournal | FIXED | Required:ledger — duplicate cost/reservation/halt observations do not append duplicate financial entries; linked corrections retained. |
| snapshotInState | NO_RECORDED_FINDINGS | Reserved commitments separated from booked ad charges; mixed/unsafe totals fail. |
| readState/sqlChange/appendSqlJournal | ADVISORY | Recommended:scale — whole-scope JSON projection costs O(s) per operation; bounded and replaceable through B1. Smallest later refactor: normalized SQL projection adapter with the same suite. |
| SQL transact/observeFailure | FIXED | Required:boundary — observer failure cannot escape a typed unavailable outcome; SQL rollback fault checked. |
| waitForLock/acquire/release/releaseTail | NO_RECORDED_FINDINGS | Bounded FIFO/cancellation; cancelled waiter never releases predecessor; no timing sleeps. |
| memory policy/effect/quote/stop/cap/audit doubles and memory transact | NO_RECORDED_FINDINGS | Explicit missing evidence; scoped fixtures; bounded state; defensive outputs; no real authority claim. |

Name audit/skepticism: `reserved` means unresolved exposure, not observed charges; `dispatchDay` retains original attribution; `remaining` excludes only an exact unresolved retry's own reservation; settings revision differs from storage CAS version; `remoteStatus: pending` is not a remote-stop success. No remaining High/Critical finding or coverage-unfriendly seam is known. Inline purpose/error/effect/complexity docs and public examples are present; no separate doc-lint is configured. Cognitive/nesting and signatures are checked by the repository's actual lint configuration; cyclomatic/NLOC are reported, not gated.

Discovery summary: supplied safety contract paths owned the task; graph search returned no fresh safety nodes, so exact provided files were read. No preserved safety algorithm exists. The Jini db graph lacked current db symbols; inspected public db/core/ports for compatibility context, with no sibling import. No broader codebase exploration or agent delegation was needed.

Offloads: /private/tmp/om-safety-{coverage,lint,om-check-final,typecheck-root,boundaries-final,gates-final,metrics} logs/JSON; regression RED logs for trace/observer/scope/bound tests. Bootstrap Loop Alert is in PROGRESS.md. Source-level edits remain scoped; routine root gate artifacts are tool outputs.

## Final evidence (2026-10-02)

| Command | Result |
| --- | --- |
| `corepack pnpm --filter @open-marketing/safety exec vitest run tests --coverage '--coverage.include=src/**' --coverage.reporter=json-summary --coverage.reportsDirectory=/private/tmp/om-safety-coverage` | PASS: 7 files, 123 tests; same memory/SQLite suites. |
| `corepack pnpm --filter @open-marketing/safety typecheck` | PASS: production and test TypeScript. |
| `corepack pnpm --filter @open-marketing/safety build` | PASS: 24 emitted executable/declaration outputs attested by the standard integrity wrapper. |
| `node_modules/.bin/eslint features/safety --format json` | PASS: zero errors/warnings. |
| `corepack pnpm om:boundaries` | PASS: full graph/specifier checks. |
| `corepack pnpm om:gate-tests` | PASS: 5 files, 73 tests. |
| `corepack pnpm om:metrics` | PASS: metric integrity; safety including tests has max cognitive 8, nesting 2; cyclomatic max 16/NLOC max 158 reported without gates. |
| `corepack pnpm om:check` | FAIL outside this lane: missing generated integrity receipts under `features/media-library/dist/{index,src/memory,src/ports,src/service,src/types,src/validation}.{js,d.ts}` and stale `apps/studio/dist/assets/index-CSlXMYFW.js` provenance. No safety failure reported. |
| `corepack pnpm om:typecheck` (independent root run) | FAIL outside this lane: media-library memory.ts:5 missing repo methods; memory.ts:10 missing BlobStorePort.read; service.ts:18 missing recordProvenance/recordCost. Package-scoped safety typecheck passes. |

Coverage includes all safety runtime source under src, with no suppressions or exclusions added: 776/776 statements and lines (100%), 138/138 functions (100%), 523/622 branches (84.08%). Reachable unexercised boolean/error/resource-bound branches have direct port/state seams; no coverage-unfriendly unit is known. No assertion was dropped to improve metrics.

Self-Validation: scoped real-SQL/service integration PASS. Product runtime self-validation PARTIAL/not run: `ADS-memory/governance/contracts/runtime-validation.md` is absent and no safety-specific boot/health/API declaration was supplied. HTTP/studio/CLI composition is outside the authorized lane. Zero app boot attempts; no product-runtime diagnosis pass. This is not a production end-to-end readiness claim. The authorized lane and offloaded logs contain the report because the dispatch forbids ADS-memory writes. Coordinator/integrator owns the remaining product harness.
