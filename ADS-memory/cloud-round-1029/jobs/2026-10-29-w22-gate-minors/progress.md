# W22-GATE-MINORS B1 progress

Programmer persona loaded. Implementing review.md APPROVED SCOPE and coordinator override; no tests/builds/installs/om:check, commits or live calls. Existing dirty/untracked files preserved. File ownership is the 22 source/test/metadata files in review.md LOCKS-FILES plus this progress file.

Approved seed: review FIXES 1 wraps successful claim diagnostics in `{ settled }`; service/outbox retain their existing durable readback/null checks. This concrete reviewed implementation supplies pattern confirmation for this small maintenance run.

Constraints: public feature imports only; injected dependencies retained; no new layers/ports; no changes to bootServer, manifests, contracts, dist or migrations. Regression seams are existing registry, owner HTTP fixture, validator fixture, tracking fixture, report rules, pacing fixture and GBP real factory. No runtime red/green evidence is claimed because tests are prohibited.

1. DONE — features/jobs/src/handlers.ts wraps successful diagnostics; ports.ts type/doc distinguishes no handler. features/jobs/tests/handlers.test.ts regression covers null diagnostic, one claim call, zero ordinary calls and absent claim-handler fallback. Tests written, not run. service.ts/outbox.ts unchanged.
2. DONE — apps/server/src/inbound/owner.ts preserves only invalid_input/limit_exceeded fixed media refusals and masks other errors. owner-api.test.ts parameterized HTTP regression covers unsupported format (400) and masked unavailable (503). Tests written, not run. Existing byte cap/admission retained; no attachment mechanism extended.
3. DONE — apps/server/tests/agent-plugin-backends.test.ts adds admitted read+write effects to the existing validator table and reuses refused branch assertions (forbidden, zero fetches/credential access). Production gate already rejects it; no production edit. Test written, not run.
4. DONE — apps/server/src/composition/tracking.ts requires host only for nonempty campaignKeys; identity.ts derives module-level keys from public landingPropertiesSchema, retaining subject restriction and consent gates. p1-tracking.test.ts regression covers absent/empty keys yielding source without host, tagged refusal with zero binding lookup/invoke; existing refusal assertions retained. Tests written, not run.
5. DONE — apps/server/src/alerts/rules.ts uses code-point ID tie ordering (including equality); index.ts drops only unused weekly rule/type re-exports. weekly-report.test.ts extends tied-spend test with a/Z => Z/a regression, written not run. Existing direct rules imports retained; weekly failed-read tail deferred as approved.
6. DONE — apps/server/tests/p1-alerts.test.ts appends binding-foreign AFTER the own-scope insertion loop, so its only credential row remains foreign-owner. Second binding page includes revoked + foreign rows; existing single-call/count assertions retained. Read default-fixture tests (evaluation, partial failure, deadline): counts are unaffected because sources joins only own-scope connected credentials. Test written, not run.
7. DONE — GBP src/posts.ts observes publication status on success/error code on failure; plugin.json and capabilities.json fingerprints recomputed from source (f30eb2152e97612246f454e09ca5db58fcb688a115c9c51386447983c67f0432). Existing real-factory capabilities.test.ts expectation changed to published; no extra receipt/error cases per review. Test written, not run. Dist rebuild deferred to Coordinator.
8. DONE — features/brand/index.ts exports existing revisionNumberSchema/expectedRevisionSchema; apps/server/src/om-tools.ts imports/reuses them. Existing 60 KiB kit refine retained. Schema-equivalent deduplication, no added test per plan.
9. DONE — apps/server/src/om-tool-coverage.ts uses one small tool-to-Studio label lookup; adds Activity inbox only for leads list/set_stage and retains existing measure/integration labels + chat default. Metadata-only; no added test per review.
10. DONE — features/safety/src/paid-sending.ts renames admitted's string parameter/property write to operation at declaration, predicate and call. Boolean storage-write flags and reserve remain unchanged. Mechanical rename, no added test.
11. DONE — apps/server/src/alerts/provider-settings.ts reuses one module-local upsert SQL literal at both existing writes. Transaction, values, omitted/null semantics retained. No behaviour change/test per review.
12. DONE — all implementation items complete; jobs, safety, server and direct GBP package typechecks passed. Jobs used its one corrective rerun. No separate brand/studio check per review; server compiles brand's source exports. No tests/builds/om:check/installs/live calls, commits or pushes performed.

Typecheck jobs, attempt 1: FAILED (exit 2), tests/handlers.test.ts:19/:24 TS2722 because dispatchClaim is optional in the inherited public port. Added non-null assertion at the concrete registry test calls (factory always supplies it); no production contract expansion. Running the one allowed corrective rerun before moving to safety.

