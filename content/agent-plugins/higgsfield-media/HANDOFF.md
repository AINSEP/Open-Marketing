# Programmer(Direct): j11 Higgsfield plugin

The plugin now supplies the server-side core for a Higgsfield image request:
reviewed price quote, exact effect/wire mapping, asynchronous provider job,
bounded Jini polling/recovery and a guarded media import reference with cost
provenance. An owner would connect by browser OAuth and use creative to see a
pending job followed by a media asset. The package remains disabled/unadmitted.
Host composition, current vendor acceptance, video and batches are deferred.

## CHANGED FILES

All changes are under `content/agent-plugins/higgsfield-media`:

- `plugin.json`, `mcp.json`: v1.1.0 portable HTTP declaration; OAuth/default discovery/
  spend hints confined to OM extension; no policy selection, API key or token.
- `io.github.ainsep.openmarketing/{capabilities,status-capability,quote-capability}.json`:
  host-unadmitted generation/status/local-quote envelopes. Host supplies byte/schema pins.
- Namespace `oauth-discovery.json`: historical OAuth/discovery/PKCE/DCR hints, marked
  unverified-current; no registration or device-flow fallback.
- Namespace `src/`: `types`, `schemas`, `results`, `pricing`, `effects`,
  `dispatch-evidence`, `provider-results`, `observations`, `adapter`, `bridge`, `index`.
- Namespace `tests/`: pricing/effects, vendor results, bridge, released Jini runtime,
  package/provenance, safety integration, federation integration and shared port suite;
  synthetic fixtures only.
- Namespace package/tsconfigs and retained `typecheck-output.txt`.
- `README.md`, `PROVENANCE.md`, `NOTICE`, skill/references and `progress-ledger.md`.
  Existing Apache-2.0 LICENSE is retained unchanged.

Local ignored `node_modules` links point only to already-installed published Jini
and public OM packages, for the single compiler attempt. They are a removable
tooling shim, not shipped source/dependency imports. No installation was run.

## TESTS — written, not run

| Written suite | Behavior |
| --- | --- |
| package.test.ts | Real manifest bytes through public plugin validator; closed server schema; namespace/policy rejection; provenance and agent-safe export |
| pricing-effects.test.ts | Known, expired and unknown evidence; account/model/schema/configuration/argument drift; rational credit conversion; effect category and exact wire mapping |
| provider-results.test.ts | Async handle, plan gate, multiple-job refusal, bounded delay, wrong job, structured import reference, failed charges, unsafe URLs and malformed/oversized metadata |
| bridge.test.ts | Inert factory, caller snapshot, render/argument/scope drift, credential header refusal, cancellation, timeout handoff, unknown/malformed output, secret-field stripping and no duplicate submission |
| runtime.test.ts | REAL released Jini start/poll/recover with fake host/media: pending→asset, attempt/deadline caps, crash gaps, revoked status, failure costs, repeated/conflicting charge observations |
| safety-integration.test.ts | REAL safety service consumes plugin evidence: under-allowance Always allow, over/unknown exact choices, owner-local timezone, denied unconfirmed/unbounded dispatch and a simulated authorized handoff |
| federation-integration.test.ts + contract/federation-suite.ts | ONE shared suite against a port double and REAL public federation host with fake transport; exact pins/arguments/trace IDs and current credential revocation |

No test, coverage, build, om:check or runtime self-validation commands were run,
as expressly required by the job. No suite is certified or reported green.

Exactly one compiler command ran:

```sh
node node_modules/typescript/bin/tsc --noEmit -p content/agent-plugins/higgsfield-media/io.github.ainsep.openmarketing/tsconfig.json
```

It exited **2** with ten diagnostics: four unexported RenderContext/RenderResult
imports and six ES2024 Promise.withResolvers lib diagnostics (five in the read-only
safety dependency). Output is preserved in namespace `typecheck-output.txt`.
The lane imports were corrected to types derived from Jini's PUBLIC adapter/outcome
contracts; the lane tsconfig now includes ES2024 lib. Those corrections and final
review changes were **not rechecked**, under the one-typecheck limit. No other job
was edited to address compiler output. The integrator must rerun typecheck.

