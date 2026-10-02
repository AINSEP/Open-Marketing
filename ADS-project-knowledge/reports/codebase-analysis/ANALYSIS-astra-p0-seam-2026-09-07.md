# Open Marketing P0 seam analysis

- Analyst: CodeBase Analyzer; persona and seven activated skills loaded.
- Date: 2026-09-07
- Scope: bounded Phase 0 architecture analysis; no implementation.
- Inputs: root AGENTS.md, AI-Dev-Shop persona/skills, repo-map, apps/packages guides, sibling open-marketing-build-plan.md sections 110–326, current manifests and source samples.

## Sampling Notice

Files sampled: root/workspace and daemon/contracts manifests; daemon db.ts first 100 lines; server.ts wiring literals; marketing/store.ts first 100 lines and schema/export literals; routes/marketing.ts; contracts/src/api/marketing.ts; test filenames. Graph architecture and exact openDatabase search used.
Files excluded: most of 10,350 listed non-toolkit files; full agent runtime, UI, desktop, deployment, tests' contents, credentials and provider adapters. Excluded because the delegated scope is the P0 seam, not exhaustive review. User-owned dirty paths were not modified.

Confidence levels by finding category:
- Architecture structure: High
- Dependency direction: Medium
- Test coverage signal: Low
- Security surface: Low
- Code quality indicators: Low

Note: Confidence reflects sample coverage, not model certainty. A High-confidence finding means the sample was broad enough to support the conclusion. A Low-confidence finding is a hypothesis requiring human verification.

## Executive summary

Yes: begin additive framework-independent modules in this workspace. Do not implement the marketing spine inside the existing SQLite marketing overview store. Current state is layered with substantial composition in the daemon (provisionally Layered (degraded)); the recommended new product shape is a modular monolith with ports at persistence/runtime boundaries. Severity summary for this bounded assessment: Critical 0, High 2, Medium 2, Low 0. These are migration risks, not an exhaustive defect count.

## Findings

### F-1 — High: target runtime is not present

apps/daemon/package.json declares Express and better-sqlite3. No @jini-ai, pg, or postgres dependency appeared in app/package manifests. server.ts:3575 opens SQLite with the resolved daemon root. The target plan requires apps/server, always-on pollers, Jini runtime, and Postgres product data. Adding marketing tables to db.ts would deepen the wrong persistence dependency. Jini APIs/package availability were not verified; this report claims no working Jini integration.

### F-2 — High: two possible product-data authorities

Existing marketing/store.ts:159 creates marketing tables for campaigns, audiences, approvals, assets and snapshots. db.ts:15 imports its migration; server.ts:3958 mounts the overview route. The overview explicitly selects sample campaigns (store.ts:363); contracts/src/api/marketing.ts models overview summaries. This is a scaffold, not evidence of identity, consent, authorization envelopes or a delivery ledger. Reusing names without an ownership decision risks making SQLite and Postgres competing truths.

### F-3 — Medium: runtime and API contracts need reconciliation

Root contracts assign /api/* and od CLI ownership to the daemon; the product plan names apps/server, /v1/track and om CLI. Current root/daemon manifests already expose both om and od, so do not create a duplicate CLI. A reviewed adapter/proxy contract must explain how both clients reach the same marketing authority while preserving the current API contract. Root package.json also contains lifecycle aliases forbidden by root guidance; these pre-existing inconsistencies must not be copied or incidentally repaired in the spine slice.

### F-4 — Medium: graph freshness limits

Existing graph project Users-la-Programming-Open-Marketing reports daemon/web/contracts and resolves openDatabase. Searching marketing functions returns none despite source files and wiring existing. Treat this slice's graph as stale. Source inspection is the evidence of record. Reported graph web→daemon call edges are not proof of forbidden imports (symbol resolution can overconnect common names). No reindex performed.

## Test signal and safety limits

Daemon and contracts have usable Vitest commands. Daemon has DB and active-context route tests by filename; no marketing-named tests were found in the sampled test directories. This is a coverage signal, not a zero-coverage claim. No tests, build tools or project scripts ran during this analysis. Security was not audited. Existing secrets handling is not evidence that production marketing custody is safe.

## Recommended first code slice

New packages/om-clock and packages/spine: one injected Clock and exactly sendability, shareability, spendability in spine/src/gates.ts, as required by the plan's first-commit tell. Pure input snapshots and explicit decision results allow tests without Express, SQLite, Jini, network or real time. Define identity/merge, purpose-specific consent, suppression, budget-envelope and holdout data semantics before persistence. Reserve order_id identifiers and conversion value/currency now. Do not duplicate gate logic in UI, adapters or estimators.

This core slice is internal infrastructure, not a shipped capability; UI/CLI closure is required when the first capability is exposed. The complete first planned spine milestone also needs om-pg/migrations/0001_spine.sql containing subject_merge, consent and budget_authorization. A gates-only scaffold must not be reported as that milestone complete.

## Handoff

Output: this analysis and paired MIGRATION-astra-p0-seam-2026-09-07.md. Risks: unresolved target-server ownership, schema semantics and existing scaffold cutover. Next assignee: Spec Agent for the spine invariants, then Software Architect for Postgres/runtime boundary. No changes to source, configs, dirty paths, dependencies or graph indexes.
