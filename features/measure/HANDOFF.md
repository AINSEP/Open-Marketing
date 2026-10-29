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

## W2-P1-3 B1 reporting persistence (2026-10-25)
Persists validated report.metrics.v1 evidence and whole-day partitions; campaign results place vendor totals beside OM-verified creation-cohort lead counts. Product surfaces and server wiring remain deferred.
CHANGED FILES: index.ts; src/reporting/{metrics,metrics-sync,campaign-results}.ts; src/adapters/{memory-metrics,sql-metrics}.ts; migrations/0003_metrics.sql; tests/{fixtures,sql-fixture,metrics.test}.ts; tests/contract/metrics.test.ts; HANDOFF.md. Other dirty work preserved.
CONTRACTS: additive measure exports only: syncMetrics, campaignResults, schemas/types, MetricsRepoPort, VerifiedLeadCountsPort, repository adapters and METRICS_SYNC_JOB="measure.sync_metrics". Existing services unchanged.
BOUNDS: one account/grain, 1..31 half-open calendar days, 5,000 input/combined output rows; one capability invocation, no internal retries. Caller MUST enforce a <=30-second deadline through the required signal.
MIGRATIONS: local 3 is assigned global v25; DDL written and fixture loader extended. No migration executed or registered globally.
TESTS: shared memory/SQLite suite covers precision, cloning, scoped idempotency/conflicts, restatements, partial/empty replacement, UTF-8 ties, isolation, invalid batches, cancellation and combined row limits. SQL trigger test asserts rollback of batch AND days, then successful retry.
TESTS: operation tests cover exact capability arguments, malformed outcomes, mismatches, future evidence, bounds/deadline, cancellation, storage failure, observer throws, ratios, reach, incompatible series and lead failures/keys. Written, never run; no runtime/coverage/red-green claims.
TYPECHECK: ran corepack pnpm --filter @open-marketing/measure typecheck && corepack pnpm --filter @open-marketing/server typecheck once. FAIL (exit 2): campaign-results.ts:28 inferred metricsBoundary<never>. Added explicit <CampaignResults>; not rerun under the one-run limit. Measure test compilation and server typecheck were not reached.
Reuse: metric validation/ratios; searched contracts metrics/capabilities; used existing metricBatchSchema, reportMetricsInputSchema and deriveMetricRatios. No copied vendor logic.
Reuse: persistence boundary; inspected measure SQL session/rollback/boundary and fixtures; reused injected SqlSession/transaction and SQLite fixture. Reporting uses its existing small boundary; shared rules/types no longer reach delivery.
Reuse: scheduling; inspected installed @jini-ai/cms@0.6.12 dist/content-types/write-service.d.ts OutboxPort and Jini CAPABILITIES.md; CMS content events lack this job boundary. Existing OM jobs remains the only outbox; 0.6.15 work stays deferred.
RISKS: aggregate values above the shared 38-digit metric cap return limit_exceeded; integer precision is preserved within that cap. SQL history cost is unmeasured; <=31 winning batch JSON values cross a read, with repeated period evidence possible.
NEEDS: integrator registers v25 in apps/server/src/composition/migrations.ts and updates migration expectations; no live application authorized.
NEEDS: integrator binds SQL repo, admitted manifest-driven report capability and leads.cohort adapter; decodes/registers measure.sync_metrics and enqueues stable keys/digests with availableAt through existing jobs, enforcing <=30-second deadlines.
Reporting dependency enforcement is implemented in development/scripts/boundaries.mjs, including transitive type-only/barrel paths; reporting currently reaches no delivery/ingestion/policy code.
NEEDS: HTTP/studio/CLI/MCP surfaces and owner-account reconciliation remain outside B1; leads implementation is caller-owned. Shared contracts would need wider aggregate support to exceed 38 digits.
Architecture source audit: PASS for new modules (contracts-only external runtime imports, no reporting delivery/ingestion/policy imports, injected I/O/clock, append-only evidence, one outbox, no startup effects); transitive reporting boundary enforcement is implemented.
Assessment units | Disposition | Findings / local action
--- | --- | ---
Schemas, partition selection, memory repo | INCONCLUSIVE | Runtime suite forbidden; exact request binding, whole-day replacement, UTF-8 ties and cloning have direct shared assertions.
SQL append/read | INCONCLUSIVE | Driver/commit behavior unexecuted; conflicts precede writes, transaction owns rollback, second-day failure assertion written. History query plans unmeasured.
Sync/boundary | INCONCLUSIVE | Deadline enforcement remains server-owned; capability outcomes validated, cancellation precedes persistence, observer errors cannot undo commits.
Aggregation/lead join | INCONCLUSIVE | 38-digit aggregate cap disclosed; unsupported/null/zero kept distinct, incompatible series and duplicate/unexpected keys rejected; no inferred zero leads.
Source second pass checked variable meanings, input mutation, ordering, empty/partial coverage, ties, currency/timezone/mapping compatibility and boundary errors; no known unresolved Critical/High source defect. Mechanical complexity/nesting and coverage remain unmeasured.
Documentation: public operations/ports and behavior-bearing private helpers documented; existing handoff preserved. New production/SQL source remains below 500 lines; new tests/fixtures remain below 250 lines.
Pre-completion: approved file map and invariants rechecked, no tests weakened/deleted/run, no tests/builds/installs/om:check/live effects, no commits/pushes; self-validation not run because dispatch forbids runtime checks.
HANDOFF: Coordinator source review and authorized runtime verification, then integrator wiring/boundary/migration work; this B1 implementation is not integrated product completion.

