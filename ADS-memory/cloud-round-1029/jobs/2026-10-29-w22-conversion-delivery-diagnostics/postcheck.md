### 2026-10-29-w22-conversion-delivery-diagnostics: verdict SMALL FIXES (2), one of which is a BLOCKER

Reviewer R1, 2026-10-29. Checked against the current tree: the work is committed in dd7bf32 (mixed with other jobs), and HEAD is now ca2d393. Line numbers are for the current HEAD. apps/server/src/composition/agent-plugin-backends.ts has unrelated in-progress edits in the working tree (messaging); the fixes below give anchor text, so re-read before editing. All tests attributed below were also re-run on a private copy of HEAD with the in-progress edits removed. That copy is the scratchpad `r1head`; the results were identical.

Ledger:
1. Server egress classification (MailAttempt + `conversionOutcome`, deliver only): FIXED. agent-plugin-backends.ts `conversionOutcome` sits beside `mailOutcome`. The wrapped fetch sets `refused` before each throw and `egressed` right before the native fetch. The outer guardedFetch catch is also classified. Plugin results are validated as delivered/unknown(+receiptId) only, and reconcile never yields not_sent. Cognitive complexity is 10, and SonarJS reports clean.
2. `finishConversion` → `conversionJobState` (delivered→succeeded, not_sent forbidden→denied, other not_sent→failed, leased forbidden failure→denied, else reconcile): FIXED.
3. Schemas (discriminated outcome, record `not_sent`/`reason`/`receiptId`, Zod-derived `ConversionDispatchRecord`): FIXED. These are types.ts:28-32 and :69, and rules.ts:28.
4. ledger-rules terminal not_sent, reason pairing, immutable receipt, and the `settledOutcome` early return: FIXED. These are ledger-rules.ts:13-15 and dispatcher.ts:68/:84-89.
5. Post-claim refusal → not_sent for an acquired claim only; reconcile is unchanged: FIXED (dispatcher.ts:71, :76-81).
6. Google `deliver` returns `receiptId`: FIXED (conversions.ts:165).
7. Port reconcile input (receiptId, optional identifiers) and `ConversionDispatcher.reconcile` (CUT 4): FIXED. This covers ports.ts:34, input.ts:48-56, dispatcher.ts:28-55 and capabilities.ts:33-40.
8. Google reconcile with a receipt (one `request_status` GET plus status mapping); no receipt means zero I/O: FIXED (conversions.ts:97-130). google-ads conversions.test.ts: 34/34 pass.
9. Server claim-less `conversions().reconcile` (GET-only, admission skipped, lock/halt/binding kept): FIXED (`reconcileConversion`, `getOnly`). Its tests pass only after small fix 1.
10. Tests: PARTIAL. measure delivery + contract suites: 297/297 pass. Google: 34/34 pass. apps/server/tests/agent-plugin-jobs.test.ts: 25/51 FAIL at HEAD. With small fix 1 applied, 46/51 pass and every conversion-diagnostics case the job added passes. The remaining 5 are outside this job (see FOLLOW-UP).
11. Docs README.md:42 and HANDOFF.md:55: FIXED.
12. report.md with NEEDS and net lines: FIXED. Net is +390, and no reduction was promised.
- OVERRIDE 1 (owner-visible surface deferred; no polling): DEFERRED-OK.

Outside lane: B1 reports none. The mixed commit cannot be separated by file per job. Nothing found contradicts the claim: sql-delivery.ts and transport.ts carry no receipt or not_sent code.

New:
- [BLOCKER, pre-existing root cause made worse by this job] apps/server/src/composition/agent-plugin-backends.ts:984 (`conversionCurrent`): `policy.assess({ context, event: required.input.event })` receives the resolved event, which includes `identifiers`. The shareability adapter parses with `z.strictObject({ context, event: conversionSchema })` (features/measure/src/adapters/capabilities.ts:88), which rejects that key.
  - Failure: every claimed deliver gets `invalid_input` from `admitConversion` or the plugin's `authority.dispatch` before egress. Before this job that was a failure, which went to outbox `reconcile`. Now `conversionOutcome` turns it into terminal `not_sent: invalid_input`, and the outbox goes to `failed`. Every production conversion is permanently dropped and never resent.
  - Reproduced: 20 of the 25 agent-plugin-jobs.test.ts failures. Examples are "keeps a native-fetch exception uncertain" (received `not_sent/invalid_input`) and all three "claim-less readback" cases.
  - Fix: small fix 1, verified on the HEAD copy: 25→5 failures, server `tsc --noEmit` exit 0.
- [MAJOR, lint] agent-plugin-backends.ts:930: the new outer fetch wrapper `fetch: async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {` fails `om/two-object-arguments`. ESLint error, so om:lint and om:check fail.
  - Fix: small fix 2. Verified: ESLint clean, tsc exit 0, tests unchanged.
