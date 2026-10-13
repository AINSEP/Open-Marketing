# MVP-2 composition seams

Step0c run 2; authority: the approved plan/amendments, MVP debate A, post-MVP Tier A and data-model Coordinator review (2026-10-12). Contracts remain frozen at each feature's `index.ts`, `src/types.ts` and `src/ports.ts`. The four services remain inert `not_implemented` scaffolds. No endpoints, UI, CLI or production workers are added here.

All adapter paths below are **proposed**, relative to `apps/server/src/composition/`; none is production wiring supplied by this job. The test-only implementation of the forms/Jini/jobs transaction connections is `apps/server/tests/spike/fixture.ts`. Dependencies enter through caller-owned ports; features never deep-import or query another feature's tables.

| Caller → supplier | Caller-owned seam | Contract owner / supplier owner | Proposed server adapter | Payload and authority rule |
|---|---|---|---|---|
| forms → published Jini CMS | `FormDefinitionRepoPort`, `FormSubmissionRepoPort` | forms / Jini | `adapters/forms-repositories.ts` | Use published `/forms/sql`, one checked kernel; global workspace UUID goes straight through. Mutable definitions cannot rewrite immutable publications. |
| forms → publication storage | `FormPublicationPort` | forms / server storage | `adapters/forms-publications.ts` | Immutable descriptors and exact purpose/topic/target/wording/version/digest; no submission answers in publications. |
| forms → receipt storage | `FormReceiptPort` | forms / server storage | `adapters/forms-receipts.ts` | Workspace/publication/attempt + body digest + submission/job IDs; read and append in exact submission session; drift conflicts. |
| forms → transaction owner | `UnitOfWork`, `SqlSession` | contracts / server | `adapters/unit-of-work.ts` | One server-owned handle, checked client and Jini kernel. Throws and root failed Outcomes roll back. Nested calls join; no shared mutable session. |
| forms → jobs | `FormJobsPort` | forms / jobs | `adapters/forms-jobs.ts` | Submission + receipt + job atomic. Job payload contains submission/publication IDs only; no answers, addresses, consent text, IP or click IDs. Preserve run/correlation/trace context. |
| forms → lead acceptance | `FormAcceptancePort` | forms / server | `adapters/forms-acceptance.ts` | Worker keyed on submissionId reloads answers and publication; atomic/idempotent contacts + policy evidence + optional visit binding. No automatic ad-platform lead conversion. |
| acceptance → contacts | `ContactService.upsert` via `FormAcceptancePort` | forms / contacts | `adapters/forms-acceptance.ts` | Raw answers transient at this boundary, normalized identifiers owned by contacts. Consent does not authorize a merge. |
| acceptance → policy | `FormAcceptancePort` consent data | forms / policy | `adapters/forms-consent.ts` | Capture each explicit choice with purpose, topic, target, wording version/digest; current withdrawal/suppression wins over old captured choice. |
| acceptance → web-events | `FormAcceptancePort` optional visit token | forms / web-events | `adapters/forms-visit.ts` | Authenticate workspace/expiry and bind visit to canonical subject; token never grants consent. Async persistence/reload of optional visit token remains integration work. |
| contacts → scoped storage | `ContactRepoPort` | contacts / server storage | `adapters/contacts-repo.ts` | Sole normalized address/identifier owner, normalization/key versions, timezone, canonical ID and merge lineage. |
| contacts → policy/erasure | `ContactSuppressionPort` | contacts / policy + privacy | `adapters/contacts-suppression.ts` | Current purpose/destination consent and suppression digests/processing block; absent or unverifiable authority denies. Local HMAC is distinct from destination SHA-256. |
| policy → contacts | existing `CanonicalIdentityPort` | policy / contacts | `adapters/policy-identity.ts` | Contacts decides merges. Resolve canonical pointer at read; do not bind `createSqlCanonicalIdentity` or use `policy_subject_identifier` in composition. Policy core remains unchanged. |
| web-events → storage | `WebEventRepoPort` | web-events / server storage | `adapters/web-events-repo.ts` | One envelope; event ID/schema/version/source/name, subject/anonymous IDs, occurrence/receipt times, monotonic cursor and trace. Properties ≤32 scalar keys, strings ≤2048 chars, total JSON ≤16 KiB. |
| web-events → token verification | `VisitTokenPort` | web-events / server host | `adapters/visit-token.ts` | Workspace-bound, expiring, authenticated visits. Never infer consent from a token. |
| web-events → policy | `CollectionAuthorityPort` | web-events / policy | `adapters/web-collection-authority.ts` | Recheck collection authority; click IDs are short-lived PII, excluded from immutable ledgers. |
| measure → web-events | `AttributionTouchPort` | measure / web-events | `adapters/measure-touches.ts` | Scoped subject/window, limit 1..100; preserve link + campaign IDs. No cross-feature SQL. |
| measure → contacts | `ConversionIdentifiersPort` | measure / contacts | `adapters/measure-identifiers.ts` | Reload canonical subject/destination/purpose-bound identifiers at dispatch; erasure/mismatch denies. Immutable event/delivery records carry IDs and digests only. |
| measure → policy | `MeasurementShareabilityPort` | measure / policy | `adapters/measure-shareability.ts` | Current consent for all identifier keys, subject, purpose and destination; share dispatch barrier with withdrawal/erasure. |
| measure → jobs | `MeasureTransactionalJobPort` | measure / jobs | `adapters/measure-jobs.ts` | One outbox in exact inbox transaction. Durable source/event IDs only; worker reloads committed event. |
| measure → safety authority | `MeasurementGrantPort` | measure / safety | `adapters/measurement-grant.ts` | Recheck definition-bound grant at dispatch; shared grant/schema alignment is integration, not a permissive cast. |
| measure → plugins | `ConversionDeliveryPort`, `PlatformReportingPort` | measure / admitted plugins | `adapters/measure-capabilities.ts` | Generic `conversion.event.v1`, definitionId + stable event/delivery IDs; supported contacts hashes/click fields only, current authority and egress audit. Unknown non-idempotent outcomes reconcile. |
| jobs → forms acceptance | existing handler registry/worker transport | jobs / forms acceptance | `adapters/forms-acceptance-worker.ts` | One handler, durable submissionId idempotency; no second outbox/timer. Worker lives independently of studio/agent. |
| jobs → current authority | `JobAuthorizationPort` | jobs / safety + policy | `adapters/jobs-authorization.ts` | Dispatch-time current grant/consent/halt/caps, never authority encoded in enqueue payload. |
| privacy → progress storage | `PrivacyRepoPort` | privacy / server storage | `adapters/privacy-repo.ts` | Keep request rows, participant IDs/counts and digests; purge addresses/answers/rendered content. |
| privacy → dispatch block | `PrivacyProcessingBlockPort` | privacy / server safety + policy | `adapters/privacy-block.ts` | Block before phases; shared barrier serializes dispatch with withdrawal/erasure; failed removal stays blocked. |
| privacy → contacts/forms/web-events | `ErasureParticipantPort` + registry | privacy / each data owner | `adapters/privacy-participants.ts` | `plan → externalRemoval → purgeLocal → attest`; remove identifiers, answers, IPs, click IDs and visits through owning APIs, not direct cross-feature SQL. |
| privacy → measure/jobs | `ErasureParticipantPort` | privacy / measure + jobs | `adapters/privacy-participants.ts` | Hashed transmissions are PII participants; keep evidence IDs/counts/digests, purge reloadable payloads and cancel/block eligible work. |
| privacy → policy | `ErasureParticipantPort` | privacy / policy | `adapters/privacy-participants.ts` | Retain address HMAC digest + key version + purpose/topic/reason suppression tombstones after erasure, preventing unsafe re-import. |
| privacy → plugin external removal | `ErasureParticipantPort` through jobs | privacy / admitted plugins | `adapters/privacy-external-removal.ts` | Plan IDs before local purge, typed idempotent backend removal jobs, current authority. Pending/unknown external removal cannot attest completion. |
| server → plugin lifecycle | existing public plugin registration/admission | plugins / server | `adapters/plugin-capabilities.ts` | Namespaced `io.github.ainsep.openmarketing`; vendor configuration/credentials/egress stay server-owned in plugins. Unregister/reset/dispose, no authority granted by install. |

