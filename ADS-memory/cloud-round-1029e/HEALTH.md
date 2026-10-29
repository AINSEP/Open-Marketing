# OM code-health analysis — round 1029e

**ANALYSIS ONLY. Nothing was changed: no source, tests, config or lockfile were edited.** Measured on `main` @ b97aa20 (branch `cloud/om-round-1029e`), Node 24, `pnpm install --frozen-lockfile`. Raw outputs are in `out/`. Work was delegated to two Sonnet subagents (A: complexity+lint, B: cycles+boundaries+typecheck).

## 1. Summary

| metric | value |
|---|---|
| Source files linted | 1038 |
| Function nodes measured (Declaration/Expression/Arrow, incl. methods) | 18976 (6028 score ≥1; the rest score 0 and emit no message). `om:metrics` counts 29216 functions over 1041 sources with its own method — different counting basis |
| Functions over 10 (violations) | **4** (all score 11) |
| Functions at 8–10 (near limit) | **317** |
| Max score | **11** (apps/studio/tests/addons.test.ts:22) |
| Nesting violations (`max-depth`, `om/control-depth`) | **0 / 0** |
| Lint findings (`om:lint`, exit 1) | **49** (41 `om/two-object-arguments`, 4 `sonarjs/cognitive-complexity`, 4 `om/no-functions-in-component-body`) + 18 stale-provenance integrity failures (`packages/contracts/dist/src/**`, stale local build, not source) |
| Import cycles | **53** (41 with ≥1 runtime edge, 12 fully type-only); edges 193 = 110 runtime + 83 type-only |
| Boundary violations (non-cycle) | **2** |
| Typecheck errors | **46** (apps/studio 2, higgsfield-media plugin 44) |
| `om:metrics` | PASS |

Caveats: function names come from a regex on the reported line, many are `<anonymous>` — use file:line. Group labels "parked"/"tooling" are subagent labels for parked source and `development/`. `om:typecheck` bails at first failure; B re-ran with `--no-bail` (25 of 26 workspace projects). Plugins are not workspace members and were typechecked per directory; 6 plugin dirs (anthropic, email-lifecycle, google, om-playbook, openai, seo) have no typecheck script and were not checked.

## 2. Complexity distribution (function nodes per group)

| group | fn nodes | 0-5 | 6-7 | 8-10 | 11-15 | 16-25 | >25 |
|---|---|---|---|---|---|---|---|
| apps | 7132 | 6840 | 177 | 113 | 2 | 0 | 0 |
| features | 5038 | 4877 | 107 | 54 | 0 | 0 | 0 |
| packages | 350 | 346 | 3 | 1 | 0 | 0 | 0 |
| plugins | 6098 | 5725 | 226 | 145 | 2 | 0 | 0 |
| parked | 133 | 128 | 4 | 1 | 0 | 0 | 0 |
| tooling | 224 | 219 | 2 | 3 | 0 | 0 | 0 |
| other | 1 | 1 | 0 | 0 | 0 | 0 | 0 |

## 3. Functions over 10 (highest first)

| file:line | name | score | group |
|---|---|---|---|
| apps/studio/tests/addons.test.ts:22 | <anonymous> | 11 | apps |
| apps/studio/src/shared/api/http.ts:98 | <anonymous> | 11 | apps |
| content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/read-capabilities.test.ts:341 | test | 11 | plugins |
| content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts:69 | <anonymous> | 11 | plugins |

### Near limit (8–10), top 40 (of 317; full list in `out/complexity-functions.tsv`)

