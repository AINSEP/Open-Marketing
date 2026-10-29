### 2026-10-29-w22-gate-minors: verdict READY TO COMMIT (already committed; no fixes needed)

Reviewer R1, 2026-10-29. Checked against the current tree: the work is committed in 7fbfbd3..dd7bf32, and HEAD is now ca2d393. Several of this job's files (composition/tracking.ts, identity.ts, alerts/**) have unrelated in-progress edits in the working tree. So tests were run on a private copy of HEAD with those edits removed, the scratchpad `r1head` copy.

Ledger:
1. Item 2, jobs claim null: FIXED.
   - features/jobs/src/handlers.ts:89-98 wraps a handler result as `{ settled }`; ports.ts:27-28 has the type and doc.
   - service.ts and outbox.ts are untouched, as CUT 1 required.
   - The regression is handlers.test.ts:13-27. handlers.test.ts: 8/8 pass.
2. Item 11, upload refusal reason: FIXED. owner.ts:54 holds a module-level `Set` and :326-327 has one conditional. owner-api upload cases pass (4/4).
3. Item 1, validator `['read','write']` row: FIXED (agent-plugin-backends.test.ts:862, 4/4 pass).
4. Item 7, tracking + identity: FIXED.
   - The tracking.ts:37 guard is in.
   - identity.ts:21 uses `Object.keys(landingPropertiesSchema.shape)`.
   - p1-tracking.test.ts passes.
5. Item 6, code-point compare + index re-exports: FIXED.
   - alerts/rules.ts:75 uses code-point order.
   - The 'Z'/'a' regression is weekly-report.test.ts:64-65.
   - The unused weekly re-exports are gone from alerts/index.ts.
   - weekly-report.test.ts passes.
6. Item 12, p1-alerts foreign binding: FIXED. p1-alerts.test.ts:226 appends it and :250-251 pages it; the test passes with `invokeCapability` called once.
7. Item 8, GBP observer outcome + fingerprint + test: FIXED.
   - posts.ts:30 is in.
   - The sha256 of posts.ts is f30eb215…0432. It equals plugin.json:91 and capabilities.json:10.
   - capabilities.test.ts:127 now expects "published"; 37/37 pass.
8. Item 4, brand revision schemas: FIXED. features/brand/index.ts:2 exports them; om-tools.ts:40 and :783-785 use them.
9. Item 5, lead tool labels: FIXED. om-tool-coverage.ts:160-176 has one lookup map with the default 'chat via execute_tool'.
10. Item 3, rename `write`→`operation` in `admitted`: FIXED (paid-sending.ts:47/:50/:65 region); `reserve` is untouched.
11. Item 10, one upsert SQL const: FIXED (alerts/provider-settings.ts:14-15, used at :106/:108).
12. Typechecks: FIXED. jobs, safety, server and GBP all exit 0 now.
- Weekly permanent-read-failure tail: DEFERRED-OK (OWNER DECISION 1 and the override).
- Item 9 (LinkedIn unused imports): DISPUTED, and the dispute is upheld.

Outside lane: none found. The final file list in progress.md matches LOCKS-FILES; ports.ts is inside the jobs lane.

New: none.
- Complexity: ESLint (sonarjs cognitive ≤10, max-depth, om rules) on every production file of this job reports no errors.
- No secrets are echoed: the upload messages are the fixed media-library strings.

Disputes/deferrals: both are upheld, as listed above.

Typecheck: B1 reported jobs, safety, server and GBP PASS. They were re-run now and all exit 0.

Small fixes: none.

FOLLOW-UP (not this job):
- owner-api.test.ts "freezes canonical refs and resolves only the current run images" fails: the attachment name is `caller-name.png` where `canonical.png` is expected. This is the chat-attachments lane.
- owner-api.test.ts "real boot serves studio…" fails with "Sandbox agent did not become ready" (environment).
- apps/studio/src/shared/api/http.ts:98 `request` is at cognitive 11 (`rawBody` branches, attachments lane).
- NEEDS carried: rebuild the GBP plugin dist; the unavailable-week representation remains for owner/P1-5.
