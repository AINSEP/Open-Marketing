# Trim review: 2026-10-29-w22-google-multiad-leadforms
VERDICT: APPROVED WITH CUTS

Checked against current code (no coordinator-note.md present):
- The contract already carries multiple ads, each with its own creativeId and destinationUrl (max 20, unique IDs), plus a single creativeDigest: packages/contracts/src/launch/index.ts:47-49. Multi-ad needs NO contracts change.
- The plugin still refuses multiple ads at campaign-translation.ts:43 (`campaign.ads.length !== 1` gives not_implemented), and readback refuses them at readback.ts:129 (`children.ads.length !== 1`). So the job is real.
- `resolved` is opaque server metadata (campaign-translation.ts:13). The server passes the sandbox fixture through unchanged (apps/server/src/composition/agent-plugin-backends.ts:541-548), so a plugin-side `additionalCreatives` needs no server edit. Server tests use single-ad fixtures (apps/server/tests/agent-plugin-backends.test.ts:881-884) and are unaffected.
- Drift and acknowledgement already compare `planDigest`: plugin.ts:109-110 and :177. A readback whose ad count or copy differs therefore already fails as a digest conflict. No new per-ad conflict checks are needed.
- validateOnly already shares `prepareCreation` → `createOperations` (hosted.ts:131-151). New ad operations are covered automatically.
- Activation and pause already iterate `hierarchy.childIds` (mapping.ts:37-51), so every `ad:` child gets status ops. validateHierarchy already enforces unique childIds and ids/statuses parity (rules.ts:65).
- The tests/helpers.ts:68-70 hosted ACK returns exactly 6 responses. plugin.ts:156 treats a length mismatch as an unknown receipt, so the helper must follow the operation count (plan item 7 is correct).
- Fingerprint: the current `schemas.ts` sha256 `cd4c3239…c38e` appears in 12 JSON rows and also in HANDOFF.md:31.
- Vendor facts:
  - Google allows a maximum of 3 enabled RSAs per ad group (support.google.com/google-ads/answer/7684791). The plan's cap of 1–3 is right.
  - The transport is on v26 (transport.ts:110-111). The plan cites v26 MutateGoogleAdsRequest (partialFailure/validateOnly) and LeadFormAsset + CampaignAsset LEAD_FORM.
- Lead forms: the contract has no form-content fields (business name, headline, description, privacy URL, fields), and OM has no intake endpoint. Content taken from `resolved` would bypass the exact approval card, because the card shows only the intent. DEFER + NEEDS is the correct and allowed path (job: "build only what the current contract allows").

CUTS:
1. Readback "verify group membership" plus "unique ID / explicit status" checks (plan §4.5). Ads are read with `WHERE campaign.id = …`, and readback already requires exactly one group (readback.ts:129). The hierarchySchema status enum (schemas.ts:51-52), validateHierarchy uniqueness (rules.ts:65) and the planSchema parse of each ad's copy/URL already cover the rest. Readback only maps 1–3 ad rows into root + `additionalAds` and parses. Drop the "wrong-group" and "duplicate-ID" regression tests too.
2. "two/three creatives across objectives" (plan §4.8). Multi-ad is objective-independent: the objective only changes bidding and goal ops. Use one traffic multi-ad translation test and one leads multi-ad deploy case (item 4 in scope); no per-objective loop.
3. Separate readback drift tests for "missing/extra ad" and "changed copy/URL/status". The existing digest conflict path covers them. Keep ONE drift test: readback with one ad's URL changed gives conflict via plugin.ts:109-110.
4. A new validate test (plan §4.9). Instead add one `["multi-ad traffic", multiAdPlan]` row to the existing parameterized validate loop at tests/campaign-deployment.test.ts:319-343. It already asserts body equality except validateOnly, zero writes and zero checkpoints.
5. HANDOFF.md "primary sources" essay. Edit ≤10 lines:
   - the supported subset (1–3 RSAs, one ad group, per-ad destination);
   - citations (v26 MutateGoogleAdsRequest, RSA guide, 3-enabled-RSA limit);
   - the new schemas.ts fingerprint (replace HANDOFF.md:31);
   - lead forms DEFERRED, with the line "if built before OM intake exists: leads stay in Google".