| file:line | name | score | group |
|---|---|---|---|
| apps/desktop/src/om-server.ts:80 | <anonymous> | 10 | apps |
| apps/server/src/om-tools.ts:413 | <anonymous> | 10 | apps |
| apps/server/src/om-tools.ts:1029 | <anonymous> | 10 | apps |
| apps/server/src/runs.ts:234 | <anonymous> | 10 | apps |
| apps/server/src/site-guide.ts:59 | <anonymous> | 10 | apps |
| apps/server/tests/om-tools.test.ts:1302 | <anonymous> | 10 | apps |
| apps/studio/tests/theme-pack.test.ts:116 | it | 10 | apps |
| features/contacts/src/rules.ts:103 | <anonymous> | 10 | features |
| features/contacts/src/service.ts:65 | <anonymous> | 10 | features |
| features/creative/src/lifecycle.ts:14 | <anonymous> | 10 | features |
| features/credentials/src/token.ts:127 | run | 10 | features |
| apps/agent/src/inbound/control.ts:12 | <anonymous> | 10 | apps |
| apps/server/src/alerts/provider-settings.ts:71 | <anonymous> | 10 | apps |
| apps/server/src/cli/addons.ts:144 | <anonymous> | 10 | apps |
| apps/server/src/composition/agent-plugin-backends.ts:1107 | <anonymous> | 10 | apps |
| apps/server/src/composition/alerts.ts:103 | <anonymous> | 10 | apps |
| apps/server/src/composition/cli.ts:21 | <anonymous> | 10 | apps |
| apps/server/src/composition/forms.ts:105 | <anonymous> | 10 | apps |
| apps/server/src/composition/index.ts:273 | <anonymous> | 10 | apps |
| apps/server/src/composition/subject-lane.ts:20 | <anonymous> | 10 | apps |
| apps/server/src/composition/subject-lane.ts:42 | <anonymous> | 10 | apps |
| apps/server/src/inbound/consent-limit.ts:14 | <anonymous> | 10 | apps |
| apps/server/src/inbound/model.ts:188 | <anonymous> | 10 | apps |
| apps/studio/src/widgets/om-chat/OMChatPane.hooks.ts:113 | <anonymous> | 10 | apps |
| content/agent-plugins/apple-search-ads/io.github.ainsep.openmarketing/src/transport.ts:123 | <anonymous> | 10 | plugins |
| content/agent-plugins/apple-search-ads/io.github.ainsep.openmarketing/src/transport.ts:194 | <anonymous> | 10 | plugins |
| content/agent-plugins/apple-search-ads/io.github.ainsep.openmarketing/tests/deployment.test.ts:55 | it | 10 | plugins |
| content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/plugin.ts:83 | <anonymous> | 10 | plugins |
| content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/plugin.ts:100 | <anonymous> | 10 | plugins |
| content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts:139 | <anonymous> | 10 | plugins |
| content/agent-plugins/line-ads/io.github.ainsep.openmarketing/tests/fixtures.ts:93 | dependencies | 10 | plugins |
| content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/src/capabilities.ts:90 | <anonymous> | 10 | plugins |
| content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/src/capi.ts:155 | <anonymous> | 10 | plugins |
| content/agent-plugins/linkedin-ads/io.github.ainsep.openmarketing/src/transport.ts:182 | <anonymous> | 10 | plugins |
| content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/campaign-translation.ts:89 | <anonymous> | 10 | plugins |
| content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts:27 | <anonymous> | 10 | plugins |
| content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts:250 | <anonymous> | 10 | plugins |
| content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/transport.ts:206 | <anonymous> | 10 | plugins |
| content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/tests/campaign-deployment.test.ts:178 | f | 10 | plugins |
| content/agent-plugins/naver-ads/io.github.ainsep.openmarketing/tests/capabilities.test.ts:26 | <anonymous> | 10 | plugins |

## 4. Cycles

The cycle list below is generated from dependency-cruiser (`no-cycles`, same config as `om:boundaries`); `boundaries.mjs` also prints 37 `cycle:` lines from its own DFS (separate count, see `out/boundaries-raw.txt`). Full JSON: `out/cycles.json`.

- Violation rows reported by cruiser: 53 (all distinct after rotation dedupe)
- Unique cycles (rotation-deduped): 53
- Cycles with at least one runtime edge: 41
- Fully type-only cycles (every edge type-only): 12
- Edges total: 193 (runtime 110, type-only 83)
- Note: boundaries.mjs also prints its own "cycle: <file>" lines (graphCycles DFS back-edges over TS-resolved edges, type-only included); those are a separate count in boundaries-raw.txt.

## Top 5 files by number of unique cycles
- 23  apps/server/src/composition/agent-plugin-backends.ts
- 20  apps/server/src/om-tools.ts
- 15  apps/server/src/composition/identity.ts
- 12  apps/server/src/composition/forms.ts
- 8  content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts

## By package

