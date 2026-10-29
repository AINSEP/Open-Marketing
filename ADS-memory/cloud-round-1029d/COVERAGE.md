# OM coverage analysis — round 1029d

**MEASUREMENT ONLY. No source, test, config, lockfile or package.json was changed.** Branch `cloud/om-round-1029d` from `main`. Node 24.2.0, `pnpm install --frozen-lockfile`, vitest 3.2.4 + `@vitest/coverage-v8` (v8 provider, `coverage.all`, `src/` only; tests/dist/`.d.ts` excluded). Raw outputs: `ADS-memory/cloud-round-1029d/out/<slug>/run.txt` and `<slug>/coverage/coverage-summary.json`; aggregates in `out/group-*.json`, `out/aggregate.json`.

## 0. Caveats (read first)
- **Vitest writes no coverage when tests fail**; failing packages were re-run once with `--coverage.reportOnFailure=true` (the one allowed retry). Failing tests were NOT fixed.
- **Setup gap:** `packages/om-db` and `packages/om-clock` had no `dist/` (needed by features and apps/server; the brief did not list them). Features were measured with a temp vitest alias config (outside the repo) mapping them to `src`; apps/server after building those two git-ignored dists. `om-clock` is not declared/linked in `apps/server` (a fresh install may not resolve it).
- **ENV-broken (numbers not meaningful, excluded from aggregates):** `higgsfield-media` (builds here, but 6/7 test files fail to resolve `@jini-ai/integrations/media-providers`, `@open-marketing/federation`, `@open-marketing/safety`; 22% lines), `content/plugins/charts-chartjs` and `charts-echarts` (tests cannot resolve `@jini-ai/ui/charts`; 0 tests ran; their `provider.ts` shows 0%). They have no `test` script.
- **`google-ads` and `google-business-profile` use `node --test`** with `--experimental-test-coverage` (loaded files only, no `coverage.all`, no per-file JSON; table in their `run.txt`). Their figures are in the per-package table but are NOT in the aggregates.
- Parallel runs caused load flakes (5 s timeouts, SQLite transaction tests in forms/jobs/safety, studio 17 timeouts); failures listed below were not re-isolated, so some "failed" counts may be flaky. Directories `anthropic, email-lifecycle, google, om-playbook, openai, seo` under agent-plugins have no package.json/tests.

## 1. Overall (vitest-measured, ENV-broken and node:test packages excluded)
| Scope | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| apps | 95.50% (15818/16564) | 84.15% (8408/9992) | 91.51% (2156/2356) | 95.50% (15818/16564) |
| features | 99.15% (12943/13054) | 84.27% (7518/8921) | 98.13% (1945/1982) | 99.15% (12943/13054) |
| packages | 98.66% (881/893) | 94.77% (344/363) | 96.43% (81/84) | 98.66% (881/893) |
| plugins (vitest only, excl. ENV-broken) | 99.20% (11841/11937) | 88.02% (7759/8815) | 99.08% (1184/1195) | 99.20% (11841/11937) |
| ALL (vitest-measured, same exclusions) | 97.73% (41483/42448) | 85.54% (24029/28091) | 95.53% (5366/5617) | 97.73% (41483/42448) |

