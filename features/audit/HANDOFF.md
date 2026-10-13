# Programmer(Direct): audit j03 — 2026-10-12

Audit preserves a scoped history of attempted actions, approvals, dispatch and
results. A correction adds a linked record; it never replaces prior evidence.
For example, call `audit.record({ context, entry: { operationId, kind: "intent",
argumentsDigest, references: [securedEvidenceId] } })`, require a successful
receipt before the effect, then read redacted pages with `audit.list`.

Feature code and tests are implemented; runtime verification remains deferred by
the owner's NO TEST RUNS override. Server integration, exact-review evidence
security, real published-redactor testing and retention decisions remain open.

## Inputs and continuation

- Read `AI-Dev-Shop/agents/programmer/skills.md` first and applied its foundation,
  navigation, hexagonal, documentation, quality, debugging and adversarial guidance.
- Inspected `git diff 59db645 3e2648f -- features/audit` and the current committed
  source (baseline HEAD 1c74533). Retained the previous factories, repositories,
  algorithms, migrations and behavioral suites; no restart/rewrite.
- Contract authority: current index/ports/types, JOBS j03, COMMON, architecture
  §§4.3/5 and preservation constraints, with dispatch overrides taking precedence.
- No prior feature HANDOFF/PROGRESS, project-memory file or ADR index was found.
  No separate certified-test artifact/spec hash was supplied. Direct dispatch
  supplies the current requirements; no certification or test pass is invented.
- Graph tools were absent. Direct source reads/rg confirmed the bounded candidate
  set: audit service/validation/redactor, memory and SQL adapters, local migrations,
  fixtures and contract/service/durability tests.
- Existing typed Outcome/object-argument/injected-port code supplied the pattern
  seed for this continuation. No new style or architectural layer was introduced.

## CHANGED FILES

Changes relative to the starting HEAD, all inside `features/audit/`:

- `src/service.ts`: cancellation after final/empty reads; immediate cursor-progress
  check; extracted single-entry redaction validation to keep orchestration small.
- `src/validation.ts`: operational receipt/cursor shape; empty-page continuation
  rejection. Input/payload limits and explicit error values retained.
- `src/sql.ts`: schema-validated row containers; indexed metadata must agree with
  persisted JSON; duplicate receipt detection; cancellation after final SELECT.
- `src/types.ts`: documented opaque receipt-ID requirements; signatures unchanged.
- `src/redactor.ts`: corrected the published Jini 0.4.3 API usage example.
- `tests/boundaries.test.ts`: public-boundary regressions for cancellation,
  receipt/cursor privacy, empty/repeated continuation and valid progression.
- `tests/durability.test.ts`: contradictory metadata, malformed row container,
  duplicate identity, final-query cancellation and actual SQLite corruption tests.
- `tests/contract/port-suites.ts`: shared DB acquisition-cancellation and transaction
  serialization assertions.
- `tests/sqlite-fixture.ts`: scripted SQL double now serializes transaction bodies,
  honors cancellation before acquisition and discards failed callback history.
- `README.md`, `PROGRESS.md`, `HANDOFF.md`: accurate usage, limits, integration
  assumptions, verification restrictions and resumable status.

All public factories already exported by the prior commit have implementations:
service, memory repository/redactor/observer, SQL repository and injected Jini
redactor. No exported factory is left as a fake success or not_implemented stub.
SQL database/session are composition-owned injected ports, with scripted doubles
and a real disposable SQLite test bridge.

## TESTS

- Tests: **written, not run**. Existing suites retained; no assertions removed,
  weakened, skipped or excluded. New regressions were written before their fixes.
- Required command: `corepack pnpm --filter @open-marketing/audit typecheck` —
  **PASS**, exit 0. Ran once; both `tsc --noEmit` and
  `tsc -p tsconfig.tests.json` completed successfully.
- `git diff --check -- features/audit` — passed (no whitespace errors).
- No vitest, test suite, build, install, lint, om:check, coverage, runtime probe or
  live migration was run. Coordinator must execute combined verification later.
- Red/green evidence: **not executed** under the binding override. Static root-cause
  traces are recorded below; they are not represented as runtime proof.

Acceptance mapping:

