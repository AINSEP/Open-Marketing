# Policy

Public imports use `@open-marketing/policy`. This package owns the preserved pure
sendability, shareability and spendability gates, append-only subject evidence,
and scoped canonical identifier resolution. Factories perform no I/O.

```ts
const repo = createMemoryPolicyRepo({
  bindings: [{ identifier: "email:customer", subject: { scope, subjectId: "customer" } }],
});
const policy = createPolicyService({ repo, clock, ids });
await policy.appendEvidence({ context, evidence: {
  id: "ingress-event-1", scope, subjectId: "customer", kind: "consent",
  recordedAt: clock.now({}), sourceId: "authenticated-signup",
  consent: { scope: "destination", target: "meta", purpose: "signup",
    status: "granted", start: 0, end: 200 },
} });
const snapshot = await policy.snapshot({ context, subjectId: "customer" });
if (snapshot.ok) {
  const decision = shareability({ subject: snapshot.value,
    destination: { id: "meta", intent: "measurement" },
    purpose: "signup", now: clock.now({}) });
}
```

All timestamps are epoch milliseconds. Grants/suppressions are half-open.
Matching withdrawals remain effective after their end, including after a merge;
a new grant cannot remove them. Suppression is messaging-only. A snapshot alone
never authorizes egress: dispatch must refresh consent and current authority.
Sendability supplies no MVP messaging surface. Spendability does not reserve
money or create a reusable budget authority; safety binds the exact operation.

Every evidence kind requires its exact payload (`consent`, `suppression` or
`target`). Ingress supplies a stable evidence ID and authenticated source ID.
Retries with identical canonical content return the existing row; changed content
conflicts. The service rejects future recordedAt values using injected time and
never replaces IDs. The retained ids dependency is unused because the contract
requires an ingress-owned ID. Ownership authentication happens upstream; this
package additionally rejects owner-principal/scope mismatches.

Use `createSqlPolicyRepo({ pool, observer })` with a server-owned pool compatible
with the DB shim's `connect`, object-shaped `query`, and `release`. Set dialect to
`sqlite` or `postgres`; SQLite writes use BEGIN IMMEDIATE. PostgreSQL uses
serializable writes and maps serialization failures to unavailable; retry the
same evidence ID. The feature imports no driver, server source or sibling repo.
The application owns pool timeouts, lifecycle and migration execution. Read
transactions use a consistent evidence statement; identity lookup and evidence
resolution use one connection. Pass an observer for trace/correlation/run metadata.

Migration `migrations/0001_policy.sql` is additive and has not been applied. It
creates feature-prefixed identifier and evidence tables; typed JSON represents
consent, suppression and merge records without rewriting the preserved migration.
No automatic table creation, updates/deletes, vendor calls or background work.

Each workspace defaults to 10,000 evidence records; maxEvidence may be 1–100,000.
Snapshots and appends fail with limit_exceeded above the bound, never truncate
consent/withdrawal history. Exact retries at capacity still work. SQL queries use
one bounded bulk read and strict validation of stored JSON. Scale beyond this
bound requires a scoped projection/pagination design before increasing capacity.

Deferred: public authenticated identifier registration, holdout/frequency-counter
mutation and projection, explicit re-consent/supersession, and erasure/retention
workflows. The existing ports expose none of these writes. Unknown subjects have
no grants; current evidence projection has holdout false and no frequency cap.
Merged evidence is conservative and irreversible; conflicting source merges and
cycles fail. The standalone memory identity factory accepts seeds; the memory
repository also implements resolve to share live merge state.

B1 behavioral suites are written for memory and real in-memory SQLite fixtures.
The approved gate characterization remains unchanged. Tests, builds and om:check
were not run under the owner override; the Coordinator runs combined verification.