| package | cycles | runtime | fully type-only |
|---|---|---|---|
| apps/server | 24 | 24 | 0 |
| apps/studio | 1 | 0 | 1 |
| content/agent-plugins/amazon-ads | 1 | 1 | 0 |
| content/agent-plugins/google-ads | 2 | 1 | 1 |
| content/agent-plugins/line-ads | 1 | 0 | 1 |
| content/agent-plugins/meta-ads | 2 | 2 | 0 |
| content/agent-plugins/microsoft-ads | 3 | 3 | 0 |
| content/agent-plugins/pinterest-ads | 2 | 2 | 0 |
| content/agent-plugins/reddit-ads | 1 | 0 | 1 |
| content/agent-plugins/resend-email | 1 | 0 | 1 |
| content/agent-plugins/snapchat-ads | 8 | 6 | 2 |
| content/agent-plugins/twilio-sms | 3 | 1 | 2 |
| content/agent-plugins/vk-ads | 1 | 0 | 1 |
| content/agent-plugins/whatsapp-business | 1 | 0 | 1 |
| features/jobs | 1 | 0 | 1 |
| features/measure | 1 | 1 | 0 |

## apps/server

### Cycle 1 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- apps/server/src/alerts/email.ts -> apps/server/src/alerts/provider-settings.ts  [runtime]
- apps/server/src/alerts/provider-settings.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/alerts/email.ts  [type-only]

### Cycle 2 (4 files, 2 runtime / 2 type-only edges) RUNTIME
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/alerts/email.ts  [type-only]

### Cycle 3 (6 files, 5 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 4 (6 files, 5 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/jobs.ts  [runtime]
- apps/server/src/alerts/jobs.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 5 (4 files, 3 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/provider-settings.ts  [runtime]
- apps/server/src/alerts/provider-settings.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 6 (7 files, 6 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/store.ts  [runtime]
- apps/server/src/alerts/store.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]

### Cycle 7 (8 files, 7 runtime / 1 type-only edges) RUNTIME
- apps/server/src/alerts/jobs.ts -> apps/server/src/alerts/store.ts  [runtime]
- apps/server/src/alerts/store.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/alerts/index.ts  [runtime]
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/jobs.ts  [runtime]

### Cycle 8 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]

### Cycle 9 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]

### Cycle 10 (7 files, 5 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/alerts.ts -> apps/server/src/alerts/index.ts  [runtime]
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/alerts.ts  [type-only]

### Cycle 11 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/alerts.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/alerts.ts  [type-only]

### Cycle 12 (7 files, 5 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/alerts.ts -> apps/server/src/composition/reporting.ts  [runtime]
- apps/server/src/composition/reporting.ts -> apps/server/src/alerts/jobs.ts  [runtime]
- apps/server/src/alerts/jobs.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/alerts.ts  [type-only]

### Cycle 13 (6 files, 4 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/reporting.ts -> apps/server/src/alerts/jobs.ts  [runtime]
- apps/server/src/alerts/jobs.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/reporting.ts  [type-only]

### Cycle 14 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/reporting.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/reporting.ts  [type-only]

### Cycle 15 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/reporting.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/reporting.ts  [type-only]

### Cycle 16 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/composition/tracking.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]

### Cycle 17 (6 files, 4 runtime / 2 type-only edges) RUNTIME
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]
- apps/server/src/inbound/public.ts -> apps/server/src/composition/forms.ts  [type-only]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]

### Cycle 18 (6 files, 3 runtime / 3 type-only edges) RUNTIME
- apps/server/src/conversations.ts -> apps/server/src/model-providers.ts  [runtime]
- apps/server/src/model-providers.ts -> apps/server/src/composition/addons.ts  [type-only]
- apps/server/src/composition/addons.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/inbound/owner.ts  [runtime]
- apps/server/src/inbound/owner.ts -> apps/server/src/conversations.ts  [type-only]

### Cycle 19 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/inbound/integrations.ts -> apps/server/src/om-tools.ts  [type-only]
- apps/server/src/om-tools.ts -> apps/server/src/inbound/owner.ts  [runtime]
- apps/server/src/inbound/owner.ts -> apps/server/src/inbound/integrations.ts  [runtime]

### Cycle 20 (6 files, 4 runtime / 2 type-only edges) RUNTIME
- apps/server/src/inbound/messaging-webhooks.ts -> apps/server/src/composition/identity.ts  [type-only]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]
- apps/server/src/inbound/public.ts -> apps/server/src/inbound/messaging-webhooks.ts  [runtime]

