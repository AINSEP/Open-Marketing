Programmer(Direct): Conversion settings implementation is written across HTTP, assistant tools, CLI and Studio, but is NOT ready to run: the public contracts barrel is outside the approved file list and its export authorization remains unanswered. The owner-facing form lives in each declared plugin's Integrations panel; map values use key=value lines. Owners can also use `om integrations conversion-settings get|set --plugin ID`; set reads a JSON values object from stdin. Assistant saves require an exact owner card. Saving never installs/enables a plugin or verifies the identifiers with a vendor.

## CHANGED FILES

Relative to this run's preserved baseline (not HEAD): **24 source/config/test files, +476 / -27, net +449 lines**, excluding job artifacts. Every application/config/test edit is in the reviewed LOCKS-FILES; contracts addon module is authorized by the final Coordinator override. The contracts root barrel has NOT been edited.

- `apps/server/src/integrations.ts`
- `apps/server/src/integration-credential-cards.ts`
- `apps/server/src/composition/addons.ts`
- `apps/server/src/inbound/integrations.ts`
- `apps/server/src/addon-tools.ts`
- `apps/server/src/om-tools.ts`
- `apps/server/src/om-tool-coverage.ts`
- `apps/server/src/cli/addons.ts`
- `apps/server/src/cli/http.ts`
- `apps/studio/src/pages/addons/model/integrations.hooks.ts`
- `apps/studio/src/pages/addons/ui/IntegrationsPage.tsx`
- `apps/studio/src/shared/api/types.ts`
- `apps/studio/src/shared/api/http.ts`
- `apps/studio/src/shared/api/sample.ts`
- `content/agent-plugins/google-ads/plugin.json`
- `content/agent-plugins/meta-ads/plugin.json`
- `content/agent-plugins/tiktok-ads/plugin.json`
- `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/tests/manifests.test.ts`
- `apps/server/tests/integrations.test.ts`
- `apps/server/tests/addons.test.ts`
- `apps/server/tests/om-tools.test.ts`
- `apps/server/tests/cli/addons.test.ts`
- `apps/studio/tests/addons.test.ts`
- `packages/contracts/src/addons/index.ts`

Job artifacts: plan.md (implementation file-map addendum), progress.md, report.md, baseline.json, change-summary.json, public-exports-needed.patch, typecheck.txt, typecheck-server.txt, typecheck-studio.txt.

## TESTS (written, not run)

- Server integrations: owner HTTP set/get, service scoped read, cross-workspace isolation, explicit clear, catalog unchanged, non-owner denied before manifest/SQL/body read, unknown names/invalid decimal formats/>100 entries/>4096 bytes with no inserted row, redacted diagnostics, invalid declaration preserves credential cards and refuses save.
- Server addons: actual composed plugin state receives saved metadata; invalid stored shape/format preserves non-null state and original metadata; empty override propagates.
- Server tools: valid get output, ownerOnly set, Allow/Cancel only, Always allow refused, second save needs a fresh card, authenticated owner identity on continuation, route coverage.
- CLI: get/set argv, exact stdin object/body routing, malformed/oversized stdin before HTTP.
- Studio: HTTP/sample empty declaration reads and unavailable writes; fake manifest fields load, non-secret inputs, textarea trim/key=value mapping with long identifiers preserved, explicit save acknowledgement, duplicate keys refused.
- TikTok strict manifest extension schema accepts optional conversionSettings.

No test suite, build, om:check, install, vendor call, or runtime/browser harness was run. Runtime verification and red/green execution are unproven because the owner explicitly forbids tests/builds in this run. Existing tests were not deleted or weakened; TikTok's extension parser adds only the new optional metadata key.

## TYPECHECK

