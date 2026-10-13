# Programmer(Direct): j06 jobs continuation — 2026-10-12

Jobs provides one durable queue for external writes: enqueue a stable operation,
let a server worker make one authorized, fenced attempt, and retain unknown
outcomes for evidence-based reconciliation. For example,
`await jobs.enqueue({ context, job })`, then
`await jobs.processOne({ worker: { workerId: "server-worker" } })`.
Domain state changes use `createDomainIntentTransaction` instead of a separate
write followed by enqueue. Production DB/scheduler/handler composition and
HTTP/CLI/studio wiring are deferred to their owners. Runtime tests and gates are
pending the Coordinator's combined run.

## Inputs and continuation

Authoritative input: current features/jobs/index.ts, src/ports.ts and src/types.ts;
development/JOBS.md j06; development/COMMON.md; target architecture v2 §§4.8,
5, 6 and 10; all dispatched owner overrides. Inspected the full feature diff
59db645..3e2648f and committed partial source/tests before changing code.
AI-Dev-Shop persona and base/selected backend, hexagonal, reliability,
adversarial-test, documentation and function-quality guidance were read.
No certification hash, pipeline outline or dedicated critical-constraints
artifact was supplied; Direct Mode proceeds against the dispatched contracts.
The architecture itself explicitly designates outbox fencing and atomic intent/
enqueue constraints. Both remain binding; no deviation was made.

Graph tools were unavailable in the enabled tool catalog. Direct discovery was
limited to this feature, its contracts/clock, server DB port shape, architecture,
and relevant Jini package declarations. Discovery found the implementation in
src/outbox.ts, repository.ts, sql.ts/sql-queries.ts, transactions.ts and handlers.ts;
uncertainty remains at server composition and unexecuted runtime validation.

## CHANGED FILES

All changes stay inside features/jobs. Other lanes' dirty/untracked work was
preserved. No root, application, contract-package, lockfile or dependency edit.

- src/schema.ts: shared bounded request parser and strict transport/process result schemas.
- src/store.ts: strict lease-fence, completion and terminal-evidence resolution validation.
- src/adapters/memory-store.ts: active token uniqueness/checkpoint indexes and UTF-8 ordering.
- src/sql.ts: detach inputs before transaction admission, promised async rejection semantics,
  and explicit live-token conflicts matching memory behavior.
- src/outbox.ts: detach authorization input and validate transport output. Preserved retry,
  crash-recovery and dispatch-ordering algorithms remain the starting implementation.
- src/service.ts: validate result shape and freeze expected operation ID before dispatch.
- src/handlers.ts: share parsing, validate output, retain stable identity, and bound active effects.
- src/memory.ts: dispatch double validates the same request boundary as the registry adapter.
- src/ports.ts: document operationId binding for completed dispatch results.
- tests/contract/port-suites.ts: add malformed request cases for double and registry.
- tests/contract/store-suite.ts: add mutation during admission, malformed completion/resolution,
  duplicate active token and Unicode ordering cases, unchanged across memory and SQL.
- tests/contract/service-suite.ts: mismatched dispatch result cannot create retry authority.
- tests/handlers.test.ts: malformed result and global active-effect capacity cases.
- tests/outbox.test.ts: malformed classification and mutable authorization input cases.
- tests/memory-store.ts: replace the shallow legacy fixture with a compatibility wrapper
  over the same memory double used by B1; original characterization assertions preserved.
- README.md, PROGRESS.md, HANDOFF.md: remove stale stub/old-package instructions and record
  current usage, wiring obligations, verification and restart checkpoint.

## TESTS

- `corepack pnpm --filter @open-marketing/jobs typecheck`: **PASS**, exit 0.
  Exactly one invocation; package script checked production and all test files.
- `git diff --check -- features/jobs`: **PASS**.
- `corepack pnpm --filter @open-marketing/jobs test`: **written, not run**.
- `corepack pnpm --filter @open-marketing/jobs build`: **not run**.
- `corepack pnpm om:check`, `om:gate-tests`: **not run**.
- No install, vendor calls, real spend or live migration was performed.

