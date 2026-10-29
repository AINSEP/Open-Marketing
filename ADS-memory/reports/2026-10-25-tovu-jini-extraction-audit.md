# Tovu ↔ OM: Jini extraction inventory — 2026-10-25

The strongest new extraction is the sidebar blank-click behavior. Credential-card display metadata is a smaller second candidate, provided its shared subset leaves each application's save rules intact. Site-guide, chat, mail-provider, admin-surface and coverage foundations already exist in installed Jini 0.6.12; do not rebuild them. Theme catalogs and whole application shells should stay with their applications.

This is an inventory, not an extraction or adoption approval. Only this report changes. No source, contracts, dependencies, migrations or configuration change; no tests, builds, installs, application startup or vendor operations ran.

## Inputs and evidence limits

- Scope: [approved plan][plan], [review: build directly from plan][review], and the nine candidates in [todos][todos].
- Binding constraints: [owner decisions][owner], [architecture debate including round 3 and final owner decisions][debate], [target architecture][architecture], and [COMMON.md][common] unchanged. The round-2 Opus/Codex/Gemini sketches were consulted as supporting context; final owner decisions win.
- Discovery used bounded direct reads and `rg`, as required by this run. No graph index or indexing tool was used. Immediate imports, composition callers and selected tests were inspected; this is not an exhaustive dependency audit.
- Inspected working trees: OM HEAD `6032eb4`, Tovu HEAD `d3226c55e`, Jini HEAD `a1a5b71ff`. Parallel edits exist, including OM themes/chat tests. References describe the inspected tree, not a frozen release or runtime observation.
- [Jini CAPABILITIES.md][capabilities] is dated 2026-10-07 and indexes source. Its omissions do not establish a missing capability: installed `agentic` site-guide and `platform` mail-provider implementations are more complete than that map.
- Local package metadata, export maps, declarations **and implementation JS** were checked. OM resolves ui/chat/platform/agentic/agent-plugins 0.6.12; Tovu additionally supplies installed admin/devops 0.6.12 for inspection. Neither admin nor devops is installed in OM's pnpm store.
- **Registry-confirmed: none.** Bounded registry requests for agentic/devops/admin failed through the web tool; a separate UI metadata request failed with `curl: (6) Could not resolve host: registry.npmjs.org`. These failures do not prove absence. Current npm availability remains unverified; no download or version upgrade is proposed here.
- **Working-tree-only candidates:** the sidebar and credential metadata additions proposed below have no matching implementation found in the inspected Jini package source. Existing source tests are evidence of intended behavior, not passing results.

## Ranked inventory

Rank favors demonstrated reuse, then a clean boundary and a small next action. High/medium/low are qualitative judgments, not calculated scores. “Cleanliness” rates the remaining extraction, not Jini's existing foundation.