FIXES:
1. schemas.ts. Define the existing RSA field schemas once (headlines `z.array(z.string().min(1).max(30)).min(3).max(15)`, descriptions `…max(90)).min(2).max(4)`, finalUrl) as local consts. Use them in both the root fields (schemas.ts:20-22) and `additionalAds: z.array(z.strictObject({ headlines, descriptions, finalUrl })).min(1).max(2).optional()`. Single-ad plans must OMIT the key; never emit `[]`. That keeps the traffic digest and body byte-identical.
2. campaign-translation.ts:
   - Replace the :43 guard with `campaign.ads.length > 3` → `failure({ code: "not_implemented", message: "Google supports at most three responsive search ads" })`, before the resolved parse.
   - Add an optional `additionalCreatives` array (1–2 items of `{ creativeId: id, headlines, descriptions }`, reusing the same JSON-schema item definitions as :29-30) to `resolvedSchema`, and add the field to the `Resolved` type.
   - Put the matching in ONE helper, `additionalAds({ campaign, resolved })`, returning `Outcome<SearchPlan["additionalAds"]>`. Its length must equal `campaign.ads.length - 1`, and each `campaign.ads[i].creativeId` (i≥1) must appear exactly once. Otherwise return `conflict` "Google creative resolution differs from intent", the same message as :50.
   - Take each URL from `campaign.ads[i].destinationUrl`.
   - translateCampaign must not gain complexity beyond the helper call; it is near the limit.
3. rules.ts:38-44. Run the existing duplicate check (headlines, descriptions) and URL check over `[root, ...(plan.additionalAds ?? [])]` with one loop or `.some`. Add no new helper unless it is needed to stay at complexity ≤10.
4. mapping.ts:28. Map `[root, ...additionalAds]` to the existing adGroupAdOperation literal. Keep the operation order (ads where the single ad is today) so the singleton body is byte-identical.
5. readback.ts:
   - In projectHierarchy (:129), allow `children.ads.length` 1–3. Build root from ads[0] and `additionalAds` from the rest, only when length > 1. Extract one `projectAds` helper so projectHierarchy stays ≤10.
   - childIds/childStatuses list every ad (`"ad:" + group.id + "~" + ad.id`).
   - In planDigest (:184-186), keep the existing expression exactly when `additionalAds` is absent. When present, digest `{ ...rest, ads: sorted([root, ...additionalAds] normalized: headlines/descriptions sorted, records sorted by canonical JSON) }` with root's headlines/descriptions/finalUrl removed. This makes ordering independent of which ad readback returns first.
6. fixture.ts:
   - Change `state.ad` to `ads: Record<string, unknown>[]` with ids "401","402","403" in creation order.
   - Match status updates by the resourceName `~id` suffix, copying the applyKeyword pattern at :85-89.
   - Map `fault: "partial"` (:46) to `state.ads = []`.
   - Return one row per ad in adRows (:122-125).
7. tests/helpers.ts:68-70. Build the ACK from the request's `mutateOperations`: kind = the operation key with "Operation" replaced by "Result". Paths: the existing table for the first six, then `adGroupAds/301~402`, `~403` for extra ad ops. Singleton reference expectations stay unchanged.
8. Fingerprint. After the final schemas.ts edit, replace ALL occurrences of the old sha in the lane: 12 JSON rows plus HANDOFF.md:31. Do not touch read-capabilities fingerprints.
9. Update the existing tests that pin the old refusal instead of adding parallel ones:
   - campaign-translation.test.ts:60-67 becomes "4 ads → not_implemented before metadata read";
   - :127 stays a rejection (2 ads with no additionalCreatives = conflict); confirm it still fails closed.

REUSE:
- Creative/digest binding → campaign-translation.ts:44-50 (`resolvedSchema`, the creativeId/creativeDigest conflict check).
- Copy/URL validation → rules.ts:38-44 `validatePlan`.
- Ad operation → mapping.ts:28; status fan-out → mapping.ts:37-51 (unchanged).
- Readback/digest → readback.ts:115-163 `readChildren`/`projectHierarchy`, :184 `planDigest`, rules.ts:16 `digest`.
- Drift/ack → plugin.ts:109-110, :156, :177 (unchanged).
- validateOnly parity → hosted.ts:131-151 `validateCampaignDeployment` via `prepareCreation` (unchanged).
- Fixture id/status matching → fixture.ts:85-89 `applyKeyword` pattern.
- Validate test → tests/campaign-deployment.test.ts:319-343 parameterized loop.