| Requirement | Written evidence | Remaining limit |
| --- | --- | --- |
| Append-only/scope isolation | Shared repository B1 suite, SQL UPDATE/DELETE guards | Not run |
| Intent receipt survives restart | File-backed SQLite close/reopen test | Not run |
| Required failure prevents effect | Service caller-barrier test with failed and successful paths | Production callers must enforce barrier |
| Secrets/PII excluded operationally | Shared redactor suite, service telemetry tests, receipt/cursor regressions | Real Jini suite and host non-personal IDs |
| Exact-review linkage | Approval/dispatch/outcome digest and secured-reference SQL test | Referenced storage security is host-owned, unproven here |
| Bounded export/corrections | 100/101 page test, lineage/scoping suite, malformed/repeated cursor regressions | Multi-page snapshot/export jobs not in accepted API |
| DB/session replaceability | Same suite for script double and disposable SQLite bridge | Server bridge integration |

Bug traces and distinguishing assertions:

- `redactPage` checked cancellation only before each item; an abort during the
  final await (or empty repository page) escaped as success. Single-item and empty
  page tests now require the exact cancelled Outcome, with no partial value.
- Generic `idSchema` admitted personal/token payloads into unredacted receipts and
  cursors; a continuation could also repeat or accompany zero entries. Tests now
  require protocol_mismatch rather than a value containing that data or a loop.
- SQL SELECT/decode omitted denormalized metadata. Valid JSON could therefore
  contradict the operation/scope/digest columns. Table-driven tests and a real
  SQLite inserted inconsistency now require protocol_mismatch and preserve rows.
- The SQL page check enforced sequence order without unique IDs. Two increasing
  sequences with the same receipt now fail instead of exporting duplicate evidence.
- Scripted DB callbacks shared an unsynchronized current-query array. A shared
  two-transaction barrier test now requires the second body to wait for the first;
  pre-aborted acquisition must never execute its body.

## CONTRACTS

- `index.ts` unchanged. No public method/factory/port signature added or removed.
- `src/types.ts` changed documentation only: exposed receipt IDs must be opaque,
  non-personal identifiers using letters/digits/colon/underscore/hyphen. Receipt
  and cursor validation rejects other shapes with protocol_mismatch; stored payload
  and operational identities retain their accepted DTO shapes.
- Read validation now requires immediate continuation progress, a nonempty page
  with continuation, unique SQL receipts and metadata/JSON consistency.
- SQL statements still use the same owned table/schema and bound `$n` parameters.
  A bridge must return selected columns exactly and normalize integer results to
  safe JS numbers. No driver API or SQL implementation enters feature core.
- Jini reuse: installed `@jini-ai/core@0.4.3` public declarations export
  `redactSecrets({ input }, options?)`. The existing caller-owned scrubber adapter
  supports it without copying the lexical algorithm or importing a sibling repo.
  Core's own documented limits exclude semantic names/addresses/business secrets,
  so all operational references remain withheld rather than relying on detection.
- Installed platform APIs are credential/network infrastructure, not an audit
  repository. No rebuild or import of those unrelated APIs. `@jini-ai/db@0.3.2`
  is not installed; the dispatch explicitly requires OM DB ports, so the SQL seam
  remains injected. No temporary redactor shim exists or was added.
- npm verification attempted via registry and npm pages; browser fetches failed
  and shell reported `Could not resolve host: registry.npmjs.org`. Installed
  declarations/package metadata were checked; online publication was not verified.

## MIGRATIONS

No migration added, edited or applied in this continuation. Retained prior
`0001_audit.sql` (portable schema/indexes/correction FK) and
`0002_audit_sqlite_immutability.sql` (SQLite UPDATE/DELETE triggers). Tests are
written to apply them only to disposable SQLite databases. Retention/purge
authority is not invented; future Postgres needs equivalent append-only guards.

## Architecture audit and pre-completion

Static scope/boundary review: **PASS** for the inspected feature edits. Runtime
architecture/lint gates: **NOT RUN**, so no automated architecture pass is claimed.
Checked public-only package exports, caller-owned ports, contracts-only imports,
injected clock/IDs/I/O, no runtime driver/sibling import, no hidden service startup,
append-only SQL, bounded scans, no second outbox and no policy import.

Requirements were re-read; changed files stayed in-lane. Other feature sessions'
dirty/untracked work was observed and preserved. No commit or push performed.
Fresh evidence is limited to the allowed typecheck and diff review. No tests were
deleted or weakened. No UI/runtime harness was launched: the dispatch prohibits
it and this lane has no application wiring. Self-validation/coverage are explicitly
unmeasured, not passing. Open integration items are listed below.

