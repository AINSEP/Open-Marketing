# Programmer(Direct): j02 workspace handoff

Workspaces authenticates a server session, resolves its owner's workspace, and
binds vendor accounts only to connections owned by that scope. For example,
resolve `session-a` into `workspace-a`, then pass that returned context and an
owned `connection-a` into `bindAccount`. Forged/copied contexts, revoked sessions,
other-owner connections and conflicting bindings return typed failures.

Deferred: integrator-owned real Jini identity adapter, server DB/composition
wiring, trusted workspace/connection provisioning, HTTP/studio/CLI routes, and
combined runtime verification. No login/password/session-minting implementation
was duplicated.

## CHANGED FILES

- `index.ts`: additive SQL factories/types, memory observer and fixture record types.
- `src/service.ts`: authenticated resolution, instance-issued context proof,
  five-minute expiration, live identity recheck, tainted-output checks and trace events.
- `src/ports.ts`, `src/types.ts`: unchanged method/value shapes; accurate security documentation.
- `src/memory.ts`: seeded identity/repository/lookup doubles, revocation and observer double.
- `src/schemas.ts`, `src/rules.ts`, `src/boundary.ts`: strict parsing, pure ownership/replay
  rules, typed exception boundaries and privacy-safe best-effort observations.
- `src/repository.ts`, `src/store.ts`: shared repository behavior over memory/SQL persistence.
- `src/adapters/memory-store.ts`: scoped indexes, bounded validated seeds, immutable persistence.
- `src/adapters/sql-store.ts`, `src/sql.ts`: inert DB-shaped SQL adapter and injection contracts.
- `migrations/0001_workspaces.sql`: feature-owned ownership/binding tables and constraints.
- `tests/fixtures.ts`, `tests/sql-fixture.ts`: instance-local IDs and real SQLite fixture.
- `tests/contract/{port-suites.ts,memory.test.ts,sql.test.ts}`: shared behavioral B1 suites.
- `tests/{service.test.ts,adapters.test.ts}`: feature acceptance, security and failure tests.
- `README.md`, `HANDOFF.md`, `progress-ledger.md`: usage, constraints and resume/handoff records.

All writes are inside `features/workspaces/`. No commit or push.
`git diff --check -- features/workspaces` found no whitespace errors.

## TESTS

- Tests: **written, not run**, per the owner's override. No red/green execution
  evidence is claimed; this implements j00 stubs rather than an already-running bug fix.
- `corepack pnpm --filter @open-marketing/workspaces typecheck`: **exit 2**. Production
  `tsc --noEmit` passed; test compilation found only two missing `ObserverEvent`
  exports in test imports. Both test imports were corrected to the public
  `@open-marketing/contracts` type. No rerun: only one invocation is authorized.
  Final test compilation remains unverified. Lookup wrappers were also reviewed and
  hardened after this check to map thrown/malformed injected repository responses
  through the existing typed boundary; final compilation was not rerun.
- `corepack pnpm --filter @open-marketing/workspaces test`, build, `om:check`,
  `om:gate-tests`, installs and coverage: **not run** under the override.
- B1 repository/lookup suites have memory and real SQLite registrations. Identity
  has one shared suite registered with the memory double; the real identity adapter
  registration is deferred. Observer has a shared suite registered with its double.
- Adversarial cases: repeated external IDs in multiple scopes, both binding-key
  conflicts, concurrent conflicting writes, failed-bind state leaks, caller mutation,
  context forgery/copy/mutation, expiry boundary, revocation, SQL literal injection,
  foreign-key violations, reconstructed SQL adapter, malformed/throwing ports, and
  cancellation after a committed write.

## CONTRACTS

Service, port method and domain value shapes remain unchanged. Documentation now
states that repository/lookup are trusted server boundaries, while service binding
requires an exact instance-issued context and reverified session. This is necessary
because `bindAccount` has no session argument and raw `CallContext` fields cannot
become authority. The returned context remains the existing public value shape.

The stub memory factory's `{}` input was expanded compatibly to optional trusted
seed/dependency fields. Lookup delegates to the same repository; empty configuration
fails explicitly. New public SQL factories/types and memory observer are additive.

`AccountBinding`/lookup has no vendor discriminator. External account IDs are unique
within owner+workspace, including across connections; collisions cannot silently
rebind. Different scopes may reuse both external account IDs and binding IDs.

## MIGRATIONS

`0001_workspaces.sql` is additive and **not applied**. Tables: `workspace`,
`workspace_connection_scope`, `workspace_account_binding`. Compound primary/unique
keys and foreign keys preserve full scope and owned connection references.
SQLite foreign keys and transaction serialization are server responsibilities.

