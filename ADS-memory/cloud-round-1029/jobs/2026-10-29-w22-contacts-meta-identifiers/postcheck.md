### 2026-10-29-w22-contacts-meta-identifiers: verdict READY TO COMMIT (committed in 24e3381; depends on consent-banner small fixes 1-4 for its consent-first guarantee)

Reviewer R2, 2026-10-29. Separated from w22-consent-banner by LOCKS-FILES. This job's hunks:
- public.ts: `landingSchema` `.omit({ client_user_agent: true })` and `userAgentProperty` (public.ts:44, :183-189).
- identity.ts.
- web-events types.ts and rules.ts.
- measure dispatcher.ts and memory.ts.
- web-events fixtures and port-suite.
- measure delivery and boundaries tests.
- The UA test in ingress-worker.test.ts (:384-428).

Ledger:
1. Dispatcher superset rule + memory alias + measure tests (FIXES 4, 5): FIXED.
   - dispatcher.ts:101-103 checks that every committed digest key is present with an equal value and that the subject matches. The resolved superset is forwarded only in the transient input. The committed event, `eventIdentity`, `deliveryIdentity` and the ledger are unchanged, and the refusal message is kept.
   - memory.ts:35: `phone` evidence covers `phone_digits`, and withdrawal precedence is unchanged.
   - Tests:
     - A legacy `{email, phone}` commit dispatches once with all five keys.
     - A changed digest or a missing key refuses.
     - The phone/phone_digits alias works, email-only does not cover it, and withdrawal wins.
2. web-events storage of the UA/URL pair (FIX 2): FIXED.
   - `contextPair` (rules.ts:94-100) stores the UA and the query/fragment-free origin+path only as a pair, each ≤1024 characters.
   - `canonicalClicks` and the replay digest include both keys.
   - The types.ts doc line is corrected. There is no migration, and purge clears the map.
   - Port-suite covers: the pair is stored and replayed, a changed UA conflicts, a lone UA is not stored, and purge clears the pair.
3. Capture + allowlist + enrichment (FIXES 1, 3): FIXED.
   - A browser-supplied `client_user_agent` gets 400 through the `landingSchema` omit.
   - The server reads the `user-agent` header, trims it, and keeps it only at 1..1024 characters. This happens inside `landingProperties`, i.e. after the `/c` consent gate.
   - The collection allowlist is derived from the schema keys, so `client_user_agent` is included.
   - `withWebsiteContext` (identity.ts:99-115) reads ≤10 touches from the last 30 days, newest first, and takes the first touch with both keys. It adds the raw values plus their `destinationIdentifierHash` digests. Contacts denial/failure paths are untouched.
   - The ingress-worker test covers: ungranted gets 403; a spoofed UA gets 400; only the pair lands in `web_touch` and nothing in `web_event`; enrichment works after binding; an unbound subject is unchanged; erasure clears the map and enrichment afterwards adds nothing.
4. Typechecks: FIXED. R2 re-ran measure, web-events and server: all pass.

Outside lane: none. `features/web-events/tests/adapters.test.ts` was locked but not needed, because port-suite runs on both adapters.

New:
- [MAJOR, inherited, fixed via consent-banner] public.ts:183-189: UA capture is only as consent-first as the `/c` gate.
  - With `regionMode: 'auto'`, a `jini_region=us` cookie alone opens that gate, so OM stores UA + URL + click IDs without any consent choice.
  - No separate fix here. Consent-banner Small fixes 1-4 close it.
- [MINOR] identity.ts:99-115: enrichment ignores later visitor withdrawal.
  - Failure: the visitor accepts, lands (the UA/URL pair is stored), becomes a contact, and later withdraws through the Jini reopen link. Future conversion dispatches still attach the stored UA/URL until erasure or the 30-day window ends, because Jini withdrawal is not recorded per subject.
  - The destination/purpose consent from contacts still gates the dispatch.
  - FOLLOW-UP: same job as consent-banner OWNER DECISION 4.
- [MINOR] UA/URL come from the newest consented landing touch, not the converting page. Accepted per OWNER DECISION 2; noted only.
- Checked and clean:
  - No vendor names in core.
  - No caching.
  - The UA is never browser-trusted.
  - The digest key-parity check in `parseResolvedDeliveryInput` still holds, because the identifiers and digests both come from the evidence.
  - eslint passes (complexity ≤10, nesting ≤3).
  - Types are Zod-derived (`touchSchema`, `landingPropertiesSchema`).

Disputes/deferrals:
- Job item (2), a production `identifierKeys` writer: DISPUTED-OK per review CUT 1, because no production writer exists. Only the memory double changes.
- Capture on a form submit without a consented touch: DEFERRED-OK.
- Builder's baseline failure attribution: accepted. The same 3 `ingress-worker` failures also fail on the untouched copy. The new UA test passes.

Typecheck: measure, web-events and server PASS (R2). Tests (R2):
- measure 419/419;
- web-events 111/111;
- ingress-worker: the UA test passes (62/65 overall; the 3 failures are the baseline ones).

Small fixes: none in this lane. Consent-banner Small fixes 1-4 must land before this job's consent guarantee holds.
