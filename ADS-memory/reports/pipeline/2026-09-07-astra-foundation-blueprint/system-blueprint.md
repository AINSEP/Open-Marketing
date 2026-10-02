# System Blueprint: Open Marketing preliminary foundation

- Status: DRAFT
- Date: 2026-09-07
- Author: System Design Agent (delegated Phase-0 planning)
- Scope: Existing codebase extension candidate; target repository unresolved
- Functional model status: BLOCKED
- NFR model status: BLOCKED
- Next action: Coordinator resolves target and structural decisions, consumes concurrent analyzer evidence, then requests blueprint review. This is planning, not a feature spec or binding ADR.

## 1) System goal

Build the loop `ad → acquisition → identified subject → lifecycle journey → purchase → consented conversion export → improved acquisition`. Operators and agents share one product, canonical identity, consent and factual ledgers. Journey execution, spend pacing and generation remain separate engines because their retry and failure semantics differ.

Inputs used: root AGENTS.md supplied in task; AI-Dev-Shop/AGENTS.md and System Design persona plus activated skills; docs/repo-map.md; MARKETING-RESEARCH.md; `/Users/la/Programming/OSS-Marketing-Repos/docs/open-marketing-build-plan.md`; Coordinator's task context. Plan statements marked source-verified by its authors remain inherited evidence, not a fresh verification of Jini here.

## 2) Scope and MVP boundary

Preserve the plan's Meta-only, image-only, ledger-only v1. Commerce and full experimentation defer, while the early spine must reserve conversion value/currency/order identifier semantics and global holdout assignment. Desktop comes last. No new chat-first implementation, workflow VM, four-platform adapter program or new analytical database is implied.

Framework P0 means the thin shared bootstrap. The plan's “Phase 0” includes business-owned spine and holdout data; call that early product wave P1 so it does not contaminate P0. Both precede the first real contact or send. This naming reconciliation changes no product ordering.

## 3) Functional discovery model

| Category | Status | Summary / unknown | Class |
|---|---|---|---|
| Actors/user types | Applicable | Operator, approver, agent, anonymous visitor, subject, deployment operator; membership/tenant model unspecified | BLOCKING |
| Goals/capabilities | Applicable | Acquire, identify, message, measure, control spending and erase data | — |
| Workflows | Applicable | Flows below are proposed from the plan; require human correction before approval | BLOCKING |
| Resources/operations | Applicable | Subjects identify/merge; consent grant/withdraw; definitions draft/publish; sends enqueue/cancel; budgets approve/halt; assets generate/version | — |
| Permissions/ownership | Unknown | Organization boundary, operator roles, service principals and Jini authority | BLOCKING |
| Lifecycle/state | Applicable | Pin journey version; durable decisions outlive runs; uncertain external submits require reconciliation | BLOCKING: exact transitions |
| Business invariants | Applicable | One implementation per gate; same render path; server-only credentials; stop does not authorize resume | — |
| Exceptions/recovery | Applicable | Crash/retry, uncertain provider result, merge collision, late callback, erasure retry | BLOCKING: durable semantics |
| Communication/collaboration | Applicable | UI/CLI approval and action history; broad team collaboration unspecified | DEFERRED: Spec owner |
| Reporting/analytics | Applicable | Distinct ledger, platform snapshots and attribution; v1 ledger-only | — |
| External integrations | Unknown | Exact Jini pin/consumption, first mail provider, Meta credential contract, creative transport | BLOCKING |
| Admin/support/operations | Applicable | Halt, inspect, resolve unknown execution, erase, credential rotation | BLOCKING: authority |
| Audit/history | Applicable | Principal on mutation; approved envelope and immutable facts | BLOCKING: retention/erasure reconciliation |
| Settings/preferences | Applicable | Purpose/channel preferences, caps, provider configuration | BLOCKING: policy owner |
| Account/data lifecycle | Unknown | Tenant onboarding/deletion, backup restoration and retention scope | BLOCKING |

### Main flows and resources

