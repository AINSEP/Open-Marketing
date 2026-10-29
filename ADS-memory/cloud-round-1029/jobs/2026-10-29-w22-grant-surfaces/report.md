# W22-GRANT-SURFACES B1 implementation report

Programmer(Direct): Owners can list, grant and revoke conversion-sharing permission in Integrations, through the assistant and through the existing HTTP/`om tools call` transport. Every grant/revoke uses the server's exact Allow/Cancel card. Grant changes and their audit commit together. Production conversion delivery remains disabled pending W23-CONVERSION-PRODUCER-WORKER.

## Inputs and scope

Implemented this job's plan.md as amended by review.md, its coordinator override, and the 2026-10-13 owner decisions. Applied COMMON.md, ctx-wave-1029.md and the final 2026-10-25 architecture/owner decisions. Read the prior conversion-grants, jobs-lease-handoff and gmeta conversion-delivery reviews/postchecks. Persona: AI-Dev-Shop/agents/programmer/skills.md. No delegation, tests, builds, installs, indexing, live effects, staging, commits or pushes.

## CHANGED FILES

Counts compare against the initial working-tree contents, preserving earlier jobs' changes. Code/tests: **+556 / -16 = net +540 lines** (source net +268; tests/fixture net +272). Job artifacts are excluded.

| File | Change | + / - |
|---|---|---:|
| features/measure/src/adapters/sql-grants.ts | Conflict-safe insert/read-back; concrete scoped keyset list; shared row decoding | 33 / 13 |
| features/measure/tests/sql-fixture.ts | One-shot competing grant insert in existing beforeQuery seam | 9 / 0 |
| features/measure/tests/contract/sql.test.ts | Two SQL-only races; revoked/scoped pagination and malformed stored-row denial | 33 / 1 |
| apps/server/src/composition/conversions.ts | Owner service, fixed payload metadata and transactional audit | 60 / 0 |
| apps/server/src/composition/catalog.ts | Inject live grant service beside paidSending | 3 / 1 |
| apps/server/src/om-tools.ts | Service type and three tool definitions; unconditional helper registration | 18 / 0 |
| apps/server/src/om-tool-coverage.ts | Coverage rows, Integrations label and production-worker NEEDS | 5 / 1 |
| apps/server/tests/measurement-grants.test.ts | Real server SQL service, authority and rollback regressions | 65 / 0 |
| apps/server/tests/om-tools.test.ts | One shared-dispatcher exact-card persistence regression | 38 / 0 |
| apps/studio/src/pages/addons/model/conversion-grants.hooks.ts | Bounded form/list, retained operation and completion refresh | 123 / 0 |
| apps/studio/src/pages/addons/ui/ConversionGrants.tsx | Existing settings-card/ApprovalCard presentation | 39 / 0 |
| apps/studio/src/pages/addons/ui/IntegrationsPage.tsx | Import plus one-line mount after Connections | 2 / 0 |
| apps/studio/tests/conversion-grants.test.ts | Four panel/lifecycle regressions | 128 / 0 |

Job artifacts: progress.md, report.md, typecheck.txt in this directory. No implementation file outside the amended approved list was edited.

## TESTS — written, not run

Eleven tests added; existing shared suites/assertions retained.

- SQL (3): identical competing insert returns the stored grant; different competing content returns conflict; keyset limit 1/cursor, scope isolation, included revoked grant, final cursor null and oversized persisted-row invalid_input denial.
- Server service (3): owner grant/list/revoke, server-fixed metadata and exact audit contexts/outcomes; non-owner grant/revoke denial and caller metadata rejection; an injected failing audit insert rolls back both grant and revoke. A subsequent current() read observes revoked:true.
- Shared dispatcher (1): all three tools and coverage labels, ownerOnly writes, pending card before persistence, actual confirmation request has no operationScope, exact choices, Always allow rejection, Cancel persists nothing, Allow writes one grant and owner audit.
- Studio (4): Active/Revoked/Expired list; pending grant and exact ApprovalCard without premature success, then completed-operation list reload; same revoke lifecycle; unresolved operation retains identity and blocks repeated writes. Form assertion includes clock-derived expiry, definition parsing and omitted server metadata.

