# Phase 0 spine: implementation slice design

Programmer(Execution), 2026-09-07. Discovery/design only; no product source or configuration changed.

## Inputs and evidence

- Programmer persona loaded from `AI-Dev-Shop/agents/programmer/skills.md`; activated general-behavior, backend-implementation, hexagonal-architecture, api-design, api-contracts, tool-design, observability-implementation, change-management.
- Product authority: sibling `OSS-Marketing-Repos/docs/open-marketing-build-plan.md`, especially lines 118–129, 185, 203–222, 252–278 and 443–448. This report is a requested pipeline artifact, not a replacement product plan.
- Repository boundaries: root instructions, `AI-Dev-Shop/AGENTS.md`, `docs/repo-map.md`, `packages/AGENTS.md`.
- Package templates inspected: `packages/release/{package.json,tsconfig.json,tsconfig.tests.json,esbuild.config.ts}`, `packages/contracts/package.json`, root manifest and workspace file. Release uses private ESM package, neutral ESM plus Node CJS dist, declaration build, Vitest and separate source/test typechecks; no dedicated release Vitest config exists.
- Graph discovery used existing `Users-la-Programming-Open-Marketing`; exact gate/Clock symbol lookup returned only an unrelated daemon clock variable. No reindex. This is evidence of no indexed gate implementation, not proof that unindexed files cannot exist.
- `governance/adrs/ADR-INDEX.md` and `memory/project_memory.md` under ADS-project-knowledge are absent. No certified spec/hash or test certification was supplied. These are implementation prerequisites for pipeline work, not reasons to stop this discovery task.

## Proposed bounded first write batch

Create one pure package, tentatively `@open-marketing/spine` (name needs coordinator agreement during rebrand), with these exact candidate files:

1. `packages/spine/package.json`
2. `packages/spine/tsconfig.json`
3. `packages/spine/tsconfig.tests.json`
4. `packages/spine/esbuild.config.ts`
5. `packages/spine/src/index.ts`
6. `packages/spine/src/clock.ts`
7. `packages/spine/src/types.ts`
8. `packages/spine/src/gates.ts`
9. `packages/spine/tests/gates.test.ts`
10. `packages/spine/tests/public-api.test.ts`
11. `packages/spine/tests/fixtures.ts`

The coordinator alone owns the resulting `pnpm-lock.yaml` update after package installation. Existing workspace globs already include the package; root scripts need no changes. Use the existing release package dev-tool versions as local convention (TypeScript 6.0.3, Vitest 4.1.6, tsx 4.22.3, esbuild 0.28.0), with no runtime dependencies. Do not introduce Jini, a database client, ORM, HTTP framework, or telemetry SDK into this core. Versions above are inspected local pins, not recommendations about latest releases.

Preserve all seven dirty areas named in dispatch. No app wiring in this first batch. An internal library is not a shipped user capability; later exposure must land shared DTOs, HTTP, UI and CLI together according to root contracts.

Batch is independently testable once the input and decision semantics below are settled. Do not ship permissive placeholders, stub gates that always deny, or claim a completed Phase 0 on this batch alone. To honor the plan's first-commit tell, hold the first product commit until the companion migration is available in that same commit.

## Core seam and API

`gates.ts` has exactly the three runtime exports from the dispatch:

```ts
sendability(subject, channel, purpose, clock)
shareability(subject, destination, purpose)
spendability(ad_account, amount, window, clock)
```

Put types and Clock outside that file. Explicit positional compatibility takes precedence over the persona's usual required-object convention. Proposal: Clock provides `now(): number` as UTC epoch milliseconds; core receives immutable, already-resolved policy snapshots, not database IDs that require hidden lookups. Functions return a discriminated allowed/denied decision with stable reason codes; malformed internal snapshots throw a distinct validation error. These input/return choices are proposals pending spec confirmation.

Inbound port: the three exported pure decisions. Outbound core port: Clock only. Test drivers supply snapshots and fake time. A later server-owned application service loads snapshots through an explicit repository port, invokes the same gates, and performs transactional reservation/outbox creation. Server bootstrap owns concrete PostgreSQL wiring. Estimator and dispatcher import this package; neither reimplements a gate. The UI renders server decisions rather than independently deciding permission.

No I/O, cache, retries, queues or telemetry in this initial pure slice. Instrument future repository and HTTP adapters using the activated observability skill. Never treat a transient repository error as an allowed decision or ordinary policy denial.

## Companion migration and dependencies

Proposed sole initial migration location: `packages/om-pg/migrations/0001_spine.sql`, owned by the database slice. Do not duplicate SQL in the spine package. The eventual migration integration test belongs at `packages/om-pg/tests/spine-migration.test.ts`, alongside that package's migration runner/test harness. Confirm this path with the database agent before writes.