| Rank / candidate | Tovu evidence | OM consumer | Installed Jini coverage/version | Reuse value | Separation cleanliness | Recommendation | Uncertainty |
|---|---|---|---|---|---|---|---|
| 1. Sidebar empty-click / rail hook | [hook][t-sidebar], called by `App.tsx`'s `SidebarBlankClickToggle` | [adaptation][om-sidebar], called by `Shell.hooks.ts` | admin 0.6.12 has Sidebar/useSidebar/useSidebarRail; [public component][j-sidebar] lacks this gesture | High: same behavior already duplicated | High: decision plus DOM listener lifecycle | Add a small opt-in UI helper, ask S1 | Selector and cross-document differences need paired fixtures |
| 2. Site guide / capability cards | [host composition][t-guide], [facts][t-facts], pointer text | [runOmSiteGuide][om-guide], server composition and `site_guide` MCP tool/resource | agentic 0.6.12 already exports [createSiteGuide/parseGuideTopics][j-guide] | High: both expose overview/explain with fresh facts | Medium: wire shapes and authority timing differ | Reuse review of existing engine; no new engine ask | Replacement must preserve OM's post-await authorization and cancellation |
| 3. Credential / connection cards | [descriptor parser][t-cards], [form builder][t-card-form], connect-card UI | [manifest parser][om-cards] → `integrations.ts` plugin-status DTO | ui 0.6.12 [secret-card][j-secret] and surfaces already own form/save/outcome mechanics | High for common display metadata | Medium: save kinds, fields and URLs differ | Extract only shared display validation, ask S2 | OM studio still uses its own connection forms; shared rendered UI is unproven |
| 4. Chat-pane wiring | App mounts [AssistantDock][t-chat]; panels holds application screen declarations | [OMChatPane][om-chat] and its hooks | chat 0.6.12 [ChatPane/useChatPane][j-chat] plus controlled runtime and render slots | High, already realized at component level | Medium for residual host wiring | Keep app adapters; reuse existing pane/hooks | No second identical residual hook established |
| 5. Route / tool coverage | [pure classifier][t-parity] and `check-route-tool-parity.ts` | [generateOmToolCoverage][om-coverage] → CLI inventory and server tests | No equivalent parity export found in inspected devops map/export surface; coverage package solves another problem | Medium: same missing-capability concern | Medium: different input and status semantics | Defer new extraction until a lossless shared classifier is demonstrated | OM has no Tovu-style mapping file or suggestion consumer |
| 6. Test rigor / coverage scripts | [HEAD inventory][t-rigor], LCOV integrity/floor scripts | [output provenance checks][om-integrity], package test scripts | devops 0.6.12 already supplies [LCOV/floors/diff/integrity/disk checks][j-coverage] in Tovu | Medium for coverage; inventory's second consumer unproven | Low for whole script; high for existing pure coverage checks | Reuse coverage exports when separately needed; defer inventory extraction | OM output receipts are not LCOV contamination checks |
| 7. Themes / accent swatches | [manifest registry][t-themes] → theme hooks/settings | [static choices][om-themes] + `accents.css` → appearance/preferences/settings | ui 0.6.12 [theme][j-theme] validates/applies palettes, fonts, density and color scheme | Medium for primitives, low for catalogs | Low for a common catalog: different models | Keep palettes, previews and accent catalogs local | No meaningful duplicated algorithm beyond small lookup/default logic |
| 8. Plugin admin surfaces / exports host | [thin surface adapter][t-surfaces] and handler/capability bindings | [plugin-host.ts][om-plugin] handles executable plugins/chart assets, not Agent Plugin admin frames | agent-plugins 0.6.12 [admin-surfaces][j-surfaces] already owns descriptors, protocol and handler host; OM uses plugins/host separately | Medium future value; current second frame host absent | Low for Tovu host bindings | No new framework; use existing Jini seam only if OM needs frames | Ordinary plugins and Agent Plugin admin surfaces are different consumers |
| 9. Mail adapters | [registry][t-mail], content-owned [Resend declaration][t-mail-declaration] and vendor module | [Resend commands][om-mail] and Amazon SES account/domain reads; future alert delivery | platform 0.6.12 [mail provider registry/contracts/policy][j-mail], SMTP; lifecycle contributes providers | Future medium; current sender reuse unproven | Low for Tovu registry as a whole | Keep vendor code in plugins; reuse existing mail contract for a future approved sender | No current OM Resend send command or Tovu manifest consumer |

## Smallest shared behavior and application remainder

### 1. Sidebar

Both implementations ignore controls, non-primary/prevented clicks, text selections and drags; desktop blank space calls the existing rail toggle. They use two native listeners and remove them on cleanup. Both currently use the 901px desktop breakpoint and a four-pixel drag threshold.

Tovu additionally excludes inert `.cms-item` rows and uses `instanceof Element`; OM accepts an injected document/media port and structural target checks for cross-document use. Share the click decision/listener lifecycle, preserving these host differences. Storage keys, breakpoint ownership, navigation rows and the rail preference stay local. OM need not acquire the entire admin package for one gesture.

### 2. Site guide

Tovu's composition already resolves `createSiteGuide` from `@jini-ai/agentic`; its structural local interfaces are not proof of an upstream gap. Installed `dist/core/index.js` re-exports the engine; its JS combines bounded cards, filters permissions and reads facts through host ports. Tovu's guide facts, plugin admission and pointer prose remain Tovu-owned.

OM's result has versioned topic/capability/fact projections, fixed tool mappings, scoped dispatch, cancellation and repeated authorization checks. Jini returns topics/facts/callerPermissions/enrichment and caches each permission within a request. This is not a drop-in replacement. A separate reuse job must preserve OM's boundary schemas and final authority checks; do not copy Tovu's plugin topics or introduce enrichment OM does not need.

### 3. Credentials

