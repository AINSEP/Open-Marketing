# Trim review: 2026-10-29-w22-meta-postal-resolution
VERDICT: APPROVED WITH CUTS

No coordinator-note.md exists, so plan.md and job.md govern.

Vendor facts, checked 2026-10-29 against the [Targeting Search reference](https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-search/), which fetched fine this run:
- Endpoint and parameters: GET `/search` with `type=adgeolocation`, `q`, `location_types` (JSON array, so `["zip"]`), `country_code` ("limits the search to one country"), and `limit` (default 8).
- Fields on a zip row: `key` (in the form `country:zip`), `name` (the zip), `type` = `zip`, `country_code`, `country_name`, `region`/`region_id`, `primary_city`/`primary_city_id`, `supports_region`, `supports_city`.
- Example from the docs: `{"key":"US:90028","name":"90028","type":"zip","country_code":"US"}`.
- The API version stays at v26.0 (`adsGraphVersion`, src/instagram-fetch.ts:9).

Finding: the postal path is real. The job text says "literal key". In fact, src/campaign-translation.ts:21 and :64-67 trust the `resolved.postalCodes` mappings the caller supplies and only check their prefix. No Meta lookup exists today.

CUTS:
1. Plan §4.1, "reuse the canonical launch schema to enforce bounded, unique postal codes and exactly one country". Drop this. The input is already a parsed `NeutralCampaignLaunch`, and packages/contracts/src/launch/index.ts:26-27 and :46 already enforce 1–200 unique trimmed codes and exactly one country for postal. Do not re-parse it in the translator.
2. Plan §4.7, "incomplete/paginated results → invalid_input". Drop the pagination refusal and ignore `paging`.
   - With `country_code` set (FIX 1) and an exact `q`, the exact row comes back on page 1.
   - If it isn't there, the result is "not found", which already fails closed.
   - Duplicate exact rows on one page still refuse as "ambiguous".
3. Plan §4.9 extra tests: drop cancellation, binding mismatch, repeated-call freshness and narrow route denial.
   - Binding mismatch is covered by `boundContext`'s existing use.
   - Per-call credentials hold by construction (instagram-fetch.ts:26-33).
   - No instagram-fetch test file exists, and none may be added.
   - Keep only the four the job names (resolved, not found, ambiguous, wrong country), plus supplied-key rejection and the request-shape/zero-POST assertions inside the resolved case. See SCOPE 4.
4. Plan §4.10 needs no catalog work. Neither edited file is hashed. I checked by running sha256 over campaign-translation.ts (93f74649…) and instagram-fetch.ts (0386177d…) and found neither digest in plugin.json or capabilities.json.
   - However, src/read-capabilities.ts IS hashed (e651d134… appears in both manifests).
   - IMPORT `boundContext` from it, but do NOT edit read-capabilities.ts.
5. No new helper module, no deadline helper, no response-reader helper. Everything new goes in campaign-translation.ts. At most ONE new private function (e.g. `resolvePostalKeys`) to keep complexity ≤10.

FIXES:
1. Send `country_code=<campaign.audience.countries[0]>` on every search (documented parameter; the plan omitted it). Full parameter set:
   - `type=adgeolocation`
   - `location_types='["zip"]'` (JSON string; `encodeRequest` stringifies values, instagram-fetch.ts:81)
   - `q=<code>`
   - `country_code=<CC>`
   - `limit=100`
2. Match rule: accept exactly one row where all of these hold, and use its `key` verbatim:
   - `type === "zip"`
   - `country_code === CC`
   - `name.trim().toUpperCase() === code.toUpperCase()`

   Keep the wrong-country check even though `country_code` filters on Meta's side (defense in depth). The row schema is `z.object` (not strict) with only `key` (1–64), `name`, `type` and `country_code` read. The envelope is `{ data: z.array(row).max(100) }`.
3. Transport allowlist (src/instagram-fetch.ts:69-80): add ONE condition. All three must be true:
   - `input.request.method === 'GET'`
   - `adsPath === '/search'`
   - effects exactly `['read']`

   Nothing else changes: auth, abort, redirect:'error', 1 MiB bound and redacted errors stay as they are.