Regression cases were written before their fixes. Runtime RED/GREEN was not
established: the owner's no-test-runs override explicitly prohibits those runs.
No assertion was removed or weakened. Coverage/cognitive/nesting/signature
metrics were not run; no lint rule, exclusion or coverage gate was changed.
No source/test change followed the passing typecheck.

| Acceptance | Retained evidence (written, not run) |
| --- | --- |
| Memory/SQL one suite; dedupe/conflicts | tests/contract/store-suite.ts, port-suites.ts, memory.test.ts, sql.test.ts |
| Expiry/token/tenant/state fencing | store-suite.ts, service-suite.ts, outbox.test.ts |
| Crash before/after dispatch; lost acknowledgement | service-suite.ts, sql-faults.test.ts |
| Unknown non-idempotent effect not blindly retried | service-suite.ts, outbox.test.ts, handlers.test.ts |
| Cancellation and file-backed restart | service-suite.ts, sql-faults.test.ts |
| Atomic domain intent/enqueue commit and rollback | intent-suite.ts, transactions.test.ts |
| Registry removal/drain/reset/dispose | handlers.test.ts, contract/handlers.test.ts |
| Payload/scope validation and adversarial bounds | schema.test.ts, port-suites.ts, store-suite.ts |

B1 suites cover the repository/store and worker against memory and real SQL,
transactional intent against the memory helper and a SQL writer, and dispatch
against the double and handler registry. Authorization/observer doubles have
behavioral suites; no production authorization/observer adapter is authored here.
SQL integration fixtures use injected query/session contracts over test-only
SQLite; server production DB composition still needs its own integration evidence.

## CONTRACTS / reuse

index.ts and src/types.ts are unchanged. src/ports.ts has a documentation-only
clarification: JobDispatchPort completed.jobId binds JobRequest.operationId;
JobService reports the persisted queue ID. The request port contains no queue ID.
createJobHandlerRegistry adds optional maxActive (default 128, range 1..10000)
to satisfy bounded active effects. Existing callers remain source-compatible.
Malformed boundary values now fail explicitly or reconcile; valid states and
retry algorithms are preserved. No new dependency or shared-contract request.

Inspected installed @jini-ai/platform 0.5.3 public .d.ts/package exports and
@jini-ai/core 0.4.3 public registry declarations, plus Jini's db 0.3.2 build's
public core/sqlite/recovery declarations. npm searches were attempted; direct
versioned npm/registry access was unavailable from this environment. No install,
download or sibling-source dependency was introduced.

Reused the existing published-dependency-free jobs ports, @open-marketing/om-clock
checks/injected clock, pure OM schemas, Zod public validation, preserved outbox/
retry algorithms, and existing SQL transaction seam. No direct Jini import was
added: platform exposes OS/network/storage primitives, core's public ToolRegistry
is a discovery/registration surface rather than this job dispatch/drain contract,
and ContributionRegistry lacks unregister/drain/dispose. The inspected db exports
provide DB connection/restore/kernel primitives, not this stable operation/fenced
outbox state machine. db is not installed in this feature; the owner explicitly
requires using OM's DB ports. Production Jini reuse/adaptation belongs to the
server DB owner, through public exports, not imports into app-private shims here.

## MIGRATIONS

No migration added, changed or applied in this continuation. Preserved additive
migrations/0001_jobs.sql owns job and append-only job_attempt tables. Domain
writers own their feature's tables and receive the same transaction session.
Only test fixtures apply the SQL file when the Coordinator later runs tests.

## Architecture Audit / function quality

Static architecture audit: **PASS for inspected lane boundaries**. Checked public
imports only, no other-feature internals/policy import, pure contracts, injected
clock/IDs/I/O, no runtime service start at construction, no driver import in
production, one outbox, same-session atomic intent writes, fenced transitions,
append-only SQL evidence, and lifecycle disposal. No binding deviation found.
Mechanical and runtime verification: **INCONCLUSIVE / pending**, because lint,
boundaries, fault injection and tests were not authorized to run. This is not a
claim that om:check or acceptance tests passed.

