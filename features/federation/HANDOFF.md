# Programmer(Direct): federation j10 continuation

Federation now has server gateway logic and published Jini HTTP/stdio transports: reviewed
reads run directly, other external tool effects display an exact card and require current
authority. For example, server composition can call `host.invoke({ context, call })` to fetch
campaign performance; the reviewed call's operation/digest/trace IDs reach the remote tool.
Production wiring, durable authority/storage and combined verification remain deferred.

## Inputs and scope

- Required Programmer persona loaded before work; resumed `59db645..3e2648f` rather than restarting.
- Authoritative existing feature contract, development/JOBS.md j10, unchanged COMMON.md,
  target architecture §§4.6/5/6/10 and owner overrides of 2026-10-02/2026-10-12.
- No separate spec certification/outline/progress artifacts beyond the feature ledger supplied.
  Named ADR index and project_memory.md paths absent. Dispatch authorizes implementation.
- No callable graph tools; direct source reads used as the required unavailable-tool fallback.
- Only `features/federation/**` edited; unrelated parallel work preserved. No commit/push/install.

## CHANGED FILES

| File | Delivered behavior |
| --- | --- |
| index.ts | Published Jini transport factories/types; observer double/types |
| src/adapters/jini-transport.ts (new) | Inert HTTP/stdio adapters, per-call Jini sessions, deadline, final fence, cancellation/disposal and stalled-open cap |
| src/adapters/wire.ts (new) | Immutable OM metadata, exact argument check, correlated bounded initialize/result parsing before Jini normalization |
| src/adapters/remote-result.ts (new) | Bounded provider-to-OM result projection, no raw MCP metadata |
| src/adapters/sdk-transport.ts (removed) | Published Jini clients replace the temporary SDK shim |
| src/service.ts | Guard malformed invocation; scope/identity-bound reload; final concurrent reload capacity recheck; avoid passing dependencies/config into lookup |
| src/admission.ts | Extract unchanged identity comparison from catalog workflow to keep cognitive complexity bounded |
| src/validation.ts | Preserve failed/unknown results when no successful schema payload exists; scope comparison independent of JSON key order |
| src/memory.ts | Observer double; order-independent approval scope check; updated transport docs |
| tests/contract/port-suites.ts | Shared observer suite and revoked transport fence case |
| tests/contract/memory.test.ts | Run observer suite against the double (written only) |
| tests/contract/jini.test.ts (new) | SAME transport suite against scripted and real Jini HTTP/stdio |
| tests/contract/sdk.test.ts (removed) | Adapter suite moved to its actual published implementation |
| tests/admission.test.ts | SAME admission suite also targets Jini scripted protocol doubles |
| tests/fixtures/local-transports.ts | Real loopback/child fixtures use published Jini clients |
| tests/fixtures/jini-transports.ts (new) | Reuse published ScriptedMcpHttpExchange/ScriptedMcpStdioChannel |
| tests/fixtures/latch.ts (new) | Explicit race synchronization, no sleeps/polling |
| tests/host.test.ts (new) | Missing gates, all non-read exact cards, unknown/failed status, mutation/drift/revocation/audit/schema edges |
| tests/jini-transport.test.ts (new) | Metadata isolation, final broker race, late-channel disposal, stalled-open cap, ID/flag/SSE validation, timeout uncertainty |
| tests/validation.test.ts (new) | Canonical JSON, accessors/cycles/prototypes/size/depth/node caps and complete approval binding |
| README.md | Server usage, production integration obligations, bounds and deferrals |
| progress-ledger.md | Continuation state and design/test seams |

The committed admission/confirmation/gateway/registry core was retained, with targeted fixes.
No preserved approved algorithms were discarded.

## TESTS

Owner override prohibits running suites, builds, lint/om:check or installs. All new/shared tests
are **written, not run**. Runtime/self-validation and coverage were not run for that reason.
No certified tests were deleted/weakened; the SDK suite was replaced with the same shared
suite against the implementation now exported. Red/green is **not demonstrated** under this
override. The uncertainty regression would exercise the original missing-structured-output
branch; assertions require unknown status, one outbound call, and no replay.

Single allowed command: `corepack pnpm --filter @open-marketing/federation typecheck`.
Result: **PASS (exit 0)** on 2026-10-12 local date. The package script ran
`tsc --noEmit && tsc -p tsconfig.tests.json`, checking production source and TypeScript test
files. This was the only typecheck invocation. No runtime test/lint/build was run.

