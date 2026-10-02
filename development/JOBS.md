# Feature ownership for twelve concurrent jobs

Coordinator addendum supersedes the historical v2 five-job scheduling limit. Start all twelve only after j00 contracts are reviewed. Each job owns ONLY its complete features/<name>/ directory, including index.ts, src/ports.ts, src/types.ts, implementation, adapters, migrations and tests. No shared-root/contracts/lockfile/application edits. Cross-cutting changes are NEEDS for the integrator.

## j02 — workspaces

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/workspaces/**` only. Public contract: `features/workspaces/index.ts`, `createWorkspaceService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Workspace authentication and account scope

**Dependencies:** j00.

**Scope map:** `features/workspaces`; its memory/SQL adapters/tests; scoped identity compatibility adapter assigned by integrator.

**Contract:** `WorkspaceService` and `IdentityPort` from §4.1; owner/workspace/account resolution independent of browser or agent claims.

**Acceptance tests:**

- Valid owner resolves context and binds owned account.
- Forged owner/workspace, other-owner connection, and conflicting account binding fail.
- Reused vendor account IDs remain scoped.
- Memory and SQL share one suite.
- Identity failures return typed values and preserve trace context.

**Gates:** G; no agent-supplied principal becomes authority; no redundant account approval flow.


Proof commands: `corepack pnpm --filter @open-marketing/workspaces test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j03 — audit

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/audit/**` only. Public contract: `features/audit/index.ts`, `createAuditService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Append-only audit

**Dependencies:** j00.

**Scope map:** `features/audit` only.

**Contract:** §4.3 audit append/list/export, durable intent receipts, redaction, correction lineage.

**Acceptance tests:**

- Memory/SQL shared suite verifies append-only behavior and scope isolation.
- Intent receipt survives restart.
- Required audit failure prevents a new effect.
- Secrets/PII are redacted from operational output.
- Exact-review evidence is secured and linked to operation/result.
- Exports are bounded; corrections do not replace entries.

**Gates:** G; retention policy remains explicit, not invented.


Proof commands: `corepack pnpm --filter @open-marketing/audit test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j04 — policy

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/policy/**` only. Public contract: `features/policy/index.ts`, `createPolicyService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: Moved packages/spine gates, evidence and tests.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Policy and preserved spine

**Dependencies:** j00.

**Scope map:** `features/policy`; preserved gate/evidence tests; `om-clock` changes only through integrator.

**Contract:** §4.2 canonical gates and consent/identity evidence, object signatures, injected time.

**Acceptance tests:**

- Characterize preserved approved behavior before substantive changes.
- Withdrawal precedence, suppression distinction, exact purpose/destination.
- Half-open intervals and currency/overflow adversarial cases.
- Identity merges cannot cross workspace.
- Halted/revoked/expired exact authority fails spendability.
- Memory/SQL evidence repository passes one suite.
- No duplicate gate implementation elsewhere.

**Gates:** G; sendability remains available as a tested contract but creates no MVP messaging surface.


Proof commands: `corepack pnpm --filter @open-marketing/policy test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j05 — media-library

Current contract (j00-finish / owner decision): build on @jini-ai/cms/media (published 0.3.11). Jini owns MediaRecord, AssetBlobRecord, AssetRenditionRecord, blob storage, named transforms and renditions. OM owns prompt/model/seed/cost/vendor-terms/rights evidence, append-only provenance/cost records, and versioned ad-placement presets. MediaRepoPort stores only OM metadata; JiniMediaPort supplies scoped Outcome adapters over canonical Jini assets. Factory adds required media: JiniMediaPort and optional placementPresets; index.ts is the final contract.

NEEDS: @jini-ai/cms@0.3.11 does not export ./media/import (registry and installed package both checked). Keep GuardedAssetImportPort typed and unimplemented; bind the public Jini importer when published, do not deep-import or rebuild it. Reuse uploadMedia/getMediaById/listMedia, registerTransform/resolveMediaRendition, and the public Jini storage/transform ports and test doubles. Read the actual release limitations: safe ingress, bounded listing, persistence and host scope validation still need acceptance evidence.

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/media-library/**` only. Public contract: `features/media-library/index.ts`, `createMediaLibrary`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No source copy; parked render/segments are not media implementations.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Media library and crops

**Dependencies:** j00.

**Scope map:** `features/media-library`; owned blob/import/transform adapters and tests.

**Contract:** §4.9 canonical assets, rights/provenance/cost links, guarded import, non-destructive crops.

**Acceptance tests:**

- Memory/SQL metadata and memory/real temporary blob adapters pass shared suites.
- Dedupe and repeated import preserve provenance.
- SSRF/redirect/type/size rejection.
- Partial blob failure cleans up safely.
- Crop preserves original and validates placement dimensions.
- Cost/provenance links support failed or delayed generation outcomes.
- Cross-workspace access denied.

**Gates:** G; no vendor-specific assumptions in core.


Proof commands: `corepack pnpm --filter @open-marketing/media-library test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j06 — jobs

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/jobs/**` only. Public contract: `features/jobs/index.ts`, `createJobService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: Moved packages/om-outbox implementation in src/outbox.ts and characterization tests.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Single durable outbox

**Dependencies:** j00.

**Scope map:** `features/jobs`; preserved outbox characterization and adapter tests.

**Contract:** §4.8 job state machine, stable operation key/digest, transactional enqueue, leases/fences, bounded retry/reconciliation.

**Acceptance tests:**

- Memory/SQL run one suite.
- Duplicate key/same digest deduplicates; different digest conflicts.
- Stale lease cannot complete or dispatch anew.
- Crash before/after dispatch remains recoverable.
- Unknown non-idempotent effect is not blindly retried.
- Cancellation and restart preserve honest state.
- Domain intent and enqueue commit/rollback together.
- Handler registry disposes; no second feature-specific outbox exists.

**Gates:** G; fault-injection and lease-ordering tests required.


Proof commands: `corepack pnpm --filter @open-marketing/jobs test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j07 — credentials

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/credentials/**` only. Public contract: `features/credentials/index.ts`, `createCredentialService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Server-only credentials and OAuth

**Dependencies:** j01, j02, j03.

**Scope map:** `features/credentials`, owned adapters/tests; assigned OAuth/sealer seam changes.

**Contract:** §4.4 connection lifecycle, encrypted records, host-only credential broker, serialized refresh/revocation.

**Acceptance tests:**

- One shared repository/broker suite for doubles and real adapters.
- PKCE/state/redirect validation.
- Wrong scope/key/version fails AAD checks.
- Refresh races perform one refresh.
- Revocation between confirmation and dispatch denies.
- No token in UI DTO, transcript, log, agent config/environment, or tool result.
- Reconnect produces a useful typed status.

**Gates:** G; cryptographic-format and credential-boundary security review before production use.


Proof commands: `corepack pnpm --filter @open-marketing/credentials test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j08 — safety

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/safety/**` only. Public contract: `features/safety/index.ts`, `createSafetyService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Status: implemented overnight by j08; source is unchanged by j00-finish. Read features/safety/HANDOFF.md and README.md before integration. Its 123 tests pass in the final workspace run.

Final contract: createSafetyService injects repo, policy, confirmations, effects, platformLimits, accountLocks, clock, ids and audit. withDispatch holds the account barrier through transport; authorizeDispatch alone is not authority to bypass that barrier. Reserve/settle generation through the exported authorization/reservation/settlement types. Allowance resets at owner-local midnight, with timezone edits deferred until rollover. createSqlSafetyRepo consumes SafetySqlDatabase/SafetySqlSession; j01 must adapt the server-owned SQLite shim with serialized transactions. No direct native driver is added to safety.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Exact approvals, halt, limits, generation allowance

**Dependencies:** j02, j03, j04.

**Scope map:** `features/safety`; approval, money, halt, allowance fixtures/tests.

**Contract:** §4.7 and §6. No envelope API/table/grant; exact ad-spend approval; narrowly typed backend stop exception; atomic generation allowance.

**Acceptance tests:**

- Every distinct ad-spend call requires its exact card.
- Reallocation and broad chat/persistent ad-spend grants fail.
- Reviewed arguments equal dispatched digest/value.
- Missing/stale/forged effect or cap evidence fails closed.
- Concurrent reservations cannot oversubscribe authority/allowance.
- Normal mutation loses race to completed halt.
- Halt-stop permits allow pause/stop only; payload inflation or activation fails.
- Default generation allowance is USD $10/day; setting edits are versioned/audited.
- Under-allowance card offers Always allow; above/unknown does not.
- Midnight, settings changes, quote drift, timeout, and late cost settlement preserve accounting.
- Memory and SQL use one suite.

**Gates:** G; irreversible/security ordering tests and property tests. Owner decisions are implemented without reopening them.


Proof commands: `corepack pnpm --filter @open-marketing/safety test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j09 — plugins

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/plugins/**` only. Public contract: `features/plugins/index.ts`, `createPluginService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Plugin lifecycle and capability admission

**Dependencies:** j01, j02, j03.

**Scope map:** `features/plugins`; assigned plugin-validation/lifecycle seams; plugin fixture harness.

**Contract:** §4.5 lifecycle, portable-format validation, namespace extension validation, trust/digest admission, sanitized agent instruction export.

**Acceptance tests:**

- Valid/invalid v1.1 fixtures.
- Unknown/invalid extension and server entry handling is explicit.
- Archive/path/symlink escape rejected.
- Enable/disable/update/uninstall unregisters and disposes correctly.
- Running jobs are handled explicitly during update/removal.
- Digest/schema update invalidates prior authority.
- Installation cannot grant writes/spend.
- Agent instruction view contains no MCP configuration or credentials.
- Memory/real filesystem/repository adapters share their suites.

**Gates:** G; extension namespace must be `io.github.ainsep.openmarketing`.


Proof commands: `corepack pnpm --filter @open-marketing/plugins test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j10 — federation

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/federation/**` only. Public contract: `features/federation/index.ts`, `createFederationHost`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Server federation gateway

**Dependencies:** j07, j08, j09.

**Scope map:** `features/federation`; owned HTTP/stdio adapters and tests. No agent vendor integration.

**Contract:** §4.6 only external MCP invocation path; trusted catalog/effects, immutable confirmations, credential broker, dispatch gates, bounded validated results.

**Acceptance tests:**

- Shared transport/admission suites for test transport and real local HTTP/stdio fixture servers.
- Read-only admission and unknown-tool policy.
- Displayed arguments equal outbound arguments.
- Revocation/schema drift after confirmation denies.
- Missing gate fails closed.
- Namespace collisions, reconnect, reset/dispose.
- Tainted/oversized/invalid MCP result rejected or mapped explicitly.
- Agent receives only OM schemas/results; no vendor secret/config.
- Operation IDs and traces reach outbound calls/audit.

**Gates:** G; no optional money or halt gate.


Proof commands: `corepack pnpm --filter @open-marketing/federation test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j14 — creative

Current contract (j00-finish / owner decision): build on @jini-ai/integrations/media-providers (published 0.3.6). Reuse AsyncOperationStore/AsyncOperationRecord and startOperation/pollDueOperations/recoverAfterRestart through caller-owned ports. GenerationRequest includes surface/model/seed, maxAttempts and deadlineAt; receipt records asyncOperationId and handles inline success as well as pending. Service/capability expose bounded pollDue, recover and local cancellation. CreativeRepoPort appends cost observations; CreativeAssetPort accepts byte or URL output and records provenance/cost even without an asset. Safety remains the authority. Vendor dispatch/signers/credentials stay in content/agent-plugins; core imports public types only.

Reuse the durable async operation path, not MediaTaskStore's interrupted-on-boot tracker. Do not add a second outbox or assume a timeout/cancellation means no charge/refund. A server/job worker drives recovery and polling independently of the agent.

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/creative/**` only. Public contract: `features/creative/index.ts`, `createCreativeService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Creative lifecycle and cost provenance

**Dependencies:** j05, j06, j08; provider integration after j11.

**Scope map:** `features/creative` only.

**Contract:** §4.10 quote → safety assessment → outbox generation lifecycle → observed cost → asset provenance, through generic ports.

**Acceptance tests:**

- Shared memory/SQL and capability-adapter suites.
- Async generation persists without an agent session.
- Original quote/arguments bind approval and dispatch.
- Under/over/unknown allowance cases route through correct card policy.
- Status recovery after server restart.
- Possible charge on timeout remains reserved/unknown.
- Duplicate asset import does not duplicate cost.
- Failed generation still records cost.
- Cancellation does not claim refund.
- Missing capability yields connect/install action.

**Gates:** G; no provider branches or allowance authority in creative core.


Proof commands: `corepack pnpm --filter @open-marketing/creative test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j15 — campaigns

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/campaigns/**` only. Public contract: `features/campaigns/index.ts`, `createCampaignService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: No preexisting implementation; complete the typed stubs.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Campaign drafts and exact launch

**Dependencies:** j05, j06, j08; provider integration after j12/j13.

**Scope map:** `features/campaigns` only.

**Contract:** §4.11 paused plan, creative-set digest, exact launch/budget operations, desired/observed state, recoverable partial creation.

**Acceptance tests:**

- Shared memory/SQL/capability suite.
- Create cannot activate.
- Campaign hierarchy is read back PAUSED.
- Changed creative/arguments invalidates approval.
- Every later spend mutation receives a new exact card.
- Partial creation and unknown activation reconcile.
- Halt blocks normal operations.
- Production account mutations denied in local/read-only mode.
- Account/workspace mismatch denied.

**Gates:** G; no budget-envelope or automatic reallocation API.


Proof commands: `corepack pnpm --filter @open-marketing/campaigns test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

## j16/j17 — measure

Before writing code, check published @jini-ai/* for an existing implementation and report what you reuse.

Exact write scope: `features/measure/**` only. Public contract: `features/measure/index.ts`, `createMeasureService`, all service methods/types and caller-owned ports in src/types.ts and src/ports.ts. Implement the final index.ts/src contract (accepted §4 plus documented owner decisions); propose further shared changes as NEEDS.

Preserved source: Policy is consumed only via public pure gates; no messaging/segmentation promotion.

Architecture job acceptance follows, with the owner-approved contract updates noted below:

Tracked links and verified conversion ingestion

**Dependencies:** j04, j06.

**Scope map:** Measure `src/ingestion`, `src/links`, corresponding adapters/tests. Shared `measure/index.ts`, types, and migrations remain integrator-owned.

**Contract:** §4.12 tracked-link and conversion-inbox contracts; authenticated/deduplicated signup/trial intent and transactional job creation.

**Acceptance tests:**

- Destination/redirect validation.
- UTM/click-ID preservation without unauthorized identifier collection.
- Source authentication and schema validation.
- Same event deduplicates; conflicting duplicate is explicit.
- Consent evidence is purpose/destination-bound.
- Atomic conversion/outbox commit.
- Memory/SQL use one suite.

**Gates:** G; no edits to j17-owned paths and no vendor normalization in core.


Conversion delivery, reports, attribution, CAC

**Dependencies:** j00 contracts; j03, j04, j06, j07; integration after j16 and applicable j12/j13 capabilities.

**Scope map:** Measure `src/delivery`, `src/reporting`, corresponding adapters/tests. No j16 files.

**Contract:** Typed production server conversion workflow with narrow measurement grant; immutable snapshots, declared attribution, source-labelled CAC.

**Acceptance tests:**

- Delivery works with no agent or studio session.
- Dispatch-time withdrawal prevents egress.
- Grant cannot invoke campaign mutation, arbitrary export, or MCP.
- Local-mode production conversion delivery denied.
- Stable delivery identity across retry; unknown outcomes reconcile.
- Egress audit and trace evidence.
- Restated/late snapshots append lineage.
- Currency/timezone/attribution-window boundaries.
- Zero denominator returns undefined CAC.
- Mixed currencies and summed platform attributed totals are rejected.
- Memory/SQL/real local capability adapters use shared suites.

**Gates:** G; conversion service path is not exposed as an arbitrary agent tool.


Proof commands: `corepack pnpm --filter @open-marketing/measure test`, `typecheck`, `build`; then `corepack pnpm om:check`. Extend tests/contract/port-suites.ts for both memory and real adapters. Add real feature acceptance listed above; stub absence tests alone are not acceptance.