| Assessment unit | Disposition | Findings/local fix and direct seam |
| --- | --- | --- |
| Request/result parsers; dispatchResult | INCONCLUSIVE | Static malformed/mismatched-result gap fixed with strict schemas; malformed-output/request suites; runtime evidence pending |
| Fence/completion/resolution validators | INCONCLUSIVE | Static unsafe transition/extra-field gap fixed; store-suite invalid transitions and readback |
| Memory save/checkpoint/token/order | INCONCLUSIVE | Static memory/SQL token/order disagreement fixed; shared suite; checkpoint uniqueness extracted; memory capacity bounded |
| SQL adapter transitions/claim | INCONCLUSIVE | Static deferred-input and synchronous-throw gaps fixed; detached arguments, async ABI and shared suite; SQL transaction host assumption remains |
| Outbox authorization/dispatch | INCONCLUSIVE | Static mutable authorization/unknown classification gap fixed; detached input and validated output; outbox/service regressions |
| Handler admission/dispatch/drain | INCONCLUSIVE | Static unbounded-active gap fixed with maxActive; active call lifecycle and capacity tests; non-settling handler drain remains intentionally pending |
| Dispatch double/characterization wrapper | INCONCLUSIVE | Double now shares validation and actual memory state machine; same B1 and preserved characterization assertions |

No known unresolved Critical/High semantic finding in inspected changes.
Mechanical metrics are unmeasured; all dispositions remain INCONCLUSIVE until
fresh permitted runtime/gate evidence. Helpers carry behavior and complexity
notes; tiny delegation methods inherit the wrapper/factory documentation.
Bounded JSON is O(n log k) time/O(n) space; memory ordering O(j log j) plus bounded
ID encoding, memory checkpoint O(j+p); SQL claims use indexed lookup/update/append
inside a serialized transaction; registry admission is O(1), drain O(h+a).
Every changed unit has a directly assertable injectable/public test seam.
Variable-name review confirmed snapshot versus live input, expected operationId,
and active-token versus job-key indexes have distinct, accurate names. No claim
of measured coverage or lint compliance is made. Foreign Promise/sort/Vitest
callbacks retain their ABIs; owned method signatures use at most two objects.

## RISKS

- Unknown non-idempotent outcomes never automatically replay. Pre-dispatch lease
  loss also conservatively reconciles; operator evidence is needed for resolution.
- Dispatch port errors, including known local overload/missing handler errors,
  conservatively reconcile. Host worker concurrency should stay within maxActive.
- IDs must be globally unique across restart/retry horizons. Both stores reject
  active token reuse; composition is responsible for never reusing historical tokens.
- Awaited policy admission does not itself serialize egress against a later halt/
  consent change; each injected dispatch handler must implement the final barrier.
- DB/provider call deadlines and AbortSignals are host-owned. Drain waits for
  actual settlement; lease expiry is not proof that remote work stopped.
- SQLite adapter correctness depends on serialized writers and same-connection
  transaction callbacks. Postgres concurrency/row codecs are not verified.
- Capacity includes historical jobs. Archival/retention requires a separate owned
  workflow preserving deduplication horizon and append-only evidence.
- Runtime regressions, lint metrics and acceptance remain unverified under the
  no-runs override; typecheck cannot substitute for those results.

## NEEDS

- Server integrator: bind JobsSqlDatabase to the server-owned SQLite/Jini DB port,
  adapt sql/parameters versus text/values, serialize transactions with BEGIN
  IMMEDIATE, preserve typed callback failures after confirmed rollback, and keep
  unknown commit outcomes unavailable. No app or DB shim edits made here.
- Server/plugin integrator: bind host scheduling/deadlines and current authority/
  halt/consent serialization at each actual dispatch. Reuse this queue for every
  feature; no feature-specific durable outbox.
- App/API owners: provide jobs activity/reconciliation HTTP + CLI + studio surfaces.
- Coordinator: execute one combined validation, then review/commit OM work.

## HANDOFF / pre-completion / self-validation

Next owner: Coordinator, followed by server/plugin integrators. Implementation
changes and all required tests are present; runtime acceptance is pending.
Requirements re-read; fresh single typecheck and whitespace diff evidence saved
above; test integrity and lane scope checked; unrelated concurrent changes
untouched. No commit/push. Self-validation **not run** because the binding owner
update forbids test suites/builds/gates; no runtime PASS claimed, no retry loop.
PROGRESS.md records this checkpoint and next actions. No offload or loop alert.
