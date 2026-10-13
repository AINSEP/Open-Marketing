# Higgsfield provenance

Modified/adapted for OM by j11, 2026-10-12. Apache-2.0; retain LICENSE and NOTICE.
Source: `/Users/la/Programming/Tovu/content/agent-plugins/higgsfield-media`, last
lane commit `96cdc66383ae3d8ea2791528f4e49f2e3102f11e`, plus working-tree report
`ADS-memory/reports/2026-09-10-higgsfield-mcp-research.md`. That commit identifies
lane history, not a claim that the report was part of it.

| OM artifact | Source | Modification |
| --- | --- | --- |
| SKILL.md | Tovu same path | Rewritten for OM server federation, allowance and durable workers; removed Tovu tool/UI names, restart assumptions and automatic fallbacks |
| failure-modes.md | Tovu same reference | Historical diagnostics adapted; no claim that Tovu transport defects apply to OM |
| models-and-plan-gates.md | Tovu same reference | Historical examples retained; no current entitlement or credit-to-dollar assumption |
| oauth-discovery.json | September research | Discovery/PKCE/DCR hints marked unverified-current; unresolved device flow unadmitted |
| mcp.json | Tovu endpoint/OM skeleton | Closed v1.1.0 server entry; OAuth moved to namespace |
| src/ and tests/ | New OM code | No copied executable source; synthetic fixtures, not current vendor recordings |

Reuse: installed `@jini-ai/integrations@0.4.2` supplies PollingVendorAdapter,
AsyncOperationStore, startOperation, pollDueOperations and recoverAfterRestart.
The plugin only supplies vendor mapping and an in-process host bridge. Server
federation uses `@jini-ai/mcp@0.4.3`; no second MCP client is constructed here.

`npm view` was attempted for both packages without installation and failed with
`ENOTFOUND registry.npmjs.org`. APIs/versions were inspected in installed published
artifacts. There are no imports into the sibling Tovu or Jini source trees.

Format authority: [Agent Plugins spec 1.1.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.1.0.md), read during implementation. Loading uses local schemas.
