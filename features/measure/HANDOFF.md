# Programmer(Direct): step0b measure amendment

Measure now records customer IDs and digests instead of copying identifiers into
immutable outcome/delivery evidence. Server workers resolve current identifiers
only when sending or reconciling. Tracked links retain their campaign ID; CAC counts
one customer acquisition per selected definition. Callers can ingest a purchase with
Money/orderRef, then request its definition-specific CAC. Contacts/server/plugin
wiring, product surfaces and adjustments remain deferred.

Status: implementation and regression tests written; runtime verification pending.
Continued the interrupted job's partial edits; retained its valid changes. No
commits, pushes, installs, live calls, spend or migration application. All writes
stayed in the approved measure files; unrelated work and AI-Dev-Shop were preserved.

## CHANGED FILES

All paths are relative to `features/measure/`.

- Public contracts: `index.ts`, `src/types.ts`, `src/ports.ts`.
- Validation/identity/doubles: `src/rules.ts`, `src/memory.ts`.
- Links: `src/links/links.ts`, `src/adapters/sql-links.ts`.
- Acquisition counting: `src/adapters/memory-repo.ts`, `src/adapters/sql-repo.ts`,
  `src/reporting/report.ts`.
- Delivery: `src/delivery/input.ts`, `src/delivery/dispatcher.ts`,
  `src/delivery/ledger-rules.ts`, `src/adapters/sql-delivery.ts`,
  `src/adapters/capabilities.ts`.
- Initial DDL: `migrations/0001_measure.sql`, amended in place per Coordinator.
  New subject/definition/event columns are NOT NULL, with the two scoped indexes.
  No 0003 was added; existing 0002 was left unchanged.
- Tests/fixtures: `tests/fixtures.ts`, `tests/sql-fixture.ts`,
  `tests/local-capability-fixture.ts`, `tests/ingestion.test.ts`,
  `tests/delivery.test.ts`, `tests/reporting.test.ts`,
  `tests/contract/port-suites.ts`, `tests/contract/memory.test.ts`,
  `tests/contract/sql.test.ts`, `tests/contract/capabilities.test.ts`,
  `tests/contract/local-capabilities.test.ts`.
- Documentation: `README.md`, `HANDOFF.md`.

## TESTS — written, not run

Regressions cover open definitions/Money/orderRef, strict raw-identifier/adjustment
rejection, 16-key/map and definition-grant bounds, optional-field/digest-order
identity stability, immutable value/order/definition changes, campaign retention
independent of UTM labels, and identifier-free event/delivery/outbox evidence.

The shared memory/SQL repository suite covers repeated customers across sources,
independent definitions, first-outcome selection before account/model/campaign/
period filters, late earlier outcomes and deterministic event/source ties (including
Unicode). Reporting tests assert one acquisition across successive periods.

Dispatch tests cover absent/erased subjects, lookup failure/throws/malformed data,
subject/digest/key mismatch, transient identifier delivery, current lookup on
reconciliation, post-lookup withdrawal/revocation and digest-only ledger/audit.
Existing rollback, cancellation, expiry, unknown-outcome and worker-race assertions
were retained. Delivery/ledger suites retain memory, SQL and loopback bindings.

`ConversionIdentifiersPortSuite` is bound to the scoped lookup double; the contacts
production adapter must reuse it later. No production identifier adapter exists in
this lane, so B1 adapter equivalence for that port is pending integration.

No test suites, om:check, builds, lint, coverage, runtime probes or red/green runs
were executed, per dispatch. Runtime correctness is not claimed.

## TYPECHECK

Single permitted command: `corepack pnpm --filter @open-marketing/measure typecheck`.
Result: **FAIL, exit 2**. Production `tsc --noEmit` passed; test compilation reported
`tests/delivery.test.ts:212` TS2322: `void` is not assignable to `undefined`.
Root cause: the existing withdrawal callback inferred `() => undefined`, while
its assigned consent-replacement expression returns void. Added an explicit
`() => void` annotation (also on the new revocation callback). This local test-only
fix was not rechecked; no second invocation was run, per the one-run limit.
Whitespace review: `git diff --check -- features/measure` passed before typecheck.

## CONTRACTS

- Durable `ConversionInput` uses open `definitionId`, canonical `subjectId`,
  `identifierDigests`, optional `Money` value and business `orderRef`.
- `ResolvedConversionInput` adds transient identifiers; only delivery/reconciliation
  accepts it. `createConversionDispatcher` requires `ConversionIdentifiersPort`.
- Local `MeasureGrant` uses `definitionIds`; current grant checks/fingerprints and
  consent operate on durable data. Generic naming is `conversion.event.v1`.
- `CacQuery`/`CacReport` require/echo `definitionId`.
- `TrackedLink.campaignId` is required and non-null, following the Coordinator's
  removal of data-compatibility handling; every new link has its supplied campaign.
- Delivery evidence requires subject/event IDs and a validated 64-hex digest.
- `AttributionTouchPort` is reserved as types only, limit 1..100. Existing source
  authentication represents trusted signed-webhook or authorized-operator intake.
  Adjustment fields/actions remain rejected; `conversion.adjustment.v1` is deferred.