`git diff --check -- features/federation`: PASS (exit 0); whitespace-only review evidence.

Coordinator verification after parallel lanes settle:

1. `corepack pnpm --filter @open-marketing/federation test`
2. `corepack pnpm --filter @open-marketing/federation typecheck`
3. `corepack pnpm --filter @open-marketing/federation build`
4. `corepack pnpm om:check`

No pass counts, coverage percentage or red/green claims can be made before that verification.

## CONTRACTS and published reuse

- `src/ports.ts` and `src/types.ts` remain unchanged from the committed continuation contract.
  All host/owned port methods have implementations and every owned port has a memory double
  plus one shared contract suite; real adapters written here implement the transport port.
- `index.ts`: replace `createSdkMcpTransport`/`FederationSdkClient`/
  `FederationSdkSessionOpener` (temporary continuation exports) with
  `createJiniHttpMcpTransport`/`createJiniStdioMcpTransport` and their dependency types.
  This follows the binding owner requirement to build on the now-published seam. No remaining
  consumers of the retired names were found in apps/features/packages/content/development.
  Any external composition using them must migrate to the Jini factories.
- Add `createMemoryFederationObserver`/`MemoryFederationObserver` to complete B1 for the
  already-exported observer port. No shared DTO or another feature contract changed.
- Reused installed **@jini-ai/mcp 0.4.3** through public `./federation`, `./federation/stdio`
  and `./federation/testing` exports: HTTP/stdio protocol, handshake, credential supplier,
  session cleanup, protocol test doubles. The existing installed dependency is sufficient.
- Jini call declarations drop `_meta`; OM guards its injected exchange/channel to attach
  operation/digest/trace IDs without changing arguments. Fresh per-call sessions avoid
  cross-call mutable metadata. This is an OM adaptation, not a fork of Jini protocol code.
- Jini admission/remembered approvals do not fit OM's exact-operation money/destructive
  contract. OM's existing catalog/effects/approval/dispatch ports remain authoritative.
  Jini exposes lower-level I/O ports; production composition injects guarded bounded ones.
- Retained existing AJV/Zod and canonical JSON/digest implementation. No OAuth/secret/DB
  library overlap is implemented here; those effects stay behind server-owned ports.
- npm page/registry web checks failed with cache miss/inaccessible URL. Installed manifest,
  public declarations/implementation and the owner's publication statement are the evidence.
  No install, npm execution, live provider or sibling-source import was attempted.

## MIGRATIONS

None authored or applied. Durable connection/admission persistence is deferred to the
composition/feature integration owner through the existing connection port.

## Architecture audit and pre-completion

Static audit: PASS for lane ownership, public package imports, core/adapter direction,
inert construction, injected fetch/process/broker, immutable card/call, explicit typed
failures, current gate probing, zero retry and redacted audit/observer/agent DTOs. Mechanical
lint/boundary/complexity verification is NOT RUN. This is not a production readiness claim.
TypeScript source/test compile verification is PASS; behavioral assessment remains inconclusive.

Architecture checklist covered every changed production file: core imports no adapter,
other feature internals, applications or sibling sources; installed Jini imports use public
exports only. Registry remains instance-local with unregister/reset/dispose. No policy import,
hidden clock read, schema default/coercion, unconditional approval or vendor-specific code.
Designated confirmation/spend/halt/credential/plugin constraints remain binding, with no
deviation: current production authority and durable single-use/outbox fencing are required
from the dispatch/broker ports, not supplied by memory doubles.

Requirements re-read; test assertions retain exact outbound identity and no-egress denials.
Scope verified by feature diff/status. Runtime self-validation: not run (explicit owner ban),
zero attempts, no diagnosis loop. No test pass, lint pass or production readiness inferred.
Only Markdown documentation was updated after the permitted typecheck; no source changed.

## Style/function-quality notes

