# Programmer(Direct): Measure continuation handoff

Measure now has tracking links, authenticated and deduplicated signup/trial
inbox ingestion, consent-gated server conversion delivery, immutable reports and
account-bound CAC. For example, ingest a verified signup, append its declared
account/campaign attribution, then call `reportCac` for that account's USD period
and `30d_click` platform window. Production server/plugin binding, automatic touch
attribution, surface integration and combined verification are deferred.

Status: **PARTIAL — implementation and tests written; verification pending.**
Continued `3e2648f`; retained the previous algorithms and adapter/transaction shape.
No commits or pushes. No unrelated dirty work was changed.

## CHANGED FILES

Public contracts and orchestration:

- `index.ts`: exports the committed-conversion verification port and memory/SQL factories.
- `src/types.ts`: adds account/window report dimensions and account-bound attribution.
- `src/ports.ts`: adds `ConversionVerificationPort`; corrects the portable SQLite DB seam description.
- `src/service.ts`: parses complete inputs before context derivation or effects.
- `src/rules.ts`: strict input/evidence schemas, canonical identities, bounded storage and validated ID allocation.
- `src/memory.ts`: validates contexts, registry/evidence inputs, audit evidence and reconciliation; preserves account/schema delivery identity and delivered outcomes.

Ingestion, links, delivery and reporting:

- `src/ingestion/ingest.ts`: shared scope validation; receipt must match submitted event.
- `src/links/links.ts`: rejects duplicate query keys and dot path IDs; validates IDs/resolution context; translates ID failure.
- `src/delivery/input.ts` (new): shared send/reconcile schemas and account/connection/schema identity.
- `src/delivery/dispatcher.ts`: verifies the committed inbox; validates ledger claims/outcomes; keeps final audit/authority ordering; persists evidence after cancellation.
- `src/reporting/report.ts`: exact account/window checks and half-open watermark bounds; small separate query/summary rules.

Adapters:

- `src/adapters/capabilities.ts`: validates complete capability inputs/outcomes; contains/redacts throws and propagates observer evidence.
- `src/adapters/verification.ts` (new): bounded committed-event double and indexed SQL verifier.
- `src/adapters/memory-repo.ts`: source context validation, immutable result IDs, account-isolated denominator and bounded/validated IDs.
- `src/adapters/sql-repo.ts`: corresponding SQL behavior and cancellation rollback during enqueue.
- `src/adapters/sql-jobs.ts`: shared source/event scope validation.
- `src/adapters/sql-links.ts`: validated ID allocation and resolution ID.
- `src/adapters/sql-delivery.ts`: validates service contexts.
- `src/adapters/sql-boundary.ts`: explicit generic parameter/return type to address the inherited compiler error.

Tests:

- Updated `tests/contract/port-suites.ts`, `memory.test.ts`, `sql.test.ts`, `capabilities.test.ts`.
- Added `tests/contract/local-capabilities.test.ts`, `tests/local-capability-fixture.ts`, `tests/boundaries.test.ts`.
- Updated `tests/delivery.test.ts`, `ingestion.test.ts`, `reporting.test.ts`, `fixtures.ts`, `sql-fixture.ts`.
- SQLite fixture applies only in-memory test DDL, enables foreign keys, and serializes transaction writers. Node listener/stream ABIs stay in test wrappers.

Documentation: `README.md`, `PROGRESS.md`, this `HANDOFF.md`.
Migration: `migrations/0002_attribution_account.sql` (new).

## TESTS

- `corepack pnpm --filter @open-marketing/measure typecheck`: **RED, exit 2**.
  First `tsc --noEmit` found `src/adapters/sql-boundary.ts:17` inferring
  `runBoundary<never>` from the rollback outcome; corrected to `runBoundary<T>`
  with an explicit `Promise<Outcome<T>>` callback. No second invocation was run.
  The test-file typecheck after `&&` never ran. Later additions also remain unverified.
- `git diff --check -- features/measure`: **GREEN** (whitespace check only).
- Package tests, builds, `om:check`, lint, coverage, runtime self-validation and
  mutation/red-green regression runs: **written, not run**, as required by the
  owner override. No test pass count or numeric complexity/coverage claim is made.
- Coordinator commands: package typecheck/test/build, followed by combined root
  `om:check`. These are handoff instructions, not commands executed here.

Shared B1 suites are declared for repo, consent, delivery, reporting, jobs, links,
audit, source authentication, current grants, delivery ledger and committed-event
verification. Applicable suites are reused unchanged by memory and SQLite. Typed
capability wrappers share the delivery/reporting suites with actual loopback HTTP
fixtures as well as memory capabilities. Fault-injection ingestion tests assert
inbox AND outbox rollback, including cancellation during enqueue.

