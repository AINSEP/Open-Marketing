Software Architect(Direct):

1. **Summary**

Meta postal targeting will resolve each requested code through Meta’s targeting search before producing a prepared campaign plan. Only one exact postal match in the requested country will be accepted; missing or ambiguous matches return typed `invalid_input` before any write. The plan retains strict deployment readback and the existing approval flow. The Coordinator must wire the asynchronous translator into server preparation before this behavior reaches users.

2. **Files**

All paths below are under `content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/`.

- `src/campaign-translation.ts` — (edit) resolve postal geography during translation; remove caller-supplied postal mappings.
- `src/instagram-fetch.ts` — (edit) permit the exact versioned targeting-search GET through the existing guarded transport.
- `tests/campaign-translation.test.ts` — (edit) await translation; add fixture-fetch resolution and refusal cases.
- `HANDOFF.md` — (edit) record API evidence, changed signature, limits and integration dependency.

No new files. The existing `src/index.ts` re-exports remain sufficient.

3. **Public contracts**

- `translateCampaign(required: CampaignTranslationInput, optional?: CallOptions): Promise<Outcome<MetaPausedPlan>>`.
- Extend existing `CampaignTranslationInput` with `context: CallContext` and `dependencies: PluginCapabilityDependencies`; include `connectionId` in its existing `target` projection.
- Remove `resolved.postalCodes`; postal keys come exclusively from the search response.
- Keep `MetaPausedPlan = z.infer<typeof campaignDeploymentPlanSchema>`.
- No new capability, command, port, factory or shared contract.

4. **Approach**

1. Preserve existing unsupported-intent, account, budget, creative and schedule checks before lookup. Reuse the canonical launch schema to enforce bounded, unique postal codes and exactly one country.
2. Make `translateCampaign` asynchronous and extend its existing geography function. Country and radius targeting retain their behavior and perform no network lookup.
3. For postal targeting, reuse `createConfiguredDispatch` and `boundContext` to check the configured scope, account and selected connection before credentials or fetch.
4. Extend the transport allowlist narrowly for GET `https://graph.facebook.com/v26.0/search` with effects exactly `["read"]`. Keep existing authentication, cancellation, response bounds and redacted errors.
5. Search each code with `type=adgeolocation`, `location_types=["zip"]`, `q=<code>` and a fixed response limit of 100. Use the existing native abort-signal composition pattern for a 30-second aggregate deadline; retain the transport’s 15-second per-request limit.
6. Validate response envelopes and rows with Zod. Require exactly one `zip` result whose country matches and whose name equals the requested code after trimming and case folding. Use its opaque `key` verbatim; remove the country-prefix inference.
7. Return `invalid_input` for no match, wrong-country-only results, multiple exact matches, malformed responses or incomplete/paginated results. Transport failures retain typed failures. Discard partial resolutions.
8. Reuse existing sorted `zips` output and final plan validation. Never add broad country targeting alongside postal keys. Leave deployment and strict location readback untouched.
9. Write fixture-fetch regressions for resolved, not found, ambiguous and wrong-country results. Also cover supplied-key rejection, cancellation, binding mismatch, repeated-call freshness, narrow route denial and zero POSTs. Preserve existing country/radius assertions and the existing real-factory test.
10. Inspect fingerprint inputs after changes. Neither edited source currently participates in the declared schema fingerprints, so no catalog rewrite is planned; bundle digest regeneration belongs to the Coordinator.
11. Run only `corepack pnpm --dir content/agent-plugins/meta-ads typecheck` at build end, with one corrective rerun allowed. Write tests without running them.

5. **Reuse**

