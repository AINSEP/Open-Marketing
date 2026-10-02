# om-pg checkpoint

Independent package saved: injected pg-compatible ports; transaction helper with rollback,
release and uncertain-commit errors; checksum migration runner with transaction advisory lock;
allowlisted bounded claimBatch with SKIP LOCKED; initial migrations/0001_spine.sql with
scoped identity, consent, suppression, budget authorization, holdout and conversion prerequisites.

Tests saved: transaction.test.ts, migrations.test.ts, claim-batch.test.ts and fake-client.ts.
Initial transaction run: 5 passed. Expanded package test: 20 passed; typecheck passed.
All work is inside packages/om-pg. Coordinator owns dependency install/lockfile.

Next commands: `corepack pnpm --filter @open-marketing/om-pg test`,
`corepack pnpm --filter @open-marketing/om-pg typecheck`,
`corepack pnpm --filter @open-marketing/om-pg build`.

Build passed. README saved with injected pool deadlines, trusted migration SQL, cleanup outcome
semantics, queue table/index contract and indefinite-consent adapter requirement.
Real Postgres schema probe passed, including scoped references, separate channel/destination consent,
invalid scope rejection, self-merge rejection and exact money beyond JavaScript safe integer.
Remaining integration: real-driver migration replay/concurrency and SKIP LOCKED worker competition.
No pg driver was installed; Docker unavailable. Fake tests cannot establish those semantics.

Disposable database `om_pg_probe_20260907_astra`: created after absence check, schema/probe applied,
dropped; recreated for corrected consent schema, probe passed, dropped and verified absent.
No disposable resources remain. Only disposable fixture data was removed; no recovery needed.
Read-only probes found localhost:5432 available,
current user la on postgres database. Docker daemon unavailable. No existing database modified.

Architecture audit: PASS for independent-module boundaries; imports only Node crypto and local files.
Public behavior and constraints documented in README/JSDoc. Function assessment: core validation/
instrumentation helpers 100 after edge review; transaction/migration/claim orchestration 95 with
documented host/deployment assumptions and remaining live-driver integration evidence. No known
Critical/High findings; no certified tests removed. Scope exclusively packages/om-pg.

Final fresh verification on 2026-09-07: `test` passed 20/20 tests across 3 files;
`typecheck` exited 0; `build` exited 0. Schema probe passed on local PostgreSQL.
No coverage percentage measured (coverage provider/config not added); direct tests cover
transaction cleanup/uncertain outcomes, migration drift/duplicate/partial-failure behavior,
and claim SQL parameterization/allowlisting/bounds. Root guard/typecheck are coordinator-owned.

## j00-finish (2026-10-02)

Owner decision supersedes the original PostgreSQL deployment assumption: server-owned better-sqlite3 behind the preserved query ports. See README.md for the injected inert adapter, portable migration/claim SQL and limits. The original 0001_spine.sql was never applied anywhere; it remains byte-preserved historical evidence. Feature tables may be reorganized. No live migration applied. Real ephemeral SQLite tests now accompany the original transaction/fencing characterization suites.