Regressions written but not executed: account/result ID collisions, account-separated
CAC, account/attribution-window drift, malformed reconciliation, malformed source
context, tainted ledger evidence, uncommitted event denial, simultaneous workers,
post-egress cancellation, invalid limits/IDs, withdrawal/expiry, immutable evidence,
and half-open event periods. The Coordinator must obtain demonstrated red/green
runtime evidence; this session supplies no claimed green bug-fix evidence.

## CONTRACTS

Minimal local fixes to incomplete contracts:

1. `CacQuery` now requires `accountId` and `attributionWindow`; `CacReport` echoes
   both. Previously a single-account spend snapshot could be divided by workspace
   conversions, and no requested platform window existed to validate.
2. `AttributionResult` requires `accountId`. Memory and SQL count only that account;
   result IDs cannot silently bind a different event/model, and account corrections
   require a new declared model version/result ID.
3. `ConversionVerificationPort` and memory/SQL factories are exported from
   `index.ts`. `createConversionDispatcher` requires `verification`: source consent
   plus a grant alone did not prove a worker payload came from the verified inbox.
   The new SQL adapter checks scope and canonical full event identity against
   committed Measure events before any claim/egress.
4. Capability factories may take an optional observer; existing call forms remain
   supported. `createMeasureService`'s required argument contract is preserved.
   Its preexisting optional authentication seam remains mandatory for successful
   ingestion. Compatibility `jobs`/`conversions` dependencies are not dispatched
   sequentially by ingestion or exposed as agent conversion tools.

No shared contract, root manifest, lockfile or other feature was edited. No current
external account/window/dispatcher consumers were found in the inspected
`apps`/`features` search. Future surface/composition callers must use these dimensions.

Jini reuse review:

- Inspected installed `@jini-ai/platform@0.5.3` public declarations for
  `./http/guarded` and `./net/endpoint-policy`. Those are generic DNS/pinned HTTP and
  address policy primitives; their production seam belongs in injected plugin
  egress. Measure creates no HTTP engine, credential broker or endpoint classifier.
  Feature-specific origin/query admission is retained; it performs no network I/O.
- No Jini package is a direct Measure dependency, and none was added or installed.
  No new temporary compatibility shim was created. Source authentication, policy,
  grants, jobs and credentials remain caller-owned seams.
- SQLite stays behind the OM DB-shaped port as explicitly required. No Jini/native
  DB driver was constructed in production code. better-sqlite3 appears only in the
  inherited test fixture; the generic host DB binding remains an integration need.
- npm registry requests were attempted (web and bounded curl) but were unavailable;
  curl reported DNS resolution failure. No remote package/API verification is claimed.

## MIGRATIONS

Added `0002_attribution_account.sql`: nullable `account_id` on attribution records,
an account/model lookup index and an event-ID index for inbox verification. SQL is
portable to SQLite/Postgres. Historical rows without account evidence are excluded
from account CAC; no inferred backfill overwrites records. In-memory tests are
written to apply 0001 then 0002. No live migration was applied. Integrator owns
migration scheduling and any justified append-only historical correction.

## RISKS

- No test/build/lint/combined gate evidence; the one typecheck did not pass. The
  explicit SQL generic correction and test compilation need combined verification.
- The dispatcher denies rather than guessing when required authority, authentication,
  committed-event verification, consent, ledger or audit is missing.
- A claim retained after a pre-egress denial is conservatively uncertain on retry;
  only reconciliation is allowed. It does not authorize a new send. Recovery needs
  explicit plugin evidence or operator handling, not automatic ID replacement.
- Worker delivery IDs must derive from the single jobs outbox and remain stable;
  arbitrary new IDs would constitute new delivery operations. Jobs fencing and
  provider idempotency/reconciliation remain host/plugin responsibilities.
- Grant/consent can change while another gate or transport awaits. The plugin egress
  broker must recheck current connection/account authority and current consent at
  actual dispatch; the feature's checks do not create a cross-feature lock/barrier.
- Snapshot lineage is immutable, but automatic touch/model calculation is not
  provided by this contract. A trusted attribution producer must supply evidence.
  The watermark represents observed event time, not ingestion/report completeness.
  Unmapped/gap diagnostics need an explicit future report contract.
- Memory authentication/grant/consent/verification stores are doubles. They must
  never substitute for authenticated host ingress or durable production authority.

## NEEDS

- `apps/server` composition: bind `MeasureSqlDatabase` to the server-owned SQLite
  OM DB port with serialized transaction writers and rollback on thrown outcomes.
- Jobs integration: implement `MeasureTransactionalJobPort` over the exact supplied
  session for the ONE jobs-owned outbox; bind stable worker delivery IDs and fencing.
  No new feature-owned production jobs table is supplied.
- Host ingress/current authority: real source authentication bound to trusted
  request evidence, canonical policy projection, durable `MeasurementGrantPort`,
  current credential connection/account checks and plugin egress rechecks.