## Style notes and documentation

All changed owned logic retains at most two object arguments. Native Array/Zod/
Promise/Vitest callback ABIs remain at their immediate foreign boundaries. Side
effects stay in injected repository/redactor/transaction boundaries; validators
and evidence comparisons are pure. No per-item database query was added.

| Assessment unit | Disposition | Findings / local fix |
| --- | --- | --- |
| readPage / redactPage / redactEntry | INCONCLUSIVE | High:contract-and-boundary: final cancellation and cursor-progress gaps structurally fixed; regression execution deferred |
| operational receipt/page schemas | INCONCLUSIVE | High:safety-and-privacy: payload-shaped IDs rejected; tests written, host semantic identity guarantees still required |
| query / decodeRow / metadataMatches | INCONCLUSIVE | High:contract-and-boundary: row/JSON disagreement now fails typed; corruption tests written |
| findRow / appendSql / nextSequence | INCONCLUSIVE | Route existing queries through validated container; existing lineage/conflict/rollback tests retained |
| listSql / validPageRows | INCONCLUSIVE | High:contract-and-boundary: final read cancellation and duplicate identity gaps structurally fixed; tests written |
| memorySqlHarness / shared DB suite | INCONCLUSIVE | High:test-seam-and-evidence: concurrent callbacks serialized and cancellation covered; execution deferred |
| new boundary fixtures / SQL fixture helper | INCONCLUSIVE | Direct input/output assertions target real service/adapter code; no production unit mocked away |

No unresolved High/Critical defect is asserted inside the edited implementation
from static review; no mechanical zero count is claimed. Function-quality routing
remains **INCONCLUSIVE** because test/lint/runtime evidence is unavailable by
instruction. Cognitive/nesting/cyclomatic/NLOC values were not measured. Coverage
mapping is the acceptance/test table, not a coverage percentage.

Documentation classification: `AuditReceipt` and `createJiniAuditRedactor` are
stale-doc-updated; service read orchestration, query/decode/evidence/page validators
and SQL double have behavior/resource docs. Tiny unchanged mappers inherit their
parent context. README's stub claims were replaced. Second static review checked
variable names (`previous`, `seen`, `storedContext`, `cursor`, `selected`) against
their computed meanings, aggregate edge cases, rollback behavior and scope filters.
No zero-findings claim or waiver is made. No loop alert was triggered.

## RISKS

- Tests/lint/om:check/build/security review are unrun; the feature is not represented
  as production-ready. Actual Jini behavior is not exercised by the scripted suite.
- Trusted server callers must secure exact-review evidence and authorize agent/
  service scope; audit cannot prove either from digest/reference-only DTOs.
- Shape checks and lexical scrubbing cannot identify arbitrary personal names or
  opaque business secrets. Host-generated IDs must be non-personal, and references
  must identify secured evidence instead of containing it.
- DB composition owns serialization, cancellation, lock timeouts and integer
  normalization. An uncertain commit returns failure and is never retried here;
  caller reconciliation is required before creating another effect.
- No persisted export job/snapshot, audit_export table, retention/deletion policy
  or future Postgres trigger implementation was added.

## NEEDS

1. `features/audit/package.json` + integrator-owned lockfile: add
   `@jini-ai/core@0.4.3` as a test dependency, then run the same redactor B1 suite
   against the actual public `redactSecrets` wrapper. No install/dependency edit
   was attempted. Host composition also needs its own declared core dependency
   when it supplies that public function.
2. `apps/server` composition: adapt serialized server-owned SQLite transactions to
   `AuditSqlDatabase`/`AuditSqlSession`, load the two audit migrations through the
   authorized runner, and bind required caller audit ports. No live migration here.
3. Host exact-review evidence contract/storage: secure and scope-authorize referenced
   reviewed arguments/results, with explicit retention and key-recovery decisions.
   Current audit contract exposes no evidence-encryption/storage port.
4. Server HTTP + om CLI + studio owners: wire bounded audit listing/export and
   operation/result navigation through the accepted public service.
5. Coordinator: combined tests/build/lint/boundaries/om:check and security review,
   including real redactor and durable DB integration, before production readiness.

## HANDOFF

Next owner: Coordinator/integrator, then combined verification and security review.
No further feature-core implementation is intentionally pending after the written
regressions/fixes. Keep the public contract and durable migrations; complete the
listed integrations and run evidence commands once across the parallel batch.
