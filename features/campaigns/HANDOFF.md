# Programmer(Direct): campaigns continuation — 2026-10-12

Campaigns creates vendor-neutral drafts PAUSED, verifies the full hierarchy, freezes
one exact launch operation for approval, and dispatches durable intent once. Partial
creation or uncertain activation is reconciled by reading evidence, without sending
the mutation again. For example: create a paused campaign, propose its flight, have
safety approve that exact card, enqueue launch, then let a server worker dispatch it.

Deferred: server bindings to safety, the one jobs outbox, asset revisions and plugin
federation; HTTP/studio/CLI composition; live provider validation. These belong to
other lanes. Budget changes/reallocation are absent from the authoritative API.
Tests and mechanical gates are deferred by the owner's no-test override.

## Inputs and continuation

- Read AI-Dev-Shop/agents/programmer/skills.md and AI-Dev-Shop/AGENTS.md first.
- Inspected 59db645..3e2648f for features/campaigns, then current source/tests.
- No earlier HANDOFF.md/PROGRESS.md was present. Retained the committed core,
  memory doubles, SQL/capability adapters, migration and behavioral suites.
- Authority: current index.ts/src/ports.ts/src/types.ts, JOBS.md j15, COMMON.md,
  architecture §4.11 and dispatch overrides. No certified spec/hash artifact was
  supplied; this direct feature dispatch is the active acceptance contract.
- Codebase graph MCP tools were unavailable; direct scoped source reads were used.

## CHANGED FILES

- index.ts: add the missing observer double factory/type to the public entry.
- src/rules.ts: validate the entire spend envelope in exact matching, including
  creative identity, account/connection, effect class, exposure and no limit grant.
- src/repo-rules.ts: validate scoped record/proposal output and matching observations;
  reject receipt/evidence contradictions and substituted proposal acknowledgements.
- src/job-rules.ts (new): validate outbox scope, operation, digest and immutable intent.
- src/creative-rules.ts (new): one shared current-revision check for create/queue/dispatch.
- src/creation-ready.ts (new): launch requires the matching submitted creation job,
  as well as paused evidence. An unrelated paused readback cannot complete creation.
- src/dispatch-intent.ts (new): bind intent to current campaign and creative revisions.
- src/create.ts, src/create-and-dispatch.ts, src/launch.ts: use those validation seams;
  schema-snapshot repository acknowledgements before they become visible or durable intent.
- src/dispatch.ts: verify the claimed job is exactly the queued job; recheck current
  state after claim; persist unknown evidence when injected dispatch ports throw.
  Request cancellation after an effect does not cancel completion/audit persistence.
- src/memory-jobs.ts: reuse the same complete intent-binding rule for enqueue.
- src/memory.ts: bounded copying observer double, explicit configuration/event errors.
- src/adapters/sql-repo.ts: bind draft operation to row operation_id, observation to
  campaign key, and full proposal to stored campaign/operation keys. Accept malformed
  inputs as typed errors even if the input object is null. Update query-port docs.
- src/ports.ts: documentation only; no SQL/feature port signature changes.
- tests/contract/port-suites.ts and memory.test.ts: observer contract suite and exact
  envelope substitutions against memory/capability implementations; stronger job/safety cases.
- tests/adapters/sql-repo.test.ts: durable proposal restart and schema-valid SQL corruption.
- tests/acceptance/recovery.test.ts (new): faults before/during/after claim, inconsistent
  evidence, repository replacement identity, hierarchy duplication/mixing/emptiness,
  lost acknowledgement, cancelled post-effect persistence, finish failure and reconciliation.
- tests/acceptance/observability.test.ts (new): correlation propagation, bounded snapshots
  and telemetry isolation.
- README.md: replace stale stub claims with usage, semantics and composition requirements.
- PROGRESS.md, HANDOFF.md: continuation and review evidence, exclusively in this lane.

## TESTS

- Tests: **written, not run**. Existing assertions retained; no suite deletion,
  weakened assertions, suppressions, coverage exclusions or production exclusions.
- Regression red/green: **not executed** under the binding no-test override. Source
  review found the original paths lacked full envelope checks, immutable claim
  comparison, post-claim freshness checks and relational JSON identity binding.
  The new tests exercise those paths with otherwise-valid inputs and read actual
  provider/outbox/repository state after the operation.
