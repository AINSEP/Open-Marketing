# Campaigns continuation — 2026-10-12

Persona: AI-Dev-Shop Programmer, loaded. Scope: features/campaigns only.
Inputs: dispatch, development/COMMON.md and JOBS.md j15, architecture §4.11,
and committed continuation 59db645..3e2648f. Existing implementation retained.

Verification constraint: no tests, builds, install, om:check or gate runs.
One package typecheck is allowed at the end. Regression tests will be written,
not run; no executed red/green evidence will be claimed.

Current objective: harden stored identity, exact-envelope binding and dispatch
rechecks, complete adversarial tests, then document server integration needs.

Discovery: graph MCP tools unavailable; inspected feature source directly.
No earlier PROGRESS.md/HANDOFF.md exists. README still describes stubs.
Jini installed declarations inspected: @jini-ai/mcp 0.4.3 federation and
approvals. Published npm entry also inspected. Campaigns owns no MCP transport,
OAuth or credential implementation. Keep the caller-owned backend seam; the
server federation binding must use the published package. No new dependency
or jini-compat implementation is needed in this feature.

Pattern priming: continue the committed, authorized style: pure typed validation
rules, injected effect ports, schema snapshots before await, module-level tests.
No new layer/pattern or public service contract is planned.

Pre-code checklist: feature-only imports via contracts, no canonical policy
import, driver-free SQL adapter, inert factories, one caller-owned jobs outbox,
no activation fields on draft, immutable exact launch arguments, final safety
dispatch barrier, operation/scope binding, no retry after claim, injected clock.
Tests will directly assert denied dispatch plus zero provider mutations, changed
claim payloads, stale paused state, wrong SQL identity and throw/reconcile paths.
Work remains bounded by existing DTO limits (100 assets, 500 hierarchy entities),
one bulk asset resolution and constant port calls; no retries or per-item I/O.

Implemented: exact envelope and outbox identity checks, claim payload comparison,
post-claim creative/state checks, matching creation readiness, typed unknown evidence
on thrown dispatch, SQL relational identity checks, observer double, and regression
tests. Existing service/adapters/migration retained. README and HANDOFF updated.

Review correction: initially coupled service record validation to the memory/SQL
campaign ID formula. Removed that coupling; campaign identity stays repository-owned.
SQL instead compares draft operation with its relational operation_id. Added a
replacement-repository identity test. This correction required no contract change.

Final evidence: the ONE allowed `corepack pnpm --filter @open-marketing/campaigns
typecheck` invocation passed, exit 0 (production and tests). Scoped git diff
whitespace check passed. No tests/build/om:check/install/runtime validation ran.
HANDOFF.md records changes, tests, contracts, architecture/function review and NEEDS.

Next owner: Coordinator runs combined verification and inspection; server/provider/UI
integrators supply the real safety/jobs/assets/federation and HTTP/studio/CLI bindings.
No commit or push. All writes stayed inside features/campaigns.