DUPLICATES:
- Searched published Jini 0.6.15-rc.2 (node_modules/.pnpm/@jini-ai+*@0.6.15-rc.2*), /Users/la/Programming/tovu-integration-clones/ai-traces-jini and /Users/la/Programming/Tovu (excluding node_modules) for `responsiveSearchAd|leadFormAsset|adGroupAdOperation`: no hits.
- The digest and fixtures reuse the plugin's own `digest` (rules.ts:16). The rc.3 "canonical tool-argument digest" is source-only, so no action.
- None found; no JINI ASK.

OWNER DECISIONS (defaults):
1. Max ads per Google launch = 3 (Google's enabled-RSA limit per ad group). Launches with more than 3 are refused, never truncated or split into extra ad groups.
2. Hosted lead forms: DEFERRED until the contract carries reviewed form content (so it appears on the exact approval card) and an OM intake decision exists. Until then, record in HANDOFF that Google-hosted leads would stay in Google; OM intake requires consent before persistence (om-tracking-consent-first).
3. Root ad = `campaign.ads[0]`; `additionalAds` = the rest. Multi-ad digests are order-independent; single-ad digests are unchanged.

APPROVED SCOPE for B1:
1. schemas.ts `additionalAds` (FIX 1).
2. campaign-translation.ts: ≤3 guard plus the `additionalCreatives` matching helper (FIX 2).
3. rules.ts per-ad validation (FIX 3); mapping.ts per-ad operations (FIX 4).
4. readback.ts multi-ad projection, childIds and the order-independent multi-ad digest (FIX 5).
5. fixture.ts ads array (FIX 6); tests/helpers.ts operation-matched ACK (FIX 7).
6. Tests (written, NOT run):
   - campaign-translation.test.ts:
     - 2-ad traffic translates with per-ad URLs;
     - missing or extra `additionalCreatives` → conflict;
     - an invalid later-ad URL or duplicate headline → invalid_input;
     - 4 ads → not_implemented;
     - the singleton traffic plan has no `additionalAds` key.
   - campaign-deployment.test.ts:
     - 3-ad deploy: mutate has 3 adGroupAdOperations, all PAUSED, partialFailure false; acknowledged; childIds include 3 `ad:` entries;
     - one leads multi-ad deploy case;
     - reversed readback ad order still acknowledges;
     - one changed-URL drift → conflict;
     - activate/pause emit status ops for every ad;
     - the traffic singleton mutate body / planDigest stays byte-identical to a golden value computed from the pre-change expression;
     - the multi-ad row in the existing validate loop (CUT 4).
7. Fingerprints: 12 JSON rows plus HANDOFF.md:31 (FIX 8).
8. HANDOFF.md ≤10 lines (CUT 5).
9. progress.md in the job dir. One final `corepack pnpm --dir content/agent-plugins/google-ads typecheck` (one rerun allowed). No tests, builds or pnpm installs.

NEEDS (carry from plan, trimmed):
- INTEGRATION: Coordinator rebuilds content/agent-plugins/google-ads/io.github.ainsep.openmarketing/dist/index.mjs.
- SERVER: production creative resolution must supply `additionalCreatives: [{ creativeId, headlines, descriptions }]` for ads[1..2], and the sandbox fixture at agent-plugin-backends.ts:541 may include it. Then close HTTP + om-tool + CLI + Studio for multi-ad launch. Outside this lane.
- CONTRACTS (later lead-form job; not built now): the plan's §7 `leadForm` optional strictObject on `neutralCampaignLaunchSchema` (packages/contracts/src/launch/index.ts), with refine `leadForm === undefined || objective === "leads"`. Vendor length limits (e.g. Google business name/headline) stay in the plugin.

LOCKS-FILES: content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/campaign-translation.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/rules.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/mapping.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/readback.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/fixture.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/helpers.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-translation.test.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-deployment.test.ts, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/capabilities.json, content/agent-plugins/google-ads/plugin.json, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/search.v1.json, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/reporting.v1.json, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/stop.v1.json, content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/conversions.v1.json, content/agent-plugins/google-ads/HANDOFF.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-google-multiad-leadforms/progress.md (lock groups: w18-google)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted. Lead forms DEFERRED to a later job that first lands the leadForm contract (coordinator) so form content goes through the exact approval card.
