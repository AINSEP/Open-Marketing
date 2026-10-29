### 2026-10-29-w22-conversion-settings: verdict SMALL FIXES (4: 1 production complexity fix, 3 test-only)

Reviewer R1, 2026-10-29. Checked against the current tree: the work is committed in 7fbfbd3..dd7bf32, and HEAD is now ca2d393.
- B1's BLOCKER (missing public barrel exports) is resolved. Coordinator commit 3a0c07a added the exact two lines to packages/contracts/src/index.ts:25-26.
- apps/studio/src/pages/addons/** and apps/studio/tests/addons.test.ts have unrelated in-progress edits in the working tree. So tests were run on a private copy of HEAD with those edits removed, the scratchpad `r1head` copy.

Ledger:
1. Precondition, contracts: FIXED. The schemas are at packages/contracts/src/addons/index.ts:210-218, exactly the NEEDS text. The barrel was landed by the coordinator, and the contracts typecheck exits 0.
2. Manifest declarations: FIXED.
   - google-ads, meta-ads and tiktok-ads plugin.json:9-11 match FIX 7 names, kinds and formats.
   - The real Jini rc.2 `parseAgentPluginManifest` accepts all three (checked).
   - The TikTok strict test schema accepts the key (manifests.test.ts:12).
   - That suite's only failure is the conversion `schemaFingerprint` row (manifests.test.ts:40), which is coordinator-owned under OVERRIDE 4.
3. integration-credential-cards.ts: separate `safeParse` with null on an invalid declaration: FIXED (:31-32, :40).
4. integrations.ts read/set/merge: FIXED.
   - `conversionSettings` :168-178.
   - `setConversionSettings` :182-199: owner check first, then strict per-declaration values, the 4 KiB check, and the upsert.
   - `withConversionSettings` :206-211: invalid input leaves metadata unchanged and never returns null.
5. composition/addons.ts: one merge call on the returned metadata: FIXED (:168).
6. Surfaces: PARTIAL.
   - All are present: HTTP GET/POST (inbound/integrations.ts:23-27, :54-57), cli/http.ts:41-42, the om-tools.ts:715-725 serviceDefinition pair, coverage rows, addon-tools.ts:13 Pick, and cli/addons.ts:122/:155/:295-306. CLI suite: 78/78 pass.
   - But `handleIntegrationRequest` is now at cognitive 11 (see New).
7. Studio: FIXED. The pieces are `useConversionSettings`, `ConversionSettingsForm` with a textarea for maps, http/sample/types methods, and no `data-private`.
8. Tests: PARTIAL. Four of the written tests fail; three are this job's own fixture or assertion defects:
   - integrations.test.ts:786 "isolates bad conversion declarations…" uses an invalid card fixture: `saveKind 'api-key'` without a password field gives "Token requires a password field". That makes `parseCredentialCardManifest` fail, so the test never reaches its assertions. Small fix 2.
   - om-tools.test.ts:1652 `expect(writes).toEqual([owner, owner])`. The approved continuation context also carries `runId: 'run'`; production is correct and the assertion is too strict. Small fix 3.
   - studio addons.test.ts:472/:481 query the accessible name 'Definition targets'. The label wraps the hint span, so the accessible name is "Definition targets One key=value per line". The form does render. Small fix 4.
   - addons.test.ts:650 "merges scoped conversion settings…" fails at `f.binding.start()` with "Invalid bundled plugin manifest" (Jini manifest parser rejects the fixture). The existing "seeds enabled model-only data…" tests fail the same way, so this is a pre-existing fixture problem and is under FOLLOW-UP.
   - With small fixes 2-4 applied on the HEAD copy, each fixed test passes. integrations.test.ts is then 48/50; the remaining 2 are the pre-existing OAuth `helpUrl` cases (FOLLOW-UP).
9. Typecheck: FIXED. server exits 0. studio fails only in tests/message-composer.test.tsx, which belongs to the w22-sms-composer job.
- OVERRIDES 1-4: honoured. The TikTok fingerprint rows are untouched, and the studio section renders no grants.

Outside lane: packages/contracts/src/addons/index.ts is authorized by OVERRIDE 2. The barrel was applied by the coordinator, not this job. No others were found.

New:
- [MAJOR, complexity gate] apps/server/src/inbound/integrations.ts:16 `handleIntegrationRequest` is at cognitive 11 > 10 (ESLint sonarjs error, so om:lint fails). The cause is the inline POST case at :24-27: the ternary inside the switch adds +2. Fix: small fix 1. Verified on the HEAD copy: ESLint clean, tsc exit 0, integrations suite unchanged.
- [MINOR, no fix now] integrations.hooks.ts:364-374 omits blank fields, while integrations.ts:143-148 builds a `z.strictObject` that requires every declared field.
  - Failure: for a multi-field declaration, clearing one field gives `invalid_input`.
  - Today every manifest declares exactly one field, so there is no live failure. FOLLOW-UP.
- [MINOR, no fix now] The `conversionSettings` declaration key is not in agent-plugin-backends.ts `hostOwned`, so it flows into every plugin's `settings`. It is harmless because the plugins use `z.object` (google conversions.ts:9, meta capi.ts:14, tiktok events.ts:17). FOLLOW-UP, outside this lane.
- [MINOR] `decimal-id` accepts up to 128 digits, while plugins require ≤19 (google) or vendorIdSchema. A too-long value saves, then fails closed at delivery. Acceptable under FIX 1's fail-closed point.

Disputes/deferrals:
- B1's "public barrel outside the file list" was a valid execution-scope stop, and the coordinator resolved it.
- Installed-copy refresh NEEDS and the JINI ASK are carried.

Typecheck: B1 reported server and studio at EXIT 2 (barrel). Re-run now: server exit 0; studio errors only in another job's message-composer test; contracts exit 0.

Small fixes:
1. apps/server/src/inbound/integrations.ts:24-27.
   - Old:
     ```
             case 'POST /api/addons/v1/integrations/conversion-settings': {
                 const body = await readBody(required);
                 return respond({ outcome: body.ok ? await required.integrations.setConversionSettings({ context: required.context, request: body.value }, { signal: required.request.signal }) : body });
             }
     ```
   - New:
     `        case 'POST /api/addons/v1/integrations/conversion-settings': return setConversionSettings(required);`
   - Then insert this immediately before `/** Binary icon delivery only; specimens are never executed. CSP also confines direct SVG views. */` (now :59):
     ```
     /** Owner replacement; the body is read only after the owner check in handleIntegrationRequest. */
     async function setConversionSettings(required: IntegrationInput): Promise<HttpResponse> {
         const body = await readBody(required);
         return respond({ outcome: body.ok ? await required.integrations.setConversionSettings({ context: required.context, request: body.value }, { signal: required.request.signal }) : body });
     }

     ```
2. apps/server/tests/integrations.test.ts:791.
   - Old: `credentialCards: [{ ...fixtureCard, saveKind: 'api-key', secretFields: [{ name: 'token', label: 'Token' }] }], conversionSettings: { fields: 'invalid' }`
   - New: `credentialCards: [secretCards[0]], conversionSettings: { fields: 'invalid' }`
   - `secretCards` is defined at :550.
3. apps/server/tests/om-tools.test.ts:1652.
   - Old: `        expect(writes).toEqual([owner, owner]);`
   - New: `        expect(writes).toEqual([expect.objectContaining(owner), expect.objectContaining(owner)]);`
4. apps/studio/tests/addons.test.ts:472 and :481 (re-read first: the file has concurrent edits).
   - Old, both lines: `{ name: 'Definition targets' }`
   - New: `{ name: /^Definition targets/ }`

FOLLOW-UP:
- apps/server/tests/addons.test.ts: the bundled-fixture manifests are rejected by Jini `parseAgentPluginManifest`. This fails the "seeds enabled model-only data…" cases and this job's merge test (:650).
- integrations.test.ts:38 "rejects credential-bearing card URLs using key/apiKey" fails with a generic message instead of "Invalid credential card or asset". This is the OAuth status path and pre-existing.
- tiktok-ads manifests.test.ts:40: conversion `schemaFingerprint` 8646…→2fa7… is coordinator-owned (OVERRIDE 4).
- Studio addons.test.ts OAuth cases fail with "multiple role=alert" from the ConversionGrants mount (w22-grant-surfaces).
- Add `conversionSettings` to `hostOwned` in agent-plugin-backends.ts.
- Decide whether blank declared fields may be omitted in multi-field declarations.
- NEEDS carried: rebuild the contracts dist; refresh the installed google/meta/tiktok workspace copies so the declarations appear.
