v24.2.0

# Cloud test checkpoint — om/clean-slate (2026-10-25)

pnpm 10.24.0 (matches `engines`/`.nvmrc`). Each package was run on its own, one after another: `pnpm --filter @open-marketing/<name> test` for features/apps and `pnpm --dir content/agent-plugins/<p> test` for plugins. om:check and whole-repo lint were not run. No source files were changed. Setup ran `pnpm install` and built only `@open-marketing/contracts`; no other workspace package has a `dist/`.

| package | result | duration (s) |
|---|---|---|
| contracts | passed | 2.1 |
| campaigns | passed | 2.5 |
| policy | passed | 2.4 |
| jobs | failed (ENV: 10/10 files fail to collect) | 1.8 |
| safety | failed (7/158 tests) | 7.8 |
| audit | passed | 1.7 |
| measure | failed (ENV: 7/7 files fail to collect) | 1.8 |
| privacy | failed (ENV: 2/2 files fail to collect) | 1.4 |
| contacts | passed | 1.6 |
| workspaces | passed | 1.8 |
| credentials | failed (2/166 tests) | 3.2 |
| plugins | failed (3/129 tests) | 3.1 |
| studio | failed (42/272 tests, 8/20 files) | 16.6 |
| agent | passed | 3.9 |
| server | failed (23/30 files fail to collect from ENV; 1/219 tests fail) | 5.0 |
| plugin: google-ads | passed | 1.3 |
| plugin: meta-ads | passed | 2.4 |
| plugin: linkedin-ads | failed (3/259 tests) | 2.2 |
| plugin: tiktok-ads | failed (4/309 tests) | 2.1 |
| plugin: apple-search-ads | failed (1/61 tests) | 1.6 |
| plugin: x-ads | skipped (deps unresolved: `oauth-1.0a`) | 1.6 |
| plugin: resend-email | passed | 1.3 |
| plugin: naver-ads | passed | 1.5 |
| plugin: pinterest-ads | passed | 1.9 |
| plugin: reddit-ads | passed | 1.5 |

Totals: 13 passed, 11 failed, 1 skipped.

## Environmental failures (missing build output)

The workspace `exports` send `import` to `./dist/src/index.js`, but setup built only contracts. Vite fails at collection time with `Error: Failed to resolve entry for package "@open-marketing/<pkg>". The package may have incorrect main/module/exports specified in its package.json.` No test body runs in the affected files. Rerunning after building the dependency packages should show their real status.

- **jobs**: all 10 test files, for example `features/jobs/tests/outbox.test.ts:2` `import { createFakeClock } from "@open-marketing/om-clock"`. Unbuilt package: `om-clock`.
- **measure**: all 7 test files (boundaries, contract/capabilities, contract/memory, contract/sql, delivery, ingestion, reporting). Unbuilt packages: `om-clock`, `policy`.
- **privacy**: `tests/ports.test.ts` and `tests/service.test.ts`. Unbuilt package: `om-clock`.
- **server**: 23 of 30 files fail to collect: addon-federation, addon-tools, addons, agent-plugin-backends, agent-plugin-jobs, agent-process, boot, campaign-launch, catalog-composition, chart-assets, conversations, ingress-worker, integration-credential-cards, integration-oauth-vendors, integrations, om-tools, owner-api, shell, site-guide, spike/digest-stability, spike/transaction, subject-lane, tool-operations. Unbuilt packages: `campaigns`, `contacts`, `credentials`, `jobs`, `measure`, `safety`.
- **plugin x-ads (skipped)**: all 5 files hit `Error: Cannot find package 'oauth-1.0a' imported from content/agent-plugins/x-ads/io.github.ainsep.openmarketing/src/transport.ts`. The plugin's dependencies are not installed in this checkout.

## Failures in test bodies (not attributable to the environment)

