# Programmer(Direct): j04 policy handoff

Policy stores exact consent, withdrawal, suppression and merge evidence, returns
fresh subject-policy snapshots, and resolves identifiers inside one owner/workspace.
The preserved gates decide whether a message, identifier share or exact-operation
spend is eligible. For example, append a signup consent for destination `meta`,
read the subject snapshot, then call `shareability` for purpose `signup` at injected
time; a matching withdrawal denies sharing even after an identity merge.

Deferred: identifier registration, holdout/frequency-counter writes/projection,
explicit consent supersession/re-consent, retention/erasure, production composition,
and behavioral verification. Current authoritative ports expose no methods for
those writes. Core snapshots have no grants by default, holdout false and no cap.
This is a PARTIAL handoff pending the Coordinator's combined checks and integration.

## CHANGED FILES

All changes are within features/policy. No commits/pushes or unrelated edits.

- index.ts: additive SQL factories/types, memory options, IdentifierBinding and typed configuration error exports.
- src/types.ts: exact per-kind evidence payload union and identifier-binding seed type.
- src/ports.ts: implementation-era contract docs; existing method signatures unchanged.
- src/service.ts: typed validation/dependency failures, future evidence rejection using injected clock, observer propagation, inert factory.
- src/memory.ts: isolated append-only repository and canonical identity double with shared live merge state.
- src/projection.ts: conservative merged snapshot projection, canonical roots/cycle detection and normalized retry comparison.
- src/validation.ts: strict bounded schemas, scope/principal validation, typed failures/configuration error, safe observers.
- src/sql.ts: injected DB-pool adapter, parameterized queries, serialized writes, rollback/release, tainted persisted JSON validation and column consistency.
- migrations/0001_policy.sql: feature-owned additive identifier/evidence tables and scoped indexes.
- tests/contract/{port-suites,memory.test,sql.test}.ts: one behavioral suite for memory/SQL repositories and identity resolution; observer double suite.
- tests/{fixtures,sql-fixture,service.test,adapters.test}.ts: deterministic data, actual in-memory SQLite query-port binding, service and adapter failure/cap/corruption tests.
- README.md, CHARACTERIZATION.md, progress-ledger.md, HANDOFF.md: usage, approved behavior, limits, implementation state and review evidence.

src/gates.ts, src/index.ts and tests/gates.test.ts remain unchanged.

## TESTS

Written, not run: shared memory/SQL repository suite; canonical identity suite;
observer suite; service and adapter tests. Existing gate characterization retained.
No vitest, om:check, om:gate-tests, build, install or test suite was executed.
Coverage was not measured. Red/green regression evidence is unavailable because
the owner expressly prohibited test execution; no passing-test claim is made.

ONE permitted command executed:
`corepack pnpm --filter @open-marketing/policy typecheck` — exit 2.

The command's first `tsc --noEmit` completed successfully (production source).
The second `tsc -p tsconfig.tests.json` reported only:
`tests/sql-fixture.ts(10,17): TS4058` (exported inferred return type could not name
BetterSqlite3.Database). Root cause: the fixture exported an inferred third-party
constructor instance type while declaration checking remained enabled. The return
now explicitly names the public `Database.Database` type. This correction has NOT
been typechecked again; the single-command allowance was exhausted. Coordinator
must rerun the package typecheck during combined verification.

`git diff --check -- features/policy` — exit 0 after the type annotation correction.
Source inspection: no production driver import, startup I/O or hidden time read.
Graph search for exact gate names returned exactly the three canonical functions
under features/policy/src/gates.ts; direct diff confirmed algorithms/tests unchanged.
Graph discovery preceded source reads; stale/missing entries and approval-blocked
search_code caused a scoped source fallback. No index refresh or repo-wide scan.

Adversarial assertions written: overlapping grant/withdrawal in both append orders;
withdrawal on merged identities; workspace/owner collisions; same-ID changed
payload; concurrent exact retries; cycles/self-merge/repeated source merges;
capacity overflow without truncation; immutable ingress/snapshot data; malformed
stored JSON/scope; cancellation; dependency/query failures and connection eviction.
The SQLite fixture applies migration SQL only to its own :memory: database when
Coordinator executes tests; it has not been instantiated in this session.

## CONTRACTS

`PolicyEvidence` formerly had metadata plus kind only. It could neither carry a
purpose/destination-bound consent nor name a suppression/merge target. Minimal
in-lane fix: metadata intersected with a kind-specific payload union:
- consent/withdrawal require `consent: Consent`; schema enforces matching status.
- suppression requires `suppression: Suppression`.
- merge requires `target: SubjectReference`; owner and workspace must match.

All existing factory names and service/port methods are implemented; signatures
are preserved. Memory factories accept optional seed fields while `{}` remains
valid. Memory/SQL repo factories additionally implement CanonicalIdentityPort so
identifier resolution observes the same current merge state. Root exports add SQL
factories, structural pool/client types, memory config, binding type, and typed
PolicyConfigurationError. No shared DTO, manifest, lockfile or other feature edit.
Callers constructing metadata-only evidence must now supply the exact payload.
Clock is used only by service append; IDs remain ingress-owned to retain retry
identity. The retained ids factory dependency is intentionally unused.

## MIGRATIONS

One additive unapplied file: migrations/0001_policy.sql. Tables are
policy_subject_identifier and policy_evidence; JSON evidence distinguishes consent,
withdrawal, suppression and merge facts. No budget authority/envelope table.
SQL uses portable TEXT/BIGINT, scoped primary keys and indexes. No old migration
rewritten, no migration runner altered, no live or local database migrated.
The server owns registration and execution through its DB shim.