- `content/agent-plugins` owners: typed conversion/reporting capabilities using
  published Jini guarded HTTP/credential primitives and provider-specific codecs,
  response identity, idempotency and reconciliation evidence.
- Surface owners: close Measure HTTP + studio + om CLI together. Bind explicit
  account/window dimensions; never expose the conversion dispatcher as generic MCP.
- Coordinator: run combined verification and regression red/green; review/apply
  additive migrations only in an explicitly assigned operation.

Production adapters for current grants, raw source authentication, generic DB
transactions and transaction-scoped jobs are explicitly deferred to these host
bindings. Their test seams are supplied by domain doubles and/or the SQLite fixture;
no second generic SQL or jobs engine was rebuilt to simulate production success.

## HANDOFF / REVIEW EVIDENCE

Architecture audit: **WARNING / verification pending**. Source review confirmed
feature-only edits, caller-owned ports, public external imports, no vendor core
branches, injected clocks/IDs/I/O, no startup effects, no source .tsx, one outbox
binding, immutable evidence and no live operations. Mechanical boundary/complexity
checks did not run; no numeric metrics are invented. Review the required host
rechecks and stable-ID composition before production admission.

Pre-completion checklist: requirements revisited; previous implementation preserved;
existing assertions retained and strengthened for new dimensions; scope reviewed;
fresh permitted typecheck failure recorded; whitespace checked; open needs listed.
Self-validation: not run because the owner forbids runtime/test/build runs in this
session. No test execution, live service startup or probe was used to bypass that
restriction.

Pattern/style: continued the committed guard-clause/pure-rule/injected-port patterns
rather than creating a new architecture. Existing dispatch authorization and the
continuation instruction supplied permission to proceed with that established
style. No additional pattern approval was requested. Documentation class:
new public verification factories/port and shared rules **documented**; report and
service docs **stale-doc-updated**; small obvious private mappers intentionally rely
on the containing boundary's docs. Foreign listener/stream callbacks are narrow
and documented in tests.

Function-quality review (semantic source review; mechanical evidence unavailable):

| Assessment units | Disposition | Findings and local fix |
| --- | --- | --- |
| service create/ingest/report; parseSourceEvent; ingestion validation/receipt | INCONCLUSIVE | High:boundary:context derived from unparsed ingress; complete-input validation added. Receipt identity checked. Tests written. |
| reportCac; query/snapshot/summary validation; repo attribution append/read | INCONCLUSIVE | High:analytics:account/window ambiguity and reused result IDs; explicit dimensions, immutable IDs, SQL/memory parity and account-period tests added. |
| dispatchOnce; verifyConversion; claimDelivery; authorizeEgress; perform | INCONCLUSIVE | High:authority:unverified events and tainted claims; committed-inbox port and evidence validation added. High:durability:cancellation discarded outcome; final persistence now ignores cancelled signal. |
| parseDeliveryInput; deliveryIdentity; capabilityOutcome and capability wrappers | INCONCLUSIVE | Medium:boundary:reconciliation/context/result errors; shared schemas and redacted outcome wrapper added. No retry added. |
| SQL conversion commit; sqlBoundary; source/job/ledger/link adapter methods | INCONCLUSIVE | High:atomicity:cancellation during enqueue; transaction rollback added. Compiler:generic-inference:explicit T fix after the single failed check. |
| memory consent/source/grant/audit/delivery/ledger; storageLimit; nextId; tracked link rules | INCONCLUSIVE | Medium:bounds:unvalidated config/IDs and ambiguous query keys; bounded evidence/storage, strict schemas and ID/query validation added. |
| memory/SQL committed-event verification | INCONCLUSIVE | Scoped full identity with bounded fixtures/indexed query; tests include conflict and cross-scope denial. |
| test SQLite and loopback HTTP fixtures | INCONCLUSIVE | Actual transaction/transport mechanisms are exercised by written suites; no executed evidence yet. |

The High findings above describe addressed failure modes, not a claimed runtime
clearance. Remaining cross-feature egress authority/barrier risk requires host and
Security review; no claim of zero findings is made. Numeric cognitive/cyclomatic,
nesting, NLOC and coverage measurements are unavailable under the override.

Complexity: URL/event/schema work is bounded by request limits; memory stores cap
records; account attribution is O(n+a) in memory and a bounded-result aggregate over
indexed SQL account/period joins. Verification uses one indexed query. Dispatch has
fixed port-call count and no internal retry. All changed branches have input/effect
seams; coverage mapping is to the shared suites and named acceptance files above,
not an unexecuted percentage. No coverage exclusion or test suppression was added.

Discovery: graph MCP was unavailable; direct reads and rg fallback identified only
Measure implementation paths. No subagent was spawned. Progress/next actions are
retained in `PROGRESS.md`. Suggested routing: Coordinator combined verification,
then integration and security/architecture inspection of production egress binding.