## JINI REUSE CHECK

Checked installed published packages before implementation: `@jini-ai/core@0.3.1`,
`@jini-ai/platform@0.3.0`, and `@jini-ai/cms@0.3.11`, including public identity and
workspace declarations. The identity entry exports `validateSession`, login/logout,
session repositories and session minting. These should be reused by the real
identity adapter, assigned to the integrator; this lane implements only the required
identity double. No runtime Jini dependency was added because new dependencies and
identity composition are integrator-owned.

Jini workspace CRUD has id/name/slug/createdAt and no OM account-scope binding seam;
core token/origin auth is not owner/workspace resolution. No approved algorithm was
reimplemented. SQL uses the injected server DB-shaped port rather than a native
driver in production. Actual SQLite is only a dev-dependency fixture.

npm search and direct package/registry requests were attempted. Direct npm/registry
fetches failed/cache-missed and shell network returned no metadata, so an online
published-version verification is **unavailable**, not claimed successful. Installed
published tarball declarations provided the implementation inventory.

## RISKS

- Runtime/lint/boundary/coverage evidence is pending the combined Coordinator run.
- Real identity adapter and its B1 registration are not delivered in this lane.
- Server must resolve context per request and preserve the context instance through
  binding. It must not expose repository/lookup as independently authenticated APIs.
- Identity port and DB port calls rely on injected adapters/server supervision for
  timeouts/cancellation; the feature does not start timers or blindly retry writes.
- Connection authority provisioning must track ownership changes; revocation of a
  connection must remove/invalidate its authority through trusted server composition.
- Five-minute expiration is fail closed on invalid/rolled-back clocks. Active contexts
  do not survive service recreation; resolve again, while SQL bindings remain persisted.
- A post-commit transport failure returns unavailable and requires reconciliation/exact
  replay; it is never reported as a successful unobserved write.

## NEEDS

1. Integrator: declare/reuse `@jini-ai/cms/identity` public `validateSession` and map
   server session handles plus verified owner identity into `IdentityPort`; register
   its adapter in the existing shared identity suite. No browser/agent owner claims.
2. Integrator: adapt `apps/server/src/platform/jini-compat/db` to exported
   `WorkspaceSqlDatabase`; use serialized SQLite transactions, foreign keys,
   query timeout supervision and the server's numbered parameter translation.
3. Integrator: register the feature migration and trusted bootstrap/synchronization
   of workspace/connection ownership; do not populate authority from bindAccount.
4. Integrator: close HTTP/studio/CLI composition around this service and run combined
   checks. No files outside the lane were edited to implement these items.

## HANDOFF / ARCHITECTURE AUDIT

Status: **WARNING — runtime evidence deferred by owner**. Source review confirms
pure contracts, no cross-feature imports, injected I/O/clock/IDs, no native driver in
production, no module startup, caller-owned ports, bounded values, and scoped SQL.
The public contracts-only import plus zod is allowed. Root manifests/configuration,
other lanes, platform code and shared contracts are untouched.

Pre-completion: acceptance requirements mapped to retained tests, test assertions
reviewed against realistic failure modes, write scope checked, and deferred items
named. Self-validation/coverage were not run because the owner forbids tests/builds.
No coverage exclusions or weakened thresholds were added. Documentation is updated
for every changed public symbol; obvious private leaves inherit parent docs.

Function-quality source review (verification is inconclusive until combined gates):

| Units | Disposition | Findings / smallest follow-up |
| --- | --- | --- |
| resolve/bind orchestration and boundary helpers | INCONCLUSIVE | test-seam-and-evidence: tests/gates not run by owner direction |
| pure scope/replay/context comparisons | INCONCLUSIVE | observable acceptance assertions written; no runtime evidence |
| memory constructors/store/expiration | INCONCLUSIVE | bounded seeds, instance-local mutation and copied outputs reviewed; tests not run |
| SQL store/query decoding/atomic bind | INCONCLUSIVE | real SQLite shared suite written; server adapter needs integration verification |
| observer/lookup adapters | INCONCLUSIVE | trace/privacy and shared index assertions written; tests not run |

Source skepticism pass checked value names, both uniqueness keys, mutation after
resolution, copied contexts, typed exception mapping, privacy of trace events,
post-commit cancellation and SQL parameter binding. No measured complexity or
coverage result is claimed. Smallest compliant next step is the Coordinator's
combined verification plus real identity/DB composition, not a local test rerun.