## REUSE

Read installed public package metadata/exports for @jini-ai/core 0.3.1,
@jini-ai/platform 0.3.0 and @jini-ai/integrations 0.3.6 in node_modules/.pnpm.
They expose kernel/tool-registry/auth, OS/platform and vendor integration behavior;
no OM consent/subject evidence implementation was found in those inspected exports.
The npm publisher listing was checked, but exact package-page/registry retrieval
was unavailable (browser cache misses; shell DNS unavailable), so a complete live
registry inventory is not claimed. Publisher evidence: https://www.npmjs.com/~ai-oss.

No new Jini dependency is imported: these exports do not replace OM-owned policy,
and dependency addition would require integrator ownership. Reused existing shared
@open-marketing/contracts schemas/outcomes/context, zod, the preserved OM gate
algorithms/tests and the structural public DB-shim query/connect/release shape.
No generic DB driver/pool/transaction machinery was rebuilt: the adapter borrows
an injected connection and issues the feature's parameterized SQL. Real drivers
remain server-owned; better-sqlite3 appears only in test fixtures.

## RISKS

- Behavioral suites and final test-fixture type annotation remain unverified.
- Per-workspace evidence limit defaults to 10,000 (configurable 1–100,000).
  Reads/appends fail closed at/above the limit rather than dropping withdrawals.
  This deliberately simple bulk projection must be replaced with indexed scoped
  projection before larger histories; memory scans all retained fixtures by scope.
- Identifier registration and holdout/frequency state cannot be authored through
  current ports; those are deferred explicitly rather than represented as writes.
- A merge is permanent. Superseding withdrawal/re-consent has no current contract.
- Server composition must configure bounded pool connect/query timeouts. This
  feature supplies no process-global timers or connection lifecycle.
- PostgreSQL path is authored for portability, not exercised; serialization errors
  fail unavailable. Retry the same evidence ID, never invent a new ID.
- Authentication and agent/service principal admission remain upstream. This
  feature enforces scope equality and owner-principal consistency, not credential
  verification. Identifier normalization is explicit ingress responsibility.

## NEEDS

- Server integrator: register the feature-owned migration; inject existing
  SQLite pool and observer; set pool timeouts and lifecycle. No driver switch is
  needed: the read server DB shim already exposes SQLite.
- Coordinator/ingress contract owner: define authenticated identifier-registration
  writes and holdout/frequency persistence if those workflows are required now.
  Current PolicyService/CanonicalIdentityPort have only evidence append/snapshot
  and identifier resolve. No out-of-lane files were changed to invent these APIs.
- Coordinator: review the required evidence payload addition and run combined
  tests, typecheck, build and om:check (including tests and SQLite native binding).

## HANDOFF / architecture audit

Static audit status WARNING: code stays in its assigned slice, imports only public
contracts/zod in production, injects effects/time, retains one gate implementation,
uses no vendor calls or root/shared mutations, and provides append-only scoped
storage. Mechanical lint/boundary tests were not run under the override.
No ADR index/project_memory/certification artifact was present at referenced paths;
the dispatch, COMMON and accepted architecture serve as the binding checklist.
Pattern priming used the approved object-shaped gates and skeleton ports as its
style seed; dispatch authorization superseded additional confirmation steps.

Function-quality assessment (all runtime evidence deferred):

| Units | Disposition | Findings | Local fix/review |
| --- | --- | --- | --- |
| service/validation/observer boundaries | INCONCLUSIVE | mechanical/test evidence unavailable | strict schemas, typed failure paths and deterministic assertions written |
| rootsFor/resolveRoot/checkAppend/projection | INCONCLUSIVE | mechanical/test evidence unavailable | memoized O(n) graph traversal; cycle/scope/retry adversarial assertions |
| memory factories/seeds/resolution | INCONCLUSIVE | mechanical/test evidence unavailable | quadratic seed replay replaced with grouped linear validation; bound seeds |
| SQL reads/writes/transaction helpers | INCONCLUSIVE | mechanical/test evidence unavailable | bulk bounded read, rollback/release, stored-column checks; shared SQLite suite |
| subject holdout/frequency projection | RECOMMENDED | Medium:contract: no write/projection contract exists | explicitly deferred; route contract rather than add unsupported evidence kinds |
| SQLite fixture | INCONCLUSIVE | TS4058 naming failure corrected but not rechecked | explicit public DB type; lease acquisition atomically claims before awaiting |

No unresolved Critical/High source finding was identified in static review; this
is not a claim that lint/tests pass. Remaining scalability/contract limitations
are listed above. A second static pass checked variable meanings, cancellation,
idempotency, merged withdrawal and hidden dependencies. Runtime evidence remains
INCONCLUSIVE. Tests assert actual gate/repository outputs, not only echoed input;
all seams are directly reachable without global service mocks. Documentation is
added for public factories, payloads, DB lifetime, errors/side effects and limits;
old stub docs updated. Existing public gate docs remain unchanged.

Pre-completion checklist: requirements and scope reread; only lane edits; approved
gates retained; tests written without suppressions; single typecheck attempted;
its fixture naming failure corrected but not re-run; outstanding needs recorded.
Self-validation not run: owner prohibited runtime/test/build execution.
Next routing: Coordinator combined verification and server composition, then
Code Inspection for contracts, SQL races, gate invariants and bounded projections.
