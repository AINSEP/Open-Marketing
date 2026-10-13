# Creative lifecycle

`@open-marketing/creative` queues an immutable generation request and quote, asks safety for its approval policy, and lets a server worker dispatch, poll, recover, and import results. Charges and rights/provenance evidence survive failed generation, cancellation and missing assets. Construction starts no service or scheduler.

```ts
const creative = createCreativeService(
  { repo, generation, assets, jobs, safety, clock, ids, audit },
  { observer },
);
// Compute argumentsDigest with digestGenerationRequest({ request: draft }).
const queued = await creative.requestGeneration({ context, request });
// The durable server worker uses the queued generationId, independently of chat.
await creative.dispatchGeneration({ context, generationId });
const tick = await creative.pollDue({
  context, request: { leaseOwner: "creative-worker", leaseMs: 30_000, limit: 20 },
});
await creative.refreshJob({ context, generationId });
```

Check every returned `Outcome`. Enqueue success means queued work, with a null `asyncOperationId`; dispatch receipts identify a provider operation. Poll ticks also return `reconcileCursor`; pass it into the next tick until it is null. Run boot recovery before polling workers start, then page reconciliation with worker ticks. Recovery reconciles one page of up to 100 generation intents, while the released Jini recovery algorithm scans its scoped operation store.

Safety owns allowance settings, the owner's timezone rollover, cards, grants, reservation, and settlement. Creative stores safety's assessment unchanged and invokes `withDispatch` for the current authority check. The assessment itself grants nothing. Confirmation may be completed in the safety exchange before a later worker dispatch; composition must resolve the exact approval for the stored operation/arguments/quote without replacing the intent. Expired quotes require a new reviewed operation, never silent requoting.

The memory doubles are inspectable test adapters. `createSqlCreativeRepo({ database })` supplies scoped storage, optimistic revisions, atomic dispatch claims, and append-only cost identities through an injected query/transaction port. `createTransactionalCreativeJob({ transaction })` requires **the same database transaction** for creative intent and the single jobs outbox enqueue. An unsuccessful Outcome or exception must roll back. The creative migration is additive and has not been applied. Production source neither imports a native driver nor creates a database.

`createJiniGenerationCapability({ runtime, host, repo, clock })` builds on the installed **`@jini-ai/integrations/media-providers` 0.4.2** public exports: `startOperation`, `pollDueOperations`, `recoverAfterRestart`, `PollingVendorAdapter`, and `AsyncOperationStore`. Core uses public Jini types; plugin/server composition injects the functions, adapter, scoped operation store, signer and guarded `httpClient`. No compatibility shim, second polling engine, second outbox, provider branch, catalogue-dependent stub success, or `MediaTaskStore` is used. Jini's published in-memory operation store is reused in tests; its native SQLite factory is left to platform composition because creative cannot create a DB or depend on driver APIs.

The host binding must be scoped to owner/workspace across get, create, claims and boot reconciliation. It must translate the original request into an exact vendor context, verify current plugin/configuration admission, recheck credentials/policy at signing, enforce HTTP body/deadline caps, and acknowledge the bounded submit handoff through `awaitHandoff`. The safety barrier stays held through that acknowledgment, including a Jini return before its signer finishes. Runtime errors retain uncertainty; a durable handoff marker prevents resubmission even when an operation row is missing.

Cancellation stops local scheduling; it never asserts vendor cancellation, no charge, or a refund. Filtered cancelled operation rows are deferred under lease fencing so they cannot indefinitely block other due work. Late evidence can still record charges and import completed output while the local state stays cancelled. Estimated costs are recorded without settlement; actual/correction observations settle against the retained safety reservation. Corrections need distinct identities and a valid existing observation link. Repeated refresh/import/settlement identities deduplicate after partial failures.

Missing capabilities return explicit connect/install guidance. Shared `Outcome` errors have no navigation-action field, so HTTP/studio/CLI composition must translate that guidance into the connection/plugin action. User-facing HTTP/studio/CLI wiring, vendor implementation, media/safety adapters, production scoped operation storage, and deployment are outside this lane.

Behavior suites are under `tests/contract/port-suites.ts`: repository memory/SQLite, jobs memory/transactional SQLite, capability memory/released Jini, and memory media/safety/audit/observer ports. Acceptance and adversarial regression cases are in `tests/service.test.ts`, `tests/rules.test.ts`, and the real adapter tests. All tests are **written, not run** under the owner override. The Coordinator owns tests/build/lint/boundary/coverage verification and live migration approval.