## CONTRACTS

- Shared contracts and public feature contracts were read and left unchanged.
- Pure OM Money, Outcome, EffectEnvelope, GenerationCostQuote and context schemas
  are reused. Charging generation is `write` + `generation`, never ad_spend/read
  by plugin choice. Safety retains card/allowance/reservation authority.
- Generation effects use accountId/moneyExposure null, as required by safety;
  the separately pinned quote supplies the monetary bound.
- `createHiggsfieldDispatchEvidence` maps original creative intent digest to exact
  vendor argument digest, retaining original provenance and quote identity. Both
  the wire quote and safety generation request MUST use the wire digest at egress.
- Local structural ports: federation invocation, canonical argument digest,
  scoped job ownership, append-only charge observations, guarded media read,
  deadline runner, injected clock/IDs/observer. No credential/token port exists here.
- Charge observations include amount/currency, provider job, original operation,
  estimate/actual kind, quote/pricing provenance and explicit provider charge evidence.
  Stable identity retries deduplicate; changed actuals conflict instead of overwriting.
- Only one asynchronous image/job is supported. No second outbox, durable store,
  scheduler or MCP client was introduced. Jini owns polling/recovery mechanics.
- No migrations, commits or pushes.

## RISKS

1. Runtime/build/test evidence is unavailable by dispatch instruction. The sole
   compiler attempt failed and was corrected without rerun. This is not release-ready.
2. Provider schemas/OAuth behavior/model entitlement/CDN links require CURRENT
   approved non-spending acceptance evidence. The explicit actual-charge shape is
   synthetic; preflight `cost.credits_exact` is never treated as an actual bill.
3. Current inspected federation parsing accepts raw text content. Historical
   Higgsfield top-level resource_link output may need a server-only sanitized
   projection, or evidence that links arrive in structuredContent.resources.
   Unsupported output fails closed; no scraping or unsafe URL fallback exists.
4. Host callbacks must enforce bounded abort AND actual egress fencing, scoped
   durable row ownership, current admission/credential checks and safe media reads.
   The plugin cannot prove those callbacks honest from a TypeScript type.
5. An unknown quote has no fabricated upper bound; current safety may show exact
   spend choices but still refuse dispatch without defensible exposure. Unknown
   does not become free generation.
6. Estimates are appended while polling. For an accepted but never-polled job,
   the host costs projection must append the original estimate after the handle
   becomes durable. Timeout/cancellation do not release exposure or prove a refund.
7. Media MIME/DNS/redirect/completeness validation belongs to the injected server
   media adapter; this lane rechecks returned bytes/size, not real network delivery.
8. Video, batches, reference images, unlim, live non-spending quote preflight and
   actual-charge corrections/reconciliation are deferred.

## NEEDS

- Integrator: register/link this namespace package in the approved plugin build
  workflow and root dependency/workspace/lockfile ownership. Resolve declared
  `@jini-ai/integrations@0.4.2`, `zod@4.1.13`, TypeScript 5.9.3, Vitest 3.2.4,
  @types/node 24.10.1 and public OM workspace deps. No new library is needed beyond
  already-installed releases; verify npm publication when registry DNS is available.
- j10/host: admit package/current schema fingerprints; compose FederationHost,
  broker and safety's exact wire quote mapping; preserve the dispatch fence through
  awaitHandoff. Verify/add server-only resource-link projection as described above.
- j14: scope durable AsyncOperationStore and adapter/context lookup PER operation;
  wire Jini runtime/start/poll/recover with the existing jobs outbox. Resolve durable
  job ownership and append original estimates even if polling never starts.
- j14/media owner: retain ImportReference (provider job/operation/source URL) and
  full ChargeObservation provenance in durable storage. Current public creative
  GenerationCostObservation omits providerJobId/pricing/provider-charge IDs; either
  use an explicitly owned linked provenance store or propose **contract change**
  adding those fields. Do not silently discard them during adapter projection.
