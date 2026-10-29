Software Architect(Direct):

**1. Summary**

Build fixture-covered support for one to three responsive search ads in the existing Google Search ad group. Each ad keeps its creative copy and selected destination; creation remains one atomic, paused mutation followed by complete readback. Existing single-ad traffic digests remain byte-identical, and validation covers the same operations as deployment. Hosted lead forms are DEFERRED because the neutral launch contract has no form-content fields; production creative resolution also remains a server dependency.

**2. Files**

All paths below are proposed edits for the later build; no files changed during planning.

- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts — (edit) bounded optional additional ads, reusing the existing RSA field schemas.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/campaign-translation.ts — (edit) resolve each requested creative and preserve its destination.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/rules.ts — (edit) apply existing copy/URL validation to every ad.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/mapping.ts — (edit) emit one paused ad operation per creative.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/readback.ts — (edit) project all ads, verify group membership, normalize multi-ad digests.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/fixture.ts — (edit) retain distinct fixture ads and update their statuses individually.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/helpers.ts — (edit) replace the fixed six-entry hosted ACK with operation-matched fixture responses.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-translation.test.ts — (edit) creative association, limits, validation and traffic compatibility regressions.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-deployment.test.ts — (edit) multi-ad mutation/readback, drift and validateOnly parity regressions.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/capabilities.json — (edit) schemas.ts fingerprints only.
- content/agent-plugins/google-ads/plugin.json — (edit) schemas.ts fingerprints only.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/search.v1.json — (edit) schemas.ts fingerprint.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/reporting.v1.json — (edit) schemas.ts fingerprint.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/stop.v1.json — (edit) schemas.ts fingerprint.
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/conversions.v1.json — (edit) schemas.ts fingerprint.
- content/agent-plugins/google-ads/HANDOFF.md — (edit) supported subset, primary sources and concrete deferrals.
- ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-google-multiad-leadforms/progress.md — (new, required job bookkeeping) completed items and final typecheck result.

**3. Public contracts**

Keep existing exports and signatures; add no port, factory or command.

- `SearchPlan = z.infer<typeof campaignDeploymentPlanSchema>` gains `additionalAds?: { headlines: string[]; descriptions: string[]; finalUrl: string }[]`, length 1–2 when present.
- Existing root RSA fields represent the first ad. Single-ad plans omit `additionalAds`.
- `translateCampaign({ campaign, target, resolved }): Outcome<SearchPlan>` accepts optional `resolved.additionalCreatives`, containing 1–2 schema-derived `{ creativeId, headlines, descriptions }` records; existing first-creative fields remain.
- `validatePlan({ plan, binding }): Outcome<SearchPlan>` validates every ad.
- `createOperations({ customerId, plan, marker, timezone, conversionGoals }): Record<string, unknown>[]` keeps its signature.
- `planDigest({ plan }): string` preserves singleton behavior and normalizes whole multi-ad records.

**4. Approach**

1. Add optional additional-ad data using Zod-derived types and the existing JSON-schema projection. Accept 1–3 ads; refuse larger launches without truncating them.
2. Extend the current translator’s creative-ID/digest checks. Require exactly one matching resolution per requested creative, rejecting missing, duplicate or extra records. Take every URL from its corresponding launch ad.
3. Apply existing headline/description uniqueness and URL checks to all ads. Keep geography, money, bidding and goal handling unchanged.
4. Replace the singleton ad operation with a bounded map. All ads reference the existing temporary ad group and start PAUSED. Retain one `partialFailure:false` mutation.
5. Read back 1–3 ads; require each to belong to the controlled group and carry valid RSA content, one URL, a unique ID and explicit status. Populate every ad’s child ID/status so existing pause/activation mapping covers them.
6. For multiple ads, normalize each complete copy/URL record, then sort those records without deduplication. Preserve copy/URL association and multiplicity. Keep the existing single-ad digest path unchanged.
7. Extend the existing vendor fixture to store an ad array with stable IDs. Update the hosted ACK fixture to match operation count and return distinct ad references; preserve existing singleton reference expectations.
8. Write regressions: two/three creatives across objectives; missing/duplicate resolution; invalid later-ad URL/copy; four-ad refusal; singleton traffic golden digest/body; reversed readback order; missing/extra/duplicate/wrong-group ads; changed copy/URL/status.
9. Extend the real `createCapabilities` validation test with server-shaped configuration and multi-ad plans. Assert deployment/validation body equality except `validateOnly`, zero validation writes/checkpoints, and acknowledged deployment.
10. Recompute SHA-256 of final schemas.ts and replace its 12 fingerprint rows. Preserve read-capabilities.ts fingerprints. End with `corepack pnpm --dir content/agent-plugins/google-ads typecheck`; one corrective rerun allowed. No tests or builds.

