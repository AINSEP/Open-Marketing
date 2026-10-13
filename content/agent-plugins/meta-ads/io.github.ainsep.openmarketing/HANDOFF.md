# j13 handoff — Programmer(Direct)

The owner gets a disabled Meta plugin with server-side campaign/report/conversion building blocks. Once verified and wired by the server integrator, these produce PAUSED creation payloads, exact single-entity activation, complete hierarchy readback, cautious cap evidence, pause-only halt payloads, consent-bound signup/trial CAPI payloads and currency/timezone-bound spend snapshots. Unknown writes never trigger an internal retry.

**Delivery status: PARTIAL / unavailable for production.** Actual hosted tool schemas and behavior remain unverified. Full campaign-plan/creative composition, OAuth, real credentialed egress, a bundled write-server fallback and final host integration are deferred. No provider calls, credentials, spend, installs, builds, migrations, commits or pushes were performed.

## CHANGED FILES

All changes are within `content/agent-plugins/meta-ads`:

- `plugin.json`, `io.github.ainsep.openmarketing/capabilities.json`: six proposed generic capability envelopes, all disabled/unadmitted. Portable `mcp.json` remains unchanged and empty.
- `package.json`, `tsconfig.json`: isolated plugin tooling; root workspace/manifests/lockfile untouched. A build recipe bundles the namespace entry and pure runtime dependencies; no build artifact was generated.
- `io.github.ainsep.openmarketing/src/{index,boundary,commands,ports,evidence,adapter,account,readback,stop,capi-normalization,capi,reporting}.ts`: strict codecs, host seams, evidence pins, unknown outcomes and typed backend delivery.
- `io.github.ainsep.openmarketing/tests/{fixtures,boundary.test,codecs.test,capi-fixtures,capi.test,reporting.test,manifests.test}.ts`, `tests/contract/{gateway-suite,gateway.test,portable-suite}.ts`: hand-written fixtures, shared hosted/direct suites and an injectable shared host-validator suite.
- `io.github.ainsep.openmarketing/evidence/{README.md,actual-tools-list.json,primary-sources.json,proposed-bindings.json}`: accessible primary evidence and explicit unavailable facts.
- `README.md`, `NOTICE`, `skills/meta-ads/SKILL.md`, `skills/meta-ads/references/README.md`, this handoff and `progress-ledger.md`: adoption, user instructions and resumable status.

## TESTS — written, not run

No test suites, om:check, builds or installs were run, as directed. No coverage percentage or red/green claim is available. No certified tests were removed or weakened; none were supplied for this new lane implementation.

Exactly one typecheck was run:

```text
./node_modules/.bin/tsc --noEmit -p content/agent-plugins/meta-ads/tsconfig.json
exit 2
tests/codecs.test.ts(82,131): TS2345
Vitest table callback expected one effects array, but array rows spread into one/two arguments.
```

The fixture was corrected to object rows `{ effects: [...] }`. The original run had no production-source diagnostics. During the subsequent manual audit, configured/effective status and cap-currency checks were also tightened. **The corrected final tree has not been typechecked again**, honoring the single-run limit. Integrator must typecheck it afresh; no passing-typecheck claim is made.

Written cases cover primary/schema/scope/digest/expiry drift, unsupported fields/controls, explicit PAUSED creation, exact activation, uncertain transport/ACK outcomes, complete/incomplete/mixed/duplicate/foreign hierarchy readback, inconsistent ACTIVE effective state, cumulative caps versus daily averages, current account-currency evidence, stop-only effects and inflated/changed/expired permits, CAPI hashing/normalization, stable event identity, current consent/fence denial, production mode, grant pins, age boundaries, invalid whole payloads, no resend on reconciliation, config mutation, inclusive dates/half-open windows/DST, decimal precision/overflow, mixed currencies and restatement lineage.

The portable suite deliberately receives `@open-marketing/plugins.inspectPluginPackage` from the host harness. It has not been instantiated here; standalone manifest fixtures use actual package files/shared capability schemas. Shared gateway cases instantiate both the direct double and the hosted wrapper, with a local injected host fixture. These do not establish live Meta behavior or a real HTTP credentialed CAPI adapter.

