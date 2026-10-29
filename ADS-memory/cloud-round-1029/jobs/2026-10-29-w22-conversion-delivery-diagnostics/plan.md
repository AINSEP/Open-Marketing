Software Architect(Direct):

**1. Summary**

Delivery records will distinguish sent, not sent with a machine reason, and unknown after possible egress. Google’s ingestion request ID will survive restart and support one read-only processing-status lookup per explicit refresh. Acceptance, processing, and attribution remain separate facts. This single build covers the backend; owner-facing HTTP/tool/CLI/Studio presentation is explicitly deferred because those files are outside this lane.

**2. Files**

Every planned implementation write follows; no files were edited during planning.

- (edit) `features/measure/src/types.ts` — schema-derived outcomes, refusal reasons, receipt evidence and dispatcher reconciliation signature.
- (edit) `features/measure/src/rules.ts` — delivery-record validation using the updated schemas.
- (edit) `features/measure/src/ports.ts` — extend the existing reconcile input with receipt evidence.
- (edit) `features/measure/src/delivery/input.ts` — validate reconciliation without requiring resolved visitor identifiers.
- (edit) `features/measure/src/delivery/dispatcher.ts` — persist refusals and receipts; explicitly refresh existing delivery diagnostics.
- (edit) `features/measure/src/delivery/ledger-rules.ts` — preserve receipts and enforce terminal delivery evidence.
- (edit) `features/measure/src/adapters/sql-delivery.ts` — retain receipt/reason evidence across append-only records.
- (edit) `features/measure/src/adapters/capabilities.ts` — validate the extended reconciliation input/output.
- (edit) `features/measure/src/memory.ts` — keep existing doubles consistent with SQL and capability contracts.
- (edit) `features/measure/tests/delivery.test.ts` — dispatcher refusal, restart and readback regressions.
- (edit) `features/measure/tests/contract/port-suites.ts` — shared memory/SQL evidence-preservation assertions.
- (edit) `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/conversions.ts` — return ingestion receipt and decode one status GET.
- (edit) `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/conversions.test.ts` — fixture receipts and processing-status regressions.
- (edit) `content/agent-plugins/google-ads/skills/google-ads/references/README.md` — update current receipt/readback behavior and primary-source links.
- (edit) `content/agent-plugins/google-ads/HANDOFF.md` — update the current conversion-contract paragraph only.
- (edit) `apps/server/src/composition/agent-plugin-backends.ts` — classify actual egress, finish definite refusals, and provide read-only reconciliation.
- (edit; lane extension NEEDS) `apps/server/tests/agent-plugin-jobs.test.ts` — native-fetch and outbox-state regressions.
- (new) `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-delivery-diagnostics/progress.md` — completed-item checkpoints.
- (new) `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-delivery-diagnostics/report.md` — findings, actual line changes, checks and handoff.
- (edit) `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-delivery-diagnostics/typecheck.txt` — package typecheck results.

**3. Public contracts**

- Extend `ConversionDeliveryOutcome`: existing `delivered | unknown`, plus `not_sent` requiring `reason`; optional neutral `receiptId`.
- Derive refusal reasons from `appErrorSchema.shape.code`; persist no error messages or vendor bodies.
- Derive `ConversionDispatchRecord` from its Zod schema; retain `dispatching` plus the outcome evidence.
- Existing `ConversionDispatcher.dispatch({ context, event, grant, deliveryId }, options?)` keeps its signature.
- Add `ConversionDispatcher.reconcile({ context, event, grant, deliveryId }, options?) → Promise<Outcome<ConversionDeliveryOutcome>>`.
- Extend existing `ConversionDeliveryPort.reconcile({ context, event, grant, deliveryId, receiptId? }, options?)`; identifiers are optional for reconciliation.
- Google’s existing `createConversionDelivery(required)` factory remains; successful ingest adds `receiptId`.
- Server `conversions(required)` exposes the corresponding typed `reconcile` method alongside `dispatch`.
- No new port, factory, registry, command, dependency or shared-contract package change.

**4. Approach**