1. Operator drafts a lifecycle plan; authorized human publishes/approves its envelope; matching subjects enter a pinned journey version; render and send use canonical gates; a delivery ledger captures provider outcome. Withdrawals, complaints and cancellation can prevent a pending send.
2. Visitor follows a tagged link and submits a form; identity identifiers and consent evidence commit atomically; an event may start a journey. Invalid consent, repeated submission and identity conflict must produce deterministic outcomes.
3. Operator connects a sandbox/read-only ad account, inspects mirrored metrics, then separately approves a budget/creative envelope for production. Every write is fenced by halt state and spendability. Expired credentials, outages and platform review do not silently resume spending.
4. Subject requests erasure; authorized intake tracks local deletion plus outbound destinations to completion, including historic transmitted hashes. Whether minimal audit evidence may remain is unresolved policy.
5. Agent proposes creative variants and drafts; generation produces versioned assets with rights/provenance. A generation timeout does not imply another paid submission is safe.

Resources belong to the domains in section 13; no SQL schema is authorized by this report. Immutable facts and deletion obligations require an explicit lifecycle design before durable DDL.

Safe defaults: report statuses are draft; mocks use synthetic subjects and fake providers; empty shells have no production writes; documentation preserves existing runtime contracts. These are planning/testing assumptions, not tenancy or persistence decisions.

### NFR light pass

| Category | Status | Summary / assumption | Class | Owner |
|---|---|---|---|---|
| Scale/capacity | Unknown | Contacts, event volume, simultaneous jobs and peak submissions unknown | BLOCKING before schema sizing | Product + Architect |
| Performance/latency | Unknown | No UI/ingest SLO; define before performance claims | DEFERRED | Spec + QA |
| Availability/uptime | Applicable | Always-on server; pacing every five minutes; outage tolerance unspecified | BLOCKING before live spend | DevOps + Product |
| Reliability/fault tolerance | Applicable | Restart-safe journeys; uncertain paid submission preserved | BLOCKING: recovery policy | Architect |
| Consistency/freshness | Applicable | Consent/halt decisions cannot use arbitrary stale state; metrics may restate | BLOCKING: transaction ownership | Database + Architect |
| Durability/disaster recovery | Unknown | RPO/RTO and restore-vs-erasure semantics unspecified | BLOCKING | Product + DevOps |
| Security | Unknown | Human/agent/MCP authority and deployment trust model | BLOCKING | Security |
| Privacy | Applicable | Identifiers, hashed exports and deletion across destinations | BLOCKING: scope/retention | Product + Security |
| Data integrity | Applicable | Merge, dedupe, ledger uniqueness and atomic acquisition | BLOCKING: schema ownership | Database |
| Compliance/auditability | Unknown | Jurisdiction, evidence retention and operator obligations | BLOCKING | Product + Security |
| Observability | Applicable | Queue age, unknown outcomes, pacing, delivery failures; match-rate alerts ship with feed | — | QA + DevOps |
| Operability/deployability | Applicable | Docker server vs existing local daemon boundary unresolved | BLOCKING | Architect + DevOps |
| Maintainability/evolvability | Applicable | Vertical modules, single shared gates and contracts | — | Architect |
| Cost/resource efficiency | Unknown | Budget currency/limits, generation ceiling and cost tolerances | BLOCKING before paid operations | Product |
| Interoperability | Unknown | Provider versions, credential ownership, adapter vs broker semantics | BLOCKING | Architect |
| Portability/environment | Applicable | Server is custodian; local production account binding prohibited by plan | BLOCKING: target integration | DevOps |
| Usability/accessibility | Applicable | UI and CLI reach every capability; presentation details later | DEFERRED | Spec + QA |
| Testability/verifiability | Applicable | Injected Clock, fake providers, database concurrency and crash tests | — | TDD + QA |

Risk signals: personal identifiers, money, external credentials, asynchronous work, deletion across external systems and durable audit requirements. Targeted deepening is therefore required for security/privacy, durability, consistency and external failure handling; category-deepening reference loaded.

| Deep category | Requirement / target | Assumption | Evidence to collect | Risk | Priority/class | Owner |
|---|---|---|---|---|---|---|
| Security/privacy | No bypass of authority; specify tenant boundaries and erasure obligations | No tenant model assumed | Threat model; roles; deletion inventory | Cross-customer disclosure or unauthorized export | Critical/BLOCKING | Security + Product |
| Durability | Approved work survives run/process death; define RPO/RTO | No numeric target invented | Kill/restart and restore acceptance cases | Lost work or resurrected erased data | High/BLOCKING | DevOps + Database |
| Consistency/integrity | Gates observe authoritative consent/halt and preserve unique outcomes | No distributed transaction assumed | Concurrent withdrawal/send and halt/write scenarios | Unauthorized send/spend or duplicate facts | Critical/BLOCKING | Architect + Database |
| External failures | Represent unknown paid submits and failed outbound deletion | Provider capability unverified | Provider idempotency and callback contracts | Duplicate cost or incomplete erasure | Critical/BLOCKING | Integrations + Security |

