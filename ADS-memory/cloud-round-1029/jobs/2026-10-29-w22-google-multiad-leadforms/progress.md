# W22 Google multi-ad B1 progress

- Persona loaded: AI-Dev-Shop/agents/programmer/skills.md. Approved plan + trim review + coordinator override are binding; no tests/builds/installs/commits.
- Discovery DONE: current translation and readback each enforce one RSA. Existing prepareCreation, validateOnly, journal, drift checks and status fan-out remain owners; no new runtime layer.
- Pattern/ADR checklist: preserve existing object inputs/Outcome boundaries, plugin-local vendor code, Zod-derived plan type, injected I/O, max 3 ads, one atomic paused mutation, singleton bytes/digest unchanged. Review FIXES are the approved seed pattern. No separate style confirmation needed under explicit implementation dispatch.
- Reuse DONE: searched published Jini 0.6.15-rc.2 agent-plugins/integrations dist, read-only Tovu and ai-traces-jini for responsiveSearchAd|leadFormAsset|adGroupAdOperation: no matching implementation. Extend this plugin's translator, validator, mapper, readback/digest and fixtures. No JINI ASK.
- Vendor docs: checked v26 MutateGoogleAdsRequest (atomic partialFailure=false; validateOnly=true does not execute), RSA guide, Google RSA help and LeadFormAsset. Lead forms remain deferred under owner override.
- Test seam: pure translateCampaign/createOperations/planDigest plus real hosted createCapabilities with injected fixture fetch. Adversarial cases: unmatched/duplicate resolution, invalid later ad, reversed readback order and URL drift. Bounds unchanged except explicit 1–3 ads; no per-ad I/O.
- Scope 1 schemas: DONE — src/schemas.ts reuses local headline/description/URL schemas; optional additionalAds is 1–2 entries. Regression assertions pending scope 6; none run.
- Scope 2 translation: DONE — src/campaign-translation.ts reuses RSA JSON projection, caps at 3 before metadata, matches additionalCreatives exactly, preserves per-intent URLs and omits singleton key. Regression tests pending scope 6; none run.
- Scope 3 validation/mapping: DONE — src/rules.ts checks every ad copy/URL, src/mapping.ts maps 1–3 paused RSA operations at the original position in the atomic batch. Singleton operation order retained. Regressions pending scope 6; none run.
- Scope 4 readback/digest: DONE — src/readback.ts projects 1–3 ads and all child IDs/statuses; sorted whole multi-ad records preserve multiplicity and URL binding. Singleton digest expression retained exactly. Regressions pending scope 6; none run.
- Scope 5 fixtures: DONE — src/fixture.ts retains ads 401/402/403, updates by ~id and emits one row per ad; tests/helpers.ts ACK follows operation kinds/count and preserves singleton references. Covered by scope 6 deployment regressions, not run.
- Scope 6 regressions: DONE — campaign-translation.test.ts covers two-ad copy/URL binding, resolution conflicts, invalid later URL/copy, four-ad early refusal and singleton omission. campaign-deployment.test.ts covers three-ad atomic paused deploy, leads multi-ad deploy, reversed readback, later-URL conflict, activate/pause all ads, singleton golden digest/body and existing real-factory validate-loop multi-ad row. Tests WRITTEN, NOT RUN; no red/green claim.
- Scope 7 fingerprints: DONE — schemas.ts SHA256 cd0de4d65255610ec743c1eb46720b5289d8ce27b0702b3f329feff80962167d; replaced 12 JSON rows (capabilities ×4, plugin ×4, four bindings ×1) plus HANDOFF fingerprint. Read-capabilities fingerprints unchanged. No build.
- Scope 8 HANDOFF: DONE — HANDOFF.md adds six lines for supported subset, v26/RSA/three-enabled limit sources and lead-form/surface deferrals, plus the existing fingerprint-line replacement (7 edited lines total).
- Final typecheck: DONE — corepack pnpm --dir content/agent-plugins/google-ads typecheck, PASS exit 0, first invocation; no rerun.
- Deferred/NEEDS: hosted lead forms pending reviewed contract + intake decision; production additionalCreatives resolution and HTTP/om-tool/CLI/Studio acceptance; Coordinator dist rebuild. No shared contracts, manifest dependencies or migrations changed.

Golden provenance: pre-B1 singleton expression/body independently transcribed into a Python data-only calculation (no module/test execution). Fixture plan digest 8b8401300e947fdae872e6183037d013e7d63e52d09e9f3f8756968c2ae5db2b; traffic readback digest 0ae96efebc3012b79719c0a0598c993b6a3d0094b489fc4c62465032292303d3; serialized mutate body SHA256 7ad03987cb7156b0da89d22ad638f24fc9f27f7b3cffcaadddc9a6852e48b227.

## Pre-typecheck review