### safety: `features/safety/tests/contract/sql.test.ts` (SQL backend only; the memory suite passes)
Uses `node:sqlite` `DatabaseSync(":memory:")` on the pinned Node 24.2.0. Five of the seven failures surface only as the typed error `Error: unavailable: Confirmation storage unavailable; no authority granted`. That message comes from `src/sql-confirmation.ts:32`, where the `catch` throws away the underlying driver error, so the root cause is not visible in the log.
- `ConfirmationExchangePort B1 > owner-only generic cards reject agents/services, wrong scope and forged or missing identity`: `unavailable…` at `unwrap` (`tests/fixtures.ts:14`, from `port-suites.ts:115`)
- `ConfirmationExchangePort B1 > snapshots identity and response before audit, with one winner across competing answers`: `Test timed out in 5000ms` (`port-suites.ts:118`). This is probably a knock-on of the same storage error leaving a `Promise.withResolvers` gate unresolved.
- `ConfirmationExchangePort B1 > binds one owning card to exact constituents after reopen, denying extra calls, drift, scope and revocation`: `unavailable…` (`port-suites.ts:174`)
- `ConfirmationExchangePort B1 > reopens exact pending cards, preserves immutable answers and scopes revocation`: `AssertionError: expected [] to have a length of 1 but got +0` (`port-suites.ts:193`)
- `ConfirmationExchangePort B1 > reads exact scoped cards, paginates pending cards and removes answers from listing`: `unavailable…`
- `ConfirmationExchangePort B1 > presentation is not confirmation; responses and dispatch must exactly match`: `unavailable…`
- `persists identity and answer time across reopen and rejects old or malformed identity`: `unavailable…`

### credentials: `features/credentials/tests/token.test.ts`
- `Google developer-token purpose via memory > seals, replaces and clears independently, skips OAuth refresh and excludes ordinary listing/access`: `AssertionError: expected true to be false` at line 196, `expect((await readCredentialDeveloperToken(read)).ok).toBe(false)` after `revoke`. The developer token is still readable after the connection is revoked.
- The same test `via sql` fails with the same assertion.

### plugins: `features/plugins/tests/contract/port-suites.ts:79`
- `AgentPluginLayoutPort behavior > rejects unsupported manifest versions in both memory and disk` fails twice in `tests/contract/adapters.test.ts` and once in `tests/contract/memory.test.ts`. `AssertionError: expected { ok: true, value: {…} } to match object { ok: false, error: { code: "invalid_input" } }`: `validate` accepts an unsupported manifest version.

### studio: `apps/studio/tests/*` (8 files, 42 tests)
- `tests/shell.test.ts`: all 24 tests fail, among them "left navigation changes the center canvas…", "presents connected/sample/unavailable consistently in both connection labels", "uses a friendly workspace label for …" (several cases), "keeps the rail usable when storage reads and writes fail", "collapses each group with the keyboard…", "offers one Settings picker…", "binds guarded desktop blank clicks…", "applies sidebar, dock and FAB placement rules…", and "shows the FAB only while the assistant is closed…". Error: `TypeError: The URL must be of scheme file` at `tests/shell.test.ts:22`, `readFileSync(new URL("../src/styles.css", import.meta.url))`. Under the jsdom environment `import.meta.url` is not a `file:` URL. **Possibly environmental / harness-related**, but it should reproduce anywhere with this lockfile, so it is not specific to the cloud.
- `tests/appearance.test.ts`:
  - `keeps registry preview samples and accent dots equal to the shipped CSS`: `TypeError: Cannot read properties of undefined (reading 'split')` at line 126. The expected `:root[data-admin-theme="<id>"][data-color-scheme="<scheme>"] {` block is missing from a `src/themes/<id>.css`.
  - `Modern keeps every light accent AA on buttons, hovered buttons and links` fails the same way.
  - `Modern keeps every dark accent AA on buttons, hovered buttons and links` fails the same way.
- `tests/addons.test.ts`: four tests fail with the same error: `mounts 'Plugins'`, `mounts 'Agent Plugins'`, `mounts 'Skills'`, and `mounts 'Integrations'` (each "…from an ADD-ONS link and restores the hash route"). Error: `TestingLibraryElementError: Unable to find an accessible element with the role "group" and name "ADD-ONS"`.
- `tests/chat.test.ts`: four tests fail with `TestingLibraryElementError: Unable to find an element with the text: A little clarity.`:
  - keyboard opens the global panel, Escape closes it, and focus returns to the FAB
  - a sample chat requests native navigation and acknowledges only the rendered canvas
  - closing the dock preserves the Jini draft; New chat resets it
  - loads the chosen server conversation into Jini and uses server model choices with the existing settings write