- `corepack pnpm --filter @open-marketing/contracts typecheck` — EXIT 0 (one invocation).
- `corepack pnpm --filter @open-marketing/server typecheck` — EXIT 2 (one invocation). Missing public exports for conversion settings schemas/types, plus follow-on unknown/implicit-any/spread errors. Production-source stage failed, so test-file typechecking did not run.
- `corepack pnpm --filter @open-marketing/studio typecheck` — EXIT 2 (one invocation). Missing public exports and follow-on implicit-any. Production-source stage failed, so test-file typechecking did not run.

Raw evidence is in typecheck.txt, typecheck-server.txt, typecheck-studio.txt. No reruns: the scope-dependent export prerequisite is unresolved. One permitted rerun per application remains after exports land. Do not infer that hidden test/type errors are absent.

## CONTRACTS

Applied the review's exact additive Zod declarations/values/set/status schemas and their derived types in packages/contracts/src/addons/index.ts. No local copies, alternate import path or module augmentation. Query shape is derived with setConversionSettingsSchema.pick({ pluginId: true }). Only server integrations validates declared field kinds/formats/map cardinality/4096 UTF-8 bytes. Empty values clears the configuration.

HTTP GET/POST: /api/addons/v1/integrations/conversion-settings. Tools: integrations_conversion_settings_get / integrations_conversion_settings_set. Settings store is owner/workspace/plugin scoped, through existing om_owner_settings. Runtime merges only conversionConfiguration after existing admission/capability calculations. Invalid/absent declaration or saved row preserves all metadata and plugin availability; plugin-owned strict schemas still determine delivery readiness. DB exceptions retain existing propagation.

## REUSE

- Settings persistence: inspected OM alerts/provider-settings.ts scoped SQL/upsert; used the existing om_owner_settings table and injected CredentialSqlPort. No migration or repository abstraction.
- Installed discovery: extended parseCredentialCardManifest and reused the existing readCredentialCards path (disabled packages included). Conversion declaration parsing is separate from credential-card validation.
- Runtime: reused agentPluginState → installSettings → pluginConfiguration.settings; only metadata merge was added, no backend edits or bootServer complexity increments.
- Surfaces: reused integrationBoundary, serviceDefinition/ownerOnly approval continuation, CLI readBytes/requestOm, Studio addonRead/addonWrite, existing renderField, native textarea/FormData/String operations.
- Published Jini 0.6.15-rc.2 admin-surfaces exports were inspected; their iframe/handler host is not hosted in OM and is outside this approved scope. Existing action-schema subset lacks a dynamic record. Tovu apps/website admin-surfaces route/host search confirmed the same different integration model. Source-only ai-traces-jini ProviderConfigSource was read, not imported: unpublished and flat string settings cannot carry nested maps. /Users/la/Programming/Jini was not used for API facts per the newer binding source-of-truth instruction. No sibling source was copied.

## RISKS

- BLOCKING: application source currently fails typecheck because public barrel exports are missing; this is incomplete integration, not a clean delivery.
- Test files have not been typechecked or executed; fresh source typechecks stopped first. Tests may reveal further issues after exports are added.
- Validated generic formats are not vendor verification. Plugins retain their stricter identifier/required-setting checks.
- Installed plugin snapshots need refresh before forms appear; declaration edits alone affect bundled source, not every existing installed workspace copy.
- Conversion worker/producer and grant/consent/identifier dependencies remain owned by their other jobs. This job configures settings only; it does not claim production conversions flow.

## NEEDS / DEFERRED

1. **CONTRACTS EXPORTS (blocking):** authorize or have Coordinator apply public-exports-needed.patch to packages/contracts/src/index.ts, adding exactly:
   ```ts
   export { conversionSettingsDeclarationSchema, conversionSettingsValuesSchema, setConversionSettingsSchema, conversionSettingsStatusSchema } from './addons/index.js';
   export type { ConversionSettingsDeclaration, ConversionSettingsValues, SetConversionSettings, ConversionSettingsStatus } from './addons/index.js';
   ```
   review.md's final override adds only packages/contracts/src/addons/index.ts to the write list; LOCKS-FILES omits the root barrel. The exported public API is mandatory under COMMON §1. An asynchronous scope question was sent; no answer received. No deep import workaround used.