## FX-measure B1 fix wave — 2026-10-26

Lead sharing now derives `leadId:definitionId` through
`service.ingestLeadOutcome({ source, leadId, event })`. Supply the first qualified
or won transition's immutable evidence, without an eventId. Exact retries return
the original job; changed time/value conflicts without another event/job. Spam
and stage corrections send no vendor adjustment. Product integration is deferred.
Reporting's resolved import graph now rejects direct/transitive paths to delivery,
identifier ingestion and policy, including type imports and re-exports. Shared
diagnostic schemas moved to types.ts, removing the existing indirect dependency.

CHANGED FILES (relative to features/measure unless prefixed):
- index.ts; src/{types,rules,ports,memory,service}.ts;
  src/delivery/{input,dispatcher,ledger-rules}.ts; removed src/delivery/diagnostics.ts.
- src/adapters/sql-metrics.ts; src/reporting/{metrics,campaign-results}.ts.
- tests/{fixtures,ingestion.test,delivery.test,metrics.test}.ts;
  tests/contract/{port-suites,metrics.test}.ts; new tests/reporting-boundary.test.mjs.
- development/scripts/boundaries.mjs (reporting rule only); HANDOFF.md.

TESTS: written, not run. Shared memory/SQLite intake cases cover qualified →
disqualified → qualified and won → qualified → won, exact retries, conflicting
first evidence, distinct leads, strict parsing, authentication/consent and atomic
rollback/counts. Shared ledger and worker cases reject true→false/null and stale
observations, preserve the prior record and assert no second send. Reporting tests
cover ASCII ties in both arrival orders, non-ASCII rejection, mapping once/null,
SQL decoding/validation once per distinct batch per call, per-day metadata/window
validation, malformed stored evidence and removal of SQLite-only COLLATE BINARY.
Boundary fixture graphs cover direct, cyclic barrel/type-only and safe shared paths.
Existing combined row limits, missing diagnostics and rollback suites remain.
No red/green, test, build, lint, coverage, runtime, om:check, install or migration
was run; behavioral evidence must be obtained by the Coordinator later.

TYPECHECK: PASS, exit 0 on the single authorized invocation of
`corepack pnpm --filter @open-marketing/measure typecheck`.
Both production `tsc --noEmit` and test `tsc -p tsconfig.tests.json` completed.
No corrective rerun was needed. The .mjs boundary fixture is outside tsc's scope.