### Cycle 21 (8 files, 6 runtime / 2 type-only edges) RUNTIME
- apps/server/src/inbound/owner.ts -> apps/server/src/composition/alerts.ts  [type-only]
- apps/server/src/composition/alerts.ts -> apps/server/src/alerts/index.ts  [runtime]
- apps/server/src/alerts/index.ts -> apps/server/src/alerts/email.ts  [runtime]
- apps/server/src/alerts/email.ts -> apps/server/src/composition/forms.ts  [runtime]
- apps/server/src/composition/forms.ts -> apps/server/src/composition/identity.ts  [runtime]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/inbound/owner.ts  [runtime]

### Cycle 22 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- apps/server/src/inbound/public.ts -> apps/server/src/composition/identity.ts  [type-only]
- apps/server/src/composition/identity.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]

### Cycle 23 (5 files, 4 runtime / 1 type-only edges) RUNTIME
- apps/server/src/inbound/public.ts -> apps/server/src/inbound/messaging-webhooks.ts  [runtime]
- apps/server/src/inbound/messaging-webhooks.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]
- apps/server/src/om-tools.ts -> apps/server/src/composition/tracking.ts  [runtime]
- apps/server/src/composition/tracking.ts -> apps/server/src/inbound/public.ts  [runtime]

### Cycle 24 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- apps/server/src/om-tools.ts -> apps/server/src/alerts/provider-settings.ts  [runtime]
- apps/server/src/alerts/provider-settings.ts -> apps/server/src/composition/agent-plugin-backends.ts  [type-only]
- apps/server/src/composition/agent-plugin-backends.ts -> apps/server/src/om-tools.ts  [runtime]

## apps/studio

### Cycle 25 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- apps/studio/src/shared/api/types.ts -> apps/studio/src/shared/api/validation.ts  [type-only]
- apps/studio/src/shared/api/validation.ts -> apps/studio/src/shared/api/types.ts  [type-only]

## content/agent-plugins/amazon-ads

### Cycle 26 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]
- content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/amazon-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/google-ads

### Cycle 27 (2 files, 2 runtime / 0 type-only edges) RUNTIME
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/hosted.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts  [runtime]
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/hosted.ts  [runtime]

### Cycle 28 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/types.ts  [type-only]
- content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/types.ts -> content/agent-plugins/google-ads/io.github.ainsep.openmarketing/src/schemas.ts  [type-only]

## content/agent-plugins/line-ads

### Cycle 29 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/line-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/meta-ads

### Cycle 30 (2 files, 2 runtime / 0 type-only edges) RUNTIME
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/audiences.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts  [runtime]
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/read-capabilities.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/audiences.ts  [runtime]

### Cycle 31 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram.ts  [type-only]
- content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram.ts -> content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts  [runtime]

## content/agent-plugins/microsoft-ads

### Cycle 32 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 33 (2 files, 2 runtime / 0 type-only edges) RUNTIME
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]

### Cycle 34 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]
- content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/microsoft-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]

## content/agent-plugins/pinterest-ads

### Cycle 35 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 36 (3 files, 2 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts  [runtime]
- content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/pinterest-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/reddit-ads

### Cycle 37 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/reddit-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/resend-email

### Cycle 38 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/resend-email/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/snapchat-ads

### Cycle 39 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]

### Cycle 40 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]

### Cycle 41 (4 files, 2 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]

### Cycle 42 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 43 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/metrics-status.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/metrics-status.ts  [runtime]

### Cycle 44 (5 files, 3 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]

### Cycle 45 (4 files, 2 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/reporting.ts  [runtime]

### Cycle 46 (3 files, 1 runtime / 2 type-only edges) RUNTIME
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts  [type-only]
- content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/capi.ts -> content/agent-plugins/snapchat-ads/io.github.ainsep.openmarketing/src/transport.ts  [runtime]

## content/agent-plugins/twilio-sms

### Cycle 47 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

### Cycle 48 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts  [runtime]

### Cycle 49 (3 files, 0 runtime / 3 type-only edges) TYPE-ONLY
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts  [type-only]
- content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/twilio-sms/io.github.ainsep.openmarketing/src/transport.ts  [type-only]

## content/agent-plugins/vk-ads

### Cycle 50 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/commands.ts -> content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/ports.ts  [type-only]
- content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/vk-ads/io.github.ainsep.openmarketing/src/commands.ts  [type-only]