Questions are routed to Coordinator rather than independently burdening the user. Ask at most five functional and five NFR blockers in one pass; overflow remains blocked. Immediate functional set: target repository/runtime direction; Jini consumption and upstream approvals ownership; tenancy/principals; canonical spine/budget/holdout ownership; first messaging provider and consent policy. Immediate NFR set: retention/erasure evidence; recovery targets; capacity envelope; acceptable spend overshoot/outage behavior; production hosting/credential-custody model.

## 4) Existing-codebase evidence

No CodeBase Analyzer, MIGRATION or TESTABILITY artifact was available in the pipeline directory when checked; the directory did not yet exist. `no_analysis_reason`: bounded preliminary blueprint prepared alongside Coordinator's analysis stream, based on supplied baseline and inspected repository documents. Approval must consume that analysis; this is not a codebase certification. No graph reindex or broad source scan was performed.

The inspected research pointer explicitly calls this workspace the Open Design rebrand fork and names `/Users/la/Programming/delete-later/Open-Marketing-bare` as the real product repository. Its current checkout, branch and submodule state still require inspection. Repository selection MUST precede product code: it determines package ownership, upstream/submodule boundaries, entrypoints, deployment and where durable migrations belong.

The root contract assigns `/api/*` to apps/daemon, shared DTOs to packages/contracts, CLI to `od`, local lifecycle to tools-dev, and daemon data paths to its canonical data-directory section. The plan assigns production custody to apps/server and calls the CLI `om`, with `/v1/track` also mentioned. Neither silently overrides the other. Do not introduce aliases, a second API authority, or alternative daemon paths as an incidental foundation change.

Preserve all user-owned dirty paths listed in the dispatch. Product-source/config changes are outside this task. No marketing document was written to docs/.

## 5–8) Domains, ownership, integrations and topology

Candidate macro shape: one product deployable with strongly owned modules, a web console and CLI speaking the same HTTP application boundary, and three independently scheduled loops. Relational product state follows the plan's Postgres direction; Jini SQLite is run-event storage only. Whether any existing SQLite data migrates is unresolved.

Use ports for meaningful I/O: inbound application commands/queries for HTTP, worker ticks and agent tools; outbound persistence, Clock, send provider, ad platform, secret signing and blob storage. UI/CLI must not bypass HTTP to private app code. The server composition root wires adapters; its actual app path remains unresolved. Pure gate/render tests can use fake inputs/Clock/providers; real transaction and lease tests need Postgres.

| From | To | Boundary | Critical rule |
|---|---|---|---|
| Web/CLI/agent | Application HTTP/tool boundary | API | Same contracts and authorization; no bypass route |
| Acquisition | Identity + consent | Application transaction | One committed identity/consent result; owner approves transaction contract |
| Segments + dispatcher | Canonical gates | Domain API | No gate reimplementation |
| Journeys | Dispatcher | Durable command | Version-pinned run and idempotent delivery identity |
| Paid writes | Outbox + gates + secrets | Application/provider adapter | Halt and envelope checks; credentials stay server-side |
| Conversion feed | Erasure/transmission inventory | Durable facts/API | Retain exact transmitted value for removal obligations |
| Generation | Jini media dispatch + assets | Adapter | Preserve uncertain submit and lease semantics |
| MCP broker | External MCP server | Untrusted external data | Bounded outputs, digest/allowlist/taint; no spend or identifier-export bypass |

[OWNERSHIP UNCLEAR] Budget authorization is assigned to budget-ledger yet demanded in `0001_spine.sql`; canonical spendability lives in consent/gates while money policy belongs to budget. Decide whether spine owns authorization primitives or coordinates a budget-owned contract. Do not let two teams create the same table.

