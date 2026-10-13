# j12 Google Ads plugin handoff

Programmer(Direct), 2026-10-12. Status: **PARTIAL / verification outstanding; disabled and unadmitted**.

The plugin implements a narrow Google Search lifecycle with fully PAUSED hierarchy creation, exact activation/budget effect previews, status/budget/configuration readback, scoped served-cost reporting and read-only operation reconciliation. The backend has separate stop-only and eligible legacy conversion bindings. A packaged Node stdio entry and local fixtures provide a non-spending path. Authentication is OAuth Cloud-project based, not developer-token based. New offline integrations need Data Manager API, which is explicitly unavailable/deferred. Primary sources and setup are in `skills/google-ads/references/README.md`.

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

No certified tests were supplied or modified. No suites/builds/installs/om:check/live calls ran. Fresh command evidence:

- `node_modules/.bin/tsc -p content/agent-plugins/google-ads/tsconfig.json --noEmit`: **FAILED**, TS1005 on two missing braces in `schemas.ts` (then lines 9 and 62). Both were corrected. The user authorized only ONE typecheck, so semantic verification was not repeated.
- Static `node --check` across 21 lane TypeScript/MJS files: **PASSED**, zero syntax failures. This executes no module/test code and is not semantic typechecking. Eleven JSON files parsed successfully; scoped `git diff --check` found no whitespace errors.
- Runtime self-validation: **not run**, because the dispatch prohibits test/build execution. Startup/download behavior is asserted by the written subprocess suite and static dependency inspection, not demonstrated by an executed runtime.
- Coverage/complexity/cyclomatic/NLOC metrics: **not measured**; no gate or coverage claim. Direct test seams are injected transport, HTTP, authority, clock and journal plus exported pure mappings/calculations.

## CONTRACTS

Shared `Outcome`, `CallContext`, `Scope`, `Money`, `EffectEnvelope`, `HaltStopRequest`, `MeasurementGrant`, `ClockPort` and `ObserverPort` are used as public type contracts. No shared contracts or feature files were edited. Reviewed public campaigns, measure, plugins and host adapter contracts. Plugin factories are dynamically admitted server backends, not static feature dependencies.

Host seams requiring binding: `HostAuthorityPort`, `OperationJournalPort`, `CredentialPort`, `HttpPort`, `StopAuthorityPort`, `ConversionAuthorityPort`, `ConversionJournalPort`, `LocalMcpPort`. Trusted service contexts are injected outside agent tool arguments. Normal interactive owner/agent contexts need host adaptation to the backend service principal while preserving correlation/trace/run IDs.

## RISKS

- Production use is not verified. No OAuth project/account/action evidence, actual non-spending test account, billing-history adapter or live readback was available. All fixture IDs/evidence are invented. Production activation/budget changes deny when bounded-control evidence is unverified. Legacy conversion eligibility defaults unavailable.
- Authenticated portable stdio bootstrap is deferred: default launch has no credentials/host authority and returns unavailable; the OM server embeds the factory or provisions a private session. No credentials or policy permits are loaded from CLI/tool arguments.
- Durable journals, exact approval/halt serialization, dispatch-time consent and required audit belong to host jobs/safety/measure integration. Memory/fixture authority is not production authority. The plugin does not implement a second queue/database or canonical policy gates.
- The dependency-free MCP/schema implementation is a documented removable shim. Protocol cancellation/progress/resources, robust process lifetime deadlines, broad campaign support, and Data Manager API are not implemented. An individual HTTP call is bounded to 15s; a hierarchy read performs six fixed queries. Host process/call deadlines must bound the whole operation.
- Reporting provides served cost; billing-limit authority needs billed-cost/history evidence. Multiple groups/RSAs, broad-match keywords, shared/total budgets, alternative bidding/networks/targeting and cross-account conversion ownership fail closed or are deferred.
- UTC↔account-local flight conversion and Google v25 field eligibility require fixture and actual test-account validation, including DST transitions. Exact conversion row reconciliation is unavailable; uncertain uploads stay unknown.
- Final semantic typing and functional behavior are unverified after the one failed typecheck. Review and run the supplied lane commands before admission.

## NEEDS