## content/agent-plugins/whatsapp-business

### Cycle 51 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/ports.ts -> content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/transport.ts  [type-only]
- content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/transport.ts -> content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/ports.ts  [type-only]

## features/jobs

### Cycle 52 (2 files, 0 runtime / 2 type-only edges) TYPE-ONLY
- features/jobs/src/schema.ts -> features/jobs/src/types.ts  [type-only]
- features/jobs/src/types.ts -> features/jobs/src/schema.ts  [type-only]

## features/measure

### Cycle 53 (2 files, 1 runtime / 1 type-only edges) RUNTIME
- features/measure/src/rules.ts -> features/measure/src/types.ts  [runtime]
- features/measure/src/types.ts -> features/measure/src/rules.ts  [type-only]


## 5. Boundary violations and typecheck errors

# Non-cycle boundary violations (om:boundaries)

Source: boundaries-raw.txt. Total non-cycle violations: 2 (manifest, reporting-boundary, FSD, vendor and nonliteral-import checks all clean).

| file:line | import | rule |
|---|---|---|
| packages/contracts/tests/assistant.test.ts:2 | node:fs | impure-contracts (contracts package importing a node: builtin, in a test file) |
| apps/server/src/cli/http.ts:10 | @open-marketing/leads | cli-shortcut (a /cli/ file importing a feature package directly instead of via composition) |

Cycle violations (no-cycles via dependency-cruiser plus graphCycles) are in cycles.md / cycles.json.


# Typecheck errors

