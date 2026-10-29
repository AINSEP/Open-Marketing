# Trim review: 2026-10-29-w23-studio-lint
VERDICT: APPROVED WITH CUTS

The plan is sound and small. Its deferral of the chart plugins is justified, not an omission: `content/plugins/charts-echarts/package.json` and `charts-chartjs` declare `@jini-ai/ui`, `echarts` and `chart.js`, the plan could not resolve them, and `provider.ts` already uses object-shaped `mount`/`update` signatures. Most of the 19 findings are therefore resolution artefacts. Rewriting working callbacks to compensate would be risk for nothing. The 4 lint findings in `HEALTH.md` §6 for chart tests and the other deferred items stay on the Coordinator's NEEDS list.

CUTS:
1. Cut `apps/studio/tests/conversion-grants.test.ts` and `apps/studio/tests/shell.test.ts` as lint work only if they are already fixed: both are also edited by cloud round 1029f. `conversion-grants.test.ts:97` is a typecheck error (TS2531/TS2339), not a lint finding; `shell.test.ts:21` is the `CSS.escape` shim lint finding. Re-read both after 1029f merges and skip any finding that no longer reproduces; report it DISPUTED.
2. Cut the "No chart source edits" assurance as a decision to revisit: keep it. No chart `src/` or test edits in this job, as planned.
3. Cut the `tests/model-manifests.test.ts` new file if it can be avoided by inlining: no, keep it (see FIX 2). Nothing else is cut. The plan adds no ports, options or helpers beyond the single private `requestBody`.

FIXES:
1. `apps/studio/src/shared/api/http.ts:98` (complexity 11): the extraction is the right size. Keep the body-encoding branch inside the existing `try`, preserve raw-blob precedence, and keep the JSON serialization and absent-body behaviour byte-identical (`requestBody` signature as listed in the plan). Check the function drops to ≤10 and the helper is ≤10.
2. Manifest test move. The test at `packages/contracts/tests/assistant.test.ts:154` reads `content/agent-plugins/<id>/plugin.json` through `node:fs`. Moving it to `apps/studio/tests/` is acceptable because `readFileSync` is a file read, not an import edge, so the `client-to-backend` rule in `development/scripts/boundaries.mjs` (which looks at import edges) does not fire. The constraint: the new test must not `import` anything under `content/` or `apps/server/`. If `om:boundaries` flags it, move it to `packages/plugins/tests` or stop and report NEEDS; do not weaken the rule. Remove `readFileSync` from `assistant.test.ts` line 2 and leave all other contracts tests there untouched, with identical assertions in the moved test.
3. `AlertsFeed.tsx:45`: use the `MeasurePage.tsx:50` pattern verbatim. `AlertsFeed.tsx` and `AlertsFeed.hooks.ts` are edited by 1029f. Re-read first.
4. `apps/server/tests/integration-oauth-vendors.test.ts:32` and `integrations.test.ts:454`: change only the unused parameter annotation. `integrations.test.ts` is edited by 1029f; re-read first.
5. `leads.test.tsx`: moving the fixture to `tests/support/leads.ts` is fine. Check nothing else imports `fixture` or `unattributed` from the old location. Keep identical data.
6. Verification: `corepack pnpm om:lint` once. Studio, contracts and server typechecks run one at a time (serial). Findings outside this lane (chart plugins, higgsfield, google tests, `consent-limit.test.ts:9`, `om-tools.test.ts:668`, contracts provenance) are reported, not fixed. No tests, builds or `om:check`.

REUSE: `MeasurePage.tsx:50` foreign-callback typing; `tests/shell.test.ts` `readFileSync` + `FileURL` read; `measurementGrantSchema` for grant-id parsing (strip unknown keys so the lookup is typed). No new transport or fixture framework.

DUPLICATES: none found. Plan searched Tovu `apps/admin/src/lib/api.ts` and the Jini admin transport/chart implementation; their transports have different policies. `@jini-ai/ui@0.6.15-rc.2` already provides the chart ABI types the plugins use. No OM code is cut as a duplicate of a source-only API.

OVERLAP:
- With cloud round 1029f: 1029f edits `AlertsFeed.tsx`, `AlertsFeed.hooks.ts`, `apps/studio/tests/addons.test.ts`, `conversion-grants.test.ts`, `shell.test.ts` and `apps/server/tests/integrations.test.ts`. Six of this plan's eleven files. The build runs after 1029f merges and must re-read each, apply only what still reproduces, and preserve 1029f's edits. `apps/studio/src/shared/api/http.ts`, `leads.test.tsx` and the contracts test are not on 1029f's list.
- With the other two plans: no shared file. The server plan edits no tests; `apps/server/tests/integrations.test.ts` and `integration-oauth-vendors.test.ts` are assigned to THIS job only. The plugin plan does not touch studio.

OWNER DECISIONS (defaults): the chart-provider findings are deferred until the Coordinator restores chart dependencies and rebuilds the artifacts; default is to stay deferred.

APPROVED SCOPE for B1:
1. `shared/api/http.ts`: extract `requestBody` (complexity).
2. `tests/addons.test.ts`: hoist the OAuth-status query out of the switch.
3. `tests/leads.test.tsx` + new `tests/support/leads.ts`: relocate the fixture and move the callbacks to module scope.
4. `AlertsFeed.tsx`: type `renderObservation` via `Parameters<string[]['map']>[0]`.
5. `shell.test.ts` (`CSS.escape` shim) and `conversion-grants.test.ts` (schema-parse the input): only where still reproducing after 1029f.
6. `packages/contracts/tests/assistant.test.ts` + new `apps/studio/tests/model-manifests.test.ts`: move the manifest integration test intact.
7. `integration-oauth-vendors.test.ts`, `integrations.test.ts`: parameter annotation only.
8. Verify as in FIX 6.

LOCKS-FILES: apps/studio/src/shared/api/http.ts, apps/studio/tests/addons.test.ts, apps/studio/tests/leads.test.tsx, apps/studio/tests/support/leads.ts (new), apps/studio/tests/shell.test.ts, apps/studio/tests/conversion-grants.test.ts, apps/studio/tests/model-manifests.test.ts (new), apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.tsx, packages/contracts/tests/assistant.test.ts, apps/server/tests/integration-oauth-vendors.test.ts, apps/server/tests/integrations.test.ts (lock groups: w14-contracts, w14-surface, w16-studio-chat)