- **Translation:** extend `src/campaign-translation.ts::translateGeography`; retain sorting and `campaignDeploymentPlanSchema`. Retire the supplied postal-map path.
- **Connection and transport:** reuse `src/instagram-fetch.ts::{createConfiguredDispatch,bindDispatch,createMetaInstagramFetchDispatch}` and `src/read-capabilities.ts::boundContext`; no parallel HTTP client or credential parser.
- **Validation/errors:** reuse contracts’ `neutralCampaignLaunchSchema` and plugin configuration types, `src/boundary.ts::{parse,failure,digest}`, and installed `zod@4.1.13`.
- **Fixtures:** extend the translation suite using the existing configuration/context patterns in `tests/fixtures.ts` and `tests/campaign-deployment.test.ts`. Retain `tests/read-capabilities.test.ts:314`’s real `createCapabilities` coverage.
- Searched OM plugins/contracts, Jini and Tovu source for `adgeolocation`, `targetingsearch`, postal resolution and postal lookup. Found no existing Meta postal resolver.
- Checked Jini’s capability map and installed `@jini-ai/{platform,integrations}@0.6.15-rc.2` distributions. Their generic HTTP/deadline facilities do not replace the existing plugin transport; no dependency is needed.
- npm registry checks were attempted through web and direct HTTP; access/DNS failed. Published metadata was therefore not independently verified.
- Rejected an SDK dependency, geocoder and postal dataset: this needs Meta’s own targeting keys, obtainable through the existing transport.

6. **Deliberately left out**

- No cache, retries, pagination engine, parallel request pool, configurable limits or resolver framework.
- No fuzzy matching, postcode correction, country fallback or synthesized keys.
- No changes to deployment, readback, money, objectives, approvals, visitor tracking or other plugins.
- No new UI/CLI/tool surface: this corrects preparation behind the existing campaign flow.
- **DEFERRED:** runtime integration and bundle rebuilding, because they belong to the Coordinator’s lane.

7. **NEEDS**

- **NEEDS: Coordinator —** in `apps/server/src/composition/agent-plugin-backends.ts::prepareDestination`, await the existing translator export and pass `context` plus call-scoped `PluginCapabilityDependencies` from the existing read-only `pluginExecution`/`pluginDependencies` path. Apply this generically, without a vendor branch or `bootServer` change.
- **NEEDS: Coordinator —** update `apps/server/tests/agent-plugin-backends.test.ts` for asynchronous translation and dependency injection; verify existing HTTP, om-tool, CLI and Studio preparation paths use it.
- **NEEDS: Coordinator —** rebuild the Meta plugin dist and refresh its executable bundle digest after integration.
- Installs, shared-contract changes and migrations: none. No Jini ask identified.

8. **Unverified facts and risks**

- Use **Graph API v26.0**, already selected by OM and confirmed by [Meta’s current SDK configuration](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py).
- Meta’s [official targeting guide](https://github.com/facebookincubator/catalogue-of-api-solutions/blob/main/solutions/miscellaneous/targeting-reach-estimate.md) confirms global `/search`, `adgeolocation`, location type `zip`, and using returned keys. The [official SDK search implementation](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/targetingsearch.py) independently confirms the versioned GET route.
- The current [Targeting Search reference](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/targeting-search) and [Basic Targeting reference](https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/reference/basic-targeting) returned HTTP 429/access errors. Exact zip-search response fields, postcode formatting and completeness semantics remain unverified live.
- Unexpected response shapes or formatting refuse preparation; paginated results refuse rather than risk hidden ambiguity. Large postal lists may hit the aggregate deadline.
- **Finding clarification:** current translation does not construct literal keys; it trusts caller mappings and checks their prefix (`campaign-translation.ts:21,64`). The missing vendor lookup is real.
- End-to-end completion remains blocked on the Coordinator integration above. No tests or checks ran during this planning session.

9. **Size estimate**

Four edited files; approximately **+90–120/−15–25 source LOC**, **+130–170/−25–40 test LOC**, and about 15 documentation lines. Estimated net addition: **170–265 LOC**. One implementation run of approximately **75–90 minutes**, excluding Coordinator integration.