4. Dispatch call: copy the read pattern at src/read-capabilities.ts:111-121.
   - Signal: `AbortSignal.any([AbortSignal.timeout(30000), ...optional?.signal])`.
   - `operationId`/`effect.operationId`: `context.correlationId`.
   - `effect`: `{ connectionId, accountId: configuration.accountId, effects: ["read"], argumentsDigest: digest({ value: { q, country } }), moneyExposure: null, requiredLimit: null }`.
   - `timeoutMs: 15000`.
   - Requests run sequentially, with no retry and no cache. The first failure returns at once and the partial keys are discarded.
5. Binding: on the postal path only, call these in order:
   - `createConfiguredDispatch(required.dependencies)` (instagram-fetch.ts:16)
   - then `boundContext({ binding: { scope, connectionId, accountId } from configuration, call: { context: required.context, connection: { connectionId: target.connectionId, accountId: target.accountId } } })` (read-capabilities.ts:89)

   Both run before any credential access or fetch. Country and radius paths never touch `dependencies`. The input type still requires `context` and `dependencies`, because the server always passes both.
6. Ordering in `translateCampaign` stays as at :33-38: the unsupported-intent check, then the metadata parse, then the conflicts, and only then the lookup. The existing `get resolved()` throw test must still pass.
7. Use these error messages, with no vendor body and no echo of the token or key:
   - not found: "Meta postal code not found"
   - ambiguous: "Meta postal code ambiguous"
   - malformed: "Invalid Meta targeting search response"

   All return `invalid_input`; `failure()` already sets retryable:false (boundary.ts:6-8). Transport failures pass through unchanged.

