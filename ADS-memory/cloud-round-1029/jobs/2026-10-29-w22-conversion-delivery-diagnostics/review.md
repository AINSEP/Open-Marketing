# Trim review: 2026-10-29-w22-conversion-delivery-diagnostics
VERDICT: APPROVED WITH CUTS

Both findings are real in the current tree:
- features/measure/src/delivery/dispatcher.ts:127-128 maps any failed port result to `unknown`. :148 maps any throw to `unknown`. The status enum is `delivered | unknown` only (types.ts:28, rules.ts:28). There is no reason field.
- Google conversions.ts:121-123 parses `requestId` and then drops it. reconcile (:46-50) returns `unknown` with no I/O.
- The server fetch wrapper (apps/server/src/composition/agent-plugin-backends.ts:777-791) throws on halt, authority or binding refusal before the native fetch. The plugin then maps that to `unknown` (conversions.ts:120). This is the main source of false "unknown".
- A post-claim gate refusal (dispatcher.ts:44-45) leaves the ledger at `dispatching` forever, and the next run reconciles it as unknown.

Two facts the plan did not use:
- The transport already has `request_status` GET: google-ads transport.ts:99-104, with a fixed URL allowlist at :129+.
- `record_json` already holds the whole record (sql-delivery.ts:61). No migration is needed.

Vendor facts verified this review, from developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve:
- The call is `GET https://datamanager.googleapis.com/v1/requestStatus:retrieve?requestId=…` with an empty body and the `datamanager` scope.
- The response is `{ requestStatusPerDestination: [{ destination, requestStatus, errorInfo, warningInfo, eventsIngestionStatus: { recordCount } }] }`, in request destination order.
- `requestStatus` is one of `REQUEST_STATUS_UNKNOWN | SUCCESS | PROCESSING | FAILED | PARTIAL_SUCCESS`.
- The diagnostics guide (developers.google.com/data-manager/api/devguides/diagnostics) recommends waiting about 30 minutes before checking. The plan's "follow the REST enum `FAILED`" is correct.

CUTS:
1. Cut the `features/measure/src/adapters/sql-delivery.ts` edit. SQL append and memory append both already call `validateDeliveryTransition` and parse with `dispatchRecordSchema` (sql-delivery.ts:46-47, memory.ts ~234-238). The dispatcher appends `{ ...required.record, ...outcome }` (dispatcher.ts:132), so a stored `receiptId` carries forward on its own. Put the receipt and terminal invariants in `ledger-rules.ts` only (FIX 5). Neither adapter needs code changes.
2. Cut "adapt the earlier `diagnosticRecord` checks preserved in w20's baseline.json". Do not read or resurrect removed code. Write the few-line status parser fresh in conversions.ts (FIX 8).
3. Cut any plugin-side `not_sent`. Google's local `outcomeSchema` (conversions.ts:15) gains only an optional `receiptId`. Only the server, which owns the native fetch, can say "not sent".
4. Cut readback for records that are not `delivered`. `dispatcher.reconcile` calls the port only when the stored record is `delivered` and carries a `receiptId`. Otherwise it returns the stored evidence with no port call and no append. Unknown and dispatching records keep the existing outbox reconcile path (dispatcher.ts:43-46), unchanged.
5. Cut the "matching configured action" check in the status parser. Require exactly one `requestStatusPerDestination` entry. If `destination.operatingAccount.accountId` is present, it must equal the configured `accountId`. Do not re-derive `productDestinationId`.
6. Cut the docs edits down to one or two sentences each. README.md:42 should replace "Reconciliation … returns `unknown` without credentials or I/O until …" with the receipt and one-GET readback behaviour. HANDOFF.md:49 should replace "reconciles without I/O pending durable request-ID integration" with the same. No other doc edits.
7. Cut "Serialize shared measure/backend files with concurrent jobs" as a NEEDS line. Locks cover it.

