# @open-marketing/safety

Safety binds every spend call to its exact owner confirmation, checks current host-verified effects and platform controls, and serializes normal account writes with halt. A separate closed backend capability permits pause/stop after a local halt. Generation uses a USD $10/day allowance, with atomic reservations and append-only cost reconciliation.

Import through `@open-marketing/safety`. The service factory keeps the skeleton's required dependency object: `repo`, `policy`, `confirmations`, `effects`, `platformLimits`, `accountLocks`, `clock`, `ids`, and `audit`. Optional configuration includes `observer`, `policyRevision`, `evidenceMaxAgeMs` (60 seconds), `permitTtlMs` (30 seconds), `haltServiceId`, and `costServiceId`. Unconfigured service identities cannot authorize stop/cost-observer operations.

```ts
const card = await safety.prepareApproval({ context, request });
if (!card.ok) return card;

// The owner responds through the same UI/CLI exchange; presentation is not approval.
const confirmation = await confirmations.confirm({
  context: authenticatedOwnerContext,
  response: {
    cardId: card.value.cardId,
    operationId: card.value.operationId,
    argumentsDigest: card.value.argumentsDigest,
    choice: "allow",
  },
});
if (!confirmation.ok) return confirmation;

return safety.withDispatch({
  context,
  request: { ...request, approvalId: card.value.cardId, policyRevision: 0 },
  dispatch: serverTransport,
});
```

`serverTransport({ context, permit, request })` receives the frozen context and reviewed values. It must hand off one bounded call through the server's credential/plugin host and stable jobs idempotency key. Hold the callback only through handoff; polling and reconciliation belong to jobs. `authorizeDispatch` produces admission evidence for review/integration; a returned permit alone must not be used as an egress bypass. Use `withDispatch` at final normal egress so halt, settings and cost updates cannot cross the barrier.

```ts
await safety.haltAccount({ context: authenticatedOwnerContext, adAccountId });
await safety.getGenerationAllowance({ context });
await safety.assessGeneration({ context, request: frozenGeneration, quote });
```

For generation, attach `generation: { request, quote }` to the reviewed `EffectRequest`. A host-admitted `operationScope` enables matching ordinary write/generation grants; without it the card is exact-only. Spend/destructive cards always offer only Allow/Cancel. Generation grants require the same scope, connection, plugin/schema fingerprints, policy revision and configuration. Every final dispatch rechecks quote provenance and the remaining allowance; a grant cannot waive over-allowance spend.

`reserveGeneration({ context, authorization: { request, quote, dispatch } })` returns the durable reservation. The three values must describe the same reviewed operation. `settleGeneration` accepts a configured authenticated cost observer; `observationId` deduplicates receipts and `correctsObservationId` links append-only corrections. A quote without a supported USD upper bound cannot dispatch even with explicit approval. Excess actual charges block delegated generation until an explicit reconciliation workflow is supplied.

The repository receives `clock`, `ids`, and the owner's **explicit local IANA timezone**. No process timezone or UTC fallback is inferred. Timezone edits take effect at the next rollover of the existing zone. Pending reservations survive midnight and quote expiry; completed charges retain their dispatch-day attribution. Failed/timeout provider outcomes do not release exposure.

The memory doubles are deterministic test adapters, not production identity, plugin admission, platform evidence, persistent confirmation, or distributed-lock implementations. `CallContext`/`ServiceContext` must come from server authentication, never client or agent JSON. The production confirmation bridge must display the complete frozen effect, including financial exposure and window, before collecting the owner's response.

## Persistence and integration

`createSqlSafetyRepo` injects `SafetySqlDatabase`; it constructs no driver and applies no migrations. The adapter uses portable parameterized SQL, a scope snapshot, CAS versioning and an append-only financial journal. Snapshot updates are projections; original reservation/cost/setting evidence remains in the journal. State and journal commit in one transaction.

`SafetySqlDatabase`/`SafetySqlSession` are a documented removable compatibility seam while the integrator supplies `jini-compat/db`. They are not a claim that the unpublished shim or a released Jini query API is wired. The inspected Jini `db/core` exposes database-level operations, so the server must adapt its released kernel/shim to this query/transaction shape. The server owns **better-sqlite3**. SQLite transactions must serialize writes (`BEGIN IMMEDIATE`); a future PostgreSQL adapter needs serializable isolation and CAS rollback. Driver-specific calls appear only in the test-only in-memory SQLite fixture.

`migrations/0001_safety.sql` is additive and unapplied outside ephemeral test databases. No envelope grant/table/API exists. State is capped at 4 MiB and 10,000 journal events per scope; capacity errors fail closed. A future normalized repository/archive adapter can replace the snapshot adapter through the same B1 suite.

Remaining server composition responsibilities: authenticated scope/account resolution, canonical policy adapter, durable confirmation/grant exchange, trusted plugin/quote/stop bindings, live cap evidence, credential revocation checks at handoff, one shared dispatch barrier, stable jobs idempotency/unknown-outcome reconciliation, and HTTP/studio/CLI wiring. Ad exposure remains conservatively reserved; final ad-flight reconciliation/release is not exposed by the skeleton contract. SQL persistence and generation cost settlement are implemented; production transport integrations are not claimed.

## Verification

`corepack pnpm --filter @open-marketing/safety test`, `typecheck`, and `build` verify this package. B1 and acceptance suites run unchanged against memory and real ephemeral SQLite. Property tests exercise concurrent allowance conservation. No live provider effects, spend, or live migrations are used.
