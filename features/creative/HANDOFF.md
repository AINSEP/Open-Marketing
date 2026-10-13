# Programmer(Direct): Creative lifecycle continuation

Creative turns a reviewed generation request into durable server work, preserves the original quote/arguments, checks safety at dispatch, and records charges and asset provenance. Example: enqueue a request with `requestGeneration`, let a worker call `dispatchGeneration`, then call `pollDue`/`refreshJob` to import the result. Failed, cancelled and uncertain jobs retain financial exposure. Production composition, provider integration, user-facing surfaces and combined verification remain deferred to their owners.

## CHANGED FILES

Continuation baseline is `3e2648f`; the prior implementation was retained. This run changes only `features/creative/**`. No commit/push/install, live vendor call, spend or migration was performed. Other lanes' concurrent dirty work was left intact.

- `src/jini-capability.ts`: adapt public Jini 0.4.2 object arguments, injected clock and guarded HTTP seam; bind durable operation identity; filter unconfirmed submits and cancelled rows; lease-fence cancellation deferral to prevent queue starvation. Split projection helpers for readable bounded control flow.
- `src/lifecycle.ts`: validate reservation handles and durable dispatch receipts before projecting success.
- `src/reconciliation.ts`: validate original intent and operation ownership/cost batch before projection; reject conflicting observation identities; synthesize actual charge evidence alongside estimates; retain local cancellation and recover partial effects idempotently.
- `src/repository-rules.ts`: enforce configuration/assessment bindings, immutable async identity, persistent reservations and no reopening submitted work.
- `src/job-adapter.ts`: validate scoped intent and map opaque transaction exceptions to typed failures. The injected transaction still owns atomic rollback and the ONE outbox.
- `src/memory.ts`: align memory handoff, boundaries and settlement scope with the real adapters; add bounded media/provenance parsing. No allowance implementation was added.
- `src/rules.ts`: dispatch receipt, media output and provenance schemas. `src/sql.ts`: clarify the OM database port, remove unused import.
- `tests/service.test.ts`, `tests/contract/port-suites.ts`, `tests/contract/memory.test.ts`: replace j00 absence assertions with actual behavior contracts. These were explicitly disposable owning-job scaffolds, not certified acceptance tests.
- New shared suites: `tests/contract/repo-suite.ts`, `capability-suite.ts`, `effect-suites.ts`; real adapter runners `sql.test.ts`, `jini.test.ts`; `tests/rules.test.ts`; `tests/support/cost.ts`, `jini.ts`. Update existing `tests/support/fixtures.ts` and `sqlite.ts`.
- `README.md`, this handoff, and `progress-ledger.md`: current usage, assumptions, evidence and continuation record.

## TESTS

All tests are **written, not run**, per the binding owner override. No passing counts, coverage, red/green regressions, lint metrics or build readiness are claimed.

- `corepack pnpm --filter @open-marketing/creative typecheck`: **exit 2**. Production `tsc --noEmit` passed at the checked revision; test typechecking reported only `tests/support/jini.ts(2,58): TS2305`, because the public media-providers entry does not export `RenderContext`. Fixed the fixture to use public `StartOperationParams<unknown>["ctx"]`; **not rerun**, preserving the one-run override. No failure from another lane was reported by this command. Final review also extended the cost-conflict precheck to existing/synthesized observations and added its regression case. Those final changes are not compiler-verified.
- `corepack pnpm --filter @open-marketing/creative test`: NOT RUN (owner override).
- `corepack pnpm --filter @open-marketing/creative build`: NOT RUN (owner override).
- `corepack pnpm om:check`, `om:gate-tests`, coverage and self-validation: NOT RUN (owner override).
- `git diff --check -- features/creative`: passed before final verification; formatting only.

Behavior tests target: inert construction; queue/dispatch without an agent; concurrent duplicate intent/claim; immutable arguments/quote/assessment; safety under/over/unknown decision forwarding; current dispatch authority; quote expiry; submit timeout/unknown exposure; duplicate imports/costs; cost and provenance on failed generation; cancellation/no refund and late output/charge; restart; bounded pagination; connect/install guidance; trace context without prompt logging.

B1 shared suites run memory and SQL repositories, memory and transactional jobs, and memory and released Jini generation capability. Media/safety/audit/observer doubles each have a suite; no production adapter for those ports is authored here. Released Jini start/poll/recover algorithms are used in adapter tests with a synthetic plugin and captured local transport. Test cases include crash gaps (idempotent and non-idempotent), inline success, no second submit, deadline/attempt exhaustion, cross-owner operation rejection, cancelled-row starvation, scoped SQL cost deduplication and transaction rollback.