Typecheck jobs, corrective rerun: PASS (exit 0), `corepack pnpm --filter @open-marketing/jobs typecheck` (production + test TypeScript). No jobs reruns remain.

Typecheck safety, attempt 1: PASS (exit 0), `corepack pnpm --filter @open-marketing/safety typecheck` (production + test TypeScript). Proceeding to server.

Typecheck server, attempt 1: PASS (exit 0), `corepack pnpm --filter @open-marketing/server typecheck` (production + test TypeScript; also compiles brand's source public exports). Proceeding to GBP.

GBP workspace-filter probe: `corepack pnpm --filter @open-marketing/plugin-google-business-profile typecheck` returned "No projects matched the filters"; no compiler ran and this is NOT a pass. Its package has a typecheck script; invoking that package directly with `corepack pnpm --dir content/agent-plugins/google-business-profile typecheck` for the one actual check. No workspace/manifest edits.

Typecheck GBP, actual attempt 1: PASS (exit 0), `corepack pnpm --dir content/agent-plugins/google-business-profile typecheck` (`tsc -p tsconfig.json --noEmit`, includes src/tests).

Diff review: 22 locked source/test/metadata files changed; +88/-37 lines, net +51 (progress file excluded). No changes to any file cut by the review. Schema deduplication retains the 60 KiB tool cap, tracking guard preserves tagged refusal before I/O, and foreign binding is appended after own-scope inserts. Ready for the permitted sequential typechecks.

Documentation: dispatchClaim port doc updated for nullable diagnostics; no other input/error contract expanded. Existing boundary/complexity docs remain accurate. Added re-exports, SQL literal, label lookup and mechanical rename are self-explanatory; no comment bloat or new abstraction. Test execution and doc-lint are prohibited by this run's verification restriction.

Reuse: existing service/outbox null checks and fixtures; public brand and landing-property schemas; existing upload Outcome fixed messages; existing transactional settings writes. Published rc.2 CMS outbox search has no claim-handler seam; read-only ai-traces-jini dist has fenced outbox (rc.3 source only), so OM seam remains. Tovu's apps/website/src/contracts/core/events/jini-outbox-adapter.ts translates the CMS event queue to Jini; it has no matching diagnostic seam. No new mechanism or dependency added.

DEFERRED: permanent weekly read failure needs an unavailable-week representation across alerts/workers/Studio, as approved. DISPUTED item 9: LinkedIn imports are used; dispatch.test.ts:3/:5 import LinkedInInvocation/dispatchSuite, :7 calls dispatchSuite, :252/:291 use LinkedInInvocation. No LinkedIn edits.
NEEDS: COORDINATOR: rebuild the google-business-profile plugin dist after the posts.ts and fingerprint changes.
NEEDS: FOLLOW-UP (owner/P1-5): an unavailable-week representation for permanent weekly read failures (server alerts + workers.ts classification + Studio, keeping HTTP, om-tool and CLI visibility).

## Final changed files (only this run)

- features/jobs/src/handlers.ts
- features/jobs/src/ports.ts
- features/jobs/tests/handlers.test.ts
- apps/server/src/inbound/owner.ts
- apps/server/tests/owner-api.test.ts
- apps/server/tests/agent-plugin-backends.test.ts
- apps/server/src/composition/tracking.ts
- apps/server/src/composition/identity.ts
- apps/server/tests/p1-tracking.test.ts
- apps/server/src/alerts/rules.ts
- apps/server/src/alerts/index.ts
- apps/server/src/alerts/provider-settings.ts
- apps/server/tests/weekly-report.test.ts
- apps/server/tests/p1-alerts.test.ts
- content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/src/posts.ts
- content/agent-plugins/google-business-profile/plugin.json
- content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/capabilities.json
- content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/tests/capabilities.test.ts
- features/brand/index.ts
- apps/server/src/om-tools.ts
- apps/server/src/om-tool-coverage.ts
- features/safety/src/paid-sending.ts
- ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-gate-minors/progress.md

## Handoff

Approved B1 scope implemented. Owners see specific safe upload refusals and can get tag-free tracking snippets with no plugin host. Claim-handler null diagnostics cannot select ordinary dispatch. Weekly ordering is deterministic, existing schemas/SQL are reused, lead labels match Studio and GBP diagnostics reflect publication status.

Runtime behaviour remains unverified: all seven touched test files were written/updated and typechecked, not executed. Production/test/metadata delta is +88/-37 (net +51), excluding this progress document and all pre-existing work. No new dependency, migration, vendor core coupling, observability mechanism, service/outbox envelope, reserve refactor or LinkedIn edit. Existing cross-feature imports stay public package imports. dispatchClaim port doc updated; existing docs on re-exported schemas and boundary functions retained.

Ready for Coordinator review, deferred GBP dist rebuild and authorized test execution elsewhere. Weekly unavailable-report follow-up remains deferred as approved.