The demonstrated common subset is bounded title/label/intro/help copy, optional key hints, public field descriptions and `usedFor` (both cap it at eight strings of 120 characters). Tovu's parser uses lifecycle contribution loading; OM binds identity/saveTarget to the installed package and verifies declared icons. Those host responsibilities remain outside shared display metadata.

Tovu save kinds include API, publish-host, source-control and agent-plugin-token; OM has OAuth client, developer-token, API-key and multi-field app credentials. Tovu's `permissions` is text; OM's is an array. OM also rejects secret-looking help URL query keys and supports integer fields. A universal schema/save router would change behavior. Installed `defineSecretCardTool` already handles human-only exchange/save/outcome and rejects prefilled secrets; no second lifecycle is needed.

OM's current [studio integration form][om-integration-ui] is not a generic descriptor renderer. The concrete second consumer for S2 is the server parser/status projection, not a claim that the same card UI is already mounted in both apps.

### 4. Chat

Tovu's actual pane consumer is `components/AssistantDock/AssistantDock.tsx`, reached from App; `panels.tsx` is the screen/navigation catalog, not a neutral chat controller. Both apps already compose Jini ChatPane, ChatSettingsDialog and JiniChatProvider. Installed pane JS delegates composer, conversation and send handling to existing hooks.

Keep Tovu's CMS refresh, credentials, voice, execution policy and panel navigation local. Keep OM's server session/history, exact approval slots, sample mode and chart-plugin adapters local. No forwarding “shared dock” layer or extraction of the entire App/panels files is justified. Existing queued vendor/effort/cost asks should not be duplicated by this inventory.

### 5. Route / tool coverage

Tovu's classifier takes live routes, tool IDs and reviewed mapping entries; it reports stale/unknown/malformed entries, gaps and untriaged routes. Its seeder's route tokens, feature aliases, verbs and chatless vocabulary carry Tovu conventions. The runner boots Tovu's hermetic app and inspects its router; it is not portable as-is.

OM derives rows from tool definitions plus its owner-route table and explicit capability NEEDS, including unadmitted/internal states and missing financial bindings. Preserve that single catalog. A generic set comparison may eventually fit devops, but adding a hand-maintained parity file or importing Tovu's seeding heuristics would create a second OM source of truth. No upstream ask until both callers can use the same small function without losing these distinctions.

### 6. Test rigor / coverage

Tovu's inventory is a roughly 960-line executable: git HEAD blob reads, custom lexical/import analysis, suspect-tag heuristics, runner selection and folder-disjoint shards. It hardcodes Tovu aliases, trees and commands. OM has no equivalent inventory consumer demonstrated here; do not transplant it or first build a configuration framework around it.

Installed devops 0.6.12 already contains LCOV parsing, aggregate floor evaluation, diffs, disk inventory and baseline-aware contamination checks. Their declaration and JS exports were verified in Tovu's installed package. OM's generated-output receipts/source digests answer provenance/freshness, so they are not a duplicate to replace with LCOV checks. Coverage thresholds, file classification, test commands and debt ledgers remain host-owned. No new analyzer, parser or dependency is proposed.

### 7. Themes

Tovu's registry currently lists Classic and carries stylesheet/font manifests, scheme availability and richer swatches. OM's registry carries static theme previews and four accent choices, backed by local token CSS; a parallel OM Ink addition is visible in the inspected tree. Do not move those brand choices or either theme catalog into Jini.

Installed `ui/theme` already supplies theme validation, palette/font application with cleanup and injected color-scheme resolution. That contract is not the same as either catalog's preview metadata. A trivial lookup/default helper or shared color list does not justify a new registry API. Future token-contract gaps require two concrete consumers and evidence that existing primitives cannot express the need.

### 8. Plugin admin surfaces

Tovu's adapter imports Jini's contribution definition, file reader and handler host. Jini already owns declared paths, iframe/message protocol and action machinery. Tovu adds workspace/session checks, same-origin handling, forms, delivery bindings and issued sign-in collection; these are product adapters, not a missing generic host.

OM's executable-plugin host already delegates installation, discovery, claims, loading and contribution capture to `@jini-ai/plugins/host`. It also retains chart assets under the owner's unrestricted upload policy. No Agent Plugin admin-surface consumer was found in OM's inspected runtime. Do not import Tovu's bundled-only gate or sandbox policy into OM, or equate this future frame use case with ordinary plugin loading. Any future use of Jini frames must reconcile the owner's decisions explicitly in its own job.