## CONTRACTS

No shared contract or feature file changed. Runtime/type imports are only public `@open-marketing/contracts`, Zod and Node standard library, plus lane-local modules. No sibling source or feature-private import exists.

- `MetaGatewayPort` requires a current exact authority/effect/admission/account/halt check at egress, bounded timeout/buffers and stable jobs identity. Hosted calls structurally match public federation calls. The host resolves effects from its trusted catalog; the wrapper's locally built envelope never overrides host policy.
- Host evidence is trusted server state, not a boolean or schema an agent supplies. It binds scope/connection/account/plugin, actual tools/list/schema capture, verified operation claims, primary source and expiry. Portable declarations remain inert.
- `MetaCapiBackend` structurally fits public measure delivery; a durable delivery ID is mandatory at its boundary even though the public seam permits omission. The authority port checks CURRENT grant, all identifier-key consent, scope/dataset/version/capability and audit; guarded egress checks the fence again after credential resolution. Jobs/measure own dedupe and the single outbox.
- `MetaSpendSnapshot` structurally fits public measure snapshots. `MetaLimitReadback` preserves vendor semantics and cannot be presented directly as hard daily `PlatformLimitEvidence`. The owner must supply independently verified eligible limit evidence or safety denies.
- `mapMetaHaltStop` matches safety's digest of `{ adAccountId, entityIds, action }`, rejects non-stop effects and produces only PAUSED payloads. Server owns actual typed backend dispatch and current halt/entity checks.

Reuse: inspected installed registry artifacts `@jini-ai/mcp@0.4.3` and `@jini-ai/integrations@0.4.2`; no Meta-specific codec/backend was found in inspected entries. j10's public host seam reuses its Jini transport. Shared schemas, Zod and Node crypto are called directly. `npm view @jini-ai/mcp` failed ENOTFOUND, and registry web access failed; no current-release claim is made. No new npm dependency is needed beyond versions already present in OM tooling.

## RISKS / architecture audit

**Architecture audit: WARNING — integration/evidence/validation incomplete.** All changed lane source/config/docs were manually audited against COMMON and architecture §§5–6: lane-only ownership, public imports, injected ports/clock/observer, no services on import, pure decisions separated from egress, strict boundary parsing, exact per-call spend, typed halt/conversion paths, no retry/outbox duplication, no credential leakage, namespace isolation and disabled admission. No known cross-lane ownership/dependency violation was found. Mechanical lint/complexity/build/coverage gates were not run, so gate G is not asserted.

Primary Meta MCP documentation was inaccessible. The actual tool capture file has null schemas; candidate payloads and normalized outputs may need adaptation before admission. All test evidence is fabricated and labeled accordingly. CAPI's pinned fixture version is illustrative, not a verified current production version. The seven-day event bound is conservative OM policy, not proof of current Meta limits. Per-event CAPI reconciliation remains unknown. A server implementation that violates its injected port/fence/timeout contract would defeat guarantees; it must pass the host's actual adapter suites before use.

Function-quality and coverage self-check (reviewed directly, not a measured gate):