- B1: one CampaignRepoPortSuite defines memory and SQLite-backed repo behavior;
  one CampaignCapabilityPortSuite defines memory and generic capability-adapter
  behavior. Asset/safety/job/audit/observer suites target their doubles; no new
  production adapters for those ports were authored. Auxiliary backend and SQL
  ports have strict test-only in-memory backend/SQLite bindings.
- `git diff --check -- features/campaigns`: passed (exit 0).
- `corepack pnpm --filter @open-marketing/campaigns typecheck`: **passed**, exit 0.
  The one invocation ran `tsc --noEmit && tsc -p tsconfig.tests.json`, checking
  both production source and all package tests. No second invocation was made.
- Not run: package tests/build, om:check, om:gate-tests, install, coverage, lint,
  boundaries or runtime self-validation. Coordinator performs combined verification.

## CONTRACTS and Jini reuse

All existing public service methods, DTOs and port signatures remain unchanged.
index.ts adds only createMemoryCampaignObserver and MemoryCampaignObserver to
satisfy the observer port's missing double. src/ports.ts changes a SQL comment,
removing the obsolete assertion that it requires a temporary Jini shim.

Inspected installed @jini-ai/mcp **0.4.3** declarations for federation and approvals,
including McpSessionPort and transport/approval ports, plus its package exports.
Checked its published npm entry: https://www.npmjs.com/package/%40jini-ai/mcp.
No published campaign-domain implementation was found in that surface. This feature
does not implement MCP transport, OAuth, credential storage or a DB driver, so it
adds no direct Jini dependency and copies/rebuilds none of those mechanisms.
The existing caller-owned CampaignBackendPort is the replacement seam for the
server's published Jini federation adapter. This is a composition requirement,
not a claim that a real federation binding was implemented or tested here.
The npm DB page could not be fetched in this session; @jini-ai/db is not a feature
dependency and is not needed because SQL consumes OM's injected DB query port.

Production safety remains canonical and server-owned. The memory safety double
models fail-closed mode, scope, exact grants and synchronous dispatch barriers;
it does not replace policy or plugin/account/limit evidence.

## MIGRATIONS

No migration authored/changed/applied in this continuation. Retained the committed
additive migrations/0001_campaigns.sql: campaign, campaign_revision and
campaign_launch_proposal. No separate jobs outbox, driver construction, schema
application or live database access occurs in feature factories/imports.

## Architecture Audit

Status: **PASS for source review; mechanical verification deferred**.
Audited all changed src/index files listed above and tests for lane boundaries.
Checked: caller-owned ports; external imports via public contracts only; no
feature internals or policy imports; driver-free SQL; inert factories; injected
clock/IDs; one outbox; exact per-operation authority; final safety barrier;
claim uncertainty never retried; append-only observation/audit evidence;
bounded input/output; portable SQL; correlation/trace/run propagation.

No known boundary violation remains. Mechanical cognitive/nesting/signature/boundary
gates were not run, so this is not an om:check pass claim. Production DB and
federation ownership are fixed by the supplied contract; no ADR ambiguity blocks
this feature. Server-only adaptations are handed to the integrator below.

## Function quality and documentation