- `tests/browser-tools.test.ts`:
  - `passes the current bind token and shows surface spend approvals in the existing inline card`: `Unable to find an element with the text: Exact spend approval`
  - `shares one plugin inventory across chart surfaces and refreshes it on revision change`: `AssertionError: expected "spy" to be called 2 times, but got 0 times`
- `tests/chat-parity.test.ts > confines fabricated timing and prices to sample transcript presentation`: `AssertionError: expected [ { kind: 'text', text: 'Fixture' } ] to be undefined`
- `tests/jini-chat-transport.test.ts`:
  - `http session-backed Jini transport > returns acceptance before completion and retains reported usage with explicit estimate provenance`: `AssertionError: expected 2 to be +0`
  - `http session-backed Jini transport > detaches without cancelling, then reattaches from the cursor without another start`: `AssertionError: expected 1 to be +0`
  - `rejects unsupported image input before starting a run`: `expected [Function] to throw error including 'coming soon' but got 'This server does not accept image att…'`. The copy changed.
- `tests/observability.test.ts > one click/request/failure pair uses existing headers and preserves the response and invocation count`: `AssertionError: expected { ok: false, error: {…} } to deeply equal { ok: false, error: {…} }`

### server: `apps/server/tests/cli/cli.test.ts:428` (the only test body that ran and failed)
- `prints authoritative estimated usage after a completed ask`: `expected stdout to contain '[Usage estimate] {"kind":"usage",…,"durationMs":8000,"costUsd":0.07,…}'`. The output has the same fields with `costUsd` printed before `durationMs`, so the JSON key order no longer matches the expected string.

### plugin linkedin-ads: `io.github.ainsep.openmarketing/tests/manifests.test.ts`
These three tests fail on `ZodError unrecognized_keys ["credentialCards","credentialAssets"]` at path `extensions["io.github.ainsep.openmarketing"]` (lines 22 and 30). The test's strict local `manifestSchema` does not allow the keys that are now in `plugin.json`.
- `uses the Meta layout, OM namespace and empty MCP map, with admission off`
- `declares effects consistently with actual tool schemas, excluding backend stop from agent tools`
- `keeps source-schema compatibility fingerprints current, without a plugin trust allowlist`

### plugin tiktok-ads
- `tests/manifests.test.ts`: two tests fail with the same `ZodError unrecognized_keys ["credentialCards","credentialAssets"]` as linkedin-ads:
  - `packaged TikTok metadata > uses Meta's portable v1.1 namespace and an empty server-loaded MCP configuration`
  - `packaged TikTok metadata > declares ten tools and three backend capabilities, unadmitted, with actual schema fingerprints`
- `tests/campaign-deployment.test.ts`: two tests fail with `TypeError: Invalid URL` thrown from `src/commands.ts:15` `tiktokUrlSchema` refine. With `landingPageUrl: ""` the refine throws a TypeError instead of returning a typed `unsupported` result.
  - `memory paused deployment > returns typed unsupported with no effects for an unsupported plan` (the `CUSTOMIZED_USER` / `landingPageUrl:""` case)
  - `fetch paused deployment > returns typed unsupported …` (same case)

### plugin apple-search-ads: `io.github.ainsep.openmarketing/tests/manifests.test.ts:18`
- `advertises two reads and the recognizable unsupported report, disabled with matching source metadata`: `AssertionError` on deep equality of `schemaFingerprint`. Expected `f7d989b4…` (×2) and `0adec0d0…`; got `0fb78357…` (×2) and `7d60ab48…`. The fingerprints in the manifest no longer match the source files they hash.

## Suggested next step
Build the dependency packages (`om-clock`, `policy`, `campaigns`, `contacts`, `credentials`, `jobs`, `measure`, `safety`) and install the x-ads dependencies, then rerun jobs, measure, privacy, server and x-ads to see their real status.