1. **Verify and preserve.** Findings remain real: dispatcher `perform` maps failures to unknown; Google discards `requestId`. Existing JSON `record_json` storage needs no migration.
2. **MAJOR — definite refusal.** In server `conversionCall`, mark egress immediately before the underlying injected fetch, after all guards. Before that point, failed/thrown/malformed plugin outcomes become `not_sent` with a validated code or fixed `unavailable`/`protocol_mismatch`.
3. Apply that classification only to a fresh delivery attempt. A reconciliation call making zero requests cannot prove an earlier attempt was not sent. After native fetch begins, failures remain unknown unless valid acknowledgment proves acceptance.
4. Persist explicit `not_sent` outcomes, including known post-claim gate refusals. Duplicate calls return that evidence without sending again. Complete their existing outbox claim as denied/failed rather than reconcile.
5. **Receipt persistence.** Return Google’s body `requestId` as neutral `receiptId`; append it to the existing ledger JSON. Preserve it when later observations omit it; reject replacement by another receipt. Keep unknown historical attempts unknown.
6. **MINOR — explicit readback.** Dispatcher reconciliation reads the scoped ledger and verifies delivery identity before forwarding its saved receipt. It never accepts a caller-selected receipt, creates a send claim, or resolves visitor identifiers.
7. Server reconciliation uses current read admission/binding checks, permits only GET through its fetch wrapper, and never calls conversion `beginDispatch` or completes a write outbox claim.
8. Google reuses `createCallTransport`’s existing `request_status`. Parse one destination matching the configured account/action: clean single-event `SUCCESS` → `processed:true`; `FAILED` → `processed:false`. Processing, partial, malformed or mismatched evidence establishes no success. Preserve accepted/sent evidence and leave attribution null. [REST contract](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve)
9. Write regressions for zero-fetch refusals, post-fetch failures, false success without egress, terminal refusals, SQL restart/receipt retention, conflicting receipts, readback without POST, and retained acceptance after GET failure.
10. Update progress after each item. Run each affected package’s `typecheck` once: measure, google-ads and server; one corrective rerun allowed per package. Never run tests, builds or `om:check`.

**5. Reuse**

- **Outcome classification:** extend existing `conversionCall`; use the native-fetch handoff approach already present in server `mailHttpClient`/`mailOutcome`. Their different return contracts do not justify a new shared framework.
- **Persistence:** existing `sql-delivery.ts`, memory ledger and `ledger-rules.ts`; extend their existing shared memory/SQL suite.
- **Readback:** existing Google `createCallTransport` → `request_status` → bounded GET; leave `transport.ts` unchanged.
- **Status projection:** adapt the earlier `diagnosticRecord` checks preserved in w20’s `baseline.json`; do not restore its removed journal, preflight or configuration machinery.
- Searched Jini’s `CAPABILITIES.md`, Jini packages and Tovu for `requestStatusPerDestination`, `requestStatus:retrieve`, `pre-egress` and refusal handling. No conversion-delivery implementation found.
- Inspected Jini credentialed-HTTP refusal policy and Tovu guarded HTTP; neither owns durable conversion outcomes. No copied sibling implementation.
- Verified installed `@jini-ai/platform@0.6.15-rc.2` declarations. Existing Google transport already supplies the required bounds; no new reader or timeout mechanism.
- Existing Google `read-capabilities.test.ts:233` already exercises the real canonical factory; retain it.
- npm registry lookup was attempted but unavailable; no installation is proposed.

**6. Deliberately left out**

- Automatic polling, scheduling, retries, bulk diagnostics, new tables and plugin-local journals.
- Reclassifying existing unknown records as not sent without evidence.
- Attribution inference, raw vendor errors, identifier persistence and unrelated money/payload changes.
- **DEFERRED tail:** HTTP + om-tool + CLI + Studio diagnostics presentation and refresh wiring. These require separately locked files outside this lane; backend completion must not be reported as owner-visible completion.
- If the backend exceeds 90 minutes, finish definite refusals and receipt persistence first; mark unfinished readback explicitly DEFERRED.

**7. NEEDS**

- `Coordinator: authorize and lock apps/server/tests/agent-plugin-jobs.test.ts for regression coverage of the permitted agent-plugin-backends.ts changes.`
- `Coordinator: schedule diagnostics read/refresh closure across HTTP + om-tool + om CLI + Studio, displaying delivered as “sent”, not_sent with reason, and unknown.`
- `Coordinator: rebuild google-ads plugin dist after integration; this job does not rebuild plugin artifacts.`
- Serialize shared measure/backend files with concurrent jobs before implementation.
- Installs: none. `packages/contracts` changes: none. Migration or `migrations.ts` registration: none.

**8. Unverified facts and risks**

- Google documents asynchronous processing and recommends waiting 30 minutes before checking; this plan performs no immediate ingestion follow-up or polling loop. [Diagnostics guide](https://developers.google.com/data-manager/api/devguides/diagnostics)
- The guide spells failure `FAILURE`; the REST enum spells it `FAILED`. Follow the REST enum; unfamiliar values remain unconfirmed rather than successful.
- Request IDs lost before ledger persistence cannot be reconstructed; those attempts remain unknown and never resend automatically.
- Refusal classification relies on the server-owned fetch boundary. Never infer “not sent” from an error code alone.
- No live-account behavior, tests or typechecks were verified in this planning run.

**9. Size estimate**

One build, approximately 80–90 minutes: 20 files including reports; 11 source files, 4 test files and 5 documentation/checkpoint files. Roughly +300/−70 source LOC and +220/−40 test LOC; estimated net +410 LOC excluding documentation. No dependency, migration or application-bootstrap expansion.