| Assessment unit | Disposition | Findings | Local fix attempted / direct test seam |
| --- | --- | --- | --- |
| proposalBinding / proposalSpendBinding / exactMatch | NO_RECORDED_FINDINGS | None remaining | Split envelope/account checks from spend/exposure checks; B1 substituted-envelope tests |
| proposalForRecord / boundRecord / readCampaign | NO_RECORDED_FINDINGS | None remaining | Identity and observation consistency; corrupt SQL and replacement-ID tests |
| readLaunchProposal / persistProposal | NO_RECORDED_FINDINGS | None remaining | Boundary schema, operation and immutable acknowledgement; SQL/proposal fault tests |
| intentIdentity / boundJob / readJob | NO_RECORDED_FINDINGS | None remaining | Scoped immutable outbox validation; job B1 and foreign-scope/claim tests |
| checkCreativeSet | NO_RECORDED_FINDINGS | None remaining | Shared bounded batch decision; creative drift before/during claim |
| pausedCreationReady | NO_RECORDED_FINDINGS | None remaining | Matching creation completion; partial/unrelated-op recovery tests |
| checkIntent / intentForRecord / checkCreationForIntent | NO_RECORDED_FINDINGS | None remaining | Pure binding separated from reads; post-claim creative/state drift tests |
| prepareCreation / createAndDispatch / proposeLaunch / queueLaunch / launchReady / existingLaunch / enqueueApproved | NO_RECORDED_FINDINGS | None remaining | Reuse typed boundary rules; existing service acceptance and replacement/acknowledgement tests |
| dispatchOperation / dispatchClaim / currentReceipt | NO_RECORDED_FINDINGS | None remaining | CAS result compared with exact queued payload; concurrent/substituted-claim tests |
| completeDispatch / checkedEffect / reconcileOperation / reconcileEvidence | NO_RECORDED_FINDINGS | None remaining | Claimed-operation error mapping and no retry; throw/cancel/finish-failure recovery tests |
| createSqlCampaignRepo / readRecord / readProposal | NO_RECORDED_FINDINGS | None remaining | Relational key binding and explicit corrupt-data failures; shared real SQLite suite |
| createMemoryCampaignJob / createMemoryCampaignObserver | NO_RECORDED_FINDINGS | None remaining | Shared intent rule and bounded copied events; job/observer B1 and telemetry tests |

Critical/High findings remaining from source review: zero. Mechanical checks and
coverage metrics unavailable under the owner's override; no numeric quality or
coverage claim is made. All decision branches remain directly injectable/assertable
without combinatorial fixtures. Test-only functions use Vitest/array callback ABIs;
owned APIs continue to take at most two object parameters.

Zero-findings skepticism pass: rechecked mismatched scopes/IDs, incomplete and
duplicate hierarchies, envelope fields outside the arguments hash, state/creative
changes during claim, thrown acknowledgements, cancellation after effect and
completion storage failure. Variable-name review found no remaining inverted or
misleading computed-value names. One review correction is recorded in PROGRESS.md:
do not impose the memory/SQL campaign ID algorithm on replacement repositories.

Documentation classification: new validation/workflow helpers and observer factory
**documented**; SQL/read/README/port descriptions **stale-doc-updated**; tiny private
selectors and standard test boilerplate intentionally receive only short purpose
comments or inherit their parent description. Complexity is bounded DTO traversal
and constant port calls; SQL is at most three indexed calls per repository method.
No new per-item external calls, retries, hidden clocks or runtime registries.

## RISKS and NEEDS

- Runtime/acceptance/SQL portability/mechanical gate results remain unverified
  until the Coordinator runs combined checks. Self-validation status: **PARTIAL**,
  not run because the owner explicitly prohibited runtime/tests/builds. Attempts: 0;
  no diagnosis loop, large artifacts or offload files. Critical/negative paths are
  represented by written tests, not executed evidence.
- NEEDS: apps/server composition must adapt current safety/account authority,
  asset revisions and the one jobs outbox to the owned ports. enqueue must commit
  immutable domain intent and job atomically. A saved harmless draft may precede
  a failed enqueue. Never reclaim dispatching after lease expiry.
- NEEDS: server federation/plugin binding must implement CampaignBackendPort using
  published Jini APIs; enforce the forwarded timeout, operation idempotency,
  account/workspace binding and permit/current-authority check at actual egress.
  Campaigns forwards these requirements; it constructs no live transport.
- NEEDS: provider plugins must supply complete hierarchy and operation-correlated
  read evidence. Completeness is part of the backend contract; generic DTOs cannot
  independently infer provider-specific entity topology or money semantics.
- NEEDS: server/studio/om CLI jobs must close the public user flow and exact-card UI.
  No out-of-lane edits were made to provide those bindings.
- No new package dependency, shared DTO, root manifest or lockfile change is needed.

## HANDOFF / pre-completion

All exported factories/service methods have implementations; none returns a typed
not_implemented stub. Existing feature work was continued rather than replaced.
Only features/campaigns files were written; simultaneous changes in other lanes
were observed and left alone. No commit/push/live spend/vendor effect/live migration.
Requirements reread, test integrity checked, source architecture audited, source
and tests typechecked, and scoped diff whitespace checked. Runtime and mechanical
verification are explicitly still open.
Next owner: Coordinator for combined test/build/om:check and code inspection;
server/provider/UI integrators for the bindings listed in NEEDS.
