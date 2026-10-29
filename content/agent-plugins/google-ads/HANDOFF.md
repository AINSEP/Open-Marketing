## W22 multi-ad B1 (2026-10-29)

Search launches support 1–3 RSAs in one ad group with per-ad destinations; all are created PAUSED in one atomic mutate and acknowledged only after readback. This supersedes the singleton restriction and multi-ad deferrals below; singleton traffic bytes/digests are preserved. Multi-ad digests normalize complete copy/URL records, retaining multiplicity. Tests are written, not run; the final typecheck result is in this job's progress.md.
Sources checked: [Google Ads API v26 MutateGoogleAdsRequest](https://developers.google.com/google-ads/api/reference/rpc/v26/MutateGoogleAdsRequest), [RSA creation](https://developers.google.com/google-ads/api/docs/responsive-search-ads/create-responsive-search-ads), [three-enabled-RSA limit](https://support.google.com/google-ads/answer/6372658?hl=en).
DEFERRED: hosted lead forms until reviewed form content reaches the exact approval card and an intake decision exists; if built before OM intake exists: leads stay in Google. OM intake requires consent before persistence. Production creative resolution must supply additionalCreatives for later ads; HTTP/om-tool/CLI/Studio acceptance and Coordinator dist rebuild remain NEEDS.

## W20 campaign validation B1 (2026-10-28)

`campaign.validate.v1` reuses `prepareCreation`, including sandbox test-account and conversion-goal checks; the atomic body matches creation except fixed `validateOnly: true`. It writes no journal/checkpoint. [Google MutateGoogleAdsRequest](https://developers.google.com/google-ads/api/reference/rpc/v26/MutateGoogleAdsRequest) specifies validation without execution/results. Empty `{}` success is fixture-covered, still unverified live; a dry run does not guarantee later acceptance. The new read row defaults to `admitted: false`; declared-unadmitted/failing validation blocks the card. Source fingerprints are refreshed; Coordinator must rebuild dist. Tests are written only; final typechecks are recorded in the W20 job progress ledger.

# Google Ads plugin handoff

## W20 objectives B1 — website leads and sales (2026-10-28)

Search translation supports one RSA and its explicit destination URL for traffic, leads and sales. Traffic retains manual CPC and its existing plan representation. `objective?: "leads" | "sales"` is absent for traffic; CPC is required only for traffic and forbidden for optimized plans, including legacy `create_paused` calls. Leads select SUBMIT_LEAD_FORM/WEBSITE with MaximizeConversions; sales select PURCHASE/WEBSITE with MaximizeConversionValue. Both use standard bidding without target CPA/ROAS. Money remains integer micros.

Optimized preparation reads complete account-goal evidence after the scoped account read, refusing malformed, duplicate, incomplete, >200-row or missing-selected-goal evidence before mutation. One atomic PAUSED request appends an explicit `biddable` update for every observed category/origin: selected pair true, all others false. Existing create indices, journal/checkpoints, dispatch authority and no-replay behavior remain. The ACK envelope now accepts up to 500 responses while retaining at most 256 scoped created-resource references.

Optimized readback adds two fixed searches scoped by each resource's own campaign field. It requires one CAMPAIGN-level configuration with no custom goal, the selected pair biddable, every other pair non-biddable, and the expected standard strategy without targets or a portfolio strategy. Mismatches prevent acknowledgement and activation. A future auto-created goal that is biddable therefore blocks activation until reviewed. Traffic adds no goal queries. The local JSON matcher now validates finite decimal min/max/exclusiveMinimum values and rejects unsupported schema types; existing Zod geography rechecks remain.

Primary sources checked during B1:

- [CampaignConversionGoal v26](https://developers.google.com/google-ads/api/reference/rpc/v26/CampaignConversionGoal): resource naming and explicit false plus `updateMask: "biddable"` avoid inherited defaults.
- [Campaign goals](https://developers.google.com/google-ads/api/docs/conversions/goals/campaign-goals): updating goals switches configuration to CAMPAIGN; new goals can default to biddable. [Campaign goal fields](https://developers.google.com/google-ads/api/fields/v26/campaign_conversion_goal), [configuration fields](https://developers.google.com/google-ads/api/fields/v26/conversion_goal_campaign_config) and [account goal fields](https://developers.google.com/google-ads/api/fields/v26/customer_conversion_goal) verify the fixed query fields and campaign filters.
- [Bid strategy types](https://developers.google.com/google-ads/api/docs/campaigns/bidding/strategy-types): standard MaximizeConversions supports Search; MaximizeConversionValue is standard-capable, but this page does not explicitly establish standard Search support. **That Search combination remains unverified.**
- [Performance Max conversion-goal example](https://developers.google.com/google-ads/api/performance-max/conversion-goals) uses a temporary campaign ID in goal updates. Applying that mechanism to Search is an inference, **unverified on a live account**. [Mutate semantics](https://developers.google.com/google-ads/api/docs/mutating/overview) supports linked atomic requests; `partialFailure: false` is retained and a rejection has no fallback mutation/retry.
- [Lead-form sample](https://developers.google.com/google-ads/api/samples/add-lead-form-asset) links LeadFormAsset through CampaignAsset with LEAD_FORM. [Search lead-form rules](https://support.google.com/google-ads/answer/17079814?hl=en) allow one form per campaign and describe account-level inheritance. Existing account-level lead forms can still serve; this build neither inspects nor creates form assets.

- **Unverified:** explicit biddable updates include every observed category/origin, including STORE, APP and Google-hosted goals. If Google rejects these pairs, atomic creation fails closed and leads/sales cannot launch on that account.

Goal existence does **not** establish working conversion tracking, primary-action quality, eligibility, history, or reliable sales values. Other lead categories (CONTACT, BOOK_APPOINTMENT, REQUEST_QUOTE, PHONE_CALL_LEAD, QUALIFIED_LEAD) are not selected as substitutes: absent SUBMIT_LEAD_FORM/WEBSITE refuses. Fixtures are not vendor acceptance evidence. No live calls, spend, credentials or migrations were used.

Tests written, not run: `campaign-translation.test.ts` covers leads/sales without CPC, unchanged traffic, retained multi-ad refusal and decimal matcher bounds; `campaign-deployment.test.ts` covers real-plugin fixture payloads/acknowledgement, missing/truncated/malformed/duplicate/oversized account goals, legacy CPC exclusivity, goal/config/strategy/target drift blocking activation and a 257-response ACK retaining references. Existing canonical server-shaped `createCapabilities` test in `read-capabilities.test.ts` stays intact. Typecheck result is recorded below after the single authorized command; no tests, builds or runtime validation are authorized here.

TYPECHECK: `corepack pnpm --dir content/agent-plugins/google-ads typecheck` — PASS, exit 0 on the one permitted corrective rerun. The first invocation found one TS7022 inference error in the new decimal matcher test; an explicit Outcome result annotation resolved it. No test, build, server typecheck, install, commit or push was run. Source review found a pre-existing geography-test issue at campaign-deployment.test.ts:154: repeated `invalid-geo` IDs can cause journal conflicts between invalid plans. Left unchanged under this job's strict scope; Coordinator should assign distinct IDs before fixture acceptance.

Fingerprint: `shasum -a 256 io.github.ainsep.openmarketing/src/schemas.ts` = `cd0de4d65255610ec743c1eb46720b5289d8ce27b0702b3f329feff80962167d`, replaced in capabilities.json ×4, plugin.json ×4 and bindings/{search,reporting,stop,conversions}.v1.json ×1 each. Read-capability fingerprints are untouched.

DEFERRED: multi-ad/per-ad creative resolution and its server-test edit (server prepare remains sandbox `campaignFixture` only); Google-hosted forms pending form-content/asset-selection contract; other goal categories, custom goals, conversion-action creation and tCPA/tROAS; real preparation plus HTTP/om-tool/CLI/Studio closure and exact-plan validate/card binding. These changes do not make production launching available.

NEEDS/HANDOFF: Coordinator rebuilds plugin dist during integration; no manifest dependencies, lockfile or server files changed. Build this job before campaign-validate: its optimized dry-run must call `readConversionGoals` and pass the same evidence to `createOperations`, producing creation's body except `validateOnly`. Serialize other Google jobs and refresh all 12 schemas.ts fingerprint rows after any later schema edit. Runtime/fixture acceptance must run elsewhere under explicit authorization.

## W18 P2 launch B1 — local targeting (2026-10-28)

Google Search translation now supports country, postal-code or radius targeting for **traffic with one RSA**. Postal metadata is optional `postalCodes: [{ country, code, id }]` (max 200), while existing required metadata stays unchanged. Each requested postal code must resolve exactly once in its country; only those location IDs are sent. Radius uses rounded integer microdegrees and explicit KILOMETERS, with no broad country criterion or address. All serving entities remain PAUSED.

Readback accepts up to 200 rows and reconstructs LOCATION and PROXIMITY separately. Multiple proximities, unsupported units or malformed proximity fail closed; changed radius or added country evidence cannot acknowledge the plan. Google's descriptive address does not affect the digest. Existing `planDigest` and unknown-outcome/no-replay behavior are unchanged. Geography exclusivity also guards legacy `create_paused`. The legacy JSON matcher lacks decimal-number validation, so validation/readback reuse the Zod proximity shape directly; no matcher or out-of-lane file was changed.

Official fields checked: [location targeting](https://developers.google.com/google-ads/api/docs/targeting/location-targeting) maps postal regions through geo-target constants; [GeoPointInfo v26](https://developers.google.com/google-ads/api/reference/rpc/v26/GeoPointInfo) defines integer microdegrees; [ProximityInfo v26](https://developers.google.com/google-ads/api/reference/rpc/v26/ProximityInfo) defines the point/radius/units and descriptive address. No API radius min/max was documented there: OM retains the neutral contract's (0, 20040] km without clamping; vendor acceptance remains unverified. Country-border intersection is not guaranteed.

Tests written in `campaign-translation.test.ts` and `campaign-deployment.test.ts` cover postal completeness/duplicates/country scoping, exact radius payload, 200 reordered postal rows, hosted radius round trip, drift and invalid legacy geography. Existing server-shaped real-factory coverage in `read-capabilities.test.ts` is retained. **Tests, builds and live calls were not run.** `corepack pnpm --dir content/agent-plugins/google-ads typecheck`: **PASS (exit 0)** on the permitted corrective rerun; the first run found only readonly fetch assignments/contextual typing in two new test wrappers, corrected by replacing fixture dependency objects.

Deferred by review: leads/sales (conversion-goal evidence), multi-ad URLs (real creative resolution), `campaign.validate.v1` plus exact-card binding (separate vertical job), Meta, production preparation/surface integration and live acceptance. Coordinator NEEDS: rebuild/install plugin dist and execute fixtures in the authorized integration environment; if another job edits `schemas.ts` later, recompute all 12 schema fingerprints across declarations and four bindings. No dependency, core, shared-contract, migration or approval-policy change.

W20 conversion delivery supersedes the historical w3 conversion contract below: `createConversionDelivery` takes A3 dependencies plus authority, sends one ingest POST, reports `delivered` as accepted with processing/attribution unknown, and returns `receiptId` for durable measure evidence; explicit reconciliation with that receipt makes one bounded request-status GET for processed/failed diagnostics, with attribution unknown and no I/O when the receipt is absent.

## w3-google-ads-dm continuation — historical handoff

Programmer(Direct), 2026-10-12. **Implementation finished; tests/host adoption outstanding; disabled and unadmitted.** This section supersedes earlier conversion deferrals and the older progress-ledger.md. No new file or out-of-lane change was made.

Data Manager v1 now validates one prepared web event, atomically claims its stable identity, ingests it once and saves Google's request ID. Subsequent calls reconcile that ID with one bounded GET. Acceptance is `unknown`; only a matching destination, SUCCESS, exactly one event and no processing errors returns `delivered` (processed, never attributed). Lost receipts stay unknown and never resend. FAILED/PARTIAL_SUCCESS return non-retryable boundary errors. One host authority dispatch covers preflight + ingest; reconciliation dispatch reads only.

### CHANGED FILES

- `io.github.ainsep.openmarketing/src/conversions.ts`: Data Manager-only configuration, OM definition-to-action mapping, contacts-prepared digest validation, preflight, atomic dedupe, durable receipt and diagnostic reconciliation. Payload/project conflicts and changes during preflight reject.
- Namespace `src/{types,transport,index}.ts`: fixed ingestion/status endpoints, optional bounded HTTP GET, project/scope-attested advertiser credentials, public conversion contracts; removed upload/hash exports.
- Namespace `src/mcp.ts`: one Buffer type annotation for the existing semantic error found by the authorized typecheck; no runtime behavior change.
- Namespace `src/fixture.ts`: retained the interrupted run's small compatibility edit removing the dead upload fixture. This is an extra file beyond the approved nine-file map; it is necessary for the new transport operation union and introduces no capability.
- Namespace `tests/conversions.test.ts`: handwritten fixture suite shared by the transport double and real REST + bounded fetch adapter.
- Namespace `runtime.json`, `skills/google-ads/SKILL.md`, `skills/google-ads/references/README.md`, `HANDOFF.md`: implemented support, exact input contracts, verified semantics, host responsibilities and closed admission.

### TESTS — written, not run

Fixtures cover immutable preflight/ingest bodies, failed/malformed/warning preflight, consent/grant withdrawal, atomic duplicate/race claims, payload/action/project conflicts, restart, lost receipt/storage, processing/success/terminal failures, incorrect/ambiguous destination, malformed diagnostics, valid processing warnings, digests/raw-PII rejection, scoped grants, per-advertiser credentials, scope/project mismatch, bounded GET and sanitized correlated observations. They run the same conversion behavior against a double and the actual REST/HTTP adapters with injected fixture fetch only.

No test suites, builds, installs, om:check, live vendor calls, spend or runtime self-validation ran, as explicitly prohibited. No red/green, coverage or measured complexity claim is made. Direct seams: pure mapping plus transport, HTTP, journal, authority and injected clock. No certified test hash was supplied; the approved plan and amendments were the implementation outline.

### TYPECHECK

The single authorized command is `node_modules/.bin/tsc -p content/agent-plugins/google-ads/tsconfig.json --noEmit`. Result: **FAILED**, exit 2. It reported exactly two errors: TS2322 in `src/mcp.ts:72` (inferred Buffer<ArrayBuffer> versus the broader drainFrames Buffer return) and TS2353 in `src/transport.ts:124` (unsupported ObserverEvent.attributes). The quick lane fixes annotate the pending buffer with the existing Buffer seam type and omit unsupported observer attributes while preserving correlation/trace/run IDs. Both fixes are unverified; the command was not rerun. No second typecheck is authorized in this run.

### CONTRACTS

`google-ads.conversions.v1` and `Outcome<{ status: "delivered" | "unknown" }>` remain stable. Factory remains `createConversionBinding({ binding, configuration, transport, journal, authority, now })` with `deliver`/`reconcile`. `mapConversion({ binding, configuration, event })` stays a pure mapping of checked inputs.

Configuration is exactly `{ api: "data-manager-v1", cloudProjectId, eligibility: "verified" | "unavailable", actionIds: Record<definitionId, numericActionId>, loginCustomerId? }`. No legacy variant, eligibilityEvidenceId or phase field remains.

Event is exactly `{ eventId, definitionId, eventType, occurredAt, destination, purpose, gclid?, hashedEmail?, hashedPhoneNumber?, adUserData, adPersonalization?, valueMicros, currency }`. `definitionId` selects the action; `eventType` remains in delivery identity, with no plugin signup/trial union. Digests must be lowercase SHA-256 hex matching `^[a-f0-9]{64}$` and copy unchanged. GCLID is 1..256 characters matching `^[A-Za-z0-9_-]+$`. At least one identifier is required; raw identifiers and extra fields reject. Integer epoch milliseconds must not be future; valueMicros is non-negative and at most Number.MAX_SAFE_INTEGER; currency matches the account. Full constraints and OAuth onboarding are in the skill reference README.

Existing seams extended only: transport ingest/request_status; HttpPort optional GET (mandatory for Data Manager); CredentialPort required scope/project lookup and returned attested metadata; journal get and requestId/diagnosticStatus; authority one dispatch with current host checks and serialized consent/configuration. No new dependencies, shared contracts, manifests, lockfile or composition changes. mcp.json stays closed transport-only; OM declarations remain in the plugin namespace extension.

### RISKS / NEEDS

- Server/credentials owner: per-advertiser offline OAuth through the owner's project, API enablement, verified permissions, encrypted refresh tokens, scope/project attestation and broker binding. Plugin metadata is not provider approval evidence.
- Server/measure owner: ONE durable outbox metadata adapter, atomic claims, monotonic append-only diagnostics, current consent/grant/source/schema/action ownership/type/import-window checks, cancellation/serialization and required egress audit. Hold authority through both POSTs and all asynchronous waits. Credentials/configuration/event inputs must remain stable during each call.
- Contacts owner: deliver the specified already-normalized digests. This plugin deliberately cannot replace contacts hashing.
- Shared MeasurementGrant binds 1..16 open definition IDs and requires coverage of the exact event definition.
- Integrator: use @jini-ai/agent-plugins 0.4.4 for spec 1.1 validation; previous inspection found 0.4.3. No install or dependency change here. Execute the written suites and broader gates later.
- Production ingestion, project approval, enhanced-lead prerequisites and end-to-end matching/attribution remain unverified. Keep eligibility unavailable and admission disabled until independent evidence exists. Partner links, cross-account action ownership, batching, adjustments, extra identifiers and action discovery remain deferred.
- No verified event/transaction-ID lookup exists in this implementation. A lost Google request ID needs owner recovery; no blind retry.

### HANDOFF / audit

Next: integrator binds credentials/authority/durable measure jobs, TestRunner executes fixtures and broader gates, Code Inspection reviews Google mappings and host obligations, then independent adoption verification. No migrations, commits or pushes. Unrelated dirty/untracked work preserved.

Architecture audit: **WARNING — runtime/host evidence pending**, no known lane-boundary violation from static review. Checked v2 §§6/10, COMMON B1–B8, server-only credentials/typed conversions, contacts hashing ownership, fixed bounded endpoints, current authority, atomic claim before irreversible egress, no retries/agent tools, package-only shared type imports and no import-time service startup. Governance ADR index/project-memory files were absent. Static source discovery used direct reads/rg because no graph MCP tools were exposed. Existing object-parameter Outcome factories served as the continuation style; no new layer needed priming.

Pre-completion: approved plan/amendments rechecked, exact input shape documented, test assertions retained or replaced only for authorized legacy deletion, scope checked, one failed typecheck and two quick lane corrections recorded above; no rerun. Self-validation is not run because this dispatch prohibits suites/runtime validation. Documentation classification: public conversion/credential/HTTP APIs documented; legacy Data Manager deferral docs updated; trivial wrappers inherit parent documentation.

Reuse: mapping/validation extended existing conversions.ts and schema.ts; durable identity and payload hashes reuse rules.ts (this hashes operation payloads, never user identifiers); transport extends existing bounded adapter; the recorded double and real REST adapter are concrete replacement/test consumers. Planner's existing library investigation found no installed Data Manager codec; no new library needed.

| Assessment unit | Disposition | Findings / local fix |
| --- | --- | --- |
| conversion / existingDelivery / dispatchDelivery | INCONCLUSIVE | Duplicate/changed identity behavior has written assertions; runtime not executed. |
| checkConversion / configuration / scopes / grant / data | INCONCLUSIVE | Closed schemas and exact bounds asserted; shared grant category expansion is an upstream NEED. |
| mapConversion / conversionDigest | INCONCLUSIVE | Unchanged digests and definition selection asserted; OAuth project added to immutable digest. |
| preflightAndIngest / ingest | INCONCLUSIVE | Data changes after validation now conflict; lost receipts/claim races tested in fixtures, unexecuted. |
| reconcileReceipt / diagnosticRecord | INCONCLUSIVE | Replaced permissive/truthy diagnostic checks with closed bounded projection; terminal outcomes never resend. |
| restRequest / access / credential / endpoint / sendRequest | INCONCLUSIVE | Split access check to keep decisions small; project/scope/advertiser isolation fixtures written. |
| HTTP destination / request / observe | INCONCLUSIVE | Byte/deadline/redirect bounds and sanitized IDs asserted; no live runtime evidence. |
| fixture transport / conversion test doubles | INCONCLUSIVE | Removed obsolete upload branch; doubles cannot egress. |
| serveStdio buffer typing | INCONCLUSIVE | Corrected Buffer generic mismatch from the single typecheck; existing stdio fixtures unchanged, not run. |

No surviving Critical/High semantic defect is claimed, and no zero-findings quality claim is made: runtime/coverage/mechanical evidence is incomplete. Variable-name review checked definitionId versus grant category, processed versus attributed, claimed versus delivered, scope/project and receipt versus operation ID. Each behavior branch can be reached through the recorded injected seams without combinatorial tests; fixture execution is deferred. Host durability/serialization is an explicit integration dependency, not a plugin-owned second database or queue.

Provider evidence rechecked on 2026-10-12: [validateOnly/ingestion](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest), [diagnostics](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve), [action-owner event mapping](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events), [advertiser OAuth](https://developers.google.com/data-manager/api/devguides/concepts/deploy). These establish semantics only, not production eligibility.

---

## Earlier j12 implementation record

Programmer(Direct), 2026-10-12. Status: **PARTIAL / verification outstanding; disabled and unadmitted**.

The plugin implements a narrow Google Search lifecycle with fully PAUSED hierarchy creation, exact activation/budget effect previews, status/budget/configuration readback, scoped served-cost reporting and read-only operation reconciliation. The backend has separate stop-only and Data Manager conversion bindings. A packaged Node stdio entry and local fixtures provide a non-spending path. Authentication is OAuth Cloud-project based, not developer-token based. New offline integrations use the implemented Data Manager API path; production eligibility remains unavailable until independently verified. Primary sources and setup are in `skills/google-ads/references/README.md`.

## CHANGED FILES

Only `content/agent-plugins/google-ads/**`:

- `plugin.json`, `mcp.json`, namespace `capabilities.json`, `runtime.json`, four `bindings/*.json`: portable transport configuration, closed OM declaration envelopes and disabled admission metadata.
- `package.json`, `tsconfig.json`: lane-only commands and Node 24.2.0 baseline. No runtime npm dependencies; contracts are a development type dependency.
- Namespace `bin/mcp-server.mjs`: packaged executable, no runtime download or build required. Kept under `bin/` because repository ignores `dist/` artifacts.
- Namespace `src/{types,schema,schemas,rules,mapping,readback,plugin}.ts`: closed schemas, injected ports, stable/scoped identity, billing/flight evidence, atomic PAUSED mapping, controlled-plan digest and reconciliation.
- Namespace `src/{transport,stop,conversions,memory,fixture,mcp,main,index}.ts`: server-only OAuth/HTTPS, narrow backend stop/conversions, journals/doubles, removable private MCP shim and inert library entry.
- Namespace `tests/{helpers,capabilities,money-and-stop,conversions,boundaries}.ts`, `fixtures/invalid-mcp-extra-field.json`: shared/adversarial/local subprocess tests and a closed-schema negative fixture.
- Google skill/reference documentation, this handoff and `progress-ledger.md`.

## TESTS — written, not run

ONE shared capability suite runs against a memory implementation, real REST codec with injected fixture HTTP, and real local MCP subprocess adapter. Assertions cover PAUSED child readback, activation, budget change, pause, account scope, duplicates/conflicts, restricted tool inputs and served-cost reports. Fault fixtures cover timeout before/after commit, partial creation and concurrent duplicate claims; reconciliation does not send a second write. Other tests cover same-day 10→50→5 billing exposure, stale/incomplete history, production evidence denial, currency rounding/overflow, stop-only fields, consent withdrawal, conversion mapping/eligibility/dedupe/partial errors, host credentials, byte bounds, malformed MCP output, portable manifests and append-only journal evidence.

No certified tests were supplied or modified. No suites/builds/installs/om:check/live calls ran. Historical j12 command evidence (before w3 continuation):

- `node_modules/.bin/tsc -p content/agent-plugins/google-ads/tsconfig.json --noEmit`: **FAILED**, TS1005 on two missing braces in `schemas.ts` (then lines 9 and 62). Both were corrected. The user authorized only ONE typecheck, so semantic verification was not repeated.
- Static `node --check` across 21 lane TypeScript/MJS files: **PASSED**, zero syntax failures. This executes no module/test code and is not semantic typechecking. Eleven JSON files parsed successfully; scoped `git diff --check` found no whitespace errors.
- Runtime self-validation: **not run**, because the dispatch prohibits test/build execution. Startup/download behavior is asserted by the written subprocess suite and static dependency inspection, not demonstrated by an executed runtime.
- Coverage/complexity/cyclomatic/NLOC metrics: **not measured**; no gate or coverage claim. Direct test seams are injected transport, HTTP, authority, clock and journal plus exported pure mappings/calculations.

## CONTRACTS

Shared `Outcome`, `CallContext`, `Scope`, `Money`, `EffectEnvelope`, `HaltStopRequest`, `MeasurementGrant`, `ClockPort` and `ObserverPort` are used as public type contracts. No shared contracts or feature files were edited. Reviewed public campaigns, measure, plugins and host adapter contracts. Plugin factories are dynamically admitted server backends, not static feature dependencies.

Host seams requiring binding: `HostAuthorityPort`, `OperationJournalPort`, `CredentialPort`, `HttpPort`, `StopAuthorityPort`, `ConversionAuthorityPort`, `ConversionJournalPort`, `LocalMcpPort`. Trusted service contexts are injected outside agent tool arguments. Normal interactive owner/agent contexts need host adaptation to the backend service principal while preserving correlation/trace/run IDs.

## RISKS

- Production use is not verified. No OAuth project/account/action evidence, actual non-spending test account, billing-history adapter or live readback was available. All fixture IDs/evidence are invented. Production activation/budget changes deny when bounded-control evidence is unverified. Data Manager conversion eligibility defaults unavailable.
- Authenticated portable stdio bootstrap is deferred: default launch has no credentials/host authority and returns unavailable; the OM server embeds the factory or provisions a private session. No credentials or policy permits are loaded from CLI/tool arguments.
- Durable journals, exact approval/halt serialization, dispatch-time consent and required audit belong to host jobs/safety/measure integration. Memory/fixture authority is not production authority. The plugin does not implement a second queue/database or canonical policy gates.
- The dependency-free MCP/schema implementation is a documented removable shim. Protocol cancellation/progress/resources, robust process lifetime deadlines, and broad campaign support are not implemented. An individual HTTP call is bounded to 15s; a hierarchy read performs six fixed queries. Host process/call deadlines must bound the whole operation.
- Reporting provides served cost; billing-limit authority needs billed-cost/history evidence. Multiple groups/RSAs, broad-match keywords, shared/total budgets, alternative bidding/networks/targeting and cross-account conversion ownership fail closed or are deferred.
- UTC↔account-local flight conversion and Google v25 field eligibility require fixture and actual test-account validation, including DST transitions. Conversion diagnostics use saved Data Manager request IDs; missing receipts stay unknown with no automatic resend.
- Final semantic typing and functional behavior are unverified after the one failed typecheck. Review and run the supplied lane commands before admission.

## NEEDS

1. Integrator: run lane semantic typecheck and written tests, then appropriate package/root gates. Do not treat static syntax evidence as functional verification.
2. j10/server integrator: bind private authenticated MCP/HTTPS, durable journal mappings to the ONE jobs outbox, current exact approval/halt serialization and required audit. Supply frozen SearchPlan/assets/targeting from generic campaigns DTOs and preserve provider/account/campaign mappings.
3. measure/server: bind current measurement consent/grant/source identity, action ownership/type/eligibility, import-window validation, conversion state and reporting snapshots. Wire the implemented Data Manager capability through the current credential broker and conversion jobs.
4. Owner adoption: independently verify OAuth Cloud-project access and real non-spending Google test-account evidence. Do not enable production writes/conversions from fixture evidence.
5. No new runtime npm dependency is required by this delivery. If replacing the shim, integrator must separately verify/install/bundle `@jini-ai/mcp@0.4.3` with a compatible pinned SDK release (installed SDK 1.24.0 does not satisfy that manifest's ^1.29.0 peer). Registry freshness remains unverified; do not install blindly from this note.

## HANDOFF

No commits/pushes/migrations. Unrelated concurrent changes were preserved. Next routing: integrator typecheck/test execution, code inspection of provider mappings/host seams, then fixture-only host integration and independent account adoption verification. Keep plugin disabled until those gates have evidence.

### Architecture audit and pre-completion checklist

**WARNING / evidence incomplete.** Static review found lane-only writes, public shared type imports, no runtime feature/vendor imports, injected dependencies, no import-time service startup, no unrestricted tool, server-owned authority, default unavailable conversions, bounded collections/payloads and correlated HTTP observations. All mutation HTTP calls occur inside the host's dispatch callback; host keeps the account serialization until completion. No shared schema, policy, manifest, lockfile or composition edit occurred. Governance ADR index/project-memory artifacts were absent, so the provided v2 architecture/COMMON were authoritative. No pipeline outline/certified test hash was supplied; Direct Mode used the explicit dispatch as the implementation outline.

Requirements rechecked against j12: implemented core plus tests, explicit deferrals above. Test integrity: the conversion suite replaces obsolete legacy-upload expectations as explicitly authorized; no certified tests were supplied or weakened. Scope: lane only. Fresh evidence: failed single semantic check and passed subsequent syntax checks. Runtime readiness and architecture gate G are **not claimed**.

### Pattern priming, reuse and function assessment

Seed/style: the authorized existing public object-parameter factories and typed Outcome adapters in `features/campaigns/src/adapters/capability.ts` plus shared schemas. Applied them to `createGooglePlugin({ binding, transport, journal, authority, clock })`. No new style approval was requested because the dispatch already authorized implementation against those conventions. Boundaries were checked in order: injected test seams; closed function/error contracts; bounded fixed-query mapping; collection/payload/deadline bounds; adversarial duplicate/partial-failure fixtures.

Reuse: MCP; inspected installed Jini public server/stdio declarations and peer manifest; used compatible tool/result shapes and a removable local shim because runtime bundling/install/build was not authorized. npm verification was attempted and inaccessible.

Reuse: shared DTOs/authority; inspected contracts values/capabilities, campaigns backend/public contracts and measure delivery/public contracts; used their public types and caller-owned host seams. Canonical safety/measure policy remains with the owner; it is not imported or recreated here.

Reuse: vendor HTTP/payload digests/streams; used Node/Web standard library crypto, URL, Intl, Buffer, streams and injected fetch. No community Google SDK or sibling source dependency.

Function-quality assessment is **INCONCLUSIVE** for runtime units because tests and final semantic verification were not run. This does not mean a defect is established or absent. All assessed units expose direct tests or injected seams; tiny private getters/record/asset/result helpers inherit their parent assessment.

| Assessment units | Disposition | Finding / local action |
| --- | --- | --- |
| schema parse/matches/object/array/string/integer, protect | INCONCLUSIVE | Schema subset intentionally bounded; malformed extra fields tested; static syntax fixed. |
| digest/canonical, operationIdentity, planDigest | INCONCLUSIVE | Stable scope/action identity and ordering; duplicate/cross-scope tests written. |
| validatePlan, validateHierarchy, localDate, googleDateTime, localInstant/parseFlight | INCONCLUSIVE | Calendar/DST overlap requires actual provider fixtures; impossible dates guarded. |
| billingExposure, microsToMoney, effectFor/spendEffect | INCONCLUSIVE | Complete host history is binding; arithmetic guards and same-day/overflow tests written. |
| createOperations, statusOperations/childStatus, budgetOperations | INCONCLUSIVE | Explicit sparse masks and per-resource child kinds; no arbitrary provider mutation input. |
| readAccount/searchRows/search, readHierarchy/readChildren/projectHierarchy/supportedControls | INCONCLUSIVE | Six fixed bounded queries; taint projections parsed; unsupported controls denied. |
| plugin checkedCall/invoke/preview/prepare/prepareCreation/prepareSpend | INCONCLUSIVE | Host authority required; split decisions from transmission, foreign failures protected. |
| write/sendMutation/mutationObserved/reconcile | INCONCLUSIVE | Durable host claim mandatory; concurrent/timeout/partial tests written; no automatic resend. |
| report/validReportDates/reportItemValid | INCONCLUSIVE | Served-cost semantics explicit; date/row bounds; measure snapshot mapping deferred. |
| restRequest/endpoint/post/readBody/observe | INCONCLUSIVE | Fixed tokenless endpoints, byte/time bounds, sanitized observations; live auth unverified. |
| stop/stopScopeMatches/transmitStop | INCONCLUSIVE | Host CURRENT halt permit required; constant pause mask; no activation/budget path. |
| checkConversion/scopes/grant/data, mapConversion, preflightAndIngest/ingest/reconcileReceipt | INCONCLUSIVE | Data Manager only; contacts owns hashing; CURRENT host consent/action eligibility and durable receipts required. |
| createMemoryJournal/findCampaign, fixture apply/search helpers | INCONCLUSIVE | Copies and append history; scope collision fixed structurally; test-only state. |
| MCP session/handleMethod/drainFrames/serveStdio/localInvoke/decodeLocalResult/parseOutcome | INCONCLUSIVE | Bounded private shim; result projections validated; decoder split for complexity. |
| runCli/default composition, stdio test harness | INCONCLUSIVE | No runtime startup evidence; default egress unavailable, isolated fixture flag. |

Known Recommended issue: replace MCP/schema compatibility shims with verified packaged public libraries when bundling is authorized; retain bounds and shared tests. No measured mechanical finding count is claimed. Variable-name audit checked billed-vs-served terminology, average budget vs cap, unknown vs acknowledged, current-day highest vs candidate budget and scope/account identity. No zero-findings claim is made. Public factory/port/schema contracts are documented; obvious private leaf helpers intentionally omit narration. No >2-parameter owned API or policy-gate import was added. Foreign stream/fetch/execute callbacks follow their required ABIs.
