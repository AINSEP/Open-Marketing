# Trim review: 2026-10-29-w22-conversion-settings
VERDICT: APPROVED WITH CUTS

No coordinator-note.md exists. The plan's shape is right: manifest-declared fields, values in `om_owner_settings`, merged into the existing `metadata → installSettings → pluginConfiguration.settings` path, and HTTP + tool + CLI + Studio closed together. Checked against current code: the plugin `settings` come only from the installed plugin.json OM extension (composition/addons.ts:149-170 → agent-plugin-backends.ts:341-353). The conversion path reads the same state (agent-plugin-backends.ts:766-794 → `dependencies.state` = `addons.agentPluginState`, composition/index.ts:646). So today the only way to set `conversionConfiguration` is to edit plugin.json. The gap is real.

CUTS:
1. **`validateConversionSettings` in contracts (NEEDS CONTRACTS).** Only the server validates. Put it in apps/server/src/integrations.ts as a few lines that build a `z.strictObject` from the declaration (one Zod field per declared field), next to the existing declared-field check in `setPluginSecret` (integrations.ts:131-145). Contracts keep schemas only.
2. **`conversionSettingsQuerySchema`.** Use `setConversionSettingsSchema.pick({ pluginId: true })` at the HTTP and tool boundary. This is the same `{ pluginId }` shape as `pluginSecretQuerySchema` (contracts addons/index.ts:224). No new export.
3. **Per-field `maxLength` in the declaration.** Use one fixed bound in the values schema (≤128 chars per string, ≤100 map entries, ≤4096 serialized bytes).
4. **Studio "add/remove mapping rows" handlers.** Render a `string-map` field as one `<textarea>` with one `key=value` pair per line, and parse it in the hook (split each line on the first `=`, trim). Render `string` fields with the existing `renderField` (IntegrationsPage.tsx:~85). No row state or add/remove callbacks.
5. **The "scoped-read adaptation" (principal swap) for assistant reads.** The read takes only a valid scoped context, like `om_mail_provider_get` (om-tools.ts:699-701). The HTTP ingress already enforces the owner (inbound/integrations.ts:20-21). Don't copy the owner-principal manufacture in addon-tools.ts:69.
6. **`apps/studio/src/shared/api/sample-data.ts`.** Sample mode returns `{ pluginId, declaration: null, values: null }`, so no section renders. Tests pass their own fake API. No vendor-neutral fixture file edit.
7. **Tests to cut:** "persistence after reconstruction" (redundant with the SQL round-trip) and a separate "no lifecycle effects" test (fold it into the set test as one assertion). See APPROVED SCOPE item 8 for the surviving list.
8. **Tool descriptors/schemas in addon-tools.ts.** Define the two tools as a `serviceDefinition` pair in om-tools.ts, mirroring `mailProviderDefinitions` (om-tools.ts:695-705). The only addon-tools.ts edit is the `integrations` Pick type at addon-tools.ts:13. Nothing goes in `addonToolSchemas`, `integrationOAuthTools` or `addonRoutes`.