Adversarial invariants: competing immutable IDs must arbitrate through SQL rather than surface PK errors; an audit failure must leak no authority change; approval acknowledgement must not become UI success; uncertainty must not cause a duplicate write. Removing ON CONFLICT makes the identical-competitor test fail at the unique constraint. Committing before audit breaks the rollback test. Treating acknowledgement as completion breaks the Studio assertions. These are written expectations, not executed red/green evidence.

## TYPECHECK

Full command output and exit codes are in [typecheck.txt](typecheck.txt).

| Command | Result |
|---|---|
| corepack pnpm --filter @open-marketing/measure typecheck | PASS, exit 0 initially and on one corrective rerun after final row-validation consistency fix |
| corepack pnpm --filter @open-marketing/server typecheck | PASS, exit 0, first/only run |
| corepack pnpm --filter @open-marketing/studio typecheck | PASS, exit 0, one permitted corrective rerun |

Studio's first run exited 2 with five diagnostics in the new test fixture: ToolCall.input is arbitrary JSON, so direct field access/spread was invalid. Corrected the fixture/assertion to parse through the canonical schema pick/omit. Studio production source had no diagnostics. Final source inspection also corrected the list's array validation through parseBoundary/unwrap so oversized stored rows retain current()'s typed invalid_input behavior; its assertion was added to the existing SQL list test before measure's corrective rerun. Each script checks production and test types. Lane git diff --check also passed. No lint, coverage or runtime execution claimed.

## CONTRACTS

- createSqlMeasurementGrant retains MeasurementGrantPort and extends its concrete return with list({context,query}, options?) -> Outcome<Page<MeasureGrant>>. No port/memory/index change.
- bindMeasurementGrants({database,clock,ids,observer}) exposes list/grant/revoke; grant input derives from the canonical schema with scope/kind/revoked/payload metadata omitted. Server fills those fields. CONVERSION_PAYLOAD_SCHEMA is om.conversion, payloadVersion is 1. grantFieldsSchema is shared by the service and tool boundary.
- om_measure_grants_list({limit,cursor?}), om_measure_grant(grantFields), om_measure_revoke_grant({grantId}); the two writes are ownerOnly. No reusable write scope or spend waiver is introduced.
- HTTP: existing POST /api/tools/call, card/answer and operation lookup. Assistant: execute_tool. CLI: existing om tools call <name> --input-file <path|->. No new transport/parser.
- List includes active/revoked/expired grants. SQL reads at most limit+1 <=101 rows; UI page <=100, identifiers <=256 characters, 1–16 definitions and validity 1–365 days. UI requires an explicit Refresh after answering a card.
- Revocation is immediately visible to the existing SQL current() authority read. Existing dispatch-time consent/grant checks and plugin admission remain unchanged.

MIGRATIONS: none added, edited, applied or registered. Existing global v28 / measure local 5 is already registered; the historical migration collision finding is DISPUTED/already fixed (apps/server/src/composition/migrations.ts:33).

## REUSE

- Grant persistence/listing: searched measurement/conversion/sharing grants in installed @jini-ai/core@0.6.15-rc.2 dist and read-only ai-traces-jini/packages and Tovu/apps TypeScript; no matching grant implementation found. The stale /Users/la/Programming/Jini tree was excluded by the final source-of-truth override. Extended OM's owning sql-grants adapter; reused canonical grant/page schemas, scopeKey, parseExactIntegerJson, sqlBoundary/unwrap. Conflict-safe SQL/keyset shape follows workspaces/sql-store.ts; no new generic helper.
- Approval/tool surfaces: inspected published rc.2 core gated-mutations declarations; they describe a separate gateway. Reused OM's existing serviceDefinition/ownerOnly dispatcher and ApprovalCard, preserving the single approval owner. paidSending is the approved composition/style seed; no second ceremony or library was added.
- Atomic audit: reused createSqlMeasureAudit and the existing joined SqlSession implementation (om-db/transaction.ts:77); grant/revoke and audit use the same session. No new audit store or observability plumbing.
- Studio operation handling: followed the approved BrandProfile operation/card/explicit-refresh pattern. Domain-specific grant UI keeps only its own pending operation; shared API and ApprovalCard own transport/approval behavior. No pagination loop, polling, retry framework or new port.
- JINI ASK: none needed for this approved scope. No unpublished API was called.

## Architecture audit and function assessment