| Assessment units | Disposition | Findings / local action | Direct evidence seam |
| --- | --- | --- | --- |
| createJiniHttpMcpTransport / createJiniStdioMcpTransport / createTransport / checkBinding | INCONCLUSIVE | Mechanical/runtime evidence deferred; injected I/O and bounded per-call state reviewed | SAME transport/admission suites; binding/cap tests |
| waitForSession / waitWithinCall / invokeActive / closeActive | INCONCLUSIVE | Local cleanup: retain stalled opens, close late channels, detach abort listeners; execution evidence deferred | Explicit latch disposal/cap races; controlled timeout test |
| executeCall / failedExecution / observe | INCONCLUSIVE | Split error mapping to keep workflow simple; post-handoff cancel stays unknown | Timeout/unknown cases; observer assertion |
| prepareWireMessage / prepareGuardedMessage / assertCurrent | INCONCLUSIVE | Fence after async bearer lookup, exact canonical payload check; execution evidence deferred | Revocation race; remote metadata/argument captures |
| checkWireReply / checkRpcResult / responseMessage / guardHttpExchange | INCONCLUSIVE | Correlate raw reply before normalization; full-byte cap before SSE extraction | Wrong ID, tainted flag, SSE, invalid/oversized shared cases |
| guardStdioChannel / guardStdioReply / readMethod | INCONCLUSIVE | Never throw invalid replies from stream listener; preserve Jini refusal path | Shared stdio suite; disposal race |
| parseRemoteResult / mapRemoteResult / validateResult | INCONCLUSIVE | Omit Jini's undefined optional fields; retain unknown/failed statuses | Shared result cases; host unknown/failed/output-schema tests |
| parseInvocation / reloadConnection / sameScope / approval repo get | INCONCLUSIVE | Explicit DTO lookup, identity + scope check, post-await reload capacity check | Malformed invocation/scoped reload/order tests |
| checkCatalogBinding / catalogIdentityMatches | INCONCLUSIVE | Local extraction retains all implementation/schema/tool binding predicates | Shared admission drift/unknown and plugin drift cases |
| createMemoryFederationObserver | INCONCLUSIVE | Bounded redacted immutable event snapshots; overflow drops diagnostic events | Shared observer suite; host diagnostic failure case |

No known unresolved Critical/High semantic finding is recorded after source review. This does
not replace missing mechanical/runtime evidence. All owned changed signatures use at most
two objects; Promise/EventEmitter/Array/test callbacks retain documented foreign ABIs.
Time/space and bounds are documented at the adapter workflows and JSON/result boundaries.
No scale/I/O query loops are added beyond bounded active-call cleanup; zero tool retries.

Adversarial evidence written: concurrent operation replay and metadata isolation, mutable
caller during confirmation, revocation after credential lookup, pending-open disposal,
100 stalled opens + overflow, audit partial failure, aggregate JSON bounds and schema drift.
Coverage metrics unavailable under the no-runs override; every assessed unit has direct tests
or shared observable seams above. No suppression, exclusion or narrowed test scope added.

Documentation: new public factories/types and observer are documented; changed result,
reload and scope behavior documentation updated. Small obvious inherited getters stay under
their parent factory docs. Source-variable audit checked handedOff (actual lower I/O handoff),
openingSettled (connection promise resolution), revision (instance disposal epoch) and rejection
(explicit validation/authority failure); none are used as a success surrogate.

## RISKS / NEEDS / HANDOFF

- NEEDS `apps/server` composition: map current public credentials/safety/jobs/plugins/audit
  services to the feature's caller-owned ports. Durable dispatch must fence all relevant
  authority epochs and ONE jobs outbox, consume each exact operation once across restarts,
  and reconcile unknown outcomes. Memory grants/approvals/audit are test doubles.
- NEEDS production HTTP exchange: guarded endpoint/DNS/redirect policy and a streaming cap
  before response text allocation. Jini's plain fetch exchange uses unbounded response.text();
  controlled fixture use does not establish production HTTP safety. Use the server's installed
  platform guarded API; this feature does not need another package if composition injects it.
- NEEDS stdio composition: bounded process/channel factory, neutral/sandboxed environment,
  launch allowlist, timeout-aware creation and process reaping. No vendor config in agent.
- NEEDS plugin catalog/readmission and connection storage; gateway deliberately accepts
  server-trusted descriptors and never trusts remote hints or creates vendor integrations.
- Deferred HTTP/OM MCP endpoint, CLI and studio surfaces are outside this lane; composition
  must expose OM schemas/results only. No live vendor effect, spend or migration performed.
- Fresh sessions cost handshake/process overhead. Pooling is deferred pending a published
  metadata-aware per-call Jini seam; this avoids speculative shared-state machinery.
- Binary/resource results are explicitly rejected; a future typed media importer is required
  for them. Provider text remains untrusted. Local JSON schema dialect is draft-7.
- Combined Coordinator verification required before accepting/committing this lane. No
  commit or push performed. Suggested next assignee: Coordinator + server integrator, then
  combined verification and independent Code Inspection/security review.