- [MINOR, owner decision, no fix] dispatcher.ts:71/:76-81: any post-claim gate failure becomes terminal `not_sent`. That includes `cancelled` (worker shutdown signal at :111) and a transient audit or grant-read `unavailable`, so a graceful shutdown or a DB blip permanently drops that conversion. This is per FIX 4 and OWNER DECISION 1, so it is a FOLLOW-UP below.
- [MINOR, no fix] dispatcher.ts:51-53: if a readback returns a different `receiptId`, the ledger conflict is returned as a failure instead of the stored evidence, as CUT 4 wanted. It is harmless because nothing is appended.

Disputes/deferrals:
- Owner-facing diagnostics (workers/HTTP/om-tool/CLI/Studio) DEFERRED: upheld by OVERRIDE 1.
- The SQL adapter cut: upheld, because `record_json` persistence is proven by the passing SQL recreate test.
- No disputes raised.

Typecheck: re-run now. measure, google-ads and server all exit 0 (server includes the test project). B1's timing caveat (one assertion edit after the last measure check) is moot: the measure typecheck and suites pass.

Small fixes:
1. apps/server/src/composition/agent-plugin-backends.ts:984 (anchor: inside `async function conversionCurrent`).
   - Old (1 line):
     `    const consent = await required.authority.policy.assess({ context: required.execution.context, event: required.input.event }, { signal: required.signal });`
   - New (2 lines):
     `    const { identifiers: _identifiers, ...event } = required.input.event;`
     `    const consent = await required.authority.policy.assess({ context: required.execution.context, event }, { signal: required.signal });`
2. apps/server/src/composition/agent-plugin-backends.ts:928-933 (anchor: `const guarded = deps.value.fetch;` in `conversionCall`).
   - Old:
     ```
             const guarded = deps.value.fetch;
             const backend = (module.createConversionDelivery as Factory<Required<ConversionDeliveryPort>>)({ ...deps.value,
                 fetch: async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
                     try { return await guarded(url, options); }
                     catch { if (!attempt.egressed) attempt.refused = true; throw new Error('Conversion transport unavailable'); }
                 },
     ```
   - New:
     ```
             const guarded = deps.value.fetch;
             const observed: typeof fetch = async (url, options) => {
                 try { return await guarded(url, options); }
                 catch { if (!attempt.egressed) attempt.refused = true; throw new Error('Conversion transport unavailable'); }
             };
             const backend = (module.createConversionDelivery as Factory<Required<ConversionDeliveryPort>>)({ ...deps.value, fetch: observed,
     ```
   - The `authority: { ... }` lines that follow stay unchanged.
   - Then run `pnpm --filter @open-marketing/server exec vitest run tests/agent-plugin-jobs.test.ts`. Expect 46/51; the 5 remaining failures are the FOLLOW-UPs.

FOLLOW-UP:
- agent-plugin-jobs.test.ts still has 5 failures that this job did not cause, in halt/stop and SQLite lane fixtures. They fail identically on the HEAD copy:
  - "commits halt before enqueue…"
  - "rejects a stale halt epoch…" (Unverified fixture target)
  - "dispatches the canonical safety-issued permit through the LinkedIn halt capability"
  - "closes the admission-to-fetch gap…" (Contacts storage unavailable)
  - "retains the subject lane until … durable" (Outbox SQL transaction failed)
- Owner decision: should `cancelled` or transient `unavailable` pre-egress refusals stay terminal `not_sent`, or should they leave the claim re-acquirable?
- google-ads skills/google-ads/references/README.md:11 still says a request-status SUCCESS "establishes `delivered`". That contradicts the new :42 semantics; CUT 6 limited the edits.
- NEEDS carried: rebuild measure and google-ads dists after the fixes; wire diagnostics read/refresh across all surfaces.

## FIXES APPLIED (cloud round)
Fixer F2, 2026-10-29. No git writes.
1. Strip `identifiers` before `policy.assess` in `conversionCurrent` (apps/server/src/composition/agent-plugin-backends.ts): DONE, exact text from the brief.
   - Regression coverage: the existing agent-plugin-jobs.test.ts cases fail without this fix, as R1 reproduced (25 failures before, 5 after). These are "claim-less readback …" ×3 (they assert `input.event` has no `identifiers`) and "keeps a native-fetch exception uncertain". All of them now pass.
2. `om/two-object-arguments`: hoisted `const observed: typeof fetch` in `conversionCall`: DONE. ESLint is clean on agent-plugin-backends.ts.
- Evidence:
  - `vitest run tests/agent-plugin-jobs.test.ts`: 46/51. The 5 failures are exactly the FOLLOW-UP halt/SQLite cases and were not chased.
  - server `tsc --noEmit` (tsconfig.json and tsconfig.tests.json): exit 0.
- The prepareDestination message change in the same file belongs to Fixer F1, not to this fix.
