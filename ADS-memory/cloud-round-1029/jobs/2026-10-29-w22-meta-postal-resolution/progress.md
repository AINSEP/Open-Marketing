# W22 Meta postal resolution — B1

Persona loaded. Approved plan/review read, including open-marketing-f6 override authorizing the two server files and server typecheck. Existing dirty work preserved in baseline.json. No tests/builds/installs allowed.

## File map
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/campaign-translation.ts
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/tests/campaign-translation.test.ts
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/HANDOFF.md
- apps/server/src/composition/agent-plugin-backends.ts
- apps/server/tests/agent-plugin-backends.test.ts
- Job-local progress.md, baseline.json and verification artifacts only.

## Scope status
1. DONE: current-code verification and documentation/reuse checks. Postal mappings are caller supplied; no resolver exists. Approved pattern is createConfiguredDispatch → boundContext → sequential guarded GETs, matching existing read-capabilities reader.
2. DONE: campaign-translation.ts now resolves with canonical binding and the existing guarded dispatch; instagram-fetch.ts permits only read GET /search. campaign-translation.test.ts has the five approved fixture cases and awaits prior calls; tests written, not run. One new private helper; no cache/retry/paging.
3. DONE: prepareCampaign/prepareDestination forward CallOptions; prepareDestination reuses pluginExecution/pluginDependencies for the bound target, awaits sync or async translator, and supplies context/dependencies/signal. Existing generic server regression now uses an awaited translator and asserts the canonical configuration, context, target, signal and resulting plan. Tests written, not run. bootServer untouched; no vendor branch.
4. DONE: HANDOFF has three changed lines documenting actual search, matching/bounds, API evidence and integration/rebuild NEEDS. Old/new source SHA256 values absent from both manifests; no fingerprint rewrite needed. Static scope/architecture/function review completed: no vendor-specific code in server, no boot changes, unchanged deployment/readback.
5. DONE WITH BLOCKER: Meta typecheck passed on the permitted rerun (initial numeric-limit type error fixed). Server typecheck failed on out-of-scope reporting.ts:51–52 nextCursor errors; server tests stage did not run. No further typechecks/tests/builds/installs.

## Constraints / test seam
Plugin fixture fetch exercises real transport, exact single-country matching, opaque key preservation, sorted postal-only geography, zero POSTs and supplied-mapping refusal. Server generic fixture translator will be asynchronous and inspect canonical dependencies/context/options. Maximum 200 sequential GETs, 30s aggregate, 15s/request, 1MiB/response; no cache/retry/pagination helper. No contracts/manifests/dist/bootServer edits.

## Authorization
The approved review provides the dispatch/binding seed and explicitly requests implementation; no additional pattern confirmation is needed. Test-running and full verification requirements are superseded by this dispatch's prohibition.

Reuse verification: rg found no Meta resolver in Tovu, ai-traces-jini upcoming sources, or installed rc.2 dist. Existing OM transport/binding owns required bounds and credentials; rc.2 platform exports createDeadlineSignal but plugin has no Jini dependency, so retained its native one-line signal pattern. Official reference returned 429 this run; Meta SDK verified GET /<version>/search and v26.0.

## Static handoff review before typechecks
- Architecture audit: PASS for source boundaries (typed outcomes, injected guarded transport, canonical binding, inert imports, no credentials cached, no new port or shared dependency). Runtime evidence PARTIAL because test/build/live execution is prohibited.
- Function assessment: translateCampaign (stale docs updated; direct existing tests plus postal success/refusal), translateGeography (documented; radius/country tests plus postal fixtures), resolvePostalKeys (documented; exact match, no match, duplicate, wrong-country through fixture fetch), encodeRequest (one narrow route; resolved request-shape assertion), prepareDestination/prepareCampaign (documented; async generic regression checks context, canonical deps, target, signal and plan).
- Static cognitive counts remain <=10 and nesting <=3. resolvePostalKeys and encodeRequest reach 10; no bootServer edit. No mechanical complexity check run.
- Skepticism/variable audit: country is requested country, q is requested code, matches are exact zip/country/name matches, key comes from the selected vendor row; no inferred prefix or stale supplied mapping. Transport errors remain redacted. No unrelated files reformatted.
- Cut scope deliberately omitted: cache/retry/pagination/fuzzy match, extra cancellation/binding/freshness/route suites, helper modules, production metadata, UI/CLI surfaces, real account calls, bundle builds and upstream dependencies.
- Open risks: official reference HTTP 429 this run (approved review verified fields); 30s deadline may reject large lists; tests written but unexecuted. The existing older social fixture still lacks Meta destinationUrl/creative-987 evidence; report to Coordinator rather than expanding this job.
- No red/green, coverage or runtime-success claim. No migrations or installs. No commits/pushes.