One migration must contain `subject_merge`, `consent`, `budget_authorization`; its required dependency closure also includes `subject`, `subject_identifier`, suppression and ad-account ownership if authorization references it. Phase 0 must account for global holdout, reserve identifier kind `order_id`, and preserve the future conversion value/currency requirement. The plan does not specify enough column constraints to safely finalize DDL here.

Select a PostgreSQL driver only in om-pg after agreeing its API and supported server version; no driver is needed for the pure batch. Use actual PostgreSQL for migration/concurrency assertions, not SQLite emulation. New product schema is additive alongside existing daemon SQLite; do not silently migrate daemon state or rewrite startup. Database connection/runtime ownership and Jini adoption are separate architecture decisions.

## Decisions required before implementing behavior

1. **Clock contradiction:** build-plan line 209 and dispatch say three-argument shareability; line 219 says all three take Clock. Retain dispatch's signature until source owner resolves it. If consent expires, define how shareability gets an evaluated timestamp without ambient time.
2. **Subject argument:** ID, aggregate, or policy snapshot? Exact required fields, canonical merge resolution, snapshot version/freshness and transaction ownership. Snapshot proposal preserves purity but is not equivalent to evaluating live storage.
3. **Consent:** purpose/channel/destination key space, defaults when missing, grant vs withdrawal precedence, effective/expiry boundaries, evidence provenance, append-only history versus current projection. Do not invent legal policy from table names.
4. **Suppression/holdout/frequency:** scope and expiry of suppression; whether global holdout prevents messaging, paid targeting and conversion export; assignment ratio, stable assignment and merge behavior; rolling versus calendar frequency windows and atomic counter reservation. Explicit fact: suppression alone must not block sharing; consent withdrawal must.
5. **Identity:** tenant/workspace scope; identifier uniqueness and normalization per kind; merge cycles, concurrent merges, loser tombstones, conflicting consent and identifiers. Preserve order_id without deciding unsafe email/phone normalization heuristics.
6. **Budget:** currency and exact minor units, zero/negative amounts, flight and daily bounds/time zone, half-open boundary policy, multiple overlapping authorizations, committed/reserved/observed spend, stale platform spend handling, envelope revision/revocation and immutable approved creative digest/bid-band semantics.
7. **Atomicity:** a pure spendability check is not a reservation. Two callers may each pass while combined spend exceeds a cap. Define the transaction/lock and idempotency contract for budget/frequency reservations and outbox insertion. Account halt must be checked at outbound execution, including after approval.
8. **Result contract:** boolean versus reasoned union, precedence when several reasons deny, handling unknown accounts/subjects and malformed snapshots. JSON monetary representation must be agreed before shared DTOs; avoid serializing bigint directly.
9. **Runtime/API:** current daemon/od ownership versus planned server/om/Jini, `/api/*` root contract versus product `/v1/track`, authentication and tenant scope. No external API is finalized here; method/path/auth/error/status/retry/quota contracts remain upstream work.

## Test and validation handoff

Certified tests should directly cover: grant permits the intended purpose only; withdrawal denies; suppression denies messaging but allows otherwise-consented sharing; missing/unknown policy; frozen-time start/expiry boundaries; halted account; wrong currency; amount at/above cap; expired/revoked envelope; overlapping authorization handling; merge-conflicting policy; stable holdout policy. Exact expected outcomes for unspecified cases require the spec decisions above.

Adversarial integration cases for the companion adapter: two concurrent reservations exceed the aggregate cap; retried reservation does not consume twice; revoked consent between estimation and dispatch; halt after outbox enqueue; opposite-direction concurrent merges cannot create a cycle. Public export test asserts exactly three runtime exports from gates; no wall clock is consulted by the core. Do not mistake a migration file substring test for executed schema validation.

After authorized implementation, coordinator runs:

```bash
corepack pnpm install
corepack pnpm --filter @open-marketing/spine test
corepack pnpm --filter @open-marketing/spine typecheck
corepack pnpm --filter @open-marketing/spine build
corepack pnpm guard
corepack pnpm typecheck
```

Use agreed package name if different. Companion adapter command, once its harness exists: `corepack pnpm --filter @open-marketing/om-pg test`. Use an explicitly disposable test database. Lockfile changes require the root Nix hash refresh check; do not invoke the intentional Nix packaging update command automatically. Root manifest already contains lifecycle aliases inconsistent with root instructions; preserve and report this baseline rather than fixing it in this slice.

## Handoff status

Discovery complete; implementation Architecture Audit: BLOCKER until source/API/schema decisions are resolved. Proposed dependency direction and file placement comply with package boundaries. No product functions changed, so function-quality scoring, coverage and runtime validation are not applicable. No tests run or claimed passing; fresh evidence consists of graph lookup, source/config reads and git status confirming the dispatched dirty set. Only this report was written. Suggested next assignees: Spec/Software Architect for the nine decision groups; Database owner for the companion migration; then Programmer for the pure batch and TDD/QA for adversarial adapter evidence.