FIXES:
1. **Invalid stored values must not disable the plugin.** `agentPluginState` (composition/addons.ts:149) serves every tool, mail and model call, not just conversions. If the declaration or the stored row fails to parse, or the row is absent, leave the metadata unchanged: no `conversionConfiguration` merge, never `return null`, never throw. The plugin's own strict settings schema then refuses delivery (google conversions.ts:9, meta capi.ts:14). That is the fail-closed point. A DB error may propagate like the other reads in that function.
2. **Keep `agentPluginState` flat.** Do the merge in one exported helper in integrations.ts, e.g. `withConversionSettings({ context, db, metadata })`. Call it once, on the returned `metadata` only, after `agentCapabilities`/`admitted` are computed (addons.ts:163-169). Only the `conversionConfiguration` key changes; the declaration key stays as is. It uses the same scoped SQL as alerts/provider-settings.ts:45 (`owner_id=$1 AND workspace_id=$2 AND key=$3`) with key `'conversion-settings.' + pluginId` and the existing `ON CONFLICT … DO UPDATE` upsert (provider-settings.ts:104-105). No migration.
3. **A bad declaration must not break credential cards.** In integration-credential-cards.ts, don't add `conversionSettings` to the strict `extensionSchema` parse. A bad conversion declaration would then fail `parseCredentialCardManifest`, and with it every credential card and OAuth flow for that plugin. `safeParse` the declaration separately; if it is invalid, set `conversionSettings: null` on `CredentialCardManifest`.
4. **Set is owner-only, checked before any I/O.** `setConversionSettings` checks `principal.kind === 'owner' && principal.ownerId === scope.ownerId` before reading or writing, as `setOAuthClient` does (integrations.ts:67). It returns `forbidden` when the installed manifest has no declaration, and never touches the addon lifecycle or catalog. Error messages are fixed text and never echo values. The size is checked before the INSERT, because the table's CHECK (0006_alerts.sql:6) would otherwise throw → `limit_exceeded`.
5. **The TikTok manifest test is strict** (tiktok tests/manifests.test.ts:12, `z.strictObject` extension schema). This build already holds the w20-tiktok lock for plugin.json. Add `conversionSettings: z.record(z.string(), z.unknown()).optional()` (or `z.unknown().optional()`) to that schema in the same build, so the TikTok suite isn't left broken. This replaces the plan's "TIKTOK TEST" NEEDS. Google (boundaries.test.ts:14-25) and Meta (manifests.test.ts:8-37) are not strict; no edit needed.
6. **Fingerprints.** `schemaFingerprint` hashes source schemas, not plugin.json, so adding the `conversionSettings` key changes no fingerprint or `credentialAssets` digest. Don't recompute anything. Edit only the OM extension object.
7. **Declarations must match the plugin consumers exactly** (field name = `conversionConfiguration` key):
   - Google `actionIds`: `string-map`, `decimal-id`. Matches conversions.ts:8, `record(idSchema, /^[1-9][0-9]{0,18}$/)`.
   - Meta `datasetId`: `string`, `decimal-id`. Matches capi.ts:14.
   - TikTok `pixelId`: `string`, `code`. Matches the W22-TIKTOK-CONVERSION-DELIVERY plan.md:34.
   - Labels and hints are plain owner copy, with no vendor names in apps/*.
8. **Typecheck at the end:** once for apps/server and once for apps/studio, with one re-run allowed. The plugin edits are JSON plus one test line, so no plugin-package typecheck. Never run tests, builds or om:check.
9. **The build must not start until Coordinator has landed the CONTRACTS NEEDS below.** If they are missing at start, stop and report. Don't define local copies.

REUSE:
- Owner settings storage → `om_owner_settings` scoped SQL and upsert, apps/server/src/alerts/provider-settings.ts:45-47 and :104-108. Read the pattern only; don't edit that file (it is in the w14-alerts lane).
- Read/set tool pair with ownerOnly and an ownerRoute → `mailProviderDefinitions`, om-tools.ts:695-705; coverage rows → om-tool-coverage.ts:14, :33-34.
- Declared-field owner ingress and query-by-pluginId → plugin-secret: integrations.ts `setPluginSecret`/`pluginSecretStatus` (:55-62, :131-145); inbound/integrations.ts:22-23, :57-67.
- CLI subcommand with a JSON body on stdin → `integrations plugin-secret` (cli/addons.ts:120, :153, :~220-235); routes table → cli/http.ts:39-41.
- Installed-manifest reader that also covers disabled packages → `readCredentialCards` (composition/addons.ts:123-129) + `parseCredentialCardManifest` (integration-credential-cards.ts:23).
- Runtime delivery → the unchanged `installSettings` → `pluginConfiguration.settings` path (agent-plugin-backends.ts:341-353; conversion path at :766-794).
- Studio form → `PluginSecretForm`/`usePluginSecret` (IntegrationsPage.tsx:93-101) and `renderField`; mount inside `PluginCards` (IntegrationsPage.tsx:57-65).
- HTTP routing → the existing prefix dispatch (composition/index.ts:224, inbound/owner.ts:420). No router edit.

DUPLICATES:
- Jini rc.2 admin surfaces (`@jini-ai/agent-plugins/admin-surfaces`, dist/admin-surfaces/index.d.ts:8-22): plugin-owned sandboxed admin UI + handler modules + plugin state (`storedStateValue`, settings-value.d.ts) + `buildAdminSurfaceActionTools`. Published, but it is a different model (an iframe surface host plus plugin handler modules), and OM hosts none of it today (no OM import). Adopting it is a new host integration, not this job. NOT reused; see OWNER DECISIONS 3.
- Jini rc.2 action-schema validator (dist/contracts/admin-surface-action-schema.d.ts:11-50): closed objects only (no map/record), no `pattern`, and `checkAdminSurfaceActionSchema`/`validateAdminSurfaceActionValue` are not in any package export (package.json exports `./admin-surfaces` re-export only the type). It can't express `actionIds` and isn't reachable. The plan's claim is confirmed.
- Jini rc.2 site-plugin `settings` contribution key (`@jini-ai/plugins` host/manifest.d.ts:57, `CONTRIBUTION_KEYS`): applies to jini.plugin.json site plugins, not agent plugins. Not applicable.
- Jini source rc.3 (ai-traces-jini, source-only) `ProviderConfigSource`/`ProviderSettingsView`/`ProviderPluginConfig` (packages/plugins/src/host/provider-config-source.ts:12-38): storage-neutral saved settings per provider plugin, `settings: Record<string,string>` keyed by declared names. Unpublished, and a flat string map that can't hold Google's `actionIds` map. Keep the OM code. JINI ASK NEEDS below.
- Tovu: website admin-surface host (apps/website/.../agent-plugin-admin-surfaces) and google-workspace surfaces. These host Jini admin surfaces and aren't reachable from OM.
- OM-internal: the mail-provider settings and plugin-secret stacks above are the patterns to copy. There is no existing conversion-settings surface.

OWNER DECISIONS (defaults):
1. Settings scope is per owner/workspace/plugin, not per connection or ad account. This matches the install-level `settings` contract. Default: per workspace/plugin. If the owner later binds several Google accounts, per-account mapping is a later job.
2. An assistant save uses the existing ownerOnly exact card (never Always allow; om-tools.ts:378). Default: yes. The Studio/HTTP/CLI save is direct owner ingress.
3. Jini admin surfaces as the long-term "plugin owns its settings UI" path. Default: not now. Revisit when OM hosts admin surfaces.
4. **Overlap with W22-GRANT-SURFACES** (it may list conversion grants "where conversions are configured"; there is no measure page in apps/studio/src/pages/ — only addons, leads, tracking). Default:
   - This job owns the per-plugin "Conversion settings" section in IntegrationsPage/integrations.hooks.ts and renders no grants.
   - Grant-surfaces puts its grant list in its own component and hook files (e.g. pages/addons/ui/ConversionGrants.tsx + model/conversion-grants.hooks.ts), with a one-line mount, and must not edit the settings section.
   - Both jobs take w13-om-tools, w14-surface and w22-studio-pages, so the Coordinator serializes them. The second build merges on top of the first.
5. Clearing settings: `values: {}` replaces the row (no `null` variant). The merged empty `conversionConfiguration` is refused by the plugin, the same as absent. Default: yes.

APPROVED SCOPE for B1:
1. **Precondition:** the CONTRACTS NEEDS below are landed. Write progress.md before each item.
2. **Manifest declarations.** Add to the OM extension of:
   - content/agent-plugins/google-ads/plugin.json: `"conversionSettings": { "fields": [{ "name": "actionIds", "label": "Conversion action IDs", "hint": "One OM conversion definition = numeric action ID per line", "kind": "string-map", "format": "decimal-id" }] }`
   - content/agent-plugins/meta-ads/plugin.json: `datasetId`, `string`, `decimal-id`.
   - content/agent-plugins/tiktok-ads/plugin.json: `pixelId`, `string`, `code`.

   Then make the TikTok manifests.test.ts strict-schema edit (FIX 5). No fingerprint changes.
3. **integration-credential-cards.ts:** add an optional `conversionSettings: ConversionSettingsDeclaration | null` to `CredentialCardManifest`, parsed separately with safeParse (FIX 3).
4. **integrations.ts:**
   - `conversionSettings({ context, pluginId }, options?)`: scoped read; returns the declaration (via `readCredentialCards`) and the stored values (null if absent or invalid).
   - `setConversionSettings({ context, request }, options?)`: owner check first, strict values built from the declaration, size check, upsert (FIX 4).
   - Exported helper `withConversionSettings({ context, db, metadata })` (FIX 1-2).
   - Results go through `integrationBoundary`.
5. **composition/addons.ts:** one call to `withConversionSettings` on the returned metadata in `agentPluginState`, passing `required.db`.
6. **Surfaces:**
   - inbound/integrations.ts: two cases, `GET`/`POST /api/addons/v1/integrations/conversion-settings`.
   - cli/http.ts: two routes, `integrationConversionSettings` / `setIntegrationConversionSettings`, with the status schema.
   - om-tools.ts: `serviceDefinition` pair `integrations_conversion_settings_get` (policy read) and `integrations_conversion_settings_set` (policy write, `ownerOnly: true`, ownerRoute the set route).
   - om-tool-coverage.ts: route map and two capability rows.
   - addon-tools.ts:13: add the two methods to the Pick.
   - cli/addons.ts: `om integrations conversion-settings get|set --plugin ID`, with `set` reading a JSON values object from stdin through the existing bounded reader. Add it to the shapes and help.
7. **Studio:**
   - shared/api/types.ts and http.ts: two methods, validated with contracts schemas.
   - sample.ts: returns null declaration/values and rejects set as unavailable.
   - integrations.hooks.ts: `useConversionSettings` (load, textarea parse, save, "Saved" status; no vendor verification claim).
   - IntegrationsPage.tsx: a `ConversionSettingsForm` inside `PluginCards`, rendered only when there is a declaration. Values are not secret, so no `data-private`.
8. **Tests (written, not run):**
   - integrations.test.ts:
     - owner set+get round-trip;
     - other workspace sees null;
     - non-owner set → forbidden before any SQL;
     - unknown field / bad format / >100 entries / >4 KiB → invalid_input or limit_exceeded, with no row written;
     - no declaration → forbidden;
     - addon catalog unchanged after set.
   - addons.test.ts: `agentPluginState` metadata carries the saved `conversionConfiguration`; an invalid stored row leaves metadata unchanged and the state non-null.
   - om-tools.test.ts: the set tool is ownerOnly and never auto-allowed; the get tool output validates.
   - cli/addons.test.ts: get/set argv and stdin body routing.
   - studio addons.test.ts: the textarea parse and save calls the API with a map.
9. **Final:** one typecheck each for apps/server and apps/studio; report.md with NEEDS and net lines.

NEEDS:
- **CONTRACTS** (Coordinator, before B1; packages/contracts/src/addons/index.ts after `pluginSecretStatusSchema`; reuse the module's existing `name`, `text`, `idSchema`):
  ```ts
  /** Plugin-declared, non-secret conversion settings; declarations grant no authority. */
  export const conversionSettingsDeclarationSchema = z.strictObject({ fields: z.array(z.strictObject({ name, label: text, hint: text.optional(), kind: z.enum(['string', 'string-map']), format: z.enum(['decimal-id', 'code']) })).min(1).max(8)
   .refine(fields => new Set(fields.map(field => field.name)).size === fields.length) });
  export type ConversionSettingsDeclaration = z.infer<typeof conversionSettingsDeclarationSchema>;
  export const conversionSettingsValuesSchema = z.record(name, z.union([z.string().min(1).max(128), z.record(idSchema, z.string().min(1).max(128))]));
  export type ConversionSettingsValues = z.infer<typeof conversionSettingsValuesSchema>;
  export const setConversionSettingsSchema = z.strictObject({ pluginId: idSchema, values: conversionSettingsValuesSchema });
  export type SetConversionSettings = z.infer<typeof setConversionSettingsSchema>;
  export const conversionSettingsStatusSchema = z.strictObject({ pluginId: idSchema, declaration: conversionSettingsDeclarationSchema.nullable(), values: conversionSettingsValuesSchema.nullable() });
  export type ConversionSettingsStatus = z.infer<typeof conversionSettingsStatusSchema>;
  ```
- **TIKTOK** (W22-TIKTOK-CONVERSION-DELIVERY): consume `settings.conversionConfiguration.pixelId` (its plan.md:34 already does). Both jobs edit tiktok plugin.json, serialized by the w20-tiktok lock. Each preserves the other's edit.
- **INTEGRATION** (Coordinator): installed workspace copies of the three bundled plugins must be refreshed so the new `conversionSettings` declarations become visible. Version stays 0.1.0, so check `reconcileAgentPluginUpdates`/seed behaviour.
- **GRANT-SURFACES:** see OWNER DECISIONS 4.
- **JINI ASK (after rc.3):** when `ProviderConfigSource` (ai-traces-jini packages/plugins/src/host/provider-config-source.ts) is published, consider storing plugin settings behind it. It needs nested or map values (or a JSON-valued setting) to carry `actionIds`.

LOCKS-FILES: apps/server/src/integrations.ts, apps/server/src/integration-credential-cards.ts, apps/server/src/composition/addons.ts, apps/server/src/inbound/integrations.ts, apps/server/src/addon-tools.ts, apps/server/src/om-tools.ts, apps/server/src/om-tool-coverage.ts, apps/server/src/cli/addons.ts, apps/server/src/cli/http.ts, apps/studio/src/pages/addons/model/integrations.hooks.ts, apps/studio/src/pages/addons/ui/IntegrationsPage.tsx, apps/studio/src/shared/api/types.ts, apps/studio/src/shared/api/http.ts, apps/studio/src/shared/api/sample.ts, content/agent-plugins/google-ads/plugin.json, content/agent-plugins/meta-ads/plugin.json, content/agent-plugins/tiktok-ads/plugin.json, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/tests/manifests.test.ts, apps/server/tests/integrations.test.ts, apps/server/tests/addons.test.ts, apps/server/tests/om-tools.test.ts, apps/server/tests/cli/addons.test.ts, apps/studio/tests/addons.test.ts, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-conversion-settings/ (lock groups: w13-server-composition, w13-om-tools, w14-surface, w14-gmeta-plugins, w18-google, w20-tiktok, w22-studio-pages)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted.
2. CONTRACTS: the BUILD applies the exact contracts text from NEEDS "CONTRACTS" itself (packages/contracts/src/addons/index.ts, additive only) while holding w14-contracts, then runs `corepack pnpm --filter @open-marketing/contracts typecheck` once before the server/studio typechecks. Add packages/contracts/src/addons/index.ts to the edited files. Coordinator rebuilds the contracts dist at integration.
3. Studio layout with w22-grant-surfaces: this job owns the per-plugin "Conversion settings" section on IntegrationsPage and renders no grants.
4. TikTok plugin.json: this job's declaration edit runs under w20-tiktok after w22-tiktok-conversion-delivery (serialized by the lock); do not touch the conversion fingerprint rows (coordinator recomputes).
