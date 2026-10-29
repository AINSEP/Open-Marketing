Programmer(Direct): B1 implementation handoff

Backend delivery evidence now separates sent (`delivered`), definite not sent with a short machine reason, and uncertain sends (`unknown`). Definite refusals are terminal for the delivery ID. Google ingestion returns a durable neutral receipt, and explicit readback uses that receipt for one status GET without resolving visitor identifiers or replaying ingestion. Owner-facing diagnostics/refresh across workers, HTTP, tools, CLI and Studio remain DEFERRED under the approved scope.

CHANGED FILES

- features/measure/src/types.ts — schema-derived discriminated outcomes and dispatch records; dispatcher reconcile method.
- features/measure/src/rules.ts — not_sent/reason/receipt ledger fields.
- features/measure/src/ports.ts — existing reconcile accepts receipt and optional identifiers.
- features/measure/src/delivery/input.ts — strict readback input parser.
- features/measure/src/delivery/dispatcher.ts — fresh post-claim refusal evidence, stored-outcome projection and receipt-bound readback.
- features/measure/src/delivery/ledger-rules.ts — terminal refusal, reason pairing and immutable receipt invariants for memory and SQL.
- features/measure/src/adapters/capabilities.ts — parse readback without resolved identifiers.
- features/measure/src/memory.ts — reconcile parser and union-safe stored outcome projection; ledger adapter unchanged.
- features/measure/tests/delivery.test.ts — refusal, duplicate, receipt/restart and readback regressions.
- features/measure/tests/contract/port-suites.ts — shared terminal refusal and receipt conflict cases; outcome narrowing.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/conversions.ts — retain receipt, validate readback and project one destination's processing status.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/conversions.test.ts — real factory receipt assertion, no-receipt zero I/O, one GET, status/malformed/multiple/mismatched destination and failed GET fixtures.
- content/agent-plugins/google-ads/skills/google-ads/references/README.md — only the current reconciliation documentation sentences.
- content/agent-plugins/google-ads/HANDOFF.md — only the current conversion-contract reconciliation sentence.
- apps/server/src/composition/agent-plugin-backends.ts — native egress classification, outbox final states, claim-less GET-only readback.
- apps/server/tests/agent-plugin-jobs.test.ts — zero-fetch refusal/spoof/malformed outcomes, native-fetch failure and GET-only readback/outbox regressions; update affected expectations.
- This job directory: progress.md, report.md and typecheck.txt.

Final implementation/test/plugin-documentation diff against this run's in-memory starting contents: +503/-113, net +390 lines (source +244/-86; tests +257/-25; plugin docs +2/-2). Counts exclude job reports and preserve pre-existing dirty changes. No out-of-lane edits, commits or pushes.

TESTS (written, not run)

- Measure shared worker suite exercises memory and SQL: final-gate refusal persists; earlier uncertain claims are not reclassified; terminal duplicates never call delivery; receipt-bound readback survives dispatcher recreation; processing merges; failed/thrown/unknown reads append nothing; identifier resolution and resend throw if attempted. A separate SQL case recreates the ledger adapter and reads persisted receipt/processing evidence.
- Shared memory/SQL port suite: not_sent requires its reason and rejects every later transition; reason on unknown is rejected; receipt replacement/removal is rejected and saved evidence survives.
- Google fixtures use the real factory, canonical server-shaped configuration and existing transport. Verify receipt propagation, zero effects without receipt, exactly one GET/no POST, SUCCESS/FAILED/PROCESSING/PARTIAL_SUCCESS/unknown, malformed and multiple/mismatched destinations, retained acceptance after transport failure, no authority dispatch on readback and no vendor error text in diagnostics/observations. Existing canonical createCapabilities test retained unchanged.
- Server fixtures: halt/withdrawal before native fetch => not_sent/forbidden with denied outbox; fake delivered without egress => protocol_mismatch/failed; malformed/throw without egress => unavailable/failed; native-fetch throw => unknown/reconcile; claim-less GET updates diagnostics, POST via RequestInit or Request is refused, outbox/attempt rows remain unchanged.
- No tests, runtime probes, suites, lint, builds, om:check, installs or live vendor calls were run. Red/green and coverage evidence are unavailable under the owner's explicit prohibition; assertions are written, not verified.

