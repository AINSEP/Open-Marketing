# Programmer(Direct): j09 plugins

The feature validates plugin packages and coordinates their installation, explicit activation,
replacement and removal. For example, call `service.install({ context, source })`, then explicitly
call `service.setEnabled({ context, pluginId, enabled: true })`. Installation and enablement create
no write/spend authorization. Real v1.1 installation through Jini, app/HTTP/studio/CLI composition,
and SQL metadata are deferred as detailed below.

**CHANGED FILES**

- Core: src/service.ts (audit/cleanup ordering and identity checks), src/admission.ts (duplicates,
  deterministic pins), src/extension.ts (host-derived digest), src/memory.ts (schema-pin parity).
Portable inspector (validation/portable/extension/skills/package-types/admission) removed in OE-INSPECTOR 2026-10-28; installation validation is the server upload boundary + Jini lifecycle.
- README.md, PROGRESS.md, HANDOFF.md document usage, continuation, limitations and review needs.

**TESTS**

- Tests: written, not run. Includes valid/invalid v1.1; unknown/invalid extension and server handling;
  package/archive/disk escapes; links; repeated keys; observed/aggregate decompression limits;
  cancellation; schema/digest/identity drift; audited replacement; failed-disable cleanup;
  lifecycle unregister/dispose/running/pending behavior; sanitized agent instruction export.
- B1: shared suites instantiated for memory and filesystem repository, memory and disk/archive
  layout, memory and facade/published-Jini lifecycle, and memory/host provisioning/trust/audit.
  Observer has a memory suite; no independent real observer adapter was authored.
- `corepack pnpm --filter @open-marketing/plugins typecheck`: FAILED (exit 2). The production
  compiler reported only src/extension.ts:34 TS2322: the inherited local empty descriptor widened
  namespace to string. Added an explicit PluginExtensionDescriptor annotation afterward. Not
  rerun: the one-check allowance is exhausted. The `&&` command did not reach test-source checking.
- `git diff --check -- features/plugins`: passed before final handoff.
- `corepack pnpm --filter @open-marketing/plugins test`, builds, `corepack pnpm om:check`, gates,
  runtime self-validation and coverage: not run under the owner override. No passing counts,
  coverage percentage, lint/boundary result or executed RED/GREEN evidence is claimed.
- Regression evidence written before fixes: failed update audit preserves original bytes/bindings;
  failed disable persistence unregisters bindings; cross-plugin descriptors stop before effects.

**CONTRACTS**

- Authoritative PluginService, ports.ts and types.ts method/value contracts remain unchanged.
- index.ts adds the archive projection factory for the existing layout.readArchive seam.
- The continuation's auxiliary JiniPluginLifecycleApi type now derives from the installed public
  facade instead of accepting arbitrary Layout/Reader generics. Factory layout/reader arguments
  use Jini's actual public types; an optional observer object is added. Auxiliary consumer fixtures
  were adapted. No external lane/contracts/manifests changed.
- PluginServer aliases public `McpServerEntry` from @jini-ai/agent-plugins/manifest; OM's stricter
  v1.1/host input checks remain local because published parsing still selects v1.0.
- Package capability declarations may omit host-owned pluginDigest/admitted. Byte pins are derived
  from verified source bytes and author admission is false on output, avoiding self-referential
  archive hashes. Full returned CapabilityEnvelope stays unchanged. This does not trust source
  pins: trust/lifecycle/archive boundaries independently verify actual bytes.
- Bound capabilities support capability-envelope JSON declarations, not arbitrary executable
  vendor binding implementations; the server host owns executable admission and schema discovery.

**MIGRATIONS**

None authored or applied. Filesystem metadata is the durable adapter supplied here. A later SQL
adapter must use OM's DB ports and share the repository suite, with additive feature-owned SQL.

**RISKS**

- Runtime verification is pending; this is a partial integration handoff, not a release readiness
  claim. Mechanical complexity, nesting, signatures and boundaries await Coordinator checks.
- Jini 0.4.3 refuses v1.1 manifests. The real-Jini lifecycle B1 suite uses v1.0 only to cover physical
  behavior; a separate negative test covers the v1.1 incompatibility. OM validation remains v1.1.
- Source staging must be immutable across layout/trust/install. Native filesystem wrappers must
  enforce non-following/bounded reads and guard ancestor races; readArchive/readers must bound
  await duration/decompression buffers. The feature does not construct these app-owned effects.
- One service instance serializes operations per scope. Cross-process exclusion and excluding new
  jobs between idle-check/revocation/disposal belong to server-owned durable adapters/dispatch.
- A byte/digest fingerprint is catalog admission, not execution authority. Server provisioning
  must recheck current installed bytes/tool schema, revoke grants, and fail closed on errors.
- Partial installation, completion-audit failure, or metadata/cleanup failures require host
  reconciliation. They return explicit failures; no blind retry or rollback success is fabricated.
- Screened instructions exclude configuration and common credential syntax. Arbitrary secrets
  embedded in prose cannot be reliably inferred; only approved credential-free author text belongs
  in plugins. No server credential/config file is copied into the instruction view.