FIXES:
1. **Server egress classification (main item). Reuse the mail pattern; add no new framework.** In `conversionCall` (agent-plugin-backends.ts:752-797):
   - Create `const attempt: MailAttempt = { egressed: false, refused: false }` (type at :54).
   - In the fetch wrapper, set `attempt.refused = true` before each `throw` at :782, :784 and :785. Set `attempt.egressed = true` on the line immediately before `await dependencies.fetch(url, options)` (:786).
   - Wrap the `backend.deliver` call in try/catch. Pass `{ result, attempt }` to a new pure helper `conversionOutcome` beside `mailOutcome` (:434). The helper keeps `conversionCall` under the complexity limit.
   - The helper applies these rules for the deliver action only:
     - Not egressed and failure, throw, `unknown` or malformed → `{ status: 'not_sent', reason }`. `reason` = `'forbidden'` if `attempt.refused`, else the plugin failure's code if it parses with `appErrorSchema.shape.code`, else `'unavailable'`.
     - Not egressed and `delivered` → `{ status: 'not_sent', reason: 'protocol_mismatch' }`.
     - Egressed → parse the plugin result with a local `delivered | unknown` (+ optional `receiptId`) schema. Anything else, a failure, or a throw → `{ status: 'unknown' }`.
   - The `reconcile` action never yields `not_sent`.
   - Widen the return types at :714, :735, :752 and :794 to the measure outcome type.
2. **Server readback without a claim.** Make `claim` optional on `conversionCall`/`conversionDelivery`.
   - Add `reconcile` to the object returned at :98-99, next to `dispatch`. Run it through the existing `pluginJobBoundary` the way `dispatchConversion` does. Add no `subjectLane`, no `conversionJob` or outbox, no `finishConversion` and no `beginDispatch`. It calls `createConversionDispatcher(...).reconcile(request)` with `conversionDelivery({ …, claim: undefined })`.
   - In the fetch wrapper, replace `admitConversion` with `required.claim ? await admitConversion(...) : getOnly(options)`, where `getOnly` refuses unless `(options?.method ?? 'GET').toUpperCase() === 'GET'`. The account lock, halt snapshot and `bindingCurrent` checks stay as they are. This adds no vendor URL and no new port.
3. **finishConversion (:712-725).** The state is chosen as follows:
   - `delivered` → `succeeded`;
   - ok `not_sent` with `reason === 'forbidden'` → `denied`;
   - other ok `not_sent` → `failed`;
   - existing failure `forbidden` while leased → `denied`;
   - else → `reconcile`.
   - Keep it at complexity ≤10: compute the state with a small pure helper if needed.
4. **Dispatcher post-claim refusal (dispatcher.ts:44-45).** When `action === 'dispatch'` (claim acquired) and `authorizeEgress` fails, append `{ status: 'not_sent', reason: error.code }` and return ok `not_sent`. No capability was called, so nothing left the server. When `action === 'reconcile'`, keep today's behaviour: return the failure and append nothing, because an earlier attempt may have sent. Never infer `not_sent` from a port error code inside the dispatcher. `perform`'s `!ok → unknown` (:128) stays, because only the server knows about egress.
5. **Terminal and receipt invariants in `ledger-rules.ts` `validateDeliveryTransition` (:8-15) only:**
   - `not_sent` is terminal (any later record is a conflict);
   - `not_sent` requires `reason`, and `reason` is only allowed on `not_sent`;
   - if `previous.receiptId` exists, `record.receiptId` must equal it. This rejects both replacement and removal.
   - In `dispatchOnce` (:42), return stored evidence for an unacquired `delivered` or `not_sent` record through one helper, e.g. `settledOutcome(record)`, so the function adds no complexity.
6. **Schemas (types.ts, rules.ts):**
   - `conversionDeliveryOutcomeSchema` becomes a `z.discriminatedUnion("status", …)` with these variants:
     - `delivered { diagnostics?, receiptId? }`;
     - `unknown { diagnostics? }`;
     - `not_sent { reason: appErrorSchema.shape.code }`.
   - `dispatchRecordSchema` gains `not_sent`, optional `reason` and optional `receiptId: idSchema`.
   - Derive `ConversionDispatchRecord` as `z.infer<typeof dispatchRecordSchema>` (type-only import; no runtime cycle) instead of the hand-written type at types.ts:67.
   - Store no messages and no vendor text.
7. **Port and dispatcher contract.**
   - `ConversionDeliveryPort.reconcile` input becomes `{ context, deliveryId, event: ConversionInput & { identifiers?: … }, grant, receiptId? }` (ports.ts:34).
   - Add `ConversionDispatcher.reconcile(required: { context, event, grant, deliveryId }, optional?)`. It:
     1. checks `runtimeMode`;
     2. calls `ledger.read`;
     3. checks identity against `deliveryIdentity`;
     4. returns stored evidence unless the record is `delivered` with `receiptId` (CUT 4);
     5. calls the port with the stored `receiptId` and no identifier resolution;
     6. appends only if the port returns `delivered`, merging diagnostics.
   - Any other port result returns the stored evidence and appends nothing. Acceptance survives a failed GET.
   - Update `input.ts`, `capabilities.ts:33-40` and `memory.ts:130-140` only enough that reconcile input parses without `identifiers`.
