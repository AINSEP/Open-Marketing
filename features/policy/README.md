# Policy

Public imports use `@open-marketing/policy`. This package owns the preserved pure
sendability, shareability and spendability gates, append-only subject evidence,
and merge-aware snapshots. Contacts owns identifier resolution. Factories perform no I/O.

```ts
const repo = createMemoryPolicyRepo({});
const policy = createPolicyService({ repo, clock });
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

`dispatchDecision({ subject, policy, lineage, action, now })` accepts conversion
sharing or messaging with current merged policy and complete erasure lineage
(1–100 unique subjects in the same owner/workspace, including the requested subject;
at most 100,000 combined consent/suppression records, with overflow rejected).
Denial precedence is `invalid_input`, `erased`, `erasure_pending`, durable
`om.processing` suppression regardless of its window, then the existing action
gate; ordinary channel suppression keeps its interval semantics. Only safety and
measure may import this gate. The dispatch owner must load complete fresh evidence
under the shared subject lane, deny failed lookups (incomplete erasure is pending),
and hold serialization through the bounded provider attempt. Allowed is evidence,
not an execution permit. Lead receipt remains independent of sharing consent.

Every evidence kind requires its exact payload (`consent`, `suppression` or
`target`). Ingress supplies a stable evidence ID and authenticated source ID.
Retries with identical canonical content return the existing row; changed content
conflicts. The service rejects future recordedAt values using injected time and
never replaces IDs. Ownership authentication happens upstream; this
package additionally rejects owner-principal/scope mismatches.

Use `createSqlPolicyRepo({ pool, observer })` with a server-owned UnitOfWork.
A supplied session joins the caller's transaction. The application owns timeouts,
lifecycle and migration execution. Reads refresh bounded evidence; pass an
observer for trace/correlation/run metadata. The feature imports no driver,
server source or sibling repository.

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
cycles fail. Memory seed options contain only evidence and maxEvidence; policy
no longer reads or seeds the legacy identifier table. Applied migrations remain unchanged.

B1 behavioral suites are written for memory and real in-memory SQLite fixtures.
The approved gate characterization remains unchanged. Tests, builds and om:check
were not run under the owner override; the Coordinator runs combined verification.
