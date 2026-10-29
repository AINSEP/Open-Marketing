# Trim review: 2026-10-29-w22-gate-minors
VERDICT: APPROVED WITH CUTS

Every item below was checked against the current code on 10-29. Items 1-8 and 10 are real. Item 9 is stale: the DISPUTED claim is upheld. Coordinator items 11 and 12 (coordinator-note.md wins over the plan) are real and added.

CUTS:
1. Item 2: cut the edits to features/jobs/src/service.ts, features/jobs/src/types.ts and features/jobs/src/outbox.ts, plus the outbox.test.ts fixture changes. The bug is on one side only.
   - handlers.ts:95 returns the claim handler's Outcome unchanged. A handler that acts and resolves `{ok:true,value:null}` therefore looks identical to "no claim handler" (handlers.ts:94).
   - service.ts:71 already maps only `value === null` to null. Every other outcome goes to the durable readback and returns a ProcessResult.
   - outbox.ts:57 already treats only null as "use the transport". OutboxPorts.dispatchClaim (types.ts:102) returns `ProcessResult | null`, and a ProcessResult is never null.
   - So wrapping in handlers.ts alone fixes the bug. The "unwrap" side already exists: service.ts ignores the value and reads durable state. No envelope type is needed on the outbox side.
2. Item 2 test: cut the new shared service-suite case over memory and SQL repositories (service-suite.ts). Replace it with one case in features/jobs/tests/handlers.test.ts (see APPROVED SCOPE 1). That case fails before the fix.
3. Item 5: cut the new coverage-label assertions in apps/server/tests/om-tools.test.ts. This is a metadata label change and needs no test.
4. Item 8: cut "extend existing receipt/error cases". Change only the one real-factory observer expectation, `"ok"` → `"published"` (tests/capabilities.test.ts:127). That expectation already fails before the fix.
5. Item 1: cut "zero credential accesses" as a new requirement. It is not new: the existing unadmitted branch already asserts `f.accesses` is empty (agent-plugin-backends.test.ts:893). Reuse that branch; don't write a new assertion block.
6. Typecheck list: cut the separate brand typecheck. The only brand change is an export line, and the server typecheck compiles it, because brand's package.json `types` points at ./index.ts. Don't run the studio typecheck either (typecheck.txt lists it), since no studio file changes.
7. NEEDS: cut the "LANE EXTENSION: ports.ts, service.ts, types.ts" line. Only ports.ts remains, and it sits inside the features/jobs lane (paths.txt).

FIXES:
1. Item 2, handlers.ts:89-95: inside `work`, await `handleClaim(...)` and return `result.ok ? { ok: true, value: { settled: result.value } } : result`. Change the declared return types at handlers.ts:89 and ports.ts:28 to `Promise<Outcome<{ readonly settled: unknown } | null>>`. Update the ports.ts:27 doc to say: "null means no claim handler; a handler's own result is always wrapped". Leave service.ts and outbox.ts untouched.
2. Item 11 (coordinator), apps/server/src/inbound/owner.ts:325:
   - Today every failed `uploadImage` maps to "Image upload unavailable". That includes a non-image file: import-adapter.ts:91 returns `invalid_input` "Unsupported image format". It also includes over-limit decodes: image-inspection.ts:35/:66 and blob-adapter.ts:22 return `limit_exceeded`.
   - Fix: keep `code: asset.error.code`. Pass `asset.error.message` through only when the code is `invalid_input` or `limit_exceeded`. Every other code keeps the fixed "Image upload unavailable".
   - Those media-library messages are fixed OM strings with no filename or upstream text: boundary.ts:22-27 and contracts parseBoundary "Boundary validation failed". The "fixed failures" doc at owner.ts:314 still holds.
   - uploadAttachment is at about 7 cognitive complexity now; keep it ≤10. Prefer a module-level `Set` of the two codes plus one conditional, with no nested ternary.
3. Item 12 (coordinator), apps/server/tests/p1-alerts.test.ts (pacing postcheck small fix 2):
   - In `evidenceFixture` (:217-218), APPEND `{ id: 'binding-foreign', scope: context.scope, connectionId: 'connection-foreign', externalAccountId: 'account-foreign' }` to `bindings`. Insert no own-scope row; the only `connection-foreign` row stays the foreign-owner row at :225-227. Appending keeps the indexes of `f.bindings[0]` and `f.bindings[1]`.
   - In the join test (:250-251), return the foreign binding in the second page, `{ items: [f.bindings[1]!, f.bindings[2]!], cursor: null }`. Keep `expect(f.invokeCapability).toHaveBeenCalledTimes(1)` and the existing counts.
   - Before saving, read the other `evidenceFixture` tests (:276, :287, :303). They use the default mock, which returns every binding, so confirm their counts are unaffected because a foreign binding is skipped by the join.
   - If any count would change, add the foreign binding only inside the join test's mock instead, and record that in progress.md.