8. **Google readback (conversions.ts).**
   - `reconcile`: with no `receiptId`, keep today's zero-I/O `unknown`.
   - With a `receiptId`:
     1. Validate the configuration and the request. Use `requestSchema` with `identifiers` optional, and skip the identifier and mapping steps.
     2. Run the existing `checkAuthority` (:72) unchanged.
     3. Make one `transport.request({ method: "request_status", body: { requestId: receiptId }, context, operationId: deliveryId })` call through `createCallTransport` with `dependencies.fetch` directly. Do not use `authority.dispatch`: readback sends no visitor data and needs no consent recheck.
     4. Parse the response with a small local Zod schema.
   - Map the response as follows. Keep `receiptId` in every delivered result.
     - Exactly one entry with `SUCCESS` → `delivered {accepted:true, processed:true, attributed:null}`.
     - `FAILED` → `delivered {accepted:true, processed:false, attributed:null}`.
     - `PROCESSING`, `PARTIAL_SUCCESS`, `REQUEST_STATUS_UNKNOWN`, malformed, mismatched account, or transport failure → `delivered {accepted:true, processed:null, attributed:null}`.
   - Never persist `errorInfo` or `warningInfo`.
   - `deliver`: on a valid receipt, return `receiptId: receipt.data.requestId` (:121-123).
9. **NEEDS addition.** The server imports `@open-marketing/measure` at runtime from `dist` (features/measure/package.json exports `import: ./dist/index.js`). Add: `Coordinator: rebuild features/measure dist after integration`.
10. **Size guard.** Build order: FIX 1 + 3, then 6 + 5 + 4, then 7 + 8 + 2. If time runs out, mark FIX 7/8/2 (readback) DEFERRED in progress.md and leave every package compiling.
11. **Checks.** Write tests; do not run them. Run one typecheck per package, at the end only: measure, google-ads, server. One corrective rerun is allowed per package. No vitest, build, om:check or install.

REUSE:
- Egress flag and pre-egress refusal → `MailAttempt` (agent-plugin-backends.ts:54) and the `mailHttpClient`/`mailOutcome` pattern (:382-438).
- Refusal reason codes → `appErrorSchema.shape.code` in packages/contracts/src/values/index.ts:10, which already includes `protocol_mismatch`.
- Status GET → google-ads transport.ts:99-104 (`request_status`) plus its GET allowlist at :129+. Do not change transport.ts.
- Persistence → existing `record_json` (sql-delivery.ts:61). No migration and no new table.
- Diagnostics merge → `mergeDeliveryDiagnostics` (ledger-rules.ts:20).
- Transition rules → `validateDeliveryTransition` (ledger-rules.ts:8), shared by SQL and memory.
- Existing reconcile path → dispatcher.ts:43-46 and the port `reconcile` (ports.ts:34). Add no new port method.
- Job boundary for server readback → `pluginJobBoundary`, as `dispatchConversion` uses it (:733).