### Meta typecheck attempt 1
`corepack pnpm --dir content/agent-plugins/meta-ads typecheck` exited 2: campaign-translation.ts:97 TS2322, dispatch parameters accept string|boolean, not numeric limit. Fixed limit to string "100" (same query encoding). One permitted corrective rerun next; tests not run.

## Final verification / status
Implementation: DONE in all six approved product files, including the Coordinator's generic server override. Verification: PARTIAL, server package blocked by another lane. No source/test edits after final typechecks; only the permitted three HANDOFF lines and job-local records were finalized.

- Meta: `corepack pnpm --dir content/agent-plugins/meta-ads typecheck` — first exit 2, permitted rerun exit 0. Evidence: typecheck-meta.log, typecheck-meta-rerun.log.
- Server: `corepack pnpm --filter @open-marketing/server typecheck` — exit 2 at apps/server/src/composition/reporting.ts:51,52, TS2339 Page has no nextCursor. The script's `tsc -p tsconfig.tests.json` stage was not reached. No lane diagnostic was emitted before the blocker. Evidence: typecheck-server.log.
- `git diff --check` for the six approved files: exit 0. Fingerprint absence rechecked after final source correction; fingerprints.txt contains the final SHA256 values. No manifest changes.
- Net product lines relative to the preserved run-start baseline: +157/−58, net +99. Six product files, three HANDOFF lines changed; no unrelated work reverted. implementation.diff isolates this run from prior dirty edits.
- DISPUTED: original job wording “literal key” was imprecise: baseline campaign-translation.ts:21,64–67 trusted supplied mappings with a country-prefix check. Missing real lookup was confirmed and implemented.

## Function-quality / documentation assessment
| Unit | Disposition | Findings / action | Direct written evidence |
| --- | --- | --- | --- |
| translateCampaign / CampaignTranslationInput | NO_RECORDED_FINDINGS | Async/call-scoped public contract documented; validation ordering retained. | country/invalid metadata/unsupported intent rows, supplied-key rejection |
| translateGeography | NO_RECORDED_FINDINGS | Country/radius remain pure; postal binds before I/O, sorts only fresh keys. | existing country/radius rows; postal resolved case |
| resolvePostalKeys / response schema | NO_RECORDED_FINDINGS | O(p) keys, ≤200 sequential GETs, ≤100 rows each, 30s aggregate, no retries/cache; errors redact provider content. | resolved + not found + ambiguous + wrong-country fixtures |
| encodeRequest | NO_RECORDED_FINDINGS | Only versioned GET /search with exactly read effect admitted. Static cognitive count 10; no extra helper. | resolved fixture's method/route/query/zero-POST assertions |
| prepareDestination / prepareCampaign | INCONCLUSIVE | Source is generic and uses existing bound effects; server test compilation blocked in another lane. | generic fixture now awaits translator and asserts canonical dependencies/context/signal/plan |

Zero-findings skepticism completed on plugin units: checked hostile decoys, exact-match cardinality, key opacity, no mutation, unsupported getter ordering, fresh credentials, first-failure discard and variable meanings. Static source audit passed; runtime self-validation NOT RUN because explicitly prohibited. No coverage/red-green claim; extra cases cut by review stay out. No new public schema/port/dependency/migration; MetaPausedPlan stays Zod-derived.

## NEEDS / HANDOFF
- NEEDS: Coordinator — fix apps/server/src/composition/reporting.ts:51–52 Page.nextCursor usage in its owning lane, then run server production/test typechecks when authorized. This job must not edit it.
- NEEDS: Coordinator — rebuild content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/dist/index.mjs and refresh the executable bundle digest in the SAME integration step as the awaited caller in apps/server/src/composition/agent-plugin-backends.ts. No package/lockfile/contracts/migrations changes are requested.
- NEEDS: Coordinator — update the pre-existing social deployment fixture in apps/server/tests/agent-plugin-backends.test.ts with prepared Meta ad.destinationUrl=https://example.test/landing and creative 987 account_id=123/object_story_spec.link_data.link evidence (outside this approved async regression).
- NEEDS: Authorized verification lane — run written postal and generic-server regressions and acceptance through existing HTTP/om-tool/om CLI/Studio preparation paths after rebuild; no runtime production availability is claimed here.
- DEFERRED: production metadata preparation, leads/sales/multi-ad/creative cloning, other creative forms and capability validation follow-ups remain as before. No retry/cache/pagination/fuzzy match/configurable pool/framework or extra tests beyond approved scope. No JINI ASK: existing guarded transport/binding covers the needed generic mechanisms.