Regression evidence is **static before/after plus written cases**, not demonstrated red/green: the prior API calls were incompatible with the installed 0.4.2 declarations; actualCost was skipped when the provider returned estimates; tainted cross-generation/conflicting costs could be projected before rejection; cancellation filtering repeatedly reclaimed the same due row. The Coordinator must execute these cases against this patch and the baseline where meaningful.

## CONTRACTS

- `index.ts`, `src/ports.ts`, `src/types.ts`: unchanged in this continuation. Every exported factory/service/port method has an implementation. No `not_implemented` success scaffolds remain in production creative code.
- `JiniGenerationBinding.deps` (exported from the existing Jini adapter): requires the released guarded `httpClient` instead of removed `fetchImpl`, and excludes injected `clock`/`newId` instead of the old `now`. This minimal adaptation is necessary for installed 0.4.2 and prevents default transport construction. Calls follow Jini's current required-object/options-object ABI.
- Published reuse: `AsyncOperationStore`/records, `PollingVendorAdapter`, `startOperation`, `pollDueOperations`, `recoverAfterRestart`; released in-memory store in adapter tests. No temporary Jini shim, polling engine, task tracker or second outbox was built.
- Not reused directly: Jini dispatch catalogue/provider builders (plugin-owned); `MediaTaskStore` (interrupts rather than resumes); native SQLite operation-store factory in feature source (DB construction/driver ownership belongs to server/platform and requires scoping); other published Jini domains do not own this lifecycle. No dependency addition is needed.
- Installed public `.d.ts` and package manifest were inspected before implementation. npm access was attempted but unavailable (web cache/fetch error; local DNS cannot resolve registry); release identity is based on the installed 0.4.2 manifest, not an asserted live npm verification.

## MIGRATIONS

Existing `migrations/0001_creative.sql` retained unchanged. Additive creative request/cost tables, portable SQL, no applied migration and no new migration in this continuation.

## RISKS

- Runtime behavior and mechanical gates remain unverified until the Coordinator's combined run. Package typecheck cannot prove B1, SQLite rollback, transport/cancellation concurrency or cost idempotency.
- Jini's recovery scans the scoped store; normal worker polling and creative reconciliation are bounded/paginated. Run boot recovery before starting polling workers. Use subsequent paginated ticks after the first 100 intent reconciliations.
- The host must provide a scoped durable operation store (including boot reconciliation), guarded HTTP with bounded time/body budgets, and exact request translation. Stock unscoped storage cannot simply be shared among workspaces. Published store timestamp behavior must be adapted to the server's injected clock requirement; this feature itself reads only injected time.
- `awaitHandoff` must be bounded and acknowledge final submit transport/definitive stop. Plugin signing must recheck current admission/credentials/policy for each egress. Typed ports document these requirements; end-to-end composition/late-signer verification is outstanding.
- Uncertain handoff markers are deliberately never resubmitted automatically, including a missing async row. Explicit reconciliation/operator resolution is needed; cancellation retains exposure without asserting a vendor stop or refund.
- Safety policy/card/owner-timezone behavior is not duplicated here. The forwarding tests do not replace safety's real card/allowance suites.
- Shared errors cannot carry a structured navigation action. The core provides guidance; the connection/plugin action requires the presentation adapter described below.

## NEEDS

1. `apps/server` composition + jobs adapter: join `CreativeSqlDatabase` intent insertion and the single durable outbox enqueue in one rollback-on-error transaction; route the worker's job identity to `dispatchGeneration`; schedule bounded poll ticks/cursors and startup recovery.
2. Server/platform operation-store composition: supply a durable, owner/workspace-scoped public `AsyncOperationStore` behind OM's DB seam and injected clock; wire Jini 0.4.2 functions and guarded HTTP without a fallback global transport.
3. Server plugin/safety/media/audit composition: adapt their public services to these caller-owned ports. Resolve the original exact approval/connection from the stored capability/operation/digests, map observations to append-only settlement, import bytes/guarded URLs and preserve provenance. Vendor builders/signers/pricing remain in `content/agent-plugins`.
4. HTTP + studio + om CLI owners: expose lifecycle/status/cancellation and translate missing capability guidance into the actual connect/install navigation action; the shared `Outcome` error type has no action field. No cross-lane contract was changed here.
5. Coordinator: run package tests/build and `om:check`/gate/coverage once, review the financial/concurrency cases, then decide migration and commit. This lane did not verify or diagnose other lanes' gates.

## HANDOFF / AUDIT