## Tier A reservations

- **A1:** exact consent purpose/topic/target + versioned wording is frozen in forms; policy is the evidence/withdrawal owner.
- **A2:** contacts freezes canonical subjectId, immutable creation order, merge pointer/lineage, E.164 phone, external_customer_id, timezone and normalization/key versions. Local keyed HMAC and destination SHA-256 are separate APIs. Click identifiers never merge subjects automatically.
- **A3:** suppression digests survive address erasure. Key rotation must preserve lookup of retained key versions/tombstones; privacy cannot silently unblock erased/re-imported addresses.
- **A4:** participant phases are frozen; composition creates bounded registry instances with register/unregister/reset/dispose. Contacts/forms/web-events/measure and hashed transmission stores participate; later participants require no privacy-core edit.
- **A5:** the single web-events envelope is the future segments/journeys/experiments input; properties exclude addresses and form answers.
- **A6:** step0b opens conversion definitions with Money/orderRef and generic `conversion.event.v1`. **Reservation only:** future `ConversionAdjustment` links adjustmentId to eventId, with `retract` or `restate` (replacement Money required for restate). Measurement grants must bind definition IDs. No shared type or adjustment machinery is added in 0c; signed refund deltas remain later.
- **A7:** **Reservation only:** workspaces will persist a once-generated immutable experiment salt keyed by global workspace UUID. Contacts merges retain the earliest canonical identity (creation order; subjectId tie-break), so deterministic experiment buckets survive a merge. No salt type/storage/hash execution is added in 0c.
- **A8:** immutable ledgers/audits retain IDs and digests; durable jobs retain reload IDs, never raw identifiers, answers, IP, tokens or rendered message content. Mutable owners supply transient dispatch payloads. Digest retention is suppression/evidence, not permission to egress.
- **A9:** `apps/server/tests/spike/digest-stability.test.ts` tests absent optional schema extension stability via public safety `digestArguments`, and rejects explicit undefined. Written only; no schema-version bypass is inferred from an unrun test.