TYPECHECK

Results retained in typecheck.txt:
- corepack pnpm --filter @open-marketing/measure typecheck — PASS, exit 0 on one corrective rerun. First run found one existing test capture typed as deliver instead of reconcile; corrected type and optional identifier access.
- corepack pnpm --dir content/agent-plugins/google-ads typecheck — PASS, exit 0 on first run.
- corepack pnpm --filter @open-marketing/server typecheck — PASS, exit 0 on first run and one corrective rerun after static quality review removed conversionOutcome's extra parser-selection branch using Zod catch with the same unavailable fallback.
- Final restricted git diff --check — PASS, exit 0, no whitespace diagnostics.

Timing caveat: after the successful measure rerun, final static review aligned one existing literal assertion (consent/grant withdrawn during identifier lookup) with not_sent/forbidden. No production/type declarations changed after that passing measure check. No third typecheck was run, respecting the cap; this assertion-only final edit is not covered by a fresh compiler invocation.

CONTRACTS / MIGRATIONS

ConversionDeliveryOutcome is derived from a strict discriminated schema: delivered permits diagnostics/receipt; unknown permits diagnostics; not_sent requires an existing AppError code. Dispatch records derive from their Zod schema. Existing deliver/dispatch signatures remain; existing port reconcile input gains receipt and optional identifiers; dispatcher/server expose explicit reconcile. Plugins cannot claim not_sent: only the server classifies native-fetch evidence. No packages/contracts, manifest, lockfile, dependency, table, migration, migrations.ts or bootServer change.

REUSE / RESEARCH

- Egress classification extends server MailAttempt/mailOutcome. It also observes rejection by existing guardedFetch so an earlier halt/binding guard yields forbidden rather than a generic unknown. Module-load/configuration exceptions are inside the same call boundary; only validated reason codes survive.
- Existing appErrorSchema.shape.code and measure conversionDiagnosticsSchema provide neutral evidence schemas; existing pluginJobBoundary/runBoundary and transport observer propagate trace/correlation context. No observability plumbing added.
- Existing validateDeliveryTransition, mergeDeliveryDiagnostics and record_json persistence serve both SQL and memory. sql-delivery.ts is untouched; no parallel store/journal.
- Existing Google createCallTransport request_status path, fixed URL allowlist, timeout/body bounds and credential exchange are reused; transport.ts untouched. No new timeout, reader, retry or polling mechanism.
- Read-only searches: Tovu apps/packages and ai-traces-jini packages, plus published @jini-ai/platform 0.6.15-rc.2 declarations, for requestStatusPerDestination/requestStatus:retrieve/not_sent/notSent. No conversion-specific implementation found. Stale /Users/la/Programming/Jini and source-only rc.3 APIs were not used. Graph tools unavailable; rg/direct reads, no index operations.
- Google official REST API verified by web search: https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve specifies GET requestStatus:retrieve?requestId, empty body and SUCCESS/PROCESSING/FAILED/PARTIAL_SUCCESS/REQUEST_STATUS_UNKNOWN. https://developers.google.com/data-manager/api/devguides/diagnostics recommends an initial 30-minute wait. The guide spells failure differently; implementation uses the REST enum FAILED. No polling added.

ARCHITECTURE AUDIT / FUNCTION QUALITY

Architecture audit: PASS for static scope/boundary review; runtime remains unverified. No new dependency direction, vendor identifier/URL in core, runtime registry, hidden clock, identifier persistence, write path on readback, or bootstrap edit. Server still owns native egress, halt/account lock and binding checks; plugins retain vendor parsing. Decision helpers are pure; I/O remains injected and observed through existing boundaries. Records append; terminal/receipt invariants are shared by both adapters.

