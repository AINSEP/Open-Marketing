# Meta Ads plugin

Server-side Meta campaign codecs, strict hierarchy/cap readback, stop-only mapping, exact spend-report normalization and a typed CAPI backend. The plugin stays **disabled and unadmitted**. [Open evidence facts](io.github.ainsep.openmarketing/evidence/README.md) are the first adoption gate; actual hosted tools and schemas remain unavailable.

No vendor tool, credential or MCP configuration is exported to the agent. `mcp.json` has no servers. Portable format follows [Agent Plugins 1.1.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.1.0.md); OM declarations and implementation live in `io.github.ainsep.openmarketing`. Portable capability fingerprints identify proposed local codec bytes; the trusted host replaces them with captured schemas/installed digest at admission.

## Server integration

The public source entry is `io.github.ainsep.openmarketing/src/index.ts`. Its factories are inert and take injected ports:

- `createMetaAdsAdapter`: trusted evidence lookup, local bounded JSON-schema validation, server federation gateway, clock and redacted observer. It constructs proposed vendor arguments and `EffectEnvelope`. `createHostedMetaGateway` adapts j10's public federation host, whose trusted catalog resolves effects and enforces exact confirmation at egress. Configure both to the same timeout. j10 reuses published Jini MCP 0.4.3 transport; this plugin starts no second MCP lifecycle.
- `decodeMetaHierarchy`: checks all expected entity IDs/accounts and claims paused only for complete configured PAUSED status. `decodeMetaLimit` requires exact readback and preserves cumulative-cap/average-budget semantics. These codecs do not issue daily hard-limit evidence.
- `mapMetaHaltStop`: converts a safety-issued permit and stop-only effect into PAUSED payloads. The server owns current halt/account/entity validation and actual backend dispatch. This mapping is never exposed as arbitrary MCP updater authority.
- `createMetaCapiBackend`: structurally fits the public measure delivery seam; requires a durable delivery ID, pinned Graph version/dataset, server-only mode, current consent/admission fence and guarded credentialed egress. It sends one signup/trial website event. The egress port rechecks the fence after credential resolution, bounds timeout/buffers and avoids redirects/retries. Reconciliation remains unknown because no current per-event readback is verified.
- `decodeMetaSpendSnapshot`: returns the public measure snapshot shape after exact account, verified currency exponent, timezone, inclusive-date/half-open-period and precision checks. The caller owns snapshot IDs, immutable persistence, restatement lineage and OM attribution/CAC.

The caller owns generic feature adapters and the single jobs outbox. There are no static feature imports, extra stores, timers or dependency construction here. Call feature adapters through their `@open-marketing/<name>` entries from the server composition root. The narrow creation codec creates one hierarchy entity per operation; full plan composition, targeting/creative upload and all required actual tool fields need host integration and verified schema adaptation.

## Validation and packaging

Tests are **written, not run** by j13. They use hand-written fixtures and no credentials/vendor requests. Direct-double and hosted gateways share `tests/contract/gateway-suite.ts`. `tests/contract/portable-suite.ts` accepts the public j09 package inspector, so portable validation is shared with the host. The integrator must instantiate that suite in the host fixture harness; standalone manifest tests check actual files and unadmitted shared envelopes.

From the repository root, the integrator can run the lane's Vitest files, then package-scoped typecheck/build and `corepack pnpm om:check`. The lane is outside the existing workspace glob. Invoke existing root tooling against this directory; no install or root manifest/lockfile edit was performed. The build script bundles runtime dependencies into namespace `dist/index.mjs` for a host-loaded artifact. No build was run in this dispatch.

Deferred: authenticated tools/list capture and primary hosted behavior, final OAuth wiring, full campaign-plan/creative upload, bundled write-server fallback, production/local HTTP fixtures for server credentialed CAPI egress, lifecycle admission and real-account validation. Until those gates close, default evidence refuses every hosted capability.
