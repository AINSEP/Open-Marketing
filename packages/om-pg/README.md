# @open-marketing/om-pg

Independent Postgres foundation. No application, Jini, database driver, credential loading,
connection singleton or startup side effects. The embedding server injects a compatible
`PgPool` and owns connection/acquisition timeouts, cancellation, shutdown and telemetry wiring.

```ts
import { withTransaction, runMigrations } from '@open-marketing/om-pg';

const result = await withTransaction({
  pool,
  work: async (tx) => tx.query('SELECT $1::bigint AS amount_minor', ['9007199254740993']),
}, { statementTimeoutMs: 30_000, lockTimeoutMs: 5_000, observer });

await runMigrations({ pool, migrations: [{ version: 1, name: 'spine', sql }] });
```

Read `migrations/0001_spine.sql` explicitly in the host; importing the package does not execute it.
Do not parse PostgreSQL bigint money through JavaScript `number`; preserve string/bigint exactness.

## Transactions and failure semantics

Callbacks must await every query, must not retain the client or issue transaction-control SQL,
and should not perform remote side effects. Statement timeout bounds each statement, not the
whole callback. A host must bound callback duration and pool acquisition independently.
There are no automatic retries.

- `transaction_failed`: body/setup failure, rollback succeeded; cause preserves the original error.
- `rollback_failed`: both errors retained in AggregateError; connection is evicted.
- `commit_failed`: commit outcome is uncertain; connection is evicted. Reconcile before retry.
- `release_after_commit`: work **committed**; release failed. Never retry the work automatically.
- `release_after_failure`: AggregateError preserves transaction outcome error first, release error second.
- `query_failed` / `connect_failed`: external failures with original cause, for trusted callers.

Observer events expose operation and status only. They never include SQL, parameters or error
messages. Map these low-cardinality events to host telemetry; observer exceptions are isolated
from transaction behavior. Driver causes can contain sensitive information; do not return them
to untrusted clients or log them without sanitization.

## Migrations

Supply the complete historical migration set, not just pending files. Versions must be unique,
positive safe integers. Applied versions/names/SHA-256 checksums must be an exact ordered prefix.
The full batch is one transaction, serialized using a transaction-scoped advisory lock before
schema/ledger access. A failed migration rolls back previous SQL and tracking inserts together.
Batch limits: 1000 migrations, 1 MiB per SQL string, 16 MiB total. Timeouts are transaction-local.

Migration SQL is trusted, reviewed deployment code. It must be transaction-compatible and must
not issue COMMIT, BEGIN or other transaction control. Concurrent index operations and online
backfills need a separately designed workflow. This is not a general untrusted SQL executor.

The initial schema uses composite tenant/workspace FKs; it does not implement authorization or
RLS. The future application must derive scope from authenticated context. Consent uses explicit
`scope` + `target`; `expires_at IS NULL` means indefinite in storage. The future snapshot adapter
must deliberately map indefinite validity to its gate contract instead of passing null into a
finite-expiry field. Consent ordering, merge-cycle prevention and holdout merge policy belong to
the owning application transaction. No gate is duplicated in this package.

## Queue claims

`claimBatch` owns its transaction and changes pending rows to processing atomically using
`FOR UPDATE SKIP LOCKED`. The trusted server allowlist controls schema/table names. All values
are bound parameters. Claims are scoped by tenant and workspace with a 1–1000 limit and a lease
ending within 24 hours of the explicitly supplied time.

Caller-owned queue tables need `(tenant_id, workspace_id, id)` as primary key, `status text`,
`available_at timestamptz`, `lease_until timestamptz`, and non-null `attempts integer DEFAULT 0`.
Index `(tenant_id, workspace_id, status, available_at, id)`. Add further domain constraints in
the owning module. Returned order is unspecified. Expired processing rows are not automatically
reclaimed: reconcile external effects and explicitly mark safe retries pending. This prevents
a generic lease helper from silently repeating an ambiguous platform write.

## Verification

Package tests exercise injected clients, not PostgreSQL concurrency. `tests/schema-probe.sql`
is a retained real-Postgres schema/constraint probe; run it after 0001 only in a disposable DB
with `psql -X -v ON_ERROR_STOP=1`. Never run it against an existing application database.
The probe rolls its fixtures back. It does not prove driver compatibility, advisory lock
serialization, or concurrent queue claims. Those integration checks remain for host wiring.

Run `corepack pnpm --filter @open-marketing/om-pg test`, `typecheck`, and `build`.