- Architecture audit: PASS for inspected changes. Only approved lane files and this progress file edited; no core/vendor branching, new I/O, port, dependency, composition edit, service startup, credential handling, policy bypass or migration. Existing authority/journal/transport semantics retained. Exactly one ad group, at most 3 ads; no truncation. All external fields still cross the existing closed schemas.
- Pre-completion: approved B1 items re-read; no certified tests removed/weakened. Existing obsolete multi-ad refusal was changed to four-ad refusal as required. Unique prior assertions retained. No tests/builds/watch/installs or live vendor requests run. Runtime self-validation and coverage measurement deliberately NOT RUN per owner dispatch; no runtime acceptance claim.
- Static whitespace review: scoped git diff --check exits 0. All 12 schema rows now match; old schema digest absent from lane. Read-capability fingerprint values remain unchanged. No lint or metric tool run; complexity/nesting reviewed manually, no measured gate claim.
- Documentation: campaignDeploymentPlanSchema and planDigest updated; translator/mapping docs retained/updated; new additionalAds and projectAds document bounds/purity. Obvious private fixture row/update mappings inherit parent fixture documentation. No speculative options or forwarding layers.
- Variable-name/zero-findings skepticism pass: ads means complete ad records, creative IDs stay associated with copy, URLs remain paired, child IDs/statuses share row order, whole records sort without deduplication, rest excludes root copy/URL/additionalAds, singleton branch unchanged. Invalid later ads fail before mutation. No known changed-code semantic finding; runtime evidence remains incomplete.

| Assessed units | Disposition | Findings / seam / cost |
| --- | --- | --- |
| translateCampaign / translateSearch / additionalAds | INCONCLUSIVE (tests not run) | Static review clean; translation regressions directly assert matching/refusal/copy/URLs. Existing O(g+k) plus O(a²) matching, a<=2, no I/O. |
| validatePlan / createOperations | INCONCLUSIVE (tests not run) | Static review clean; later-ad invalid data and deployed batch tests; bounded O(g+k+c+a), no added I/O. |
| projectHierarchy / projectAds / planDigest | INCONCLUSIVE (tests not run) | Static review clean; reversed rows, URL drift, singleton goldens and all child statuses; bounded projection and O(n log n) normalization. |
| createFixtureTransport / applyOperation / adRows / hostedDeploymentFixture | INCONCLUSIVE (tests not run) | Static review clean; state owned per fixture, stable IDs and suffix-matched status updates; hosted/legacy deploy, validateOnly, status and existing partial-fault tests. |

No Critical/High judgment findings recorded; mechanical complexity metrics unavailable (only typecheck authorized). No extra options parameter added because existing signatures and the approved scope require no options. No loop alert. No out-of-scope fixes.

## Concrete NEEDS / deferred

- INTEGRATION: Coordinator rebuilds content/agent-plugins/google-ads/io.github.ainsep.openmarketing/dist/index.mjs after source approval; refresh installed plugin copies as needed.
- SERVER: production creative resolution must supply additionalCreatives: [{ creativeId, headlines, descriptions }] for ads[1..2], and the sandbox campaignFixture may include it. Then close HTTP + om-tool + om CLI + Studio for multi-ad launch. No server files edited.
- CONTRACTS (later hosted-form job; not built now): add this optional property to neutralCampaignLaunchSchema in packages/contracts/src/launch/index.ts, with leadForm === undefined || objective === "leads" refinement and type derived from Zod. The exact approval card must carry this content before form creation is implemented:

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

- HOSTED FORMS: DEFERRED under coordinator override. Vendor limits stay in the plugin. If built before OM intake exists: leads stay in Google. OM intake requires consent before persistence; no visitor persistence/intake/webhook/download added.
- RISKS: no live Google eligibility/acceptance evidence; retain prior Search conversion-goal uncertainties. Production launch remains unavailable pending its existing integration. Fixture acceptance and goldens are unexecuted.
- Deliberately omitted per trim: group-membership/duplicate-ID extra checks/tests; per-objective multi-ad matrix; redundant missing/extra/copy/status drift cases; separate validate test/helper; lead forms/intake/contract edit; support above three ads, multiple groups and UI/editor additions.
- DISPUTED: no B1 finding disputed. Vendor citation correction: the general RSA help page no longer states the enabled limit; current account-limit page (https://support.google.com/google-ads/answer/6372658?hl=en, Ad limits) explicitly states 3 enabled RSAs per group, used in HANDOFF.

Final typecheck about to run: corepack pnpm --dir content/agent-plugins/google-ads typecheck (first and only planned invocation; one corrective rerun only if needed).

## Final result

- Final typecheck: DONE — `corepack pnpm --dir content/agent-plugins/google-ads typecheck`, PASS, exit 0 on first invocation. No corrective rerun. No production/test source changed after typecheck.
- All nine approved B1 scope items DONE (tests written only, final typecheck passed). Lead forms and production/surface integration remain explicitly deferred above.
- Incremental lane delta against this run's in-memory starting snapshot: +261 / −52 = net +209 lines across 16 existing files, plus this new progress ledger. Prior dirty/untracked changes were preserved. No files outside the 17 approved paths edited.
- Handoff: source ready for Coordinator post-check, dist rebuild and separately authorized fixture test execution. No production or executed-test acceptance claimed; no commit/push.

### CHANGED FILES (all paths)

- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts` (+7/−4)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/campaign-translation.ts` (+26/−5)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/rules.ts` (+4/−3)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/mapping.ts` (+2/−2)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/readback.ts` (+34/−10)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/fixture.ts` (+10/−6)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/helpers.ts` (+8/−3)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-translation.test.ts` (+52/−6)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-deployment.test.ts` (+99/−0)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/capabilities.json` (+4/−4)
- `content/agent-plugins/google-ads/plugin.json` (+4/−4)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/search.v1.json` (+1/−1)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/reporting.v1.json` (+1/−1)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/stop.v1.json` (+1/−1)
- `content/agent-plugins/google-ads/io.github.ainsep.openmarketing/bindings/conversions.v1.json` (+1/−1)
- `content/agent-plugins/google-ads/HANDOFF.md` (+7/−1)
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-google-multiad-leadforms/progress.md` (new required bookkeeping).