1. Integrator: run lane semantic typecheck and written tests, then appropriate package/root gates. Do not treat static syntax evidence as functional verification.
2. j10/server integrator: bind private authenticated MCP/HTTPS, durable journal mappings to the ONE jobs outbox, current exact approval/halt serialization and required audit. Supply frozen SearchPlan/assets/targeting from generic campaigns DTOs and preserve provider/account/campaign mappings.
3. measure/server: bind current measurement consent/grant/source identity, action ownership/type/eligibility, import-window validation, conversion state and reporting snapshots. New integrations need a separately implemented Data Manager capability.
4. Owner adoption: independently verify OAuth Cloud-project access and real non-spending Google test-account evidence. Do not enable production writes/conversions from fixture evidence.
5. No new runtime npm dependency is required by this delivery. If replacing the shim, integrator must separately verify/install/bundle `@jini-ai/mcp@0.4.3` with a compatible pinned SDK release (installed SDK 1.24.0 does not satisfy that manifest's ^1.29.0 peer). Registry freshness remains unverified; do not install blindly from this note.

## HANDOFF

No commits/pushes/migrations. Unrelated concurrent changes were preserved. Next routing: integrator typecheck/test execution, code inspection of provider mappings/host seams, then fixture-only host integration and independent account adoption verification. Keep plugin disabled until those gates have evidence.

### Architecture audit and pre-completion checklist

**WARNING / evidence incomplete.** Static review found lane-only writes, public shared type imports, no runtime feature/vendor imports, injected dependencies, no import-time service startup, no unrestricted tool, server-owned authority, default unavailable conversions, bounded collections/payloads and correlated HTTP observations. All mutation HTTP calls occur inside the host's dispatch callback; host keeps the account serialization until completion. No shared schema, policy, manifest, lockfile or composition edit occurred. Governance ADR index/project-memory artifacts were absent, so the provided v2 architecture/COMMON were authoritative. No pipeline outline/certified test hash was supplied; Direct Mode used the explicit dispatch as the implementation outline.

Requirements rechecked against j12: implemented core plus tests, explicit deferrals above. Test integrity: only new tests; no existing assertion weakened/deleted. Scope: lane only. Fresh evidence: failed single semantic check and passed subsequent syntax checks. Runtime readiness and architecture gate G are **not claimed**.

### Pattern priming, reuse and function assessment

Seed/style: the authorized existing public object-parameter factories and typed Outcome adapters in `features/campaigns/src/adapters/capability.ts` plus shared schemas. Applied them to `createGooglePlugin({ binding, transport, journal, authority, clock })`. No new style approval was requested because the dispatch already authorized implementation against those conventions. Boundaries were checked in order: injected test seams; closed function/error contracts; bounded fixed-query mapping; collection/payload/deadline bounds; adversarial duplicate/partial-failure fixtures.

Reuse: MCP; inspected installed Jini public server/stdio declarations and peer manifest; used compatible tool/result shapes and a removable local shim because runtime bundling/install/build was not authorized. npm verification was attempted and inaccessible.

Reuse: shared DTOs/authority; inspected contracts values/capabilities, campaigns backend/public contracts and measure delivery/public contracts; used their public types and caller-owned host seams. Canonical safety/measure policy remains with the owner; it is not imported or recreated here.

Reuse: vendor HTTP/hashing/streams; used Node/Web standard library crypto, URL, Intl, Buffer, streams and injected fetch. No community Google SDK or sibling source dependency.

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
| checkConversion/scopes/grant/data, deliver/mapConversion/upload/hashEmail/hashPhone | INCONCLUSIVE | CURRENT host consent and API/action/import eligibility required; no automatic uncertain retry. |
| createMemoryJournal/findCampaign, fixture apply/search helpers | INCONCLUSIVE | Copies and append history; scope collision fixed structurally; test-only state. |
| MCP session/handleMethod/drainFrames/serveStdio/localInvoke/decodeLocalResult/parseOutcome | INCONCLUSIVE | Bounded private shim; result projections validated; decoder split for complexity. |
| runCli/default composition, stdio test harness | INCONCLUSIVE | No runtime startup evidence; default egress unavailable, isolated fixture flag. |

Known Recommended issue: replace MCP/schema compatibility shims with verified packaged public libraries when bundling is authorized; retain bounds and shared tests. No measured mechanical finding count is claimed. Variable-name audit checked billed-vs-served terminology, average budget vs cap, unknown vs acknowledged, current-day highest vs candidate budget and scope/account identity. No zero-findings claim is made. Public factory/port/schema contracts are documented; obvious private leaf helpers intentionally omit narration. No >2-parameter owned API or policy-gate import was added. Foreign stream/fetch/execute callbacks follow their required ABIs.