### 9. Mail

Tovu's registry parses `tovu-mail-adapters.json`, bridges a legacy positional mailer ABI, resolves Tovu credential labels and enforces Tovu's shipped-package trust rule. The Resend descriptor/provider is content-owned. Those rules are not a neutral OM loader contract.

Installed platform 0.6.12 already provides `MailerPort`, provider modules/registry, explicit transactional/bulk selection, purpose/policy helpers, feedback and SMTP. Its provider implementation validates capability claims against code. OM's Resend adapter currently exposes only domain list/status reads, and SES exposes account/domain reads. The binding debate names future owner-alert email under a ServiceGrant; that planned use does not establish an implemented shared sender. Keep vendor transports/codecs in agent plugins, and OM consent, caps, audit and sole outbox in OM. Do not extract a second mail registry or a vendor into Jini core.

## Additive upstream asks for a separately approved Jini job

| Ask | Concrete consumers / existing home | Minimum scope | Compatibility and evidence required |
|---|---|---|---|
| S1 — opt-in sidebar blank-click helper | Tovu App sidebar + OM studio Shell; existing `@jini-ai/ui` browser hooks surface | Plain click decision and disposable listener binding, with a narrow React wrapper only for the two actual hook consumers | Default existing Jini Sidebar behavior unchanged. Retain both applications' row exclusions, primary/prevented clicks, selection, drag threshold, desktop predicate, missing-nav and cleanup behavior. Inject browser dependencies; preserve OM's cross-document handling. |
| S2 — credential-card display metadata subset | Tovu `parsePluginCredentialCards`/form builder + OM `parseCredentialCardManifest`/status DTO; existing `@jini-ai/agent-plugins` data contributions, alongside existing UI secret-card mechanics | A bounded data-only display schema for fields both callers actually consume; derive types from its schema | Additive/opt-in; preserve each host's existing bounds, optionality and stricter checks. No shared save kinds, routing, store, credentials or admission. Paired fixtures must retain Tovu's existing declarations and OM's identity/URL/field rejection rules. If no useful subset remains without translation overhead, leave S2 deferred. |

These are requests for upstream assessment, not new package names or designed APIs. Use existing package homes; avoid a registry/service/options framework. Implement and test in Jini first, publish to npm, then assign OM adoption separately. Never link the sibling checkout. No proposed release version is invented.

## Existing test evidence inspected; nothing executed

| Area | Existing evidence and what it establishes on inspection |
|---|---|
| Sidebar | [Tovu gesture tests][t-sidebar-tests] cover inert rows, drag/selection/mobile and cleanup; [OM shell tests][om-sidebar-tests] cover decisions, listener behavior and persisted rail usage. Reuse both fixture sets for S1, including cross-document and cleanup cases before adoption. |
| Credentials | [Tovu card tests][t-card-tests] cover bounds, identity/store matching, duplicate targets and safe field submission; [OM card tests][om-card-tests] cover whole-manifest/field/identity bounds and icon validation. S2 must preserve accepted/rejected cases for both. |
| Site guide | [Tovu fact tests][t-fact-tests] check permission denial, requested-topic reads and unknown facts; [OM guide tests][om-guide-tests] cover scope, cancellation/revocation, sanitized output and HTTP/CLI/MCP resource access. Preserve these before any engine replacement. |
| Chat | [OM parity tests][om-chat-tests] exercise controlled runtime/effort, plugin context and exact-card presentation; Tovu's AssistantDock tests include send/stop and draft/attachment restoration. They do not demonstrate an identical residual controller. |
| Themes | [Tovu registry tests][t-theme-tests] assert Classic defaults/swatches; [OM theme tests][om-theme-tests] assert token-only styling and theme boundaries. Different catalogs are intentional evidence against catalog extraction. |
| Admin surfaces | [Tovu source tests][t-surface-tests] cover active lifecycle source, contained reads and plugin/surface identity. OM executable-plugin tests exercise a different host; no paired OM frame suite was found. |
| Mail | [Tovu registry tests][t-mail-tests] cover enabled/trusted modules and malformed descriptors; OM Resend's [dispatch tests][om-mail-tests] target its read adapter. Neither establishes OM delivery through Tovu's provider loader. |
| Coverage / rigor | Jini's [coverage tests][j-coverage-tests] include contamination fixtures; Tovu inventory was read as source only. No OM consumer of its HEAD/sharding heuristics was established. |
| Route parity | [Tovu classifier tests][t-parity-tests] cover stale/unknown/malformed entries and suggestions; [OM inventory test][om-coverage-tests] checks route/catalog coverage and explicit NEEDS. These are distinct output contracts, not an interchangeable shared suite. |