om:typecheck (pnpm -r typecheck, 25 of 26 workspace projects; default run bails at first failure, re-run with --no-bail): only apps/studio failed. All other workspace packages (agent, desktop, server, contracts, om-clock, om-db, all features) passed.
Plugins (content/agent-plugins/*) are NOT workspace members; their typecheck was run per directory: 22 had a typecheck script, 21 passed, content/agent-plugins/higgsfield-media failed. 6 dirs have no package.json/typecheck (anthropic, email-lifecycle, google, om-playbook, openai, seo).

**Totals: 46 errors = apps/studio 2 + higgsfield-media 44.**

## apps/studio (tests tsconfig: tsc -p tsconfig.tests.json) (2 errors)

- apps/studio/tests/conversion-grants.test.ts:97 TS2531 Object is possibly 'null'.
- apps/studio/tests/conversion-grants.test.ts:97 TS2339 Property 'grantId' does not exist on type 'string | number | boolean | JSONType[] | { [key: string]: JSONType; }'.

## content/agent-plugins/higgsfield-media (paths relative to content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/) (44 errors)

- src/adapter.ts:3 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/adapter.ts:39 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/adapter.ts:43 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/adapter.ts:51 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/adapter.ts:56 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/bridge.ts:4 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/bridge.ts:39 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/bridge.ts:52 TS7006 Parameter 'input' implicitly has an 'any' type.
- src/index.ts:16 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/types.ts:2 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- src/types.ts:5 TS2339 Property 'ctx' does not exist on type 'unknown'.
- tests/federation-integration.test.ts:4 TS2307 Cannot find module '@open-marketing/federation' or its corresponding type declarations.
- tests/federation-integration.test.ts:5 TS2307 Cannot find module '@open-marketing/federation' or its corresponding type declarations.
- tests/federation-integration.test.ts:24 TS2322 Type '{ generationSchemaFingerprint: unknown; pluginId: "higgsfield-media"; pluginDigest: string; configurationDigest: string; connectionId:
- tests/federation-integration.test.ts:24 TS2322 Type '{ generationSchemaFingerprint: unknown; evidenceId: string; source: string; observedAt: number; expiresAt: number; pluginDigest: strin
- tests/federation-integration.test.ts:34 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:34 TS7006 Parameter 'options' implicitly has an 'any' type.
- tests/federation-integration.test.ts:42 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:42 TS7006 Parameter 'options' implicitly has an 'any' type.
- tests/federation-integration.test.ts:44 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:52 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:59 TS7006 Parameter 'input' implicitly has an 'any' type.
- tests/federation-integration.test.ts:59 TS2322 Type '{ generationSchemaFingerprint: unknown; pluginId: "higgsfield-media"; pluginDigest: string; configurationDigest: string; connectionId:
- tests/federation-integration.test.ts:62 TS2322 Type '{ generationSchemaFingerprint: unknown; pluginId: "higgsfield-media"; pluginDigest: string; configurationDigest: string; connectionId:
- tests/federation-integration.test.ts:62 TS2322 Type '{ generationSchemaFingerprint: unknown; evidenceId: string; source: string; observedAt: number; expiresAt: number; pluginDigest: strin
- tests/runtime.test.ts:2 TS2307 Cannot find module '@jini-ai/integrations/media-providers' or its corresponding type declarations.
- tests/safety-integration.test.ts:3 TS2307 Cannot find module '@open-marketing/safety' or its corresponding type declarations.
- tests/safety-integration.test.ts:4 TS2307 Cannot find module '@open-marketing/safety' or its corresponding type declarations.
- tests/safety-integration.test.ts:37 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:37 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:37 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:41 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:45 TS2571 Object is of type 'unknown'.
- tests/safety-integration.test.ts:46 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:54 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:64 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:64 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:64 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:65 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:72 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:72 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:72 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:74 TS18046 'card' is of type 'unknown'.
- tests/safety-integration.test.ts:75 TS7006 Parameter 'input' implicitly has an 'any' type.

higgsfield-media by code: TS2307 x9, TS7006 x14, TS2339 x1, TS2322 x5, TS18046 x14, TS2571 x1
Root causes visible in output: unresolved modules @jini-ai/integrations/media-providers, @open-marketing/federation, @open-marketing/safety (not resolvable from the plugin dir, then cascading implicit-any/unknown errors).


## 6. Lint by rule, top files

# om:lint summary (real config), exit code 1

Rule findings: 49; other (integrity/provenance) lines: 19

## By rule
- om/two-object-arguments: 41
- sonarjs/cognitive-complexity: 4
- om/no-functions-in-component-body: 4

## Rule x group
- om/no-functions-in-component-body / apps: 4
- om/two-object-arguments / apps: 6
- om/two-object-arguments / plugins: 35
- sonarjs/cognitive-complexity / apps: 2
- sonarjs/cognitive-complexity / plugins: 2

## Non-rule failures
- stale or invalid generated source provenance: 18
-  ELIFECYCLE  Command failed with exit code 1.: 1
  files: packages/contracts/dist/src, packages/contracts/dist/src/addons, packages/contracts/dist/src/agent, packages/contracts/dist/src/api, packages/contracts/dist/src/capabilities, packages/contracts/dist/src/launch, packages/contracts/dist/src/metrics, packages/contracts/dist/src/telemetry, packages/contracts/dist/src/values,  ELIFECYCLE  Command failed with exit code 1.

## Top 10 files by findings
- content/plugins/charts-echarts/src/provider.ts: 12
- content/plugins/charts-chartjs/src/provider.ts: 7
- content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/federation-integration.test.ts: 5
- apps/studio/tests/leads.test.tsx: 4
- content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/adapter.ts: 4
- content/plugins/charts-chartjs/tests/provider.test.ts: 2
- content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/bridge.ts: 2
- apps/server/tests/consent-limit.test.ts: 1
- apps/server/tests/integration-oauth-vendors.test.ts: 1
- apps/server/tests/integrations.test.ts: 1

## Full findings (file:line:rule)
apps/server/tests/consent-limit.test.ts:9:om/two-object-arguments
apps/server/tests/integration-oauth-vendors.test.ts:32:om/two-object-arguments
apps/server/tests/integrations.test.ts:454:om/two-object-arguments
apps/server/tests/om-tools.test.ts:668:om/two-object-arguments
apps/studio/tests/addons.test.ts:22:sonarjs/cognitive-complexity
apps/studio/tests/leads.test.tsx:21:om/no-functions-in-component-body
apps/studio/tests/leads.test.tsx:22:om/no-functions-in-component-body
apps/studio/tests/leads.test.tsx:50:om/no-functions-in-component-body
apps/studio/tests/leads.test.tsx:74:om/no-functions-in-component-body
apps/studio/tests/shell.test.ts:21:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:66:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:78:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:79:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:81:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:91:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:108:om/two-object-arguments
content/plugins/charts-chartjs/src/provider.ts:125:om/two-object-arguments
content/plugins/charts-chartjs/tests/provider.test.ts:13:om/two-object-arguments
content/plugins/charts-chartjs/tests/provider.test.ts:18:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:75:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:86:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:87:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:95:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:106:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:106:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:112:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:112:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:113:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:115:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:128:om/two-object-arguments
content/plugins/charts-echarts/src/provider.ts:147:om/two-object-arguments
content/plugins/charts-echarts/tests/provider.test.ts:12:om/two-object-arguments
apps/studio/src/shared/api/http.ts:98:sonarjs/cognitive-complexity
content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/campaign-deployment.test.ts:452:om/two-object-arguments
content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/read-capabilities.test.ts:341:sonarjs/cognitive-complexity
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/adapter.ts:39:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/adapter.ts:43:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/adapter.ts:51:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/adapter.ts:56:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/bridge.ts:39:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/src/bridge.ts:52:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/federation-integration.test.ts:34:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/federation-integration.test.ts:42:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/federation-integration.test.ts:44:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/federation-integration.test.ts:52:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/federation-integration.test.ts:59:om/two-object-arguments
content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tests/safety-integration.test.ts:75:om/two-object-arguments
content/agent-plugins/meta-ads/io.github.ainsep.openmarketing/src/instagram-fetch.ts:69:sonarjs/cognitive-complexity
apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.tsx:45:om/two-object-arguments


## 7. What to work on first (ranked)

Risk weighting: money/spend, consent/privacy, approvals, conversions/measure, credentials first. Ranking is judgement from file paths in the lists above; I did not read function bodies.

1. **`apps/server/src/cli/http.ts:10` cli-shortcut** — CLI file imports `@open-marketing/leads` directly; a real architecture-contract breach on a leads/consent path.
2. **`features/measure` runtime cycle** (conversions/measure) — see the features/measure section above; runtime cycle in a measurement path.
3. **Server composition cycles** — `agent-plugin-backends.ts` (23 cycles), `om-tools.ts` (20), `identity.ts` (15), `forms.ts` (12): all 24 server cycles have a runtime edge and sit on credential/identity/forms/consent wiring; breaking the hub files (e.g. via caller-owned ports) removes most cycles.
4. **Near-limit functions on risky paths**: `features/credentials/src/token.ts:127` (credentials), `apps/server/src/inbound/consent-limit.ts:14` (consent), `apps/server/src/inbound/model.ts:188`, `features/contacts/src/rules.ts:103` and `service.ts:65` (contacts/consent), `apps/server/src/runs.ts:234`, `apps/server/src/composition/{alerts,forms,subject-lane}.ts`, `apps/server/src/om-tools.ts:413,1029`.
5. **Over-limit prod function `content/agent-plugins/meta-ads/.../src/instagram-fetch.ts:69`** (score 11, vendor fetch/spend plugin) — also meta-ads has 2 runtime cycles.
6. **Over-limit prod function `apps/studio/src/shared/api/http.ts:98`** (score 11, studio API client used by everything).
7. **Plugin runtime cycles with spend/transport surface**: snapchat-ads (8 cycles, `src/ports.ts` in 8), microsoft-ads (3 runtime), pinterest-ads (2), amazon-ads (1), twilio-sms (1 runtime; messaging/consent).
8. **higgsfield-media typecheck (44 errors)** — unresolved `@jini-ai/integrations/media-providers`, `@open-marketing/federation`, `@open-marketing/safety` from the plugin dir (looks like a workspace-resolution gap, not logic); fix the resolution and the cascade likely clears. Includes `tests/safety-integration.test.ts` (safety).
9. **Test-only over-limit and lint**: `apps/studio/tests/addons.test.ts:22`, `google-ads/.../read-capabilities.test.ts:341` (score 11); `apps/studio/tests/conversion-grants.test.ts:97` typecheck (2 errors, conversions grant); `packages/contracts/tests/assistant.test.ts:2` `node:fs` in contracts (impure-contracts).
10. **Lint hygiene**: 41 `om/two-object-arguments` (concentrated in `content/plugins/charts-echarts/src/provider.ts` 12 and `charts-chartjs/src/provider.ts` 7), 4 `om/no-functions-in-component-body` in `apps/studio/tests/leads.test.tsx`; regenerate `packages/contracts` dist to clear the 18 provenance failures (local build state).

**Nothing was changed in this round.** Only files under `ADS-memory/cloud-round-1029e/` were added.