- Host/platform: implement real deadline, job ownership, observation and guarded
  media port adapters and run their shared suites. No production doubles.
- Owner/integrator: approved non-spending vendor acceptance before enablement.
- Integrator: rerun lane typecheck, written suites, matching build and required G
  gates/om:check after composition/dependency work. No live spend in automated tests.

## HANDOFF

Start with README.md's server composition steps. Public entry is namespace
`src/index.ts` / package export; feature core must consume only generic admitted
capabilities. All runtime dependencies/configuration stay on the server. Preserve
existing concurrent feature changes. The next owner is the plugin/host integrator,
then j10/j14 for protocol, safety, durable ownership and media/cost integration.

### Reuse and discovery

Reuse: async lifecycle; searched installed @jini-ai/integrations media-providers
dispatch exports/types/providers; inspected PollingVendorAdapter, AsyncOperationStore
and operation-runtime; used RELEASED 0.4.2 start/poll/recover rather than another
outbox/polling loop. Owner record: JOBS j14 and architecture §§6–7.

Reuse: MCP invocation; inspected installed @jini-ai/mcp@0.4.3 exports and OM's current
public federation transport/host; used the host invocation port, with no second
client or OAuth implementation. Owner record: architecture §§4.4–4.6 and COMMON.

Reuse: schema/value/policy boundary; inspected packages/contracts and public safety
schemas/service; used shared parseBoundary and DTOs plus host safety. Local Higgsfield
payload/pricing logic is separate because no installed vendor-specific binding was
found and architecture §6 assigns it to this plugin.

Guidance reuse is mapped in PROVENANCE.md. npm metadata requests for Jini packages
failed with ENOTFOUND; installed published artifacts were inspected. Graph tools
were not exposed; direct source/docs discovery was used. Project memory/ADR index
paths were absent; the direct dispatch supplied the binding architecture.

### Architecture audit and pre-completion

Manual source audit: **PASS for lane ownership/dependency boundaries**, with runtime
acceptance **INCONCLUSIVE**. Checked every changed source/config/test: public OM
imports only, public published Jini ABI, no sibling source, vendor logic/config only
in namespace, injected I/O/clock/IDs, no policy grant/config leak, pure quotes/effect
mapping, one durable async runtime/outbox, strict/bounded inputs and no service startup.
No structural violations were identified by manual review. Complexity/lint/build
gates were not executed; no numerical compliance is claimed.

Pre-completion: active job/COMMON/architecture and acceptance slices reread; one
fresh compiler attempt and retained output; final lane status/source inventory
reviewed. Existing tests were not removed/weakened. No outside files were edited.
Open validation/composition/vendor needs remain as listed above.

Self-validation: required for production integration, **not run** under explicit
job restriction. Attempts: 0. No self-validation report outside the lane was written.
Critical/edge flows have fixtures, not execution evidence. No live credentials,
vendor discovery/registration, spend or migration was attempted.

### Function quality and documentation

Every row below is **INCONCLUSIVE** for execution/coverage/mechanical evidence;
manual assessment found no outstanding required source refactor. Tests are direct
port/return assertions and can exercise the owned paths without combinatorial setup.
Coverage, cognitive/cyclomatic metrics and NLOC were not measured because suites
and repository gates were prohibited. No coverage exclusions/suppressions added.