| Assessment units | Disposition | Findings / local action | Direct written evidence |
| --- | --- | --- | --- |
| failure/parse/digest/canonical/boundedJson/isUncertainFailure | ADVISORY | Medium:resource-bound — object serialization occurs after host wire-size enforcement; host must bound bytes before allocating objects. Cyclic/oversized values reject. | boundary.test, gateway-suite |
| encodeCommand/encoded and schemas | NO_RECORDED_FINDINGS | Closed commands, exhaustive switch, explicit PAUSED and string minor units; no arbitrary mutation. | codecs.test, gateway-suite |
| verifyBinding/matchesRequest/unavailable evidence | NO_RECORDED_FINDINGS | Trust is caller-owned server evidence; all local pins/claims/expiry checked before handoff. | boundary.test, gateway-suite |
| adapter factory/prepare/prepareCall/dispatch/decodeResponse/decodeFailure/extractData/uncertainty/observe/hosted wrapper | NO_RECORDED_FINDINGS | One egress; valid preflight denials preserve failure and post-handoff loss stays unknown; no raw telemetry. | shared gateway-suite |
| account metadata/hierarchy/state/aggregation/limit/readback | FIXED | High:state-inference — inconsistent effective ACTIVE now stays unknown. Medium:currency-evidence — limits now require current account metadata. Low:complexity — Set membership replaces quadratic expected-ID lookup. | codecs.test, reporting.test |
| mapMetaHaltStop/stopEffectMatches | NO_RECORDED_FINDINGS | Full typed request/envelope/digest checks, bounded distinct IDs, no money or activation payload. | codecs.test |
| identifier normalization/buildUserData/hash/match helpers | NO_RECORDED_FINDINGS | Supported fields only; no implicit subject export, no double SHA-256, raw consent-visible values preserved for authority before normalization. | capi.test |
| CAPI factory/preparation/grant matching/fenced dispatch/send/failure/ACK/observation | FIXED | High:config-race — factory snapshots scalar configuration before awaiting authority. Unknown send never retries. | capi.test |
| report snapshot/binding/local-time/row matching/decimal conversion | NO_RECORDED_FINDINGS | Account/exponent/timezone/date binding, one account total, safe integer money, immutable lineage; no platform attribution aggregation. | reporting.test |
| test table fixture | FIXED, UNRECHECKED | TS2345 and wrong runtime table shape corrected to named rows; no further typecheck/test allowed. | single compiler diagnostic above |

Scale: inputs/results/evidence have explicit byte/count limits; hierarchy/stop batches <=100, reporting one total row and <=366-day query, CAPI one event. Public boundaries and meaningful local rules carry inline documentation and complexity notes. Foreign array/Promise/Vitest callback ABIs retain their required callback shape. Final variable-name review checked amountMinor versus average/cumulative semantics, configured/effective state, received ACK versus observed outcome, occurredAt versus injected time, and inclusive versus half-open windows. No numerical complexity/NLOC or coverage result is asserted.

## NEEDS

1. Owner/integrator obtains actual authenticated tools/list and primary behavior evidence for the approved connection/account. Keep all hosted writes unavailable until this is captured and validated. Verify actual tool names/arguments/output, auth, PAUSED creation, activation, budget/cap units and report shape; candidates are not certification.
2. j01/j10 wire trusted current evidence, bounded local JSON-schema validation, federation catalog/effects, exact authority/jobs/halt, audited credentialed CAPI egress and current consent fence. Verify pinned Graph version and dataset permissions. Do not turn desktop sandbox into production mode.
3. Integrator adapts full generic campaign-plan/creative mapping and normalized readback/report payloads to the actual vendor schema. Unsupported daily hard-limit/account-cap controls remain denied. Decide whether to implement the owner-accepted fallback after hosted assessment; no fallback implemented here.
4. Instantiate the exported portable suite with j09's public inspector and run existing root Vitest against the lane, fresh lane typecheck/build, shared real transport/egress suites, then om:check. The lane is outside the root workspace glob; handle packaging/composition in the integrator lane. No root or lockfile edit requested from j13 and no install command was run.

## HANDOFF / pre-completion

Next route: owner/integrator → evidence verification → j09/j10 host fixtures → j01 composition and generic campaign/measure adapters → independent inspection and TestRunner. This is a reviewable partial implementation, not an operational vendor capability.

Requirements and evidence limits were re-read. The single compiler output is retained above. Scope was confirmed with lane-scoped git status/diff inspection. `git diff --check -- content/agent-plugins/meta-ads` was run; it reported no tracked whitespace errors (untracked file contents were manually reviewed). No existing test was deleted or weakened. No migrations are present. Runtime self-validation was **not run**, because this dispatch forbids tests/builds/live vendor calls and the plugin has no admitted capability/host composition. No green/runtime-ready claim is made. No retry loop was triggered.