No shared contracts, composition, manifests, lockfile or other feature was edited.
Reused strict Zod/shared value schemas, existing consent/grant/inbox/outbox/ledger
machinery and Node SHA-256; no new dependency or generic canonicalization layer.

## RISKS

- Tests and runtime gates are unexecuted. The lane typecheck does not prove behavior,
  B1 conformance, cognitive complexity, nesting or coverage.
- Current consent/grant checks do not prevent a concurrent withdrawal/erasure after
  lookup through actual egress. The shared dispatch barrier is explicitly deferred.
- Canonical subject identity comes from contacts; merged subjects need an agreed
  immutable-evidence interpretation. Earlier late outcomes can restate CAC.
- SQL acquisition selection uses the subject index and a correlated anti-join.
  Query plans/volume are unmeasured; no acquisition table or broader index work added.
- Vendor definition/value/order mapping and reconciliation remain unverified. Missing
  authority/schema/capability fails closed; there is no vendor fallback.
- Tracked destination URLs may carry explicitly admitted click parameters; this
  amendment removes identifier copies from immutable event/delivery records.

## NEEDS

- Step0a: amend shared MeasurementGrant/schema from closed eventTypes to definitionIds
  and agree public naming with local MeasureGrant. No shared-contract write here.
- Contacts/server: canonical subjects/digests and the current scoped identifiersFor
  adapter, including erasure and merge semantics; bind authenticated source intake.
- Server/jobs: transaction-scoped ID-only outbox payloads, committed-event reload,
  stable delivery IDs and existing production authority/consent/audit bindings.
- Plugins/server: admit conversion.event.v1 and map definition/value/order/shared
  event ID into typed provider payloads and reconciliation; credentials stay there.
- Integrator: register the amended 0001 in the migration manifest and separately
  authorize initialization. No migration operation occurred in this job.
- Web-events: implement AttributionTouchPort later. Surface owners close HTTP +
  studio + om CLI during integration. Coordinator obtains runtime/regression evidence.

## HANDOFF / REVIEW EVIDENCE

Architecture source review: PASS for this amendment's scope. Checked approved file
ownership, public external package imports, caller-owned I/O, injected clocks,
pure decision rules, existing single outbox, immutable evidence, no startup effects,
no .tsx and no vendor implementation in core. Mechanical architecture/complexity
checks remain unrun. No new runtime subsystem, approval store, barrier, archive,
touch store, acquisition table, registry/CRUD or adjustment action was introduced.

Pattern/style: continued the approved factory/port/guard-clause patterns already on
disk. The authorized continuation governs style; no extra approval was requested.
Only fixed-tuple hashing, current-identifier validation and existing repository
selection changed. UTF-8 tie comparisons align memory with SQLite BINARY ordering.
Docs classify amended public contracts/rules as documented and README examples as
stale-doc-updated; trivial private mappers inherit their containing boundary docs.

| Assessment units | Disposition | Findings / local action |
| --- | --- | --- |
| conversion/grant schemas; eventIdentity; deliveryIdentity; parseResolvedDeliveryInput | INCONCLUSIVE | High:privacy:identifier-bearing evidence addressed with digest-only schemas/hashes; optional fields and key-order regressions written. |
| resolveIdentifiers; dispatchOnce; claimDelivery; perform; current grant gates | INCONCLUSIVE | High:authority:missing/mismatched current contact evidence now denies egress; missing partial-run import repaired. Subject/event IDs checked on claims/outcomes. Callback test annotation fixed after the single typecheck, without rerunning. |
| acquisitionTimes; earlierAcquisition; SQL readAttribution; reportCac | INCONCLUSIVE | High:analytics:event counts replaced by first customer/definition acquisitions. Medium:determinism:UTF-16/UTF-8 tie mismatch corrected locally; shared regressions written. |
| link construction/read; consent/delivery/grant doubles; ledger transition/SQL writes | INCONCLUSIVE | Required campaign retention and subject identity preserved. Direct link, storage and immutable-transition suites written. |

No known unresolved Critical/High source defect was found in the amended units.
Evidence remains incomplete because behavior/lint/coverage checks are forbidden in
this run; no numeric quality/coverage claim is made. All changed behavior has direct
input/effect seams in the named tests. Aggregate counterexamples include cross-source
duplicates, unmapped earlier outcomes, period transitions and reordered ties.
Hashing is O(k log k), k <=16; memory acquisition selection is O(n+a) under existing
record caps; dispatch has a fixed port-call count and no retry. Existing foreign
callback ABIs remain confined to documented test/adapter wrappers.

Pre-completion review: requirements and Coordinator trim rechecked; no tests deleted,
weakened, skipped or executed; all writes in the file allowlist; no 0003; integration
needs listed. Runtime self-validation was not run because dispatch forbids it.
Discovery used direct source/rg fallback because graph tools were unavailable.
Project-memory and governance ADR index paths were absent; the approved plan and
target architecture supplied this amendment's constraints.

Next routing: Coordinator verification, then contacts/server/plugin integration.
This handoff records continuation state; no out-of-list progress file was changed.