| Assessment unit (tiny leaf helpers inherit named parent) | Disposition | Findings / local fix | Direct written evidence |
| --- | --- | --- | --- |
| matchesPricing | INCONCLUSIVE | Added original argument pin; prevents reuse across price-relevant arguments | pricing-effects |
| createHiggsfieldQuote | INCONCLUSIVE | Unknown/expired bounds remain null | pricing-effects, bridge |
| observedCreditCharge | INCONCLUSIVE | Fixed precision, round up; no expired rate | pricing-effects |
| bindHiggsfieldEffect / statusEffect | INCONCLUSIVE | Corrected generation account/exposure; no policy election | pricing-effects, safety-integration |
| createHiggsfieldDispatchEvidence / imageArguments | INCONCLUSIVE | Original/wire digest mapping explicit and parsed | pricing-effects, safety-integration |
| parseProviderJson | INCONCLUSIVE | Bound before allocation; sanitized errors | provider-results, runtime |
| pollDelay | INCONCLUSIVE | Finite fallback and 1–60s clamp | provider-results |
| parseVendorSubmission | INCONCLUSIVE | One job; plan/unknown refused without retry | provider-results, runtime |
| validateImportUrl | INCONCLUSIVE | Length/scheme/userinfo/local literals rejected | provider-results |
| parseVendorStatus / completedReference | INCONCLUSIVE | Explicit charge proof; structured link, wrong-job rejection | provider-results |
| createChargeObservation | INCONCLUSIVE | Stable identity, changing money conflicts | pricing-effects, runtime |
| recordCharges / appendObservation | INCONCLUSIVE | Charge before import, <=2 bounded appends; failure retains job | runtime |
| createHiggsfieldAdapter / wireRequest | INCONCLUSIVE | Released ABI; no submit idempotency or alternate flags | runtime, bridge |
| assertRenderContext / parseJobId | INCONCLUSIVE | Drift and credential-shaped resumption state rejected | bridge, runtime |
| pollResponse | INCONCLUSIVE | Failure charges survive, no asset/refund inference | runtime |
| boundedResponse | INCONCLUSIVE | Stream cap and sanitized foreign reader failure | runtime |
| readImage / assertImageBytes / extensionFor | INCONCLUSIVE | Server guard, 16MiB cap; real adapter still needed | runtime; host NEEDS |
| createHiggsfieldRuntimeBinding / higgsfieldToolName | INCONCLUSIVE | Inert snapshot, no duplicate submit; shared host suite | bridge, federation suite |
| snapshotDependencies | INCONCLUSIVE | Copy caller data; no post-confirm caller mutation | bridge |
| validateSnapshot | INCONCLUSIVE | Scope/quote/intent binding; unknown money rejected | bridge |
| validateKnownPrice | INCONCLUSIVE | Exact known amount/evidence pin | bridge, pricing-effects |
| parseWireRequest | INCONCLUSIVE | Closed body; credentials/foreign requests refused | bridge |
| executeWire / executeBoundedWire | INCONCLUSIVE | Ownership/admission moved inside total deadline | bridge, federation suite |
| validateWireIntent | INCONCLUSIVE | Exact reviewed args and scoped job ownership | bridge |
| invokeHost / observeCall | INCONCLUSIVE | Current host fences; redacted telemetry; observer non-authoritative | federation suite, runtime |
| decodeFederatedResult / projectPayload | INCONCLUSIVE | Ambiguity/unknown/secret fields refused or stripped | bridge |
| portBoundary / unwrap / failure / typed error constructor | INCONCLUSIVE | Opaque errors and foreign messages sanitized before Jini row | bridge, runtime |

Second-pass skepticism/variable audit: checked cost vs charge, original vs wire
digests, known vs expired money, job vs asset, observation identity vs amount,
clock/fence ordering, abort behavior, bounded metadata/bytes and row scope.
Identified and corrected the cost-inference, exposure-shape, deadline and argument-
evidence issues before handoff. No misleading variable name was retained.
Critical/High outstanding source findings identified by manual review: 0; this
is not mechanical or runtime evidence. Global routing remains INCONCLUSIVE.

Documentation: public functions/types/schemas and effects/invariants are documented;
README provides composition usage. Trivial leaf mapping constructors inherit parent
documentation intentionally. Foreign callbacks preserve public Jini/Promise ABIs
in narrow documented wrappers; other owned functions use object arguments.
No doc-lint was run. Source complexity comments specify bounded metadata/bytes,
constant append count, and delegated Jini lifecycle rather than metric scores.

Offload: namespace typecheck-output.txt. No retry loop, Loop Alert, out-of-lane
deviation or CIC deviation was triggered.