Existing bounds suffice: at most 256 created-resource references and 456 operations including 200 goal updates. No new limits framework is needed.

**5. Reuse**

- Translation extends `campaign-translation.ts`’s existing creative binding and geography-resolution checks.
- Per-ad validation extends `rules.ts::validatePlan`; mutation extends `mapping.ts::createOperations`.
- Readback/digests extend `readback.ts::readChildren`, `projectHierarchy` and `planDigest`.
- Validation already calls `prepareCreation` through `hosted.ts::validateCampaignDeployment`; no separate builder or handler.
- Fixtures extend `createFixtureTransport` and `hostedDeploymentFixture`; retain existing journal, transport and uncertainty behavior.
- Searched Jini/Tovu source for `ResponsiveSearchAd`, `responsiveSearchAd`, `LeadFormAsset`, `leadFormAsset` and `googleAds:mutate`: no reusable implementation found.
- Checked Jini’s CAPABILITIES.md and installed `@jini-ai/integrations` / `@jini-ai/agent-plugins` 0.6.15-rc.2 dist: no matching vendor implementation. npm registry verification failed through web access and local DNS.
- Reuse existing Zod/REST code. A Google SDK adds no needed mechanism or dependency.

**6. Deliberately left out**

- **DEFERRED:** hosted lead-form creation, linking and intake until approved form content can reach the plugin. Do not invent content from ad copy or configuration.
- **DEFERRED:** production creative resolution and HTTP/om-tool/CLI/Studio acceptance; server preparation remains sandbox fixture-only at `agent-plugin-backends.ts:541–542`.
- No webhook, download worker, visitor storage, new approval flow, ad editor, extra ad groups or support above three ads.
- **Already present:** multiple creative references in the neutral contract and shared validate/deploy preparation. Neither needs a replacement mechanism.

**7. NEEDS**

- **INSTALLS:** none.
- **INTEGRATION:** Coordinator rebuilds `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/dist/index.mjs` after source approval.
- **SERVER:** provide scoped per-creative copy matching `additionalCreatives`; update server fixtures and verify the existing HTTP + om-tool + om CLI + Studio launch path. Outside this lane.
- **CONTRACTS:** for a later hosted-form job, add this vendor-neutral optional property to `neutralCampaignLaunchSchema` in `packages/contracts/src/launch/index.ts`:

```ts
leadForm: z.strictObject({
  businessName: z.string().trim().min(1).max(200),
  headline: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(2000),
  callToActionDescription: z.string().trim().min(1).max(200),
  privacyPolicyUrl: z.url({ protocol: /^https$/ }).max(2048),
  fields: z.array(z.enum(["full_name", "email", "phone"])).min(1).max(3)
    .refine(values => new Set(values).size === values.length),
}).optional(),
```

Require `leadForm === undefined || objective === "leads"`; derive its type from Zod. Vendor-specific limits and a fixed contact CTA belong in the plugin. This contract request does not expand the current build.
- **HOSTED-FORM FOLLOW-UP:** without implemented OM intake, explicitly record “Leads stay in Google.” OM intake requires verified consent before persistence.
- **MIGRATIONS / JINI ASKS:** none for this build.

**8. Unverified facts and risks**

- Transport currently uses **Google Ads API v26**. Its request contract confirms atomic execution with `partialFailure:false` and validation without execution using `validateOnly:true`. [v26 request reference](https://developers.google.com/google-ads/api/reference/rpc/v26/MutateGoogleAdsRequest)
- RSA creation uses separate ad operations containing headline/description assets and final URLs. Account eligibility and actual acceptance remain unverified; rejection has no fallback mutation, and incomplete readback cannot acknowledge creation. [Google RSA creation guide](https://developers.google.com/google-ads/api/docs/responsive-search-ads/create-responsive-search-ads)
- Hosted forms require explicit business/form/privacy content and campaign-level `LEAD_FORM` linking. The current launch contract cannot provide that content, and this plugin has no lead intake implementation. Form creation therefore remains deferred. [LeadFormAsset v26](https://developers.google.com/google-ads/api/reference/rpc/v26/LeadFormAsset), [v26 linking sample](https://developers.google.com/google-ads/api/samples/add-lead-form-asset)
- Preserve the documented existing Search conversion-goal uncertainties. Fixtures and typechecking cannot establish live vendor acceptance.

**9. Size estimate**

One build, approximately 75–90 minutes: 16 lane files plus required progress bookkeeping; no new runtime files. Roughly source +220/−80 LOC, tests +180/−20, documentation +20; fingerprint replacements are line-neutral. Estimated net +320 LOC. Planning performed no edits, tests, builds or typechecks.