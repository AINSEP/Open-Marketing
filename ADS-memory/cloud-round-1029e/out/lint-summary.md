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
