### 2026-10-29-w22-google-multiad-leadforms: verdict READY TO COMMIT (after Coordinator dist rebuild)

All paths below are under content/agent-plugins/google-ads/io.github.ainsep.openmarketing/ unless stated otherwise.

Ledger (checked against the code):
1. schemas.ts `additionalAds`: FIXED.
   - src/schemas.ts:6-8 define `headlines`, `descriptions` and `finalUrl` once. They are reused for the root (:24) and for `additionalAds` min 1 / max 2, optional (:25).
   - Zod's `toJSONSchema` inlines reused schemas by default, so the comment's "no refs" (:28-29) holds.
2. campaign-translation.ts: FIXED.
   - The guard is `ads.length > 3` → not_implemented, placed before the resolved parse (:45).
   - `additionalCreatives` was added to `resolvedSchema` (:32, optional :35) and to the `Resolved` type (:23).
   - The single helper `additionalAds` (:86-97) does count equality, then an exactly-one match per creativeId, with the URL taken from intent (:94). It returns `undefined` for a single ad, so the key is omitted (:77).
   - translateSearch scores 6 (sonarjs 3.0.5 counts no `||`) and translateCampaign was not raised.
3. rules.ts and mapping.ts: FIXED.
   - rules.ts:38-43 runs the duplicate and URL checks per ad over `[plan, ...additionalAds]`.
   - mapping.ts:28 maps each ad to the same `adGroupAdOperation` literal as HEAD (HEAD mapping.ts:23, root first), so the singleton body is unchanged.
4. readback.ts: FIXED.
   - It accepts 1-3 RSAs (:129).
   - `projectAds` (:164-178) builds the root from ads[0], adds `additionalAds` only when there is more than one ad, and lists every ad in childIds and childStatuses.
   - `planDigest` (:202-210): the singleton branch is the HEAD expression byte for byte (HEAD readback.ts:115). The multi-ad branch normalizes records and sorts them.
5. fixture.ts and helpers: FIXED.
   - src/fixture.ts:46 maps partial to `ads=[]`, :65-67 pushes ad ids 401+ and matches by `~id`, and :128 returns one row per ad.
   - tests/helpers.ts:70-74 builds the ACK per operation (`adGroupAds/301~401..`).
6. Tests (written, not run): FIXED.
   - tests/campaign-translation.test.ts: 2-ad per-URL case (:74-78), conflict rows (:84-89), invalid later URL or copy (:100-105), 4 ads → not_implemented (:71), singleton has no key (:53).
   - tests/campaign-deployment.test.ts:
     - 3-ad atomic PAUSED deploy (:24-43)
     - leads multi-ad (:45-53)
     - reversed readback (:55-67)
     - URL drift (:80)
     - status for all ads (:93)
     - singleton goldens (:310-314)
     - multi-ad row in the validate loop (:420)
7. Fingerprints: FIXED. The current sha256 of src/schemas.ts (`cd0de4d6…167d`) appears 12 times across the JSON manifests (plugin.json ×4, capabilities.json ×4, 4 bindings ×1) and once in HANDOFF.md. The old `cd4c3239` has no hits left.
8. HANDOFF.md: FIXED. The W22 section is 5 lines: the supported subset, v26 MutateGoogleAdsRequest/RSA/3-RSA citations, lead forms DEFERRED, and "leads stay in Google".
9. progress.md and typecheck: FIXED. B1 reports PASS, first run.
- COORDINATOR OVERRIDE 1 (lead forms DEFERRED until a contract field exists): honoured. There is no lead-form code; the exact contract text is recorded in progress.md.

Outside lane: none. The file_change log has only lane files; the JSON fingerprint rows are in lane per LOCKS.

New:
- [MINOR] tests/campaign-deployment.test.ts:310-314. The three golden hashes were computed by a Python transcription of the JS expressions (progress.md:20), not by executing the code. Failure: if the cloud test run fails only on these goldens, suspect the Python transcription first (JSON.stringify spacing or number format, or `digest` canonicalization). The singleton source paths are verified identical to HEAD (readback.ts:203 ≡ HEAD:115; mapping.ts:28 ≡ HEAD:23 for one ad). Fix: if they fail, regenerate the goldens from HEAD-code output. Do not change the source.
- [MINOR, informational] The multi-ad digest sorts by `JSON.stringify(...).localeCompare` (readback.ts:209), as the existing keyword sort already does. Ordering is ICU-collation based, not byte order. That is deterministic within one runtime, so no action.
- Complexity: I checked against the eslint-plugin-sonarjs 3.0.5 rule, which scores nested callbacks separately and ignores `||`/`??`. Scores: fixture `applyOperation` 5, `projectAds` 1 (its callback 2), `planDigest` 1, `additionalAds` 5, `validatePlan` ≤8. No breach.
- No vendor names in core, no secrets and no caching.

Disputes/deferrals:
- Lead forms: DEFERRED-OK (override; the contract has no form fields, so the content would bypass the exact approval card).
- Server production `additionalCreatives` resolution and HTTP/om-tool/CLI/Studio closure: DEFERRED-OK (outside lane, NEEDS).

Typecheck: B1 reports PASS for `--dir content/agent-plugins/google-ads`. Nothing to fix.

Duplicates: none. Published rc.2 dist has no hits for `responsiveSearchAd` or `adGroupAdOperation` (re-checked with rg). Per the review, Tovu and ai-traces-jini have none either.

Net lines: +261/−52 (net +209), per B1. That is plausible for 6 source files plus about 120 lines of tests.

Small fixes: none required. NEEDS:
1. The Coordinator rebuilds the google-ads dist.
2. Server work: the sandbox fixture and production resolution supply `additionalCreatives` for ads[1..2], then close HTTP, om-tool, CLI and Studio for multi-ad.