## Handoff, risks and verification

- **CHANGED FILES:** this report only; source LOC 0, test LOC 0. Existing dirty/untracked application work is preserved.
- **TESTS:** none written or run for this documentation-only scope. Test references above were read; future acceptance cases are recommendations, not added tests or red/green evidence.
- **TYPECHECK:** dispatch substitutes `ls ADS-memory/reports`; this is only a directory-presence check, not a compiler/typecheck. Its execution/result belongs in the final handoff. No test suite, om:check, build or install is authorized.
- **CONTRACTS / MIGRATIONS:** none changed. Architecture audit: PASS for this artifact's single-file scope, published-package boundary, server authority and plugin ownership; no runtime compliance or functional pass is claimed.
- **RISKS:** inspected trees may change; local installation does not confirm current publication; similar UI/data shapes can hide different authority, trust and delivery semantics. Site-guide adoption particularly needs authorization/cancellation parity.
- **NEEDS / deferred:** verify npm artifacts before any adoption; assess S1 and S2 upstream; separately authorize any OM reuse change. Defer parity/inventory frameworks, shared theme catalogs, whole chat shells, generic frame-host wiring and mail-loader extraction absent the second consumer described above.
- **HANDOFF:** Coordinator → `tovu-ed` / Jini owner with S1/S2 and installed-capability findings. No message was sent to another session. Jini owns assessment, implementation and release; OM integrator owns any later dependency/lockfile/composition changes. This run commits/pushes nothing.

## Source references

Local links point to the inspected files; installed distribution links deliberately identify the consumer's resolved package rather than sibling source as a runtime dependency.