- Archive projection rejects noncanonical paths and links, and caps chunks at 65536 per file;
  codec wrappers should coalesce tiny chunks to stay within that bound.

**NEEDS**

- Upstream @jini-ai/agent-plugins lifecycle: published v1.1 schema support. Then the integrator must
  update features/plugins/package.json + root lockfile and run the real v1.1 installation suites.
  No package install/dependency change was performed.
- Server composition: immutable pinned source staging; bounded filesystem/archive effects; actual
  host trust; scoped audit append; federation registration/disposal/current-schema discovery;
  exact safety invalidation; authoritative running-job count; collision-free lowercase owner plus
  workspace Jini key. Wire caller-owned ports, never another feature's internals.
- Assigned app owners: plugin HTTP, studio and om CLI operations together. This lane is prohibited
  from editing apps and composition. No production dispatch claim is made without that wiring.
- Coordinator: combined tests, package build, lint/boundaries/om:check and runtime review.

**HANDOFF / AUDIT**

Architecture audit: WARNING for upstream v1.1 integration gap and pending mechanical/runtime
evidence; no known edited-file boundary violation. Checked scope ownership, public feature imports,
caller-owned ports, injected effects/time, inert factories, no policy imports, no vendor effects,
namespace, admission invalidation, running-job handling and instruction/server separation.
All changed production files and test fixtures were reviewed; external lane files were untouched.
The architecture's plugin-authority constraint still applies: changed bytes/schema lose prior
authority. No security/irreversible constraint deviation is claimed.

Pattern/style: preserved committed ports-and-adapters and Outcome conventions. Mutations are local
bounded inventories/registries or explicit injected effects. Foreign sort/map/refine/Vitest/native
callbacks retain documented library ABIs; owned functions use at most two object arguments.
Inline docs are interface/invariant/effect/resource contracts, not metric scores. No suppressions,
disabled rules, weakened certified tests or excluded source were added.

| Assessed units | Disposition | Findings / evidence | Local action |
| --- | --- | --- | --- |
| service verifySource, install, installVerified, setEnabled, disableCurrent | INCONCLUSIVE | Runtime evidence prohibited; order/identity regressions have direct tests | Audited retirement first; cleanup independent of persistence; validate identity |
| descriptorSchema (fingerprint and retired admission helpers removed in R3) | INCONCLUSIVE | Direct duplicate/drift/order tests written | Reject duplicates; deterministic sort; no execution grants |
| extension validateExtension, normalizeEnvelopes, resolveOne | INCONCLUSIVE | Byte pin must be host-derived; binding/identity tests written | Remove self-hash requirement; preserve closed declaration boundary |
| archive factory, collectArchive, collectEntry, readContent, checkChunk | INCONCLUSIVE | Limits/cancellation/aggregate tests written; host stream deadlines required | Bound inventory/bytes/chunks before next stream allocation |
| filesystem readDirectory, readChildren, readEntry, readRegularFile, contained | INCONCLUSIVE | Low:host-snapshot:ancestor races need immutable staging; direct disk tests written | Sequential bounded steps; lexical + disk containment |
| Jini factory/methods, observed, checkIdle, sourceBytes, isMissingPlugin, mapJiniFailure | INCONCLUSIVE | Upstream v1.1 absent; native B1/negative tests written | Exact public API/exception; no fake success; scope-safe host key; traces |
| validation inspectPluginPackage, collectFiles, collectEntry, inspectServers; inspectSkills | INCONCLUSIVE | Aggregate/format/kind/instruction tests written | Split bounded loops; explicit component errors |
| memory provisioning, real-adapter test fixtures and shared-suite extensions | INCONCLUSIVE | B1/cleanup evidence written; tests not executed | Schema pin parity; deterministic Jini effects; unfreeze only fixture trees |

Manual skepticism pass rechecked names (bytes versus digest, catalog admission versus authority,
observed versus declared sizes), error ordering, replay, scopes, duplicated capabilities and aggregate
limits. No unreported known High/Critical defect is claimed fixed by testing; all runtime conclusions
remain unverified. Coverage and NLOC/cyclomatic metrics were not measured due the verification ban.
No Loop Alert triggered. Required inputs were the direct dispatch/current contract; no certified
spec/test hash was supplied, so certification provenance was not invented.

Pre-completion: acceptance requirements reread; original tests retained/strengthened; scope checked;
fresh permitted evidence recorded above; open items explicit. Self-validation not run because
the owner prohibits test/build/runtime verification. Suggested next owner: Coordinator/integrator,
then published Jini lifecycle maintainer for v1.1 and the assigned app composition jobs.

Reference for retained portable grammar: [Agent Plugins v1.1.0](https://raw.githubusercontent.com/agentplugins/agent-plugins-spec/main/spec/1.1.0.md).
Installed @jini-ai/agent-plugins package.json, ./lifecycle .d.ts and its parser provide the 0.4.3 API
evidence; live npm metadata lookup failed (restricted shell DNS and web cache miss).