Architecture audit: **WARNING (verification/composition outstanding)**. Static review checks module ownership, public Jini imports only, no other feature/application/provider/policy imports, separate decisions/effects, caller-owned injection, atomic intent/enqueue contract, immutable evidence, append-only cost identities, no automatic uncertain retry, retained reservations, injected time and bounded worker interfaces. Source adapters query only creative tables. No known in-lane source boundary violation was found; mechanical lint/boundary metrics are NOT_AVAILABLE under the override.

Pre-completion: authoritative current contracts and j14 acceptance re-read; prior implementation retained; absence tests replaced with stronger behavior assertions; no certified tests deleted/weakened; own edits confined to creative; no irreversible external action; outstanding items listed. Self-validation: **not run**, explicitly forbidden by the owner. No runtime readiness claim.

Function quality assessment: **INCONCLUSIVE for execution/gate evidence**, static review complete. Complexity notes identify bounded arguments/cost batches, scoped indexed SQL and Jini recovery. No metric values are claimed.

| Unit | Disposition | Findings / direct verification seam | Local fix attempted |
|---|---|---|---|
| createJiniGenerationCapability / runtimeDeps | INCONCLUSIVE | Released API/transport integration; shared capability + captured transport tests | Object calls, clock and guarded client adapted |
| resolveBinding / startGeneration / submitOperation | INCONCLUSIVE | Admission and duplicate handoff; drift/inline/duplicate/timeout tests | Durable identity and client checks |
| generationStatus / operationState | INCONCLUSIVE | Uncertain transport/attempt outcomes; restart/crash/deadline tests | Split projections; preserve unknown exposure |
| unknownOperationStatus / projectOperationStatus | INCONCLUSIVE | Local cancellation projection; shared capability/cancellation tests | Pure bounded projection helpers |
| localSchedulingStore / localPollDisposition / suppressLocalClaim | INCONCLUSIVE | Cancellation/scope/submit-gap decisions; starvation and no-egress tests | Fenced deferral, no poll without handle |
| submitReserved | INCONCLUSIVE | Receipt/reservation taint; service dispatch/binding tests | Parse durable receipt/handle |
| refreshJob / projectObservation / validateObservation | INCONCLUSIVE | Mixed invalid batches/ownership; regression tests | Validate batch before any write; split projection |
| observations / recordCost / importResult | INCONCLUSIVE | Estimates plus actual; duplicate/partial failure/late output tests | Actual charge synthesized alongside estimates |
| validateStatus / validateReplacement / validateDispatchReplacement / validateCostLink | INCONCLUSIVE | Original evidence, CAS, reservation and correction links; shared repo tests | Additional immutable identity/dispatch guards |
| createTransactionalCreativeJob / transactionBoundary | INCONCLUSIVE | SQL rollback, matching intent and opaque exceptions; shared jobs + SQL tests | Boundary parsing and exception mapping |
| MemoryGenerationCapability.generate/status/pollDue/recover | INCONCLUSIVE | Shared capability behavior and bounds; service acceptance | Stable stored handoff and validation aligned |
| MemoryCreativeAsset.import/recordProvenance/recordCost | INCONCLUSIVE | Media/provenance conflict and validation; shared effect suite | Parse bounded output/evidence and scope |
| MemoryCreativeJob.enqueue / concurrentJob | INCONCLUSIVE | Concurrent intent deduplication; shared jobs + service tests | Extract conflict handling; keep scope errors |
| MemoryCreativeSpend.assess/withDispatch/settle | INCONCLUSIVE | Current scripted permission and scoped immutable settlement; shared safety/service tests | Context/settlement binding checks; no allowance math |

No known unresolved Critical/High logic finding from static review; execution may reveal findings. The one compiler run caught an invalid assumption that Jini's declaration-file type was a root public export; the fixture now derives it from an exported parameter type without a deep import. Static skepticism pass checked variable names, stale metrics, repeated identities, cancellation order, scope, hidden time/transport, failure Outcomes and test fixture validity. Source function names reflect their actual values. No bypass, linter disable, source exclusion or coverage suppression was added. Coverage was not measured because test runs are forbidden. Foreign Array/Promise/Jini ABIs remain at narrow boundaries; all owned signatures use zero or at most two object parameters.

Documentation: exported binding and new schemas/helpers documented; stale README/source adapter docs updated. Tests use public service/port seams and direct persisted/output assertions; tiny obvious private/test helpers need no narrative commentary. Next assignee: Coordinator/integrator for combined verification and server/plugin/safety/media/surface wiring, then Code Inspection.
