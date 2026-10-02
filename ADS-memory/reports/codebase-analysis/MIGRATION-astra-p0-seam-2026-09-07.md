# Open Marketing additive migration plan

- Date: 2026-09-07
- Source: ANALYSIS-astra-p0-seam-2026-09-07.md
- Current state: Layered (degraded), sampled classification
- Target: modular monolith; selective hexagonal boundaries

## Coverage Caveat

This migration plan is based on sampled codebase context. Files and modules not included in the analysis sample may contain architectural patterns, dependencies, or constraints not reflected in this plan. Before executing any migration phase, validate the plan against unsampled modules — especially any modules listed as excluded in the corresponding ANALYSIS report.

## Recommendation and tradeoffs

| Candidate | Fit | Adaptability | Evidence | Tradeoff / verdict |
|---|---|---|---|---|
| Additive modules plus Jini/Postgres composition | Strong | High | plan + sampled boundaries | Recommended; preserves core through runtime change, adds adapter work |
| Extend SQLite daemon for production marketing | Rejected | Low | daemon manifest and target plan | Fast prototype integration but violates product-data requirement |
| Immediate full rewrite or microservices | Weak | Medium | analogical | Broad migration and deployment complexity before first useful module |

This is a recommendation for an ADR, not a finalized architecture decision. It addresses F-1/F-2 with additive ownership, F-3 with explicit integration, and F-4 with source validation. It does not address the rebrand, general daemon quality, marketing research or security audit.

## Ordered phases

### Phase 0 — lock the spine contract (one bounded planning slice)

Specify gate inputs/reason codes, consent withdrawal versus suppression, missing data behavior, expiration boundaries, budget currency/amount/window semantics, identity merge references and global holdout assignment. Resolve the apparent shareability signature discrepancy: prose omits Clock, but the first-commit invariant requires Clock on all three functions. Follow the explicit invariant. Snapshot inputs are supplied by trusted application services, not accepted as user authority.

Architect must decide apps/server versus daemon gateway ownership, auth/tenant context, Postgres migration ownership, Jini package sourcing and CLI alias compatibility. Preserve root daemon-data contract by reference; do not invent new daemon roots. No production runtime phase can execute with these unresolved. Core types/tests can be prepared independently.

### Phase 1 — isolated core (target 1–3 days; split if larger)

Create packages/om-clock/{package.json,tsconfig.json,src/index.ts,tests/clock.test.ts} and packages/spine/{package.json,tsconfig.json,src/index.ts,src/gates.ts,src/types.ts,tests/gates.test.ts}; names are proposals pending ADR. Keep tests sibling to src per root policy. No new imports from app internals. Inbound ports are the three gate functions; they consume immutable facts and Clock. They have no persistence outbound port and perform no writes. HTTP/CLI are later inbound adapters, with CLI always calling HTTP.

Verify observable decisions across withdrawn consent, suppressed messaging versus permitted sharing, absent authorization, expired windows, halted accounts, exceeded caps and deterministic time boundaries. Avoid legal defaults invented from the high-level plan. Rollback is removal/reversion of unused additive packages; existing runtime stays deployed. No data backfill or cutover.

### Phase 2 — Postgres spine persistence (split migration and transaction/claim tests into separate ≤3-day slices)

Create packages/om-pg/src/{index.ts,pool.ts,migrate.ts}, migrations/0001_spine.sql and tests/ using real disposable Postgres. Define module-owned repositories/transactions in spine application language; implement them at the Postgres edge. Include subject_merge, consent and budget_authorization in 0001 as the plan requires. Schema review also reserves identifier order_id and conversion value/currency, plus global holdout from Phase 0. Do not create parallel SQLite versions.

Verify migration on empty DB, restart/re-run behavior, FK and uniqueness rules, atomic identity+consent operations, isolation/rollback and concurrent claimBatch ownership where introduced. Claim tests must demonstrate actual concurrent Postgres workers; fake stores cannot establish SKIP LOCKED correctness. No live writes or provider connections. Existing overview samples remain separately identified. Om-outbox is a later owned module, not hidden within a generic DB helper.

### Phase 3 — first runtime and surface slice (execution blocked pending architecture decisions)

Likely additions: apps/server/src/bootstrap.ts, app-owned HTTP adapters, packages/contracts/src/api/spine.ts, a dedicated web feature and daemon CLI command module. Likely later edits: contracts exports/manifests, daemon route registration, CLI SUBCOMMAND_MAP, web navigation and tools-dev integration. Read all applicable local guides first. User-owned cli.ts and App.tsx are integration points to coordinate explicitly; leave them untouched in independent package work.

Composition root is proposed apps/server/src/bootstrap.ts: wire Jini, Postgres and Clock there. Persisted fact-loading application ports invoke canonical gates; HTTP adapters validate and authorize input. Existing daemon can proxy marketing calls only if ADR chooses that shape. Both UI and om/od must reach the same endpoints. A pure package is not permission to claim a UI-only or CLI-only feature complete.

Verify real HTTP authorization/invalid input, UI+CLI decision parity, graceful restart and independent always-on operation before desktop integration. Characterize the existing marketing overview before modifying or routing it. Local sidecar mode must reject production ad-account binding before any credentials or ad-write feature is enabled.

## Production migration safety and operational workflow

Phases 1–2 are additive development infrastructure with no production traffic/data cutover; no dual-write/backfill is needed for those phases. Runtime phase is BLOCKED for execution until Architect/owner supplies: expand/contract API window, existing-data inventory, backfill or explicit no-backfill rationale, reconciliation invariants, health/queue metrics, tested rollback procedure, cutover authority, irreversible-step inventory and post-cutover checks. Do not silently discard or promote SQLite sample rows.

Runtime preflight owner: Architect/DevOps; evidence: approved topology, auth/tenant boundary, schema versions and backups. Dry run: disposable environment with migration/reconciliation results. Execution and monitoring: named operator, agreed thresholds and rollback criteria. Completion: UI/CLI parity, restart recovery and data-authority reconciliation. No waiver or production approval is recorded by this report.

## Validation and next assignee

After package/workspace changes use pinned Corepack pnpm install, then pnpm guard, pnpm typecheck and the new package-scoped tests/builds. Any lockfile change requires the repository's Nix hash refresh check; no incidental hash rewrite. Cross-app tests belong in e2e/tests; Playwright in e2e/ui using shared tools-dev harness. No validation commands executed for this analysis-only deliverable.

Inputs/output/risks: source report and product build plan → additive phase plan; unresolved runtime/schema decisions limit execution. Recommended pipeline entry is Spec for the spine, then Architect; first implementable slice is pure Clock/gates after those semantics are defined. Preserve all user-owned dirty files. Continue build order with ledger/dispatcher/render, then journeys; defer ad writes, creative production, MCP broker and desktop.