REUSE:
- Configured dispatch and fresh per-call credentials → src/instagram-fetch.ts:16 `createConfiguredDispatch`, :26 `bindDispatch`
- Route allowlist → src/instagram-fetch.ts:69-80 `encodeRequest` (extend it; don't add a parallel client)
- Scope/connection/account binding → src/read-capabilities.ts:89 `boundContext` (import only)
- Aggregate deadline + effect envelope shape → src/read-capabilities.ts:111-121 `boundedReader` pattern
- Errors/digest → src/boundary.ts `failure`, `digest`, `parse`
- Sorted zips + final plan validation → src/campaign-translation.ts:67, :41 (`campaignDeploymentPlanSchema`, campaign-deployment.ts:12)
- Fixture configuration → `pluginConfigurationSchema.parse({ scope, connectionId, accountId, pluginDigest, settings })`, as in tests/read-capabilities.test.ts:314, plus `context` from tests/fixtures.ts:13

DUPLICATES:
- Meta targeting/zip search: none found. I ran rg for `adgeolocation|location_types|targetingsearch` over these trees and got zero hits in each:
  - /Users/la/Programming/Tovu
  - /Users/la/Programming/Jini (stale)
  - /Users/la/Programming/tovu-integration-clones/ai-traces-jini
  - the installed @jini-ai/* 0.6.15-rc.2 dist
- Deadline: rc.2 does publish `createDeadlineSignal` (node_modules/.pnpm/@jini-ai+agent-plugins@0.6.15-rc.2…/node_modules/@jini-ai/platform/dist/fetch-with-timeout.d.ts:112). The meta-ads plugin, though, has no @jini-ai dependency, and its in-plugin pattern is a native one-liner (read-capabilities.ts:111). Adding a dependency for that line is not justified. Keep the one-liner. No JINI ASK.
- Bounded fetch: the plugin already has `readResponse` (instagram-fetch.ts:88), and the server injects the guarded fetch. No duplicate is added.

OWNER DECISIONS (defaults):
1. Aggregate deadline. Default: 30 s across all lookups, matching read-capabilities.ts:111. A list of near 200 codes may exceed it and refuse with `cancelled`. Record this limit in HANDOFF; do not raise it or add batching.
2. Lookup endpoint. Default: `adgeolocation` per code, as the job says. Do not use `adgeolocationmeta`, which would mean synthesizing keys.

APPROVED SCOPE for B1:
1. src/campaign-translation.ts:
   - `translateCampaign(required, optional?: CallOptions): Promise<Outcome<MetaPausedPlan>>`.
   - `CampaignTranslationInput` gains `context: CallContext` and `dependencies: PluginCapabilityDependencies`, and `target` adds `"connectionId"` to its Pick.
   - Delete `postalCodes` from `resolvedSchema` (:21), so a supplied mapping is now rejected as invalid_input by the strict schema.
   - Make `translateGeography` async. Its postal branch calls one private `resolvePostalKeys`, implementing FIX 1, 2, 4, 5 and 7.
   - Emit `{ zips }` sorted by key with no `countries` (:67 unchanged in spirit).
   - Update the JSDoc @complexity to "≤200 sequential GETs, ≤30 s, ≤1 MiB each".
   - Complexity ≤10 and nesting ≤3 per function.
2. src/instagram-fetch.ts: the single GET `/search` read condition (FIX 3). No other change.
3. tests/campaign-translation.test.ts:
   - `await` every existing call. Give `target` a `connectionId`. Add `context` and fixture `dependencies` to `input` (the fetch fails the test if it is called on country/radius paths).
   - Replace the supplied-mapping postal test (:54-75) with the cases below.
   - (a) Resolved: two codes, with fixture rows that include a CA decoy and a non-exact prefix row. Expect zips sorted, keys verbatim, no countries, and the input unmutated. Also assert:
     - every request is a GET to `https://graph.facebook.com/v26.0/search`;
     - each request carries `type`, `location_types=["zip"]`, `q` and `country_code=US`;
     - zero POSTs.
   - (b) Not found (empty `data`) → invalid_input.
   - (c) Ambiguous (two exact US rows) → invalid_input.
   - (d) Wrong country only (an exact `name` with `country_code:"CA"`) → invalid_input.
   - (e) A supplied `resolved.postalCodes` → invalid_input, with 0 fetches.
   - Keep the radius and leads/sales/multi-ad rows.
4. HANDOFF.md:
   - Rewrite the postal sentence at :9: real lookup through Targeting Search with `country_code`, exact single match, key verbatim, the 30 s aggregate limit, cite the URL.
   - Remove "Real postal lookup" from :15. Add the server-integration NEEDS.
   - Edit ≤8 lines in total.
5. At the end, run only `corepack pnpm --dir content/agent-plugins/meta-ads typecheck`, with one rerun allowed. Write the tests; do not run them. Confirm that the new sha256 of the two edited sources still appears in neither manifest (no fingerprint rewrite).

NEEDS (Coordinator, keep from plan §7, tightened):
- apps/server/src/composition/agent-plugin-backends.ts:548 `prepareDestination`:
  - `await` the translator, passing `{ campaign, target, resolved, context, dependencies }` and `{ signal }`.
  - `dependencies` comes from the existing `pluginDependencies` path (:500) for the target's connection/account.
  - Apply this generically, with no vendor branch. `bootServer` stays untouched.
  - **This must land in the same integration step as the Meta dist rebuild.** A rebuilt async translator called synchronously would return the plan outcome itself as `{constituent, evidence}` through the async function, which silently breaks the shape.
- Update apps/server/tests/agent-plugin-backends.test.ts for the awaited translator and the injected dependencies.
- Rebuild the Meta dist.
- Lock note: w22-contacts-meta-identifiers also lives in meta-ads (same w14-gmeta-plugins group), so the two builds serialize.

LOCKS-FILES: content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/campaign-translation.ts, content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts, content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/tests/campaign-translation.test.ts, content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/HANDOFF.md (lock groups: w14-gmeta-plugins)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted (30 s aggregate lookup deadline; adgeolocation per code).
2. The server NEEDS is IN SCOPE for this build (it must land with the async translator, not later): apps/server/src/composition/agent-plugin-backends.ts prepareDestination (~:537-548) awaits the translator and passes `{ campaign, target, resolved, context, dependencies }` + `{ signal }`, dependencies from the existing pluginDependencies path for the target connection/account; generic, no vendor branch; bootServer untouched. Update apps/server/tests/agent-plugin-backends.test.ts for the awaited translator. Extra lock w15-backends.
3. Typecheck: also run `corepack pnpm --filter @open-marketing/server typecheck` once at the end (in addition to typecheck.txt).