[OWNERSHIP UNCLEAR] Holdout owner and merge stability; `conversion` versus `conversion_event` versus generic events; `touch` between links/attribution; `creative_job` versus `generation_job`; template publication ownership; audit/erasure retention; durable approvals upstream Jini versus OM adapter. Each affects durable contracts and blocks its owner slice.

## 9) Technology directions for human review

| Direction | Benefit | Cost / unresolved constraint |
|---|---|---|
| Product shell in real OM repository, consume pinned Jini packages | Closest to build plan; clean product ownership | Confirm checkout, Jini availability and submodule contracts; migrate/reuse existing UX deliberately |
| Evolve this fork with separately owned server/domain packages | Existing shell and tooling can help delivery | Explicit daemon/server, od/om, routing and data ownership decisions; retain legacy behavior during transition |
| OM server beside existing console using an explicit remote API adapter | Incremental console reuse while server owns product state | Two lifecycles and compatibility boundary; must not create two product authorities |

These are non-binding alternatives. Ask the user to choose direction or constraints after analyzer evidence; do not treat the existing chat pane as architecture approval. Dominant quality attributes: security, reliability, data consistency. No scores at this stage.

## 10) Blocking decision register

All ownership markers above are BLOCKING, not safe defaults. Additional structural blockers: target and migration boundary; Jini version/license/consumption; Postgres driver/version and pool ownership; auth identity versus marketing subject separation; tenancy scope in all durable keys; consent purpose/evidence policy; identity normalization/merge conflict policy; erasure scope including backups; outbox idempotency and transaction boundary; approval revocation/revision semantics; provider selection/credentials/webhook trust; API namespace and CLI compatibility.

Landing builder versus URL registry remains a product blocker for that later slice. Creative MCP versus first-party polling adapters is internally ambiguous in the plan: vendor table says MCP, media section says PollingVendorAdapter. If creative uses MCP, broker must precede it, despite broker appearing later in numbered build order. Conversion-feed and offline-conversion correction semantics also need explicit owner decisions. These later blockers do not justify blocking a separately approved thin bootstrap, but do prevent blanket whole-blueprint approval.

## 11) Core/Foundation P0

After target/runtime/dependency decisions: minimal project package shells and composition root; config validation and logging primitives; injected Clock contract plus controllable test Clock; approved Postgres pool/migration-runner initialization with no domain schema; shared HTTP/client/contract scaffolding compatible with chosen repository; health/readiness and shutdown; test/CI bootstrap; empty web/CLI capability mounting seam. Infrastructure migration bookkeeping, if necessary, is not business data.

Exclude subject/consent/budget/holdout tables, gate implementations, outbox business records, approvals records, messages, segments, jobs and any polling business loop. These belong to P1+ owners. P0 does not establish production auth by omission: its auth client seam waits on the approved trust model and must not expose sensitive capabilities.

P0 exit: foundation contract accepted and merged, empty shell starts/stops with fake dependencies, Clock replacement works, database connectivity/migration harness is verifiable, and both surfaces have a shared contract seam. Apply repository guard/typecheck and relevant package checks to future implementation. No package tests were run for this report-only task.

## 12) Critical user journeys for QA/E2E

| Journey | Cross-domain validation | Priority |
|---|---|---|
| Acquire then message | Atomic consent/identity, same render, delivery fact, duplicate form | Critical |
| Withdraw during queued send | No stale-gate send; visible suppression outcome | Critical |
| Crash journey worker | Resume pinned version; no duplicate accepted send | Critical |
| Halt during ad write | UI/CLI halt reaches authority; no forbidden write; platform cap persists during outage | Critical |
| Approve after agent death | Durable decision visible/answerable through both surfaces | Critical |
| Erase exported subject | Local plus destination deletion inventory, failures visible | Critical |
| Unknown generation submit | No automatic duplicate paid submit; reconcile asset lineage | High |
| Metric restatement | Ledger remains immutable; platform values labelled separately | High |

## 13) Dependency-aware spec decomposition

Each row is a domain slice with its HTTP/contracts/UI/CLI behavior, not a separate frontend/backend assignment. Phases are conservative ordering; packages in the same phase can run together only after ownership is resolved and all dependencies merged. Every P1+ row implicitly depends on P0. Foreign-key owners must exist first.