CONTRACTS: adds MeasureService.ingestLeadOutcome; caller-owned sink is
Pick<MeasureService, "ingestLeadOutcome">, without another port/factory.
Only qualified/won pass runtime parsing; LeadOutcomeInput is derived from
leadOutcomeInputSchema, and leadOutcomeConversionSchema exports were removed.
Original APIs and diagnostic exports are preserved. CampaignResults.mapping is nullable at result level; daily observations
no longer repeat it. Sync IDs are bounded printable ASCII. Types remain inferred
from existing Zod schemas. Shared contracts/manifests/lockfile/composition unchanged
by this run; no compatibility migration or live operation.

RISKS: runtime behavior/SQL portability remain unverified. Plain SQL ordering
removes the SQLite-only syntax; PostgreSQL execution/collation is untested. Earliest
transition selection and a stable authenticated source namespace are caller duties.
Diagnostics remain unknown until actual vendor mappings/producers exist. Existing
subject-lane dispatch/withdrawal integration remains outside this fix.

NEEDS / DEFERRED: integrator wires leads→measure with earliest evidence; aligns
shared MeasurementGrant.eventTypes with local definitionIds and grants qualified/
won. Server/plugin owners supply action mappings and diagnostic producers/display.
Reporting integration still needs v25 registration, SQL/capability bindings, a
bounded sync worker (<=30-second deadline) and a verified-lead cohort adapter.
No leads files were changed. Jini fencing/enqueue replacement is after published
0.6.15. No in-lane finding was deliberately deferred; DISPUTED: none.

HANDOFF / SOURCE REVIEW: PASS for the approved file map and import/effect boundaries;
mechanical boundary/lint/runtime checks unrun. Reviewed public package imports,
caller-injected I/O/clock, no startup effects, one existing outbox, append-only
ledger evidence, no vendor code or new authority path and no React changes. New
rule decisions are pure; intake delegates effects to the existing ingestion path.
Cache lifetime is one SQL read. No out-of-lane edits, commits or pushes.

Reuse: lead intake; inspected ingestion/ingest.ts, memory-repo.ts, sql-repo.ts and
source parsing; reused their authentication/consent/atomic conflict semantics.
Reuse: diagnostics; retained validateDeliveryTransition and applied mergeDeliveryDiagnostics
in the memory and SQL ledgers and the dispatcher, retaining missing-evidence behavior.
Reuse: reporting; reused contracts metric schemas and existing partition/row limits.
Reuse: boundaries; traversed the checker's existing resolved import edges rather
than adding a second parser/graph tool. No new dependency or Jini copy.

| Assessment unit | Disposition | Findings / local fix |
| --- | --- | --- |
| ingestLeadOutcome + schema | INCONCLUSIVE | Stable identity/strict parsing added; runtime tests forbidden. O(k) bounded evidence, existing fixed port calls. |
| validateDeliveryTransition / mergeDeliveryDiagnostics | INCONCLUSIVE | Delivery transitions guarded; memory and SQL ledgers and the dispatcher merge diagnostics, retaining confirmed stages and latest observation time. Shared regressions written. O(1) time/space. |
| SQL decodeDays / decodeBatch / latestRows | INCONCLUSIVE | Once-per-batch cache, per-day validation and portable syntax; SQL execution unverified. O(B*N + D*N) time/O(B*N) space, B,D<=31 and N<=5,000. |
| newerMetricDay / campaignResults | INCONCLUSIVE | Removed UTF-8 comparison and repeated mapping; direct tie/mapping cases written. Tie O(1) for bounded IDs; aggregation bounds unchanged. |
| reportingBoundaryViolations / reportingReachability | INCONCLUSIVE | Type/barrel reachability guarded, including cycles. O(R*(V+E)) time/O(V+E) space; R reporting origins. |