Assessment units | disposition | evidence / findings
- conversionOutcome + conversionJobState | NO_RECORDED_FINDINGS after local fix | static review found conversionOutcome at 11 cognitive branches; replaced safeParse/ternary selection with the same Zod catch unavailable fallback, removing one branch. Pure bounded classification/state mapping; zero-egress/native-egress fixtures; O(1).
- conversionCall + getOnly + conversionDelivery | NO_RECORDED_FINDINGS | native boundary flag, existing guard/lock reuse, GET-only check includes Request methods, redacted catch; bounded one plugin invocation/no retries.
- dispatchOnce + recordRefusal + settledOutcome + perform | NO_RECORDED_FINDINGS | current gates retained, fresh claims alone become not_sent, failures after uncertain port handoff remain unknown; O(1) ledger calls/bounded event parsing.
- reconcileOnce + input/adapters + server reconcileConversion | NO_RECORDED_FINDINGS | scoped saved identity/receipt, no caller-selected receipt, no visitor resolution or claim; failed read keeps acceptance; O(k) bounded identity and one read/GET/append.
- validateDeliveryTransition | NO_RECORDED_FINDINGS | shared terminal/reason/immutable receipt regression cases; O(1), no I/O.
- Google readConversion + processingStatus + receipt projection | NO_RECORDED_FINDINGS | schema-validated one-destination evidence, no identifiers/error text retained, fixed existing bounded GET; O(b+a) bounded parse and O(1) status projection.

Zero-findings skepticism pass: re-read negative outcomes, duplicate/receipt conflicts, current egress flag placement, optional identifier path, failed GET preservation and variable names. `egressed` means the native fetch handoff, `receiptId` is the vendor request ID, `processed` does not assert attribution. Adversarial tests cover spoofed success, receipt mutation, multiple destinations and partial failure. Complexity reviewed manually (conversionOutcome, reconcileOnce and ledger transition validation at the <=10 boundary); no automated complexity/lint or coverage claim; prohibited tests/runtime validation remain unverified. Documentation classification: behavior/contract comments for new logic, existing patterns for small callbacks; two approved plugin documentation replacements only. Public object-parameter convention retained; fetch callbacks keep the documented foreign ABI.

RISKS / DELIBERATELY LEFT OUT

- Owner-visible closure is deferred: conversions().dispatch/reconcile are backend entry points; workers.ts has no caller yet. This is not an owner-visible diagnostics rollout.
- No rebuilds performed; runtime dist remains an integrator responsibility.
- Readback follows the approved supplied-grant binding/expiry check and halt/account/binding wrapper, without a new consent dispatch or subject lane. Integration must supply the appropriate grant; no new grant-loading mechanism was added.
- No live account verification. Lost receipts before durable append remain unknown; historical unknown rows never become not_sent and are never automatically resent.
- not_sent is terminal per delivery ID; fresh resend policy, polling, retries, bulk diagnostics, attribution inference, raw error storage, new tables and plugin-local journals are deliberately omitted.

DISPUTED / DEFERRED

DISPUTED: none of the assigned findings; both reproduced by static source inspection. The proposed SQL adapter edit was correctly cut: record_json and shared invariants already handle new evidence. No removed w20 code was read or restored.
DEFERRED: owner-facing workers/HTTP/om-tool/CLI/Studio read/refresh wiring and all runtime validation/build/rebuild steps outside the approved lane.

NEEDS / HANDOFF

- Coordinator: rebuild features/measure dist and content/agent-plugins/google-ads plugin dist after integration.
- Coordinator: schedule diagnostics read + refresh across workers/HTTP/om-tool/om CLI/Studio (labels per OWNER DECISION 4). conversions().dispatch/reconcile currently have no caller in workers.ts.
- Installs: none. packages/contracts: none. Migration / migrations.ts: none.
- JINI ASK: none.
- Next: integrate/rebuild in the Coordinator's quiet window; cloud review and authorized tests, then separately implement owner-facing diagnostics labels sent / not sent (reason) / unknown.

PRE-COMPLETION / SELF-VALIDATION

Requirements re-read against the B1 approved scope and cuts. All 16 changed implementation/test/plugin-doc files audited; three job artifacts maintained. No certified assertions deleted or weakened; prior final-gate expectations are updated to the approved diagnostic contract and zero-egress assertions remain. No runtime self-validation attempted because the owner prohibits tests/builds/runtime probes for this run; no test pass or red/green claim. Final production source has passing package typechecks; the assertion-only timing caveat above is explicit. All B1 backend scope items complete; owner-facing closure and dist integration remain open NEEDS.