2. **INTEGRATION (Coordinator):** rebuild contracts dist, refresh installed workspace copies of google-ads/meta-ads/tiktok-ads to expose declarations. Fingerprint/source-hash rows and credential asset digests were preserved; JSON comparison against baseline confirms only conversionSettings changed in the three manifests. Coordinator owns any TikTok conversion fingerprint recomputation and plugin dist work.
3. **TYPECHECK (after exports):** use the remaining permitted rerun of server/studio typecheck; fix quick lane diagnostics including tests before claiming clean.
4. **JINI ASK (after rc.3):** when ProviderConfigSource is published, consider storing plugin settings behind it. It needs nested or map values (or a JSON-valued setting) to carry actionIds.
5. Runtime/test execution is deferred to an authorized environment, not silently claimed done. No migrations created/registered/applied, no package manifests or lockfile edited, no commit/push.

## DISPUTED

None of the feature-gap findings was disputed. The public-barrel omission is an execution-scope gap discovered in this build.

## HANDOFF

Status: PARTIAL / BLOCKED ON PUBLIC EXPORTS. Coordinator applies/authorizes the exact two-line patch, rebuilds contracts during integration, then the application typecheck reruns can expose remaining diagnostics. Preserve all existing dirty/untracked work and all other jobs' edits.

Architecture self-audit: WARNING due missing public-export integration; inspected all 24 changed source/config/test files against approved boundaries. Vendor names/keys remain in the three plugin manifests; core uses declaration metadata. No new lifecycle effects, ports, registries, timers, dependencies, migration, approval rule or visitor tracking. Existing shared serviceDefinition read-context handling was reused without adding a new principal adapter; writes use the real owner continuation.

Function-quality self-check (static; metrics tooling not run):

| Units | Disposition | Evidence / remaining finding |
| --- | --- | --- |
| validateConversionSettings / readStoredConversionSettings | NO_RECORDED_FINDINGS | Bounded strict values + scoped SQL; direct invalid/clear/round-trip tests written |
| conversionSettings / setConversionSettings / withConversionSettings | NO_RECORDED_FINDINGS | Explicit Outcome boundary; owner write before I/O; corrupt-state and scope cases written |
| parseCredentialCardManifest change | NO_RECORDED_FINDINGS | Bad declaration isolated; credential cards survive regression written |
| conversionSettingsDefinitions / inbound / CLI | NO_RECORDED_FINDINGS | Existing approval/session/read bounds; direct transport assertions written |
| conversionMap / conversionFormValues / useConversionSettings / rendering | NO_RECORDED_FINDINGS | Native text parsing, duplicate guard, no JSX-body callbacks; fake API form test written |
| Cross-package API | REQUIRED: PUBLIC_EXPORTS | Two export lines remain outside authorized scope; exact patch supplied |

Zero-findings skepticism: reviewed variable names against computed values, clearing versus absence, map duplicate behavior, long identifier preservation, credential form privacy, saved-state remounts and continuation identity; no additional local findings recorded. Runtime/coverage percentages, measured cognitive/cyclomatic complexity/NLOC are unavailable (no tests/lint/metric scripts run). Manual inspection keeps each added unit at ≤10 cognitive complexity / ≤3 nesting; no bootServer edits.

Documentation: documented public methods, exported merge helper and hook (usage examples), boundary effects/bounds; updated renderer privacy comment. Obvious forwarding lambdas inherit surrounding service/API documentation. No unrelated documentation refactor.

Pre-completion: requirements reviewed; scope and manifest-only changes checked against baseline; fresh typecheck evidence retained; test integrity preserved; open blocker explicitly disclosed. Runtime self-validation: not run (owner's no-tests/builds restriction plus unresolved public exports). Suggested next routing: Coordinator integration, then permitted typecheck reruns and cloud review after integration.