No known unresolved Critical/High source defect found in changed units; behavior,
complexity metrics and coverage are not claimed. All branches have direct service,
ledger, SQL adapter or graph-fixture test seams. Source second pass checked names,
immutable first evidence, retry duplication, empty results, cache lifetime, omitted
and regressing diagnostics, cycles and shared-schema paths. Documentation: new
intake/rule/mapping contracts documented; stage-occurrence docs corrected; relocated
diagnostic docs preserved. Tiny helpers inherit the containing boundary's bounds.
Pre-completion: re-read plan/review and named findings, preserved unrelated dirty
work and existing tests (replaced the explicitly cut Unicode tie scenario with
ASCII scenarios). Project-memory/ADR index paths are absent. Discovery used source
reads and rg under the dispatch load rule; no indexing or sibling dependency.
Coordinator: review these changes, obtain behavioral evidence, then route the
listed integration work. This is source delivery, not integrated product closure.


## R2-messaging-measure B1 (2026-10-26)

Owner summary: WhatsApp marketing preference stops and the named Spanish opt-out
button case now reach the existing consent callback; signed Twilio MMS STOP is
accepted. Resend refuses reserved envelope/MIME headers before authority or HTTP.
Generic measure ingestion rejects qualified/won before effects; only lead intake
can derive those event IDs. Vendor diagnostic disagreement no longer rejects a
delivered ledger append. Tests are written, not executed. One method-type change
needs an additional file allowance; complete localized-button verification remains
unavailable (details below).

CHANGED FILES (this run only; all relative plugin paths below use
io.github.ainsep.openmarketing/):
- whatsapp-business: src/{webhooks,transport,ports,broadcast}.ts;
  tests/{webhooks.test,fixtures,dispatch.test,broadcast.test}.ts;
  evidence/primary-sources.json; plugin README.md.
- twilio-sms: src/{webhooks,commands,transport,broadcast}.ts;
  tests/{webhooks.test,fixtures,dispatch.test,broadcast.test}.ts;
  capabilities.json; plugin.json. The two commands.ts fingerprints match.
- resend-email: src/mail.ts; tests/{mail.test,manifests.test}.ts.
- amazon-ses: tests/manifests.test.ts (copied card-shape assertions removed).
- measure: index.ts; src/{service,types,memory}.ts;
  src/delivery/{input,ledger-rules,dispatcher}.ts; src/adapters/sql-delivery.ts;
  tests/{ingestion.test,delivery.test,fixtures}.ts;
  tests/contract/port-suites.ts; HANDOFF.md.

TESTS (written, not run): signed preference stop/resume, scoped raw wa_id mapping,
replay and installation/time identity, unmapped identities, malformed/foreign mixed
batches with no partial mutation, combined 100-event bound and the named Spanish
text/button/payload case; signed MMS STOP and malformed IDs; gateway/consent
callbacks without local admission flags; reserved mixed-case headers rejected
before authority/HTTP and allowed custom/redirect/unsubscribe headers preserved.
Shared memory/SQL ingestion asserts qualified/won rejection before effects and
zero inbox/outbox writes. Shared memory/SQL ledger and dispatcher regressions
assert delivered reconciliation, retained true stages, latest observation time,
non-null evidence retention, detached scoped reads, and no second send. Only the
explicitly assigned card tests were deleted; obsolete diagnostic-conflict
expectations were replaced with the approved merge behavior.

TYPECHECK: ran the prescribed command exactly once:
```sh
P='resend-email amazon-ses twilio-sms whatsapp-business'; for p in $P; do echo "== $p"; corepack pnpm --dir content/agent-plugins/$p typecheck; done; corepack pnpm --filter @open-marketing/measure typecheck
```
PASS: resend-email, amazon-ses, twilio-sms, whatsapp-business and measure all
completed without diagnostics; final command exit 0. No corrective rerun needed.
The plugin commands include their tests. Measure runs `tsc --noEmit` and
`tsc -p tsconfig.tests.json`, so its test sources also typechecked. This is static
validation only. Scoped `git diff --check` also passed.