[plan]: ../.local-artifacts/codex-runs/2026-10-25-w2-tovu-jini-audit/plan.md
[review]: ../.local-artifacts/codex-runs/2026-10-25-w2-tovu-jini-audit/review.md
[todos]: ../todos.md#queued--tovu--jini-extraction-audit-owner-2026-10-24
[owner]: ../.local-artifacts/codex-runs/2026-10-13-owner-decisions.md
[debate]: ./2026-10-25-om-architecture-debate.md
[architecture]: ./2026-10-01-om-target-architecture-v2.md
[common]: ../../development/COMMON.md
[capabilities]: /Users/la/Programming/Jini/CAPABILITIES.md
[t-sidebar]: /Users/la/Programming/Tovu/apps/admin/src/hooks/use-sidebar-empty-click-toggle.hooks.ts
[om-sidebar]: /Users/la/Programming/Open-Marketing/apps/studio/src/app/shell/sidebar-blank-click.hooks.ts
[j-sidebar]: /Users/la/Programming/Tovu/apps/admin/node_modules/@jini-ai/admin/dist/react/components/Sidebar.d.ts
[t-guide]: /Users/la/Programming/Tovu/apps/website/src/server/runtime/composition/site-guide.ts
[t-facts]: /Users/la/Programming/Tovu/apps/website/src/features/site-guide/facts.ts
[om-guide]: /Users/la/Programming/Open-Marketing/apps/server/src/site-guide.ts
[j-guide]: /Users/la/Programming/Open-Marketing/apps/server/node_modules/@jini-ai/agentic/dist/core/site-guide/site-guide.js
[t-cards]: /Users/la/Programming/Tovu/apps/website/src/features/agent-plugins/credential-cards.ts
[t-card-form]: /Users/la/Programming/Tovu/apps/website/src/features/custom-credentials/plugin-credential-card.ts
[om-cards]: /Users/la/Programming/Open-Marketing/apps/server/src/integration-credential-cards.ts
[j-secret]: /Users/la/Programming/Open-Marketing/apps/server/node_modules/@jini-ai/ui/dist/features/mcp-ui/secret-card.d.ts
[om-integration-ui]: /Users/la/Programming/Open-Marketing/apps/studio/src/pages/addons/ui/IntegrationsPage.tsx
[t-chat]: /Users/la/Programming/Tovu/apps/admin/src/components/AssistantDock/AssistantDock.tsx
[om-chat]: /Users/la/Programming/Open-Marketing/apps/studio/src/widgets/om-chat/OMChatPane.tsx
[j-chat]: /Users/la/Programming/Open-Marketing/apps/studio/node_modules/@jini-ai/chat/dist/react/chat-pane.d.ts
[t-parity]: /Users/la/Programming/Tovu/development/scripts/lib/route-tool-parity.ts
[om-coverage]: /Users/la/Programming/Open-Marketing/apps/server/src/om-tool-coverage.ts
[t-rigor]: /Users/la/Programming/Tovu/development/scripts/test-rigor-inventory.mjs
[om-integrity]: /Users/la/Programming/Open-Marketing/development/scripts/output-integrity.mjs
[j-coverage]: /Users/la/Programming/Tovu/node_modules/@jini-ai/devops/dist/checks/coverage/index.d.ts
[t-themes]: /Users/la/Programming/Tovu/apps/admin/src/admin-themes/registry.ts
[om-themes]: /Users/la/Programming/Open-Marketing/apps/studio/src/themes/registry.ts
[j-theme]: /Users/la/Programming/Open-Marketing/apps/studio/node_modules/@jini-ai/ui/dist/theme/index.d.ts
[t-surfaces]: /Users/la/Programming/Tovu/apps/website/src/features/agent-plugins/admin-surfaces/surfaces.ts
[om-plugin]: /Users/la/Programming/Open-Marketing/apps/server/src/plugin-host.ts
[j-surfaces]: /Users/la/Programming/Open-Marketing/apps/server/node_modules/@jini-ai/agent-plugins/dist/admin-surfaces/index.d.ts
[t-mail]: /Users/la/Programming/Tovu/apps/website/src/features/agent-plugins/mail-adapter-registry.ts
[t-mail-declaration]: /Users/la/Programming/Tovu/content/agent-plugins/resend/tovu-mail-adapters.json
[om-mail]: /Users/la/Programming/Open-Marketing/content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/commands.ts
[j-mail]: /Users/la/Programming/Open-Marketing/apps/server/node_modules/@jini-ai/platform/dist/mail/index.d.ts
[t-sidebar-tests]: /Users/la/Programming/Tovu/apps/admin/src/hooks/__tests__/use-sidebar-empty-click-toggle.hooks.test.tsx
[om-sidebar-tests]: /Users/la/Programming/Open-Marketing/apps/studio/tests/shell.test.ts
[t-card-tests]: /Users/la/Programming/Tovu/apps/website/src/features/agent-plugins/__tests__/unit/plugin-credential-cards.unit.test.ts
[om-card-tests]: /Users/la/Programming/Open-Marketing/apps/server/tests/integration-credential-cards.test.ts
[t-fact-tests]: /Users/la/Programming/Tovu/apps/website/src/features/site-guide/__tests__/facts.test.ts
[om-guide-tests]: /Users/la/Programming/Open-Marketing/apps/server/tests/site-guide.test.ts
[om-chat-tests]: /Users/la/Programming/Open-Marketing/apps/studio/tests/chat-parity.test.ts
[t-theme-tests]: /Users/la/Programming/Tovu/apps/admin/src/admin-themes/__tests__/admin-themes.unit.test.ts
[om-theme-tests]: /Users/la/Programming/Open-Marketing/apps/studio/tests/theme.test.ts
[t-surface-tests]: /Users/la/Programming/Tovu/apps/website/src/features/agent-plugins/admin-surfaces/__tests__/unit/surfaces.unit.test.ts
[t-mail-tests]: /Users/la/Programming/Tovu/apps/website/src/features/agent-plugins/__tests__/unit/mail-adapter-registry.unit.test.ts
[om-mail-tests]: /Users/la/Programming/Open-Marketing/content/agent-plugins/resend-email/io.github.ainsep.openmarketing/tests/dispatch.test.ts
[j-coverage-tests]: /Users/la/Programming/Jini/packages/devops/src/checks/coverage/__tests__/integrity.test.ts
[t-parity-tests]: /Users/la/Programming/Tovu/development/scripts/__tests__/route-tool-parity.unit.test.ts
[om-coverage-tests]: /Users/la/Programming/Open-Marketing/apps/server/tests/om-tools.test.ts:508