## 2. Per-package (lowest lines first)
| Package | Group | Lines % | Branches % | Funcs % | Passed | Failed | Notes |
|---|---|---|---|---|---|---|---|
| content/plugins/charts-chartjs | plugins | 0 | 100 | 100 | 0 | 0 | ENV — not meaningful. ENV: tests/provider.test.ts cannot resolve @jini-ai/ui/charts; no tests ran; 0% is not real covera |
| content/plugins/charts-echarts | plugins | 0 | 100 | 100 | 0 | 0 | ENV — not meaningful. ENV: tests/provider.test.ts cannot resolve @jini-ai/ui/charts; no tests ran; 0% is not real covera |
| content/agent-plugins/higgsfield-media | plugins | 22.07 | 0 | 0 | 1 | 0 | ENV — not meaningful. ENV: built fine, tests DID run but 6/7 files failed to load (unresolved @jini-ai/integrations/medi |
| apps/desktop | apps | 81.49 | 94.23 | 90.38 | 76 | 1 |  |
| apps/agent | apps | 82.72 | 77.68 | 84.14 | 39 | 0 |  |
| content/agent-plugins/google-business-profile | plugins | 83.65 | 88.26 | 54.03 | 37 | 1 | node:test coverage (loaded files only). node:test with --experimental-test-coverage (all-files line of node table; line/ |
| apps/studio | apps | 95.17 | 86.47 | 91.31 | 327 | 1 |  |
| content/agent-plugins/yandex-direct | plugins | 95.41 | 89.34 | 94.64 | 130 | 13 |  |
| features/plugins | features | 95.73 | 75.52 | 95.74 | 17 | 0 |  |
| packages/om-db | packages | 96 | 92.25 | 96.29 | 32 | 0 |  |
| content/agent-plugins/google-ads | plugins | 96.26 | 85.22 | 88.06 | 219 | 1 | node:test coverage (loaded files only). node:test with --experimental-test-coverage (all-files line of node table; line/ |
| apps/server | apps | 96.96 | 83.24 | 92.02 | 1158 | 7 | Initial run: om-db/om-clock dist missing so 34 files failed to load; I built dist for om-clock and om-db via development |
| features/creative | features | 97.52 | 75.21 | 98.63 | 81 | 0 |  |
| features/safety | features | 98.32 | 85.02 | 98.97 | 166 | 2 |  |
| features/federation | features | 98.47 | 77.56 | 99.32 | 151 | 0 |  |
| content/agent-plugins/apple-search-ads | plugins | 98.49 | 89.96 | 100 | 58 | 0 |  |
| features/media-library | features | 98.82 | 79.2 | 92.05 | 83 | 0 |  |
| content/agent-plugins/line-ads | plugins | 98.83 | 87.72 | 100 | 103 | 4 |  |
| content/agent-plugins/tiktok-ads | plugins | 98.93 | 88.44 | 100 | 320 | 0 |  |
| content/agent-plugins/naver-ads | plugins | 99.05 | 88.37 | 100 | 129 | 0 |  |
| content/agent-plugins/microsoft-ads | plugins | 99.17 | 85.15 | 99.06 | 161 | 10 |  |
| features/jobs | features | 99.29 | 86.94 | 96.51 | 200 | 3 |  |
| content/agent-plugins/meta-ads | plugins | 99.34 | 88.39 | 98.63 | 462 | 2 |  |
| features/workspaces | features | 99.46 | 87.19 | 100 | 50 | 0 |  |
| features/credentials | features | 99.47 | 84.34 | 98.84 | 162 | 0 |  |
| content/agent-plugins/vk-ads | plugins | 99.5 | 93.37 | 100 | 68 | 1 |  |
| content/agent-plugins/snapchat-ads | plugins | 99.51 | 84.4 | 100 | 143 | 0 |  |
| content/agent-plugins/pinterest-ads | plugins | 99.52 | 85.96 | 100 | 174 | 0 |  |
| features/campaigns | features | 99.53 | 75.98 | 98.55 | 106 | 0 |  |
| content/agent-plugins/amazon-ads | plugins | 99.53 | 88.05 | 100 | 111 | 0 |  |
| features/measure | features | 99.54 | 84.17 | 99.16 | 419 | 0 |  |
| content/agent-plugins/amazon-ses | plugins | 99.54 | 84.61 | 94.33 | 80 | 2 |  |
| features/forms | features | 99.59 | 93.63 | 96.87 | 96 | 1 |  |
| content/agent-plugins/kakao-ads | plugins | 99.62 | 93.13 | 100 | 60 | 1 |  |
| content/agent-plugins/x-ads | plugins | 99.64 | 89.36 | 100 | 142 | 5 |  |
| features/contacts | features | 99.68 | 86.5 | 100 | 111 | 0 |  |
| content/agent-plugins/linkedin-ads | plugins | 99.68 | 89.2 | 100 | 304 | 0 |  |
| content/agent-plugins/reddit-ads | plugins | 99.75 | 89.33 | 100 | 112 | 1 |  |
| packages/contracts | packages | 100 | 96.22 | 95.65 | 130 | 0 |  |
| packages/om-clock | packages | 100 | 100 | 100 | 8 | 0 |  |
| features/audit | features | 100 | 92.43 | 100 | 96 | 0 |  |
| features/brand | features | 100 | 96.55 | 100 | 19 | 0 |  |
| features/leads | features | 100 | 93.63 | 94.23 | 31 | 0 |  |
| features/policy | features | 100 | 95.65 | 100 | 118 | 0 |  |
| features/privacy | features | 100 | 88.06 | 100 | 42 | 0 |  |
| features/web-events | features | 100 | 90.66 | 100 | 112 | 0 |  |
| content/agent-plugins/resend-email | plugins | 100 | 86 | 95.12 | 69 | 2 |  |
| content/agent-plugins/twilio-sms | plugins | 100 | 87.22 | 100 | 71 | 0 |  |
| content/agent-plugins/whatsapp-business | plugins | 100 | 90.12 | 100 | 116 | 0 |  |

### Failing tests (not fixed)
- apps/desktop (1): om-server.test "POSIX fixture supervision > terminates the owned group for descendant" (likely sandbox).
- apps/studio (1): shell.test "offers one Settings picker with live theme previews and keyboard-operated accents".
- apps/server (7): agent-plugin-backends (cancelled run during final approval verification); agent-plugin-jobs ×3 (admission-to-fetch gap; halt before enqueue; subject lane/delivery ledger); ingress-worker (form withdrawal outside SQLite); om-tools (seeded bundled agent-plugin catalog after boot); owner-api (frozen canonical refs / trashed assets).
- features: forms (1, SQLite overlapping-roots timeout), jobs (3, SQLite outbox contract), safety (2, `tests/contract/sql.test.ts`: ConfirmationExchangePort B1; wrapped SQLite error code on card insert) — all look load/timing related; safety `paid-sending` flaked once and passed on rerun.
- plugins (16 of 24 packages fail; see `out/group-plugins.json` `failing` arrays and `run.txt`): amazon-ses & resend-email (2 each, `MAILER_SEND_REFUSED_NO_DURABLE_PATH` from `@jini-ai/platform` mailer), google-ads (1: extra `campaign.validate.v1` capability), google-business-profile (boundaries.test file), kakao-ads 1, line-ads 4, meta-ads 2 (5000-row tests time out), microsoft-ads 10, reddit-ads 1, vk-ads 1, x-ads 5, yandex-direct 13, + the three ENV packages. Several (google-ads extra capability, microsoft/x/line capability tests) may be real regressions rather than environment — recommend triage.

## 3. Risky paths — per-file (lines %, branches %, functions %)
Files matching: features/{safety,web-events,privacy,policy,measure,credentials}, apps/server `inbound/public.ts` & `inbound/om*`, and any file whose path contains approv/budget/quote/conversion/spend/launch/deploy. (node:test plugins google-ads/gbp have no per-file JSON; see their run.txt.)

| File | Lines | Lines % | Branch % | Func % |
|---|---|---|---|---|
| `apps/server/src/cli/approval.ts` | 59 | 100 | 96.15 | 100 |
| `apps/server/src/composition/conversions.ts` | 43 | 100 | 86.36 | 100 |
| `apps/server/src/inbound/public.ts` | 196 | 96.42 | 73.02 | 92.3 |
| `apps/studio/src/features/approve/index.ts` | 2 | 100 | 100 | 100 |
| `apps/studio/src/features/approve/model/rules.ts` | 43 | 100 | 87.09 | 100 |
| `apps/studio/src/features/approve/ui/ApprovalCard.hooks.ts` | 77 | 98.7 | 93.58 | 100 |
| `apps/studio/src/features/approve/ui/ApprovalCard.tsx` | 22 | 100 | 100 | 100 |
| `apps/studio/src/pages/addons/model/conversion-grants.hooks.ts` | 101 | 97.02 | 70.9 | 91.66 |
| `apps/studio/src/pages/addons/ui/ConversionGrants.tsx` | 33 | 100 | 85.71 | 100 |
| `apps/studio/src/widgets/om-chat/ChatApproval.hooks.ts` | 2 | 100 | 100 | 100 |
| `apps/studio/src/widgets/om-chat/ChatApproval.tsx` | 10 | 100 | 100 | 100 |
| `apps/studio/src/widgets/om-chat/approval-summary.rules.ts` | 23 | 100 | 80 | 100 |
| `content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 112 | 100 | 93.97 | 100 |
| `content/agent-plugins/apple-search-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 148 | 98.64 | 92.79 | 100 |
| `content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 112 | 99.1 | 96.29 | 100 |
| `content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 142 | 98.59 | 76.59 | 100 |
| `content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 142 | 98.59 | 88.88 | 100 |
| `content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 169 | 100 | 86.11 | 100 |
| `content/agent-plugins/naver-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 124 | 100 | 90.81 | 100 |
| `content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 99 | 100 | 87.69 | 100 |
| `content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 9 | 100 | 100 | 100 |
| `content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 134 | 100 | 84.44 | 100 |
| `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 118 | 98.3 | 87.35 | 100 |
| `content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 12 | 100 | 100 | 100 |
| `content/agent-plugins/x-ads/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 137 | 99.27 | 86.27 | 100 |
| `content/agent-plugins/yandex-direct/io.github.ainsep.openmarketing/src/campaign-deployment.ts` | 157 | 99.36 | 86.77 | 100 |
| `features/campaigns/src/launch.ts` | 72 | 100 | 56.52 | 100 |
| `features/campaigns/src/neutral-launch.ts` | 1 | 100 | 100 | 100 |
| `features/credentials/src/broker.ts` | 70 | 100 | 77.41 | 100 |
| `features/credentials/src/jini-oauth-common.ts` | 134 | 95.52 | 86.51 | 100 |
| `features/credentials/src/jini-oauth.ts` | 48 | 100 | 95.83 | 100 |
| `features/credentials/src/jini-refresh.ts` | 60 | 100 | 82 | 100 |
| `features/credentials/src/locks.ts` | 62 | 100 | 80 | 100 |
| `features/credentials/src/memory-oauth.ts` | 28 | 100 | 100 | 100 |
| `features/credentials/src/memory-repo.ts` | 69 | 100 | 81.25 | 100 |
| `features/credentials/src/memory-sealer.ts` | 30 | 100 | 82.35 | 100 |
| `features/credentials/src/memory.ts` | 68 | 100 | 86.48 | 100 |
| `features/credentials/src/oauth.ts` | 61 | 100 | 83.72 | 100 |
| `features/credentials/src/ports.ts` | 0 | 100 | 100 | 100 |
| `features/credentials/src/rules.ts` | 52 | 100 | 95.45 | 100 |
| `features/credentials/src/sealer.ts` | 84 | 100 | 82.97 | 86.66 |
| `features/credentials/src/service.ts` | 156 | 100 | 82.67 | 100 |
| `features/credentials/src/sql.ts` | 125 | 100 | 80.76 | 100 |
| `features/credentials/src/token.ts` | 106 | 100 | 89.42 | 100 |
| `features/credentials/src/types.ts` | 0 | 100 | 100 | 100 |
| `features/measure/src/adapters/capabilities.ts` | 73 | 100 | 83.33 | 100 |
| `features/measure/src/adapters/memory-metrics.ts` | 52 | 100 | 91.89 | 100 |
| `features/measure/src/adapters/memory-repo.ts` | 132 | 98.48 | 85.88 | 100 |
| `features/measure/src/adapters/sql-boundary.ts` | 19 | 100 | 100 | 100 |
| `features/measure/src/adapters/sql-delivery.ts` | 71 | 100 | 83.67 | 100 |
| `features/measure/src/adapters/sql-grants.ts` | 70 | 100 | 67.5 | 100 |
| `features/measure/src/adapters/sql-jobs.ts` | 12 | 100 | 66.66 | 100 |
| `features/measure/src/adapters/sql-links.ts` | 40 | 100 | 55.55 | 100 |
| `features/measure/src/adapters/sql-metrics.ts` | 82 | 100 | 89.36 | 100 |
| `features/measure/src/adapters/sql-repo.ts` | 105 | 98.09 | 80 | 100 |
| `features/measure/src/adapters/verification.ts` | 34 | 100 | 87.5 | 100 |
| `features/measure/src/boundary.ts` | 13 | 100 | 91.66 | 100 |
| `features/measure/src/delivery/dispatcher.ts` | 159 | 100 | 82.35 | 100 |
| `features/measure/src/delivery/input.ts` | 23 | 100 | 100 | 100 |
| `features/measure/src/delivery/ledger-rules.ts` | 25 | 100 | 100 | 100 |
| `features/measure/src/ingestion/ingest.ts` | 30 | 100 | 72.41 | 100 |
| `features/measure/src/links/links.ts` | 78 | 100 | 67.27 | 100 |
| `features/measure/src/memory.ts` | 223 | 100 | 78.76 | 96.66 |
| `features/measure/src/ports.ts` | 0 | 100 | 100 | 100 |
| `features/measure/src/reporting/campaign-results.ts` | 104 | 100 | 84.53 | 100 |
| `features/measure/src/reporting/experiments.ts` | 142 | 100 | 96 | 100 |
| `features/measure/src/reporting/metrics-sync.ts` | 21 | 100 | 94.73 | 100 |
| `features/measure/src/reporting/metrics.ts` | 76 | 100 | 97.82 | 100 |
| `features/measure/src/reporting/report.ts` | 37 | 100 | 72.72 | 100 |
| `features/measure/src/reporting/snapshot-rules.ts` | 13 | 100 | 90.9 | 100 |
| `features/measure/src/rules.ts` | 71 | 100 | 100 | 100 |
| `features/measure/src/service.ts` | 34 | 88.23 | 94.44 | 87.5 |
| `features/measure/src/types.ts` | 19 | 100 | 100 | 100 |
| `features/policy/src/dispatch.ts` | 47 | 100 | 100 | 100 |
| `features/policy/src/gates.ts` | 81 | 100 | 96.42 | 100 |
| `features/policy/src/memory.ts` | 52 | 100 | 96.55 | 100 |
| `features/policy/src/ports.ts` | 0 | 100 | 100 | 100 |
| `features/policy/src/projection.ts` | 52 | 100 | 95 | 100 |
| `features/policy/src/service.ts` | 24 | 100 | 92.3 | 100 |
| `features/policy/src/sql.ts` | 64 | 100 | 90.9 | 100 |
| `features/policy/src/types.ts` | 0 | 100 | 100 | 100 |
| `features/policy/src/validation.ts` | 63 | 100 | 97.67 | 100 |
| `features/privacy/src/memory.ts` | 37 | 100 | 91.3 | 100 |
| `features/privacy/src/ports.ts` | 0 | 100 | 100 | 100 |
| `features/privacy/src/registry.ts` | 28 | 100 | 95.83 | 100 |
| `features/privacy/src/service.ts` | 138 | 100 | 87.5 | 100 |
| `features/privacy/src/sql.ts` | 75 | 100 | 79.71 | 100 |
| `features/privacy/src/types.ts` | 8 | 100 | 100 | 100 |
| `features/privacy/src/validation.ts` | 90 | 100 | 92.68 | 100 |
| `features/safety/src/confirmation.ts` | 150 | 100 | 84.8 | 100 |
| `features/safety/src/memory-store.ts` | 31 | 100 | 66.66 | 100 |
| `features/safety/src/memory.ts` | 109 | 100 | 86.02 | 100 |
| `features/safety/src/paid-sending.ts` | 131 | 100 | 91.89 | 100 |
| `features/safety/src/ports.ts` | 0 | 100 | 100 | 100 |
| `features/safety/src/repository.ts` | 157 | 100 | 82.78 | 100 |
| `features/safety/src/rules.ts` | 49 | 100 | 90.32 | 100 |
| `features/safety/src/service.ts` | 248 | 92.33 | 79.12 | 96 |
| `features/safety/src/sql-confirmation.ts` | 89 | 100 | 82.14 | 100 |
| `features/safety/src/sql.ts` | 66 | 100 | 86.84 | 100 |
| `features/safety/src/state-schema.ts` | 17 | 100 | 100 | 100 |
| `features/safety/src/state.ts` | 87 | 100 | 95.83 | 100 |
| `features/safety/src/types.ts` | 0 | 100 | 100 | 100 |
| `features/web-events/src/memory.ts` | 100 | 100 | 97.36 | 100 |
| `features/web-events/src/ports.ts` | 0 | 100 | 100 | 100 |
| `features/web-events/src/rules.ts` | 150 | 100 | 89.23 | 100 |
| `features/web-events/src/service.ts` | 93 | 100 | 86.02 | 100 |
| `features/web-events/src/snippet.ts` | 24 | 100 | 100 | 100 |
| `features/web-events/src/sql.ts` | 140 | 100 | 90.09 | 100 |
| `features/web-events/src/types.ts` | 18 | 100 | 100 | 100 |
| `packages/contracts/src/launch/index.ts` | 47 | 100 | 100 | 100 |

Reading: money/consent/approval/credential feature code is 95–100% on lines; the weak point is **branch coverage** (safety 85%, measure 84%, credentials 84%, campaigns 76%, apps/server `inbound/public.ts` 73% branches / 92% functions). `features/measure/src/service.ts` is the lowest measure file (88%). Plugin budget/quote/conversion code is generally 95–100% lines except higgsfield-media (ENV) and yandex-direct `commands.ts` (57%).

## 4. Untested files (0% lines)
| File | Lines |
|---|---|
| `apps/desktop/src/main.ts` | 72 |
| `apps/studio/src/index.ts` | 1 |
| `apps/studio/src/main.ts` | 34 |
| `content/plugins/charts-chartjs/src/provider.ts` | 119 | (ENV — not a real gap)
| `content/plugins/charts-echarts/src/provider.ts` | 141 | (ENV — not a real gap)

Genuine zero-coverage files: `apps/studio/src/main.ts` (34), `apps/desktop/src/main.ts` (72) — process entry points — and `apps/studio/src/index.ts` (1 line). The other two are ENV artefacts.

## 5. Lowest 25 files by line coverage (≥30 lines)
| File | Lines | Lines % | ENV |
|---|---|---|---|
| `apps/studio/src/main.ts` | 34 | 0 |  |
| `content/plugins/charts-echarts/src/provider.ts` | 141 | 0 | ENV |
| `apps/desktop/src/main.ts` | 72 | 0 |  |
| `content/plugins/charts-chartjs/src/provider.ts` | 119 | 0 | ENV |
| `content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/bridge.ts` | 157 | 9.55 | ENV |
| `content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/adapter.ts` | 109 | 11.92 | ENV |
| `content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/effects.ts` | 30 | 13.33 | ENV |
| `content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/provider-results.ts` | 67 | 13.43 | ENV |
| `content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/pricing.ts` | 47 | 14.89 | ENV |
| `apps/agent/src/composition/serve.ts` | 97 | 20.61 |  |
| `apps/studio/src/composition/adapters/browser.ts` | 57 | 31.57 |  |
| `apps/server/src/composition/cli.ts` | 87 | 37.93 |  |
| `content/agent-plugins/yandex-direct/io.github.ainsep.openmarketing/src/commands.ts` | 58 | 56.89 |  |
| `apps/server/src/composition/serve.ts` | 138 | 69.56 |  |
| `apps/server/src/inbound/om.ts` | 120 | 77.5 |  |
| `apps/agent/src/inbound/control.ts` | 47 | 80.85 |  |
| `apps/server/src/composition/catalog.ts` | 168 | 82.73 |  |
| `apps/studio/src/pages/addons/model/packages.hooks.ts` | 80 | 85 |  |
| `apps/studio/src/pages/addons/model/message-composer.hooks.ts` | 138 | 85.5 |  |
| `apps/agent/src/om-client/index.ts` | 98 | 85.71 |  |
| `features/measure/src/service.ts` | 34 | 88.23 |  |
| `apps/studio/src/widgets/om-chat/OMChatPane.hooks.ts` | 151 | 89.4 |  |
| `apps/desktop/src/composition/index.ts` | 117 | 89.74 |  |
| `apps/server/src/inbound/owner.ts` | 328 | 90.24 |  |
| `apps/studio/src/features/chart-providers/use-chart-providers.ts` | 31 | 90.32 |  |

Largest absolute uncovered-line counts (non-ENV):

| File | Uncovered lines | Lines % |
|---|---|---|
| `apps/agent/src/composition/serve.ts` | 77 | 20.61 |
| `apps/desktop/src/main.ts` | 72 | 0 |
| `apps/server/src/composition/cli.ts` | 54 | 37.93 |
| `apps/server/src/composition/serve.ts` | 42 | 69.56 |
| `apps/studio/src/composition/adapters/browser.ts` | 39 | 31.57 |
| `apps/studio/src/main.ts` | 34 | 0 |
| `apps/server/src/inbound/owner.ts` | 32 | 90.24 |
| `apps/server/src/composition/catalog.ts` | 29 | 82.73 |
| `apps/server/src/inbound/om.ts` | 27 | 77.5 |
| `content/agent-plugins/yandex-direct/io.github.ainsep.openmarketing/src/commands.ts` | 25 | 56.89 |

## 6. Recommendation (nothing was changed this round)
**Thresholds** (current → proposed floor; set just below today so they ratchet, enforce per package):
| Group | Now (lines / branches) | Proposed floor |
|---|---|---|
| features | 99.2 / 84.3 | lines 97, branches 80 |
| packages | 98.7 / 94.8 | lines 95, branches 90 |
| plugins (agent-plugins) | 99.2 / 88.0 | lines 95, branches 85 |
| apps/server, apps/studio | 97.0 / 95.2 | lines 93, branches 80 |
| apps/agent, apps/desktop | 82.7 / 81.5 | lines 80 now → 90 once entry points are excluded or tested |
| **Risky paths** (features/safety, privacy, policy, web-events, measure, credentials; server `inbound/public.ts`; plugin budget/quote/conversion) | 95–100 / 73–96 | **lines 98, branches 85, functions 95, per file** |
Global: lines 95. Also gate on "no new 0% files" and exclude/declare process entry points (`main.ts`, `serve.ts`) explicitly rather than counting them.

**Top 10 gaps to close first**
1. Make the measurement trustworthy: fix `om-db`/`om-clock` dist/link setup (and declare `om-clock` in apps/server), unresolved `@jini-ai/*` imports for higgsfield-media and the charts plugins, so those three packages produce real numbers.
2. Triage the 16 failing plugin suites (possible real regressions: google-ads `campaign.validate.v1`, microsoft/x/line capability tests, yandex-direct 13) and the 7 apps/server + features SQLite failures (jobs/forms/safety) — failing money/consent/approval tests are worse than low coverage.
3. `apps/server/src/inbound/public.ts` (consent endpoint): branches 73%.
4. `features/campaigns` branches 76% (launch/approval transitions).
5. `features/safety` (confirmation/approval gates): branches 85%, 19 uncovered lines; cover the failing SQL contract tests.
6. `features/measure` `service.ts` (88%) and branches 84% (conversion delivery).
7. `features/credentials` branches 84%, 6 uncovered lines.
8. `apps/agent/src/composition/serve.ts` (21%) and `apps/agent` overall 83%.
9. `apps/server/src/composition/cli.ts` (38%) and `serve.ts` (70%), `inbound/om.ts` (78%).
10. `plugins/yandex-direct` `commands.ts` (57%) and the node:test packages (google-ads functions 88%, google-business-profile 84% lines / 54% functions) — move them to vitest so they enter `coverage.all`.

*This round was measurement only; no files outside `ADS-memory/cloud-round-1029d/` were modified.*