CONTRACTS: export leadOutcomeInputSchema and schema-derived LeadOutcomeInput;
remove eventId-bearing leadOutcomeConversionSchema/LeadOutcomeConversion aliases.
Keep ConversionDeliveryStatePort.read required (server test wrapper consumes it).
WhatsApp stop events now carry waId; preference stops have no recipient or provider
message ID. The existing apply callback resolves identity in scope and commits
withdrawals atomically under the server subject lane. No new port or approval rule.
Plugin configuration has no runtime admitted flag; host gateway and the required
server-supplied consent authority callback retain their current checks.

RESOLVED: types.ts derives LeadOutcomeInput from leadOutcomeInputSchema and uses
it for MeasureService.ingestLeadOutcome. conversionSchema/sourceSchema and their
digest-map validator live in shared types.ts; rules.ts re-exports the schemas,
preserving the reporting boundary. /tmp/om-r2-type-contract.patch is obsolete.

DEFERRED: full Meta-localized labels/payloads and exact current preference variants.
Attempted https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/user_preferences
(inaccessible), https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/user_preferences
(429, locale variant inaccessible), and the marketing-opt-out button reference
(inaccessible); primary-domain searches did not establish a localized catalogue.
The implementation follows the binding re-review's preference shape and Spanish
case; it does not claim complete localization or current v26 verification.

RISKS / remaining integration: production apply must resolve scoped wa_id and
commit withdrawals under the server's existing subject-lane protocol. This run
uses fixtures only. Legacy-to-canonical configuration/ABI migration, vendor stage
producers, server surfaces and Jini 0.6.15 work remain outside the approved plan.
No migration, dependency install, live vendor call, spend, commit or push occurred.

Architecture source audit: PASS for implemented changes; no new feature dependency,
reporting-to-delivery edge, port, registry, queue, hidden clock, or startup effect.
The method input contract is now schema-derived; the earlier scope conflict is resolved.
Reuse: existing webhook and consent seams, shared memory/SQL suites, the SES
reserved-header regex and published Jini mail policy. Installed
@jini-ai/platform@0.6.12 dist/mail/index.d.ts and policy.js were inspected; no
reserved-header validator is publicly exported, and X-Original-To remains allowed.
Documentation: public input/event/configuration changes documented; stale reporting
boundary claims corrected. Tiny private schema/projection helpers inherit the
bounded webhook contract. No positional-scalar public API was introduced.

Function quality (source review; runtime/coverage/lint evidence unavailable):
| Units | Disposition | Findings / local action |
| --- | --- | --- |
| Generic intake and lead input schema | INCONCLUSIVE | Runtime tests forbidden; method input is schema-derived in types.ts; rules.ts re-exports conversion/source schemas. Bounded maps, no added effects. |
| Diagnostic merge, memory/SQL append, dispatcher | INCONCLUSIVE | O(1) pure merge; existing atomic append/audit paths retained; shared direct assertions written for disagreement/clock skew and no resend. |
| Webhook projection and scoped fixture apply | INCONCLUSIVE | O(bytes + events), 256KiB/100-event limits; all supported-event validation precedes host apply; current Meta variants unverified. |
| Gateway/consent paths and Resend headers | INCONCLUSIVE | Existing callback ABIs retained; case-insensitive envelope restriction precedes authority and HTTP; tests exercise deny/allow. |
Source second pass checked variable meanings, null/false/true evidence, equal/older
timestamps, input mutation, replay identity, unknown preferences, late invalid
items, scope mismatch and negative-test confounding. No known Critical/High source
finding introduced. Mechanical complexity/nesting and coverage remain unmeasured.

Pre-completion: allowlist and diff reviewed; unrelated dirty/untracked work
preserved. Tests/builds/om:check/runtime self-validation were not run because the
dispatch expressly forbids them. No red/green or runtime correctness claim.
HANDOFF: Coordinator source review, resolve the rules.ts scope need, then run the
written suites in an authorized environment and supply production apply wiring.