4. Item 6, alerts/rules.ts:75: `return left.campaign.vendorCampaignId < right.campaign.vendorCampaignId ? -1 : left.campaign.vendorCampaignId > right.campaign.vendorCampaignId ? 1 : 0;` is fine. Plain `< ? -1 : 1` is also fine, because the IDs are unique. Keep the sort comparator's complexity small.
   - Regression test in weekly-report.test.ts: two campaigns with tied spend and IDs 'a' and 'Z'. Expect 'Z' first: by code point 'Z'(90) < 'a'(97), while ICU localeCompare puts 'a' first, so the test fails before the fix.
5. Item 7, tracking.ts:37:
   - Change to `if (!required.host && parsed.value.campaignKeys?.length)`. The `required.host!` at :67 is then still only reached with a host present.
   - In p1-tracking.test.ts:92-93, the missing-host case becomes two checks: no keys and no host returns ok with a source, and `campaignKeys: [key]` with no host returns `unavailable`, with no accounts lookup or invoke.
6. Item 7, identity.ts:80: import `landingPropertiesSchema` from '@open-marketing/web-events' (exported via index.ts:3 → src/types.ts:8). Use `Object.keys(landingPropertiesSchema.shape)` once, as a module-level const.
   - It holds the same 11 keys as today's hand list, so behaviour is unchanged.
   - Keep the `subjectId === undefined` restriction and the consent-gate code around it.
7. Item 4: the om-tools.ts:762 `revision` becomes `revisionNumberSchema`, and :764 `expectedRevision` becomes `expectedRevisionSchema`.
   - Both are JSON-schema equivalent: epochSchema (contracts values/index.ts:4) is int, ≥0 and ≤MAX_SAFE, so `.min(1)` and `.max(MAX_SAFE-1)` match today's declarations exactly.
   - Keep the 60 KiB refine.

REUSE:
- Claim/no-claim distinction → the existing null check in service.ts:71 and outbox.ts:57 (unchanged). No new envelope type.
- Validator regression → the existing `it.each` at agent-plugin-backends.test.ts:862. Add an `effects` tuple member; the production refusal is already at agent-plugin-backends.ts:567.
- Brand revision schemas → features/brand/src/schemas.ts:7-8.
- Tracking allowlist → `landingPropertiesSchema` (features/web-events/src/types.ts:8).
- Upload refusal reasons → media-library's existing fixed messages (import-adapter.ts:91, image-inspection.ts:35/:66, blob-adapter.ts:22).
- Upsert SQL → one module-local const string in alerts/provider-settings.ts, used at both :104-109 sites. Keep the transaction and the omitted/null semantics.
- GBP fingerprint → `shasum -a 256 .../src/posts.ts` (current value 0cc41314… matches both plugin.json:91 and capabilities.json:10).

DUPLICATES:
- The plan adds no new mechanism; every item is an edit to existing code.
- Claim/outbox fencing: published rc.2 has none. `beginDispatch`, `dispatchClaim` and `handleClaim` are absent from every node_modules/.pnpm/@jini-ai+*0.6.15-rc.2* dist. The fenced outbox exists only in source: ai-traces-jini packages/infra/dist/events/outbox/{ports,in-memory-fenced}.d.ts, which is rc.3. The OM seam stays (its TODO(R1) is at types.ts:100). The fix is three lines in existing OM code, so no JINI ASK beyond the one already pending (outbox fencing, ctx "COMING IN JINI 0.6.15").
- The weekly unavailable-report state, the code-point compare, the schema exports, the upload message and the SQL constant are all OM-specific: none found in Jini rc.2 or in Tovu.

OWNER DECISIONS (defaults):
1. Item 6 tail (a permanent weekly read failure silently skips the week): DEFERRED, and the plan's deferral is upheld.
   - weeklyReportSchema (rules.ts:38-46) requires currency and timezone, which a failed read cannot supply.
   - Surfacing the gap needs a new alert-candidate variant plus a Studio projection, plus a classification change in composition/workers.ts:107, which is in the w20-workers lock.
   - The original postcheck (w18-p3-weekly-report :30) already called this "an owner/P1-5 decision, not a small fix".
   - Default: keep the plan's FOLLOW-UP NEEDS line.
2. Item 9 (LinkedIn): DISPUTED, and the dispute is upheld. Every import in dispatch.test.ts:1-5 is used: `LinkedInInvocation` at :252/:291 and `dispatchSuite` at :7. All other names occur 2 or more times. No LinkedIn edit.

