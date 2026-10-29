# B1 implementation progress

Persona loaded; plan and review read, including Coordinator override authorizing additive contracts schemas.
No tests/builds/install/indexing will run. Typecheck only at completion (contracts, server, studio).

Scope: exact LOCKS-FILES in review.md plus packages/contracts/src/addons/index.ts under the override.
Pending authorization: public barrel exports in packages/contracts/src/index.ts; no deep-import bypass.

ADR checklist: vendor declarations only in plugin manifests; core generic; scope owner/workspace/plugin; owner-only write before I/O; scoped reads; no lifecycle effects; injected DB/context; malformed overrides preserve metadata; bounds 8 fields/100 entries/128 chars/4096 bytes; existing approval exact card; React callbacks in hooks.
Priming: approved examples setPluginSecret, provider-settings SQL, mailProviderDefinitions, PluginSecretForm/usePluginSecret govern this implementation.
Test seams: fixture SQL + manifest reader; real installed addons state; tool policy approval; CLI fetch/stdin; Studio fake API/hook form. Tests written only.
Reuse search: existing OM settings SQL/runtime/forms; published Jini rc.2 admin-surfaces inspected, incompatible iframe model; source-only ProviderConfigSource not callable and flat strings; Tovu admin-surfaces not hosted by OM. Use installed Zod and native textarea/String operations per review.

1. DONE — exact additive schemas in packages/contracts/src/addons/index.ts; public exports pending scope authorization.
2. DONE — three plugin.json OM-extension declarations, TikTok strict test schema accepts declaration; fingerprints unchanged.
3. DONE — integration-credential-cards.ts isolates declarations; integrations.ts read/set/merge; composition/addons.ts merges only metadata. Regressions written in integrations.test.ts and addons.test.ts (not run). Public barrel dependency remains pending.
4. DONE — owner HTTP GET/POST, catalog pair/coverage, CLI get/set via bounded stdin; tests written in om-tools.test.ts and cli/addons.test.ts (not run).
5. DONE — shared API HTTP/sample methods, useConversionSettings hook and manifest-driven form with textarea mapping; no private flags on settings. Sample has no declaration. Studio regression written (not run).
6. DONE — regressions written in all five application suites plus TikTok schema update. Static review corrected fixture card declaration and DOM reference after form remount. No tests run.
7. PARTIAL — contracts typecheck EXIT 0; server/studio each EXIT 2 due missing public exports and follow-on types. Both stopped before test-file typecheck. No reruns, tests, builds or installs. report.md and exact public-exports-needed.patch saved. Awaiting barrel scope authorization; no barrel edit made. One allowed application typecheck rerun remains after exports land.
