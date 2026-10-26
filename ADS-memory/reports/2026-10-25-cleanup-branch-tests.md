# Cleanup branch test run — om/cleanup-1025 (DC1 + OB2 R1)

Head under test: `55cf681` (OB2 R1), on top of `e4c1024` (DC1). Parent `5e6e0e2` is the pre-change commit.

- `node -v`: **v24.2.0** (pnpm 10.24.0)
- Install: **OK**. `pnpm install --frozen-lockfile` reported "Lockfile is up to date… Already up to date". So the hand-edited lockfile is accepted. Its only warning is the usual ignored `electron-winstaller` build script.
- Build: `pnpm -r --filter './packages/**' --filter './features/**' build` exited 0. Every package and feature emitted `dist/`.
- Tests: `pnpm --filter <pkg> test` was run for each package one at a time. Desktop was excluded. The x-ads and amazon-ses plugins were run with `pnpm --dir content/agent-plugins/<p> test`. om:check and whole-repo lint were not run, and no source files were changed.
- Attribution check: the baseline built only contracts, so many of its packages were blocked by ENV problems. To check attribution properly, the pre-change commit `5e6e0e2` was also run in a throwaway worktree with the same install and full build. Every package that fails on head was run there too: media-library, safety, server, studio and x-ads. The sets of failing test names match **exactly**.

| package | result | baseline (checkpoint) |
|---|---|---|
| contracts | passed (43) | passed |
| om-clock | passed (8) | not run |
| audit | passed (96) | passed |
| campaigns | passed (106) | passed |
| contacts | passed (106) | passed |
| creative | passed (81) | not run |
| credentials | failed (2/166) | failed (2/166), same tests |
| federation | passed (151) | not run |
| forms | passed (97) | not run |
| jobs | passed (197) | ENV (did not collect) |
| measure | passed (215) | ENV (did not collect) |
| media-library | failed (23/76, 5/6 files) | not run; identical on `5e6e0e2` |
| plugins | failed (3/129) | failed (3/129), same tests |
| policy | passed (123) | passed |
| privacy | passed (42) | ENV (did not collect) |
| safety | failed (8/158) | failed (7/158), +1 that was not visible there; identical on `5e6e0e2` |
| web-events | passed (69) | not run |
| workspaces | passed (47) | passed |
| agent | passed (31) | passed |
| server | failed (92/713, 14/30 files) | ENV (23/30 files did not collect) + 1 failure; same failing set on `5e6e0e2` (92/709) |
| studio | failed (42/272, 8/20 files) | failed (42/272), same tests |
| plugin: x-ads | failed (1/94) | skipped (`oauth-1.0a` unresolved) |
| plugin: amazon-ses | passed (29) | not run |

Totals: 15 passed, 8 failed, 0 skipped.

## NEW FAILURES (caused by DC1/OB2)

**None.** Every failure on head also fails, with the same test name, on the pre-change commit `5e6e0e2` when it is fully built. Server runs 4 more tests on head (713 vs 709), from the new `catalog-composition` cases, and all 4 pass. The packages that OB2 R1 refactored all pass: audit, creative, jobs, measure, workspaces and campaigns. Safety and media-library fail exactly as they did before.

### Newly visible (not caused by DC1/OB2, but unmasked by DC1)
- **x-ads** `io.github.ainsep.openmarketing/tests/campaign-deployment.test.ts:39`, test `fixed traffic translation and paused deployment > sends PAUSED explicitly, reads each predecessor, and retains all four references`. Error: `AssertionError: expected 'OAuth …' to contain 'oauth_signature="T1Fsx8nm%2FMcparSWqooYpW9hZQk%3D"'`; the received value was `ZUprgXq8put2Zp0qb0hxRXDyCM4%3D`. DC1 made `oauth-1.0a@2.2.6` resolvable, which is the version the plugin declares, so this test body now runs for the first time. The test builds its expected signature base with the JSON body fields in the form parameter set. `src/transport.ts:15` says "JSON bodies are excluded from OAuth's form parameter set", so the test and the source disagree. The other 93 x-ads tests pass.
- **safety** `tests/paid-sending.test.ts:108`, test `paid sending accounting / sql > defers timezone edits until rollover and enforces the 1000-reservation bound`. Error: `Test timed out in 5000ms` (5241 ms). It fails the same way on `5e6e0e2`, and the checkpoint run did not report it. It is probably a timing-sensitive SQL test near the 5 s default, and may be related to the confirmation-storage failure below.

## PRE-EXISTING failures (brief)

- **credentials**: `tests/token.test.ts`, test `Google developer-token purpose via memory|sql`. The developer token is still readable after revoke. Same as the baseline.
- **plugins**: `AgentPluginLayoutPort > rejects unsupported manifest versions` fails 3 times. Same as the baseline.
- **safety**: the 7 `tests/contract/sql.test.ts` ConfirmationExchangePort B1 / persists-identity cases fail with `unavailable: Confirmation storage unavailable` plus 1 timeout. Same as the baseline.
- **studio**: the same 42 tests in 8 files: shell `URL must be of scheme file`, theme CSS blocks, ADD-ONS group, "A little clarity." copy, transport/observability assertions. Same as the baseline.
- **media-library** (not run in the baseline): 23 tests across `contract/memory`, `contract/adapters`, `service`, `import-adapter` and `adapter-failures`. They throw `{"code":"unavailable","message":"Invalid canonical upload record|asset|records"}` from the `required.outcome` fixture unwrap, in both the memory and injected adapters. Canonical record validation rejects the fixtures, in both the memory and SQL adapters, before and after OB2.
- **server** (newly collectable now that everything is built; the same failing set before and after): 92 tests in 14 files. agent-plugin-backends 38, agent-plugin-jobs 18, boot 8, catalog-composition 8, agent-process 5, om-tools 4, conversations, ingress-worker and integrations 2 each, and chart-assets, cli, owner-api, site-guide and spike/transaction 1 each. The main errors are:
  - `Sandbox agent did not become ready` ×16
  - `Campaign deployment unavailable` ×11
  - `Cannot read properties of undefined (reading 'invoke')` ×7
  - timeouts ×6
  - `Fixture precondition: Invalid canonical upload record` ×2 (the same root cause as media-library)
  - `Cannot find module …/meta-ads/…/dist/index.mjs` ×1 (an ENV problem: agent plugins were not built, and this run did not do `om:build-plugins`)

  The baseline's cli `costUsd`/`durationMs` key-order failure is still present.