## Transaction spike and acceptance decision

Evidence command: `corepack pnpm exec vitest run apps/server/tests/spike/transaction.test.ts`.

Initial execution could not collect tests: public `@open-marketing/jobs` is not linked/declared for server/root. This is test wiring, not evidence against A1. The minimal current-source workspace resolver/dependency wiring requires the requested lane amendment. No A3 fallback is justified by this collection failure.

The written spike uses CMS **0.5.6** `submitForm` and both published SQL repositories, DB **0.3.2**, the server checked-client adapter and jobs' real `createSqlJobRepo`, SQL outbox and `createOutbox` worker. It applies the actual 13-entry migration catalogue to a temporary file; uses no fixture outbox, memory attempts, mapped workspace IDs, real credentials or vendor calls.

Acceptance probes write synthetic contacts/consent/visit state in SQLite, testing atomicity/idempotency through the frozen acceptance signature. They are not complete contacts/policy/web-events implementations. Both sync and async paths are written and pass.

**Decision (Coordinator, 2026-10-13): A1 + ASYNC acceptance.** Evidence: `corepack pnpm exec vitest run apps/server/tests/spike/transaction.test.ts` → 15/15 pass on the real Jini forms SQL repos, the one checked @jini-ai/db SQLite kernel and the real OM jobs outbox (thrown and returned-failure rollback, honeypot creates nothing, same-body replay dedupes after a handle/kernel restart and conflicting replay is denied, overlapping requests never share a transaction, nested repo calls join, integer decoding identical for OM and Jini, global UUID workspace IDs pass straight to Jini). Sync acceptance also rolls back correctly, but async keeps the public submission's atomic boundary to submission + receipt + one ID-only job, and its worker is retry-safe after a throw, a failed Outcome, a restart and a lost acknowledgement (no duplicate contact, consent or visit). A3 is not needed.

Expected observable protections: thrown and returned-failure rollback of submission/receipt/jobs/journal; honeypot writes nothing; same receipt after restart and conflict on changed body; workspace isolation with unmapped UUIDs; busy overlapping OM request rejects rather than sharing a session; nested Jini/session calls join; expired session rejects; checked integer decoding rejects overflow on both paths; worker failure rolls back partial acceptance and retries; lost acknowledgement replays acceptance without duplicate contact/consent/visit.

The bridge intentionally rejects overlapping OM requests on its single leased handle. Production composition still needs bounded scheduling/backpressure. No durable approval exchange, shared dispatch barrier, index promotion or production worker is claimed. Golden normalization fixtures specify later contacts behavior; the normalizer stubs remain unimplemented.

## Run-2 verification and handoff

One typecheck per package: `corepack pnpm --filter @open-marketing/forms typecheck` and `corepack pnpm --filter @open-marketing/contacts typecheck` passed (source + tests). `corepack pnpm --filter @open-marketing/server typecheck` failed (exit 2): production source passed, test compilation could not resolve public forms/jobs/safety modules, with cascading contextual-type errors. No second typecheck was run. Migration catalogue test, golden suite and A9 suite were written but not run; builds, installation and aggregate checks were not run.

Architecture source audit: **WARNING / evidence incomplete**. Changed files stay in the approved lane; feature imports use only public package names; one kernel/native handle and one real outbox; no production feature implementation, module runtime singleton, vendor effect or new shared contract. The public test dependencies/resolver are missing, so compilation/execution of the spike is not established. No test or gate was weakened. Unrelated dirty handoff work was preserved.

| Assessment unit | Disposition | Finding / next action |
|---|---|---|
| Migration/manifest | Source-reviewed; runtime unverified | Additive global version 13; no live application. Actual-catalogue spike must execute. |
| Submission/replay adapter | Evidence incomplete | Explicit root Outcomes, request-bound nested jobs and durable receipts; direct rollback/restart/honeypot/concurrency assertions written. Workspace test wiring blocks execution. |
| Acceptance SQL probe/worker | Evidence incomplete | Fixed two consent rows; idempotency by submissionId, failure before consent and lost-ack probes. Full production authority, consent race barrier and optional visit token reload remain integration. |
| Golden/A9 specifications | Written-only | Fixed normalization/hash expectations and existing safety fixture; no pass or normalization implementation claimed. |

New fixture boundaries/invariants are documented inline; obvious test assertions inherit their test names. Coverage and empirical function-quality metrics are unavailable because only the named spike was authorized and collection failed. Static review checked bounded bodies/wording, variable meanings, duplicate ordering, partial failure and ledger payloads; runtime evidence is still required. Self-validation is **PARTIAL** (one collection attempt, no test bodies reached).

Coordinator continuation (done 2026-10-13): server now depends on @open-marketing/{forms,jobs,safety} (workspace), base tsconfig lib is ES2024 (Node 24), server test tsconfig has declaration:false, and the spike stores consent choice as 0/1. Note: features resolve to dist/ at runtime, so dependent packages must be built before running cross-package tests. Production features and adapters follow their separate owner jobs.