APPROVED SCOPE for B1 (priority order; keep progress.md in the job dir; NO tests, builds, om:check or installs):
1. Item 2 (jobs claim null):
   - handlers.ts:89-95 wrap as in FIXES 1, and ports.ts:27-28 type/doc.
   - Regression in features/jobs/tests/handlers.test.ts: register a handler whose `handleClaim` resolves `{ ok: true, value: null }`, then `dispatchClaim` → `{ ok: true, value: { settled: null } }`, and `handle` must not be called. A handler without `handleClaim` must still return `{ ok: true, value: null }`.
2. Item 11 (coordinator): owner.ts:325 per FIXES 2. Add one case in apps/server/tests/owner-api.test.ts near :255:
   - an upload mock rejecting `invalid_input` "Unsupported image format" → the response error message equals it, with status 400;
   - a mock rejecting `unavailable` with any message → the message stays "Image upload unavailable".
3. Item 1: extend agent-plugin-backends.test.ts:862's `it.each` with a row of an admitted validator and `effects: ['read','write']`. That row takes the refused branch: forbidden "Campaign validation unavailable", `f.calls` and `f.accesses` both empty. Test only.
4. Item 7: tracking.ts:37 guard plus the p1-tracking.test.ts:92-93 change (FIXES 5); identity.ts:80 allowlist from the schema (FIXES 6).
5. Item 6:
   - rules.ts:75 code-point compare plus the 'Z'/'a' regression in weekly-report.test.ts (FIXES 4);
   - delete alerts/index.ts:4-5, the unused `weeklyReportSchema`, `weeklyReportCandidate` and `WeeklyReport` re-exports. There are no consumers: weekly-report.test.ts imports rules.js directly.
6. Item 12 (coordinator): the p1-alerts.test.ts foreign binding, per FIXES 3.
7. Item 8:
   - GBP posts.ts:30 `outcome: result.ok ? result.value.status : result.error.code`;
   - recompute the sha256 and update plugin.json:91 and capabilities.json:10;
   - capabilities.test.ts:127 `"ok"` → `"published"`.
8. Item 4: features/brand/index.ts exports `revisionNumberSchema` and `expectedRevisionSchema`; om-tools.ts:37 imports them, and :762-764 uses them (FIXES 7).
9. Item 5: om-tool-coverage.ts:147 adds `'om_leads_list', 'om_leads_set_stage'` with Studio label 'Activity inbox and chat via execute_tool', keeping 'Measure setup and chat via execute_tool' for the two tracking tools.
   - Use one small lookup: tool name → Studio label, with default 'chat via execute_tool'. Do not add a second ternary to `catalogRow`.
10. Item 3: paid-sending.ts:47/:50/:65, rename only `admitted`'s string param `write` → `operation`. Keep the boolean `write` flags. Leave `reserve` alone.
11. Item 10: one module-local upsert SQL const in alerts/provider-settings.ts for :104-109. No behaviour change and no test.
12. End: run each typecheck ONCE, sequentially, with one corrective rerun allowed: `corepack pnpm --filter @open-marketing/jobs typecheck`, then safety, then server, then the GBP package typecheck if it has one. Don't run brand or studio. Report net lines added and removed.

NEEDS (carry from the plan, trimmed):
- COORDINATOR: rebuild the google-business-profile plugin dist after the posts.ts and fingerprint changes.
- FOLLOW-UP (owner/P1-5): an unavailable-week representation for permanent weekly read failures (server alerts + workers.ts classification + Studio, keeping HTTP, om-tool and CLI visibility).

Size: about 20 files, roughly +40/−25 lines in production and metadata and +40-60 in tests. That fits comfortably in one ≤90-minute run.

LOCKS-FILES: features/jobs/src/handlers.ts, features/jobs/src/ports.ts, features/jobs/tests/handlers.test.ts, apps/server/src/inbound/owner.ts, apps/server/tests/owner-api.test.ts, apps/server/tests/agent-plugin-backends.test.ts, apps/server/src/composition/tracking.ts, apps/server/src/composition/identity.ts, apps/server/tests/p1-tracking.test.ts, apps/server/src/alerts/rules.ts, apps/server/src/alerts/index.ts, apps/server/src/alerts/provider-settings.ts, apps/server/tests/weekly-report.test.ts, apps/server/tests/p1-alerts.test.ts, content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/src/posts.ts, content/agent-plugins/google-business-profile/plugin.json, content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/capabilities.json, content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/tests/capabilities.test.ts, features/brand/index.ts, apps/server/src/om-tools.ts, apps/server/src/om-tool-coverage.ts, features/safety/src/paid-sending.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-gate-minors/progress.md (lock groups: w14-alerts, w13-server-composition, w15-backends, w13-om-tools, w14-surface, w22-brand, w22-gbp, w22-jobs, w22-safety)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted (weekly failed-read tail DEFERRED). Items 11 + 12 in scope as reviewed.
