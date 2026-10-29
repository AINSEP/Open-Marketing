Software Architect(Direct):

1. **Summary**

Add conversion settings to each plugin’s existing Integrations panel, with labelled fields and editable mapping rows. The owner can read and save the same settings through HTTP and `om` CLI; the assistant can propose changes through the existing owner-approval flow. Plugin manifests supply every vendor-specific name and validation constraint. Saving changes only workspace settings; TikTok delivery depends on its parallel plugin job.

2. **Files**

All paths below are planned edits; nothing was changed during planning.

- `apps/server/src/integrations.ts` — (edit) owner read/save methods and shared scoped settings reader.
- `apps/server/src/integration-credential-cards.ts` — (edit) expose optional conversion declarations through the existing installed-manifest reader.
- `apps/server/src/composition/addons.ts` — (edit) merge validated saved values into runtime metadata.
- `apps/server/src/inbound/integrations.ts` — (edit) authenticated GET/POST routes.
- `apps/server/src/addon-tools.ts` — (edit) extend the existing integration dependency type.
- `apps/server/src/om-tools.ts` — (edit) read/set tools using existing approval machinery.
- `apps/server/src/om-tool-coverage.ts` — (edit) register route/tool coverage.
- `apps/server/src/cli/addons.ts` — (edit) settings commands using the existing bounded stdin reader.
- `apps/server/src/cli/http.ts` — (edit) route definitions and response schemas.
- `apps/studio/src/pages/addons/model/integrations.hooks.ts` — (edit) load/save settings and mapping-row handlers.
- `apps/studio/src/pages/addons/ui/IntegrationsPage.tsx` — (edit) render declared fields and save feedback.
- `apps/studio/src/shared/api/types.ts` — (edit) settings API methods.
- `apps/studio/src/shared/api/http.ts` — (edit) validated HTTP calls.
- `apps/studio/src/shared/api/sample.ts` — (edit) equivalent per-instance sample behavior.
- `apps/studio/src/shared/api/sample-data.ts` — (edit) vendor-neutral declaration fixtures.
- `content/agent-plugins/google-ads/plugin.json` — (edit) declare `actionIds` mapping.
- `content/agent-plugins/meta-ads/plugin.json` — (edit) declare `datasetId`.
- `content/agent-plugins/tiktok-ads/plugin.json` — (edit) declare `pixelId`, subject to parallel-job agreement.
- `apps/server/tests/integrations.test.ts` — (edit) validation, persistence, authorization and HTTP regressions.
- `apps/server/tests/addons.test.ts` — (edit) installed-state override and reload regressions.
- `apps/server/tests/om-tools.test.ts` — (edit) assistant approval and coverage regressions.
- `apps/server/tests/cli/addons.test.ts` — (edit) command/stdin regressions.
- `apps/studio/tests/addons.test.ts` — (edit) shared sample/HTTP assertions and form behavior.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-settings/progress.md` — (new) implementation progress.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-settings/report.md` — (new) delivery evidence and remaining NEEDS.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-settings/typecheck.txt` — (edit) typecheck results.

3. **Public contracts**

Proposed shared schemas are Coordinator prerequisites; all types derive from Zod.

- Declaration: `{ fields: [{ name, label, hint?, kind: "string" | "string-map", format: "decimal-id" | "code", maxLength }] }`.
- Values: declared field names mapped to strings or string maps; maximum 100 map entries and 4 KiB serialized settings.
- Status: `{ pluginId, declaration: Declaration | null, values: Values | null }`.
- `Integrations.conversionSettings({ context, pluginId }, options?) → Promise<Outcome<Status>>`.
- `Integrations.setConversionSettings({ context, request: { pluginId, values } }, options?) → Promise<Outcome<Status>>`.
- `readStoredConversionSettings({ context, db, pluginId, declaration }) → Promise<Outcome<Values | null>>`; shared by management reads and runtime composition.
- `GET /api/addons/v1/integrations/conversion-settings?pluginId=…`.
- `POST /api/addons/v1/integrations/conversion-settings` with `{ pluginId, values }`.
- Tools: `integrations_conversion_settings_get({ pluginId })`; `integrations_conversion_settings_set({ pluginId, values })`.
- CLI: `om integrations conversion-settings get --plugin ID`; `… set --plugin ID` reads JSON from stdin. Both support `--json`.

4. **Approach**

1. Land the shared-schema prerequisite before starting this single build run.
2. Extend installed-manifest parsing with optional `conversionSettings` metadata. Reuse credential-field naming/copy conventions, keeping non-secret settings separate from credential storage.
3. Declare Google’s positive decimal action-ID mapping, Meta’s positive decimal dataset ID, and TikTok’s code field. Preserve identifiers as strings.
4. Validate complete replacements against the current declaration. Reject unknown fields, malformed values and oversized JSON before storage.
5. Store one row per owner/workspace/plugin in existing `om_owner_settings`, using a parameterized `conversion-settings.<pluginId>` key. No migration.
6. Read that row during `agentPluginState`; merge only validated values into `metadata.conversionConfiguration`. Existing `installSettings` → `pluginConfiguration.settings` carries them to plugins. Invalid stored overrides fail closed.
7. Add owner-authenticated HTTP and CLI access. Assistant reads use the existing scoped-read adaptation; saves use `ownerOnly: true` and the existing owner-approved continuation, without manufacturing owner identity.
8. Render manifest-labelled inputs and add/remove mapping rows in each existing plugin panel. Keep callbacks in the hooks file and show “saved,” without claiming vendor verification.
9. Write regressions covering scope isolation, denied callers before I/O, invalid declarations/values, persistence after reconstruction, no lifecycle effects, runtime propagation and assistant approval.
10. Typecheck each changed package once at the end; rerun only after fixing reported errors. Never run tests, builds or `om:check`.

5. **Reuse**

- **Storage:** extend OM’s `om_owner_settings` usage and scoped SQL pattern in `apps/server/src/alerts/provider-settings.ts`. The existing table limits values to 4 KiB.
- **Discovery:** extend `parseCredentialCardManifest` and `bindServerAddons.readCredentialCards`; these already read disabled installed packages without executing them.
- **Runtime:** retain `agentPluginState` → `installSettings` → `pluginConfiguration`; Google `conversions.ts:9` and Meta `capi.ts:14` already consume the required configuration.
- **Surfaces:** reuse `serviceDefinition`, owner approval continuation, `readBytes`, Studio `addonRead`/`addonWrite`, and existing integration hooks/forms.
- **Jini/Tovu search:** inspected Jini `CAPABILITIES.md`, settings contracts and agent-plugin admin surfaces, plus Tovu’s `admin-surfaces/public-config.ts` and `delivery-bindings.ts`. Their ledger/environment/handled-surface APIs do not provide this existing OM configuration path; no sibling implementation will be copied.
- Verified installed `@jini-ai/core` and `@jini-ai/agent-plugins` **0.6.15-rc.2** declarations. Jini’s closed action-schema subset cannot express this dynamic ID mapping and its validation helpers are not publicly exported.
- npm registry lookup was attempted but unavailable through both browsing and local DNS. No new dependency or OSS framework is proposed.

6. **Deliberately left out**

No settings framework, new repository port, registry, factory, migration, arbitrary JSON editor, vendor lookup, credential changes or automatic enablement. Settings remain per workspace/plugin, matching the existing install-level configuration contract. Conversion jobs, consent checks and spend approvals retain their existing owners.

7. **NEEDS**

- **CONTRACTS:** Coordinator adds and publicly exports `conversionSettingsDeclarationSchema`, `conversionSettingsQuerySchema`, `setConversionSettingsSchema`, `conversionSettingsStatusSchema`, their Zod-derived types, and pure `validateConversionSettings({ declaration, values }) → Outcome<Values>`. Support only the two declared field kinds/formats above, positive decimal IDs, bounded code strings, strict field matching and the 4 KiB limit.
- **TIKTOK:** W22-TIKTOK-CONVERSION-DELIVERY must consume `settings.conversionConfiguration.pixelId` through canonical `PluginCapabilityDependencies` and export `createConversionDelivery`. Current `events.ts:17` and `index.ts:10` use the older shape.
- **TIKTOK TEST:** Its owner must extend `tests/manifests.test.ts:12`, whose strict extension schema currently rejects the new declaration.
- **INTEGRATION:** Coordinate the three manifest locks with parallel plugin jobs; refresh installed packages so declarations become visible. Coordinator owns any packaging/dist work.
- No installs, manifest dependency edits or migration registration required.

8. **Unverified facts and risks**

No new vendor API behavior is proposed. Validation follows current plugin schemas; saving an ID does not confirm its existence, permissions or vendor acceptance. Missing configuration continues to prevent delivery. TikTok runtime closure remains deferred to its named parallel job; this run must report that dependency honestly. Verify fingerprint input lists before editing manifests: source/schema/asset fingerprints should remain unchanged when their inputs are unchanged.

9. **Size estimate**

One ≤90-minute build after prerequisites: **23 application/config/test files plus 3 reporting artifacts**. Approximately **450 source/manifest lines added, 220 test lines added, 20 lines removed**; roughly **+650 net**, excluding reports and Coordinator-owned contracts. No checks were run during this read-only planning phase.

## B1 implementation file-map record

Applied the final review override: packages/contracts/src/addons/index.ts is an additive edit. The other 23 source/config/test files are exactly the reviewed LOCKS-FILES (sample-data.ts cut; TikTok manifests.test.ts added by review). No packages/contracts/src/index.ts edit was made: scope authorization was requested and remains pending; exact required patch is in public-exports-needed.patch.

Job-directory artifacts edited/created in this run: plan.md, progress.md, report.md, baseline.json, change-summary.json, public-exports-needed.patch, typecheck.txt, typecheck-server.txt, typecheck-studio.txt. Full source/config/test file list is in report.md and change-summary.json.
