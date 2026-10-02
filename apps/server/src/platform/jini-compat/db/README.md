# Server-owned SQLite / Jini compatibility shim

The server owns **better-sqlite3 13.0.3**. All active PGlite/pg dependencies have been removed. Feature packages preinstall better-sqlite3 as a test dependency; feature core uses injected ports. No application import or factory opens a database, runs migrations or starts workers.

`src/index.ts` exports the preserved `PgQueryable`, `PgPool`, `PgClient`, `QueryResult` and typed `PgFoundationError` compatibility names plus `createSqlitePool({ database })`. The server composition root explicitly constructs/owns the native handle and injects it; the shim does not construct dependencies. j01 can replace this documented removable shim with published `@jini-ai/db` behind the same contract and suites.

```ts
const pool = createSqlitePool({ database });
const result = await withTransaction({
  pool,
  work: tx => tx.query({ text: 'SELECT $1 AS amount', values: [9007199254740993n] }),
}, { observer });
```

Queries bind PostgreSQL-shaped `$n` parameters by name, including repeated parameters, without rewriting SQL/literals. Native integer reads use bigint to preserve money/version precision; boundary adapters must validate and safely decode integers. DDL migration scripts can contain multiple statements, with no bound values. Query errors retain native causes only for the trusted server boundary. Transaction telemetry never emits SQL, parameters or native error contents.

SQLite transactions use `BEGIN IMMEDIATE`, preserve rollback/fencing/uncertain-commit behavior and never automatically retry. One native handle is exclusively leased across awaited bodies. An overlapping connection request fails with typed `connection_busy` before it can share the transaction; j01 owns scheduling/backpressure or multiple-handle coordination. Destroyed/uncertain leases quarantine the pool, and the composition root must reconcile before replacing/closing it. Do not retain clients or issue transaction control inside a body.

better-sqlite3 is synchronous: this shim cannot enforce PostgreSQL statement deadlines. Non-default per-transaction timeout overrides fail with `unsupported_timeout`; configure native `busy_timeout` at composition and bound SQL/transaction bodies. The retained Postgres-shaped pool fallback still supports its transaction-local timeout query; no PostgreSQL driver is installed.

Migration bookkeeping uses portable `om_schema_migrations`, integer versions, SHA-256 checksums and text timestamps. Complete migration sets are limited to 1000 migrations, 1 MiB each and 16 MiB total. History must match an ordered prefix; earlier DDL and ledger inserts roll back together if later SQL fails. SQLite serializes migration writers with `BEGIN IMMEDIATE`; a future Postgres adapter must supply equivalent serialization.

`claimBatch` uses a bounded portable CTE/update/returning statement against trusted physical `schema_table` names (e.g. `om_outbox`). It scopes candidates and updates by tenant/workspace and leaves uncertain processing rows untouched. The SQLite write transaction serializes claims. Future Postgres composition must preserve serialized/CAS claims before adding worker concurrency.

`migrations/0001_spine.sql` is byte-preserved **never-applied historical evidence**, not the SQLite product schema or an automatic startup migration. The owner authorizes reorganizing it; feature jobs own their new tables. No live migration was applied in j00 or j00-finish. Tests apply only throwaway fixture migrations to `:memory:` databases.