| Phase / priority | Spec package and modules | Owns | Depends on |
|---|---|---|---|
| 0 / P0 | Core/Foundation: om-clock, om-pg shell, runtime/surface seams | Shared bootstrap only | Target/runtime decisions |
| 1 / P1 | Trust and operational authority: auth, audit, secrets, approval integration | Principals, vault and decisions | P0; approved Jini/tenant model |
| 2 / P1 | Spine: identity, consent, gate boundary, holdout, early budget authorization contract | Subject/merge/consent and approved primitive owners | Phase 1 |
| 3 / P1 | Events + erasure baseline | Ingest facts; deletion orchestration | Spine, audit; resolve conversion ownership |
| 3 / P1 | Outbound execution | om-outbox durable calls | Spine, authority/secrets; resolve envelope/halt contracts |
| 3 / P1 | Segment definitions | segments SQL compiler and versioning | Spine; event predicates wait on Events |
| 3 / P1 | Messaging content/preferences | render, templates, preferences | Spine, authority |
| 4 / P1 | Messaging delivery | dispatcher ledger, frequency-cap, deliverability | Outbound, content/preferences, spine, events |
| 5 / P1 | Journeys | versions, runs, wait/resume poller | Delivery, segments, events |
| 6 / P2 | Acquisition join | forms, web-tracker, links; landing-page registry/builder and publish integration | Journeys milestone, spine, events, content; landing decision |
| 7 / P2 | Ad accounts and read-only mirror | ad-accounts, observed platform state | Acquisition milestone, secrets, authority |
| 8 / P2 | Metrics and reconciliation baseline | metric-snapshots, ledger/platform diff | Read-only mirror, delivery/events |
| 9 / P2 | Budget/desired ads/write control | campaign-plan, budget-ledger, spend-guard, platform-sync writes | Metrics milestone, accounts, early authorization owner, outbox; creative-binding owner resolved |
| 10 / P2 | Identifier exports | platform-audiences, conversion-feed, match-rate alerts | Ads-write milestone, segments/events, erasure, shareability/outbox |
| 11 / P2 | Creative asset foundation | asset-library, brand-kit, provenance, variant-render | Export milestone; approved blobs/rights policy |
| 12 / P2 | Creative execution | generation-jobs + Jini Postgres adapter/vendor adapters | Asset foundation; MCP broker first if transport requires it |
| 13 / P2 | Creative-fatigue loop | fatigue and approved creative rotation | Generation, metrics, ads write/envelopes |
| 14 / P2 | MCP broker (if not required earlier) | Third-party connection/tool trust | Authority, secrets, taint policy; before any production MCP use |
| 15 / P3 | Attribution + expanded reconciliation | Declared attribution model | Touch/conversion owner, snapshots, ledgers, holdout |
| 16 / P3 | Desktop shell | Console/local sandbox launcher | Server and mature shared surfaces |
| Later / P3 | offline-conversions, commerce context, full experimentation, other platforms/video | Deferred capabilities | Feed/events/erasure and explicit later product scope |

Creative-binding cannot silently point at an asset table that only appears in phase 11. Before ad writes, choose an approved minimal creative-reference ownership contract or explicitly move the asset owner earlier. Until that decision, phase 9 stays blocked. Likewise event-aware segments follow the Events package rather than running as an independent concurrent slice. Erasure must be extended with every new data owner before that owner handles production identifiers.

Object-canvas and CLI capabilities are delivered with their owning slices; the final desktop milestone does not postpone web/CLI parity. One integrator owns shared route/CLI registration to avoid concurrent edits of user-owned files.

## 14) Handoff

Output: preliminary P0 scope, full module decomposition, known contradictions and decision register. No source/config changes, binding architecture choice or schema created.

Recommended routing: Coordinator combines this artifact with CodeBase Analyzer findings and presents a concrete target/runtime choice. Security and Database consultations resolve trust, retention and owner contracts; Software Architect evaluates Jini/Postgres integration once intent is approved. Then System Design revises the blueprint and human reviews it. Spec Agent starts with the approved narrow Foundation scope; dependent domain specs wait for their owners and contracts. No blanket parallel Programmer dispatch from this draft.

## 15) Approval

- Human reviewer: pending
- Decision: REVISE / preliminary review required
- Approved boundaries: none newly approved by this report
- Remaining functional/NFR blockers: see sections 3, 6–10 and 13