DUPLICATES:
- Searched read-only:
  - Tovu: apps/ and packages/;
  - tovu-integration-clones/ai-traces-jini: packages/;
  - published @jini-ai/* 0.6.15-rc.2 .d.ts in OM node_modules.
- Search terms: `requestStatus`, `requestStatusPerDestination`, `not_sent`/`notSent`, `egressed`/egress.
- None found. No Jini or Tovu conversion-delivery outcome, egress classifier or Data Manager status reader exists. The only in-repo precedent is OM's own mail egress flag (above), which this plan reuses.
- /Users/la/Programming/Jini was not consulted, because it is stale.
- JINI ASK: none.

OWNER DECISIONS (defaults):
1. **`not_sent` is terminal for its deliveryId.** It is never resent automatically. The outbox goes to `denied` (reason forbidden) or `failed` (other reasons). Alternative, deferred: let a `not_sent` claim re-acquire for a fresh send. That changes ledger `begin` semantics in memory and SQL.
2. **Readback reuses Google's existing grant binding check**, so a revoked or expired grant refuses readback. It also reuses the server's halt/lock/binding wrapper, so readback is blocked while the account is halted. Default: accept this; it is the smallest code.
3. **No polling.** Readback runs only on an explicit refresh. Google advises waiting about 30 minutes, which the deferred UI and tool should state.
4. **Owner-facing labels:** `delivered` → "sent", `not_sent` → "not sent (<reason>)", `unknown` → "unknown". The internal enum keeps the name `delivered`.

APPROVED SCOPE for B1:
1. Server egress classification in `conversionCall` via `MailAttempt` plus a pure `conversionOutcome` helper (FIX 1). Plugin results are validated as delivered/unknown only. Deliver action only.
2. `finishConversion` outbox state mapping for `not_sent` (FIX 3). Widen the server result types.
3. Measure schemas and types: the discriminated outcome, the record's `not_sent`/`reason`/`receiptId` fields, and the Zod-derived `ConversionDispatchRecord` (FIX 6).
4. `ledger-rules.ts` terminal `not_sent`, reason pairing and receipt immutability, plus the `settledOutcome` early return in `dispatchOnce` (FIX 5).
5. Dispatcher post-claim refusal → append `not_sent` for an acquired claim only (FIX 4).
6. Google `deliver` returns `receiptId` (FIX 8, deliver part).
7. Port reconcile input with `receiptId` and optional identifiers. Make `input.ts`, `capabilities.ts` and `memory.ts` parse it. Add `ConversionDispatcher.reconcile` (FIX 7, CUT 4).
8. Google `reconcile` with a receipt: one `request_status` GET and the status mapping. With no receipt, keep zero I/O (FIX 8).
9. Server `conversions().reconcile` with no claim: GET-only, admission skipped, existing lock/halt/binding checks kept (FIX 2).
10. Tests, written and not run:
    - `features/measure/tests/delivery.test.ts`:
      - an acquired-claim gate refusal is persisted as `not_sent`;
      - a reconcile-claim gate refusal is not persisted as `not_sent`;
      - a duplicate `not_sent` returns stored evidence without calling the port;
      - readback appends `processed: true`;
      - a failed readback keeps acceptance and appends nothing;
      - readback never resolves identifiers.
    - `features/measure/tests/contract/port-suites.ts`: one shared case each for terminal `not_sent` and receipt replacement/removal being rejected.
    - Google `tests/conversions.test.ts`:
      - deliver returns `receiptId`;
      - reconcile without a receipt makes zero fetches (update the existing assertion);
      - reconcile with a receipt makes exactly one GET to the `requestStatus:retrieve` URL and no POST;
      - SUCCESS, FAILED and PROCESSING mappings, a 2-entry response and a malformed body.
    - `apps/server/tests/agent-plugin-jobs.test.ts`:
      - a halt or withdrawn authority before native fetch gives `not_sent`/`forbidden`, outbox `denied` and zero native fetches;
      - a native-fetch throw gives `unknown`/`reconcile`;
      - a plugin `delivered` without egress gives `not_sent`/`protocol_mismatch`;
      - claim-less readback refuses POST.
11. Docs: README.md:42 and HANDOFF.md:49, one or two sentences each (CUT 6).
12. `progress.md` after each item. `report.md` with net +/- lines, the vendor URLs above and these NEEDS:
    - `Coordinator: rebuild features/measure dist and content/agent-plugins/google-ads plugin dist after integration.`
    - `Coordinator: schedule diagnostics read + refresh across workers/HTTP/om-tool/om CLI/Studio (labels per OWNER DECISION 4). conversions().dispatch/reconcile currently have no caller in workers.ts.`
    - `Installs: none. packages/contracts: none. Migration / migrations.ts: none.`
    - Then the per-package typecheck (FIX 11).

LOCKS-FILES: features/measure/src/types.ts, features/measure/src/rules.ts, features/measure/src/ports.ts, features/measure/src/delivery/input.ts, features/measure/src/delivery/dispatcher.ts, features/measure/src/delivery/ledger-rules.ts, features/measure/src/adapters/capabilities.ts, features/measure/src/memory.ts, features/measure/tests/delivery.test.ts, features/measure/tests/contract/port-suites.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/conversions.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/conversions.test.ts, content/agent-plugins/google-ads/skills/google-ads/references/README.md, content/agent-plugins/google-ads/HANDOFF.md, apps/server/src/composition/agent-plugin-backends.ts, apps/server/tests/agent-plugin-jobs.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-delivery-diagnostics/{progress.md,report.md,typecheck.txt} (lock groups: w15-backends, w18-google, w20-measure)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted: not_sent final per delivery ID (no auto resend); readback reuses grant + halt + account-lock checks; no polling; labels sent / not sent (reason) / unknown. Owner-visible surface DEFERRED (no conversions() caller in workers.ts yet).