Architecture audit: **PASS by source inspection** against the approved file map and ADR checklist. Audited all 13 implementation/test paths above. Feature imports use public @open-marketing package entry points; dependencies/time/IDs are injected; canonical Zod schemas own types; SQL is parameterized and scoped; audit and authority share a transaction; only owner continuations mutate authority; TSX contains no function definitions/inline arrow callbacks inside component bodies. No vendor identity, URL, token format or price was added to core. No source is imported from sibling repositories. bootServer and featureDefinitions received zero changes/increments.

| Assessment unit | Disposition | Findings / evidence | Local fix |
|---|---|---|---|
| SQL grant insert, list and row decoder | NO_RECORDED_FINDINGS | Bounded pages, immutable IDs, preserved no-resurrection; SQL tests plus retained shared suite | Replaced pre-read/plain insert; reused row decoder |
| bindMeasurementGrants grant/revoke + changeGrant | NO_RECORDED_FINDINGS | Constant indexed I/O; owner guard, typed boundary failure, same-session audit | Shared transaction body serves both mutations |
| measurementGrantDefinitions and catalog binding | NO_RECORDED_FINDINGS | Existing exact-card policy and generic transport; no new featureDefinitions branch | Actual request operationScope assertion |
| useConversionGrants load/readCard/refreshData/write/perform/submit and prepared rows | NO_RECORDED_FINDINGS | <=100 rows/16 definitions; one retained operation; injected clock/IDs; direct component tests | Unknown outcomes retain the operation; completed list reload precedes success |
| ConversionGrants/renderGrant and mount | NO_RECORDED_FINDINGS | Existing visual components/native bounds; no event closures in TSX bodies | Handlers prepared in hook |
| New regression fixtures/assertions | NO_RECORDED_FINDINGS | Canonical parsing at tool-input seam; all test types compile | Fixed five Studio fixture diagnostics |

Manual complexity/nesting review found no new function above the job's <=10 / <=3 limits. No numeric lint/coverage/cyclomatic measurement was run or claimed. Zero-findings skepticism pass rechecked SQL rollback/competing IDs/revoked retries, source bounds and hidden time reads, operation identity/unknown states, metadata ownership, and variable names (stored vs requested grant, next cursor, status vs acknowledgement). No additional implementation finding remained. Test execution/coverage remain explicitly unverified, as required by the owner.

Documentation: public adapter/service/schema/constant/hook/component contracts documented; transaction/uncertainty and resource-bound comments included. Obvious forwarding callbacks/native event adapters inherit the enclosing contract; no separate comment narration. No two-object signature deviation except existing native React/map/test callback ABIs.

## RISKS

- Tests were not run; no red/green, rendered-browser or coverage result exists. Self-validation NOT RUN because the owner prohibited tests/builds/runtime validation for this dispatch; typechecks provide compilation evidence only.
- The competing-insert fixture proves the losing-insert SQL behavior, not live Postgres concurrency. No external database was contacted.
- A grant authorizes future sharing; creating it does not enable delivery. Production still has no conversion producer/worker binding (composition/index.ts:328, workers.ts:257). The existing grant/consent/plugin checks must remain at each future dispatch.

## NEEDS / deliberately deferred

- **W23-CONVERSION-PRODUCER-WORKER (already queued):** production producer must persist explicit grantId in durable payload; committed-event loader, production evidence/identifiers/ledger, conversion worker wiring inside bootServer by Coordinator, plugin artifact rebuilds, and pre-send failure/retry classification. This B1 adds no dead worker binding or scan-all-grants selection.
- Studio connection picker deferred per review; bounded plain identifiers are implemented. No grant-time account lookup, expiry gate, new page, grant history store, contract/manifest/lockfile change, worker test, tracking/shared API edit or custom CLI command was added.
- No new integration edit is needed to expose this grant service: bindCatalogScope plus the existing Object.assign already composes it. No new migration, dist or Jini work is requested by B1.

## HANDOFF / pre-completion

All amended B1 implementation items are complete. Requirements/file ownership rechecked; unrelated dirty/untracked work preserved; no tests deleted or weakened. Fresh evidence: all three package typechecks pass (measure and Studio used their allowed corrective reruns), and lane whitespace check passes. Full outputs: typecheck.txt; resumable checkpoints: progress.md. Suggested next routing: Coordinator/code inspection of B1, then the separately queued W23 producer/worker job. No commit or push performed.
