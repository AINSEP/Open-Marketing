---
name: build-agent-plugin
description: Build a self-contained Open Marketing agent plugin using existing upload, activation and server policy.
---

Read `site_guide` overview, then explain `build-agent-plugin`, `addons`, and `safety`. Inspect a current OM plugin and its supported manifest contracts before authoring files; do not invent executable bindings from metadata.

1. Create `plugin.json` with portable name, version, description and license. Put OM metadata under `extensions.io.github.ainsep.openmarketing`. Keep vendor configuration in the package, with no embedded credentials.
2. Add task guidance at `skills/<name>/SKILL.md` and optional `references/`. Declare actual effects accurately. Instructions do not create runtime capabilities.
3. If required, use `mcp.json` for server-owned MCP transport configuration. Vendor SDKs, codecs, OAuth, backend code and fixtures belong in this plugin's `io.github.ainsep.openmarketing/` directory. The separate agent process receives no vendor secrets, direct vendor egress or unrestricted shell.
4. Validate manifests and all external results. Bound payloads, deadlines and retries; inject I/O, clocks and IDs. Use stable idempotency keys and OM's one jobs outbox for external writes; reconcile unknown non-idempotent outcomes.
5. Write fixture tests for invalid input, policy denial, retries, cancellation and unknown results. No live spend, real credentials or vendor requests in automated tests. Never weaken the server's generic tool policy.
6. Package using the existing add-on upload format and install with Add-ons or `addons_install`. Enable separately through `addons_set_enabled`; inspect discovered instructions and tools after activation. Uploaded instructions/MCP use the normal lifecycle; uploaded executable vendor backend loading is currently unavailable. Enabling cannot supply missing host bindings or vendor admission.

Uploaded plugins, including browser chart providers, may run on the studio origin. OM imposes no bundled-only allowlist, digest pin or sandbox. Per-file integrity checks detect corruption. Charts use plugin assets through the neutral UI chart contract; do not add an npm chart dependency to OM. There is no marketplace requirement.

Ad spend requires the exact card for every call, including each reviewed call within a grouped campaign deployment. Destructive calls retain exact confirmation. Generation within the configurable daily allowance uses ordinary write grants, including Always allow; unknown/over-allowance cost requires exact spend approval. Only typed server stop jobs can follow a local halt. Conversions require typed measurement grants, dispatch-time consent checks and egress audit. A plugin cannot grant itself any of these authorities.
