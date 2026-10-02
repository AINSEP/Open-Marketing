# j08 safety progress

Persona: Programmer loaded from AI-Dev-Shop/agents/programmer/skills.md.
Inputs: initial j00 index/types/ports; development/JOBS.md j08; development/COMMON.md; architecture v2 §§4.7, 5, 6, 9, 10; binding owner addendum from dispatch. No preserved safety source exists. No certified spec hash/test certification was supplied; the dispatched acceptance contract is the active spec. Direct dispatch permits work without missing pipeline artifacts.

Current objective: final verification and Coordinator handoff. Implementation and shared memory/SQLite suites are complete in this lane. Remaining external composition is listed in HANDOFF.md.

Pattern priming: adopted the already authorized j00 object-signature factory/ports as the seed, using injected effect boundaries and pure decisions. No new human approval was needed for the explicitly dispatched implementation. Required side-effect paths have trace-bearing audits/journals/observer events.

ADR/checklist: edit only features/safety; no other feature internals, sibling source imports, platform/driver construction, live vendors or migrations; published public contracts only; explicit clock/IDs/config; exact approvals; separate cap evidence; account barrier through transport; closed backend stop path; atomic generation reservations; immutable values; append-only observations/corrections; scope/implementation/policy binding; owned signatures <=2 object parameters; cognitive <=10 and nesting <=3; no TSX functions. Memory and SQLite share the repository and service acceptance suites.

Design/test seams: service through injected ports, repo through shared atomic state store; exact value outbound capture; deterministic lock barriers; injected clock around local midnight/DST/settings changes; fault injection at SQL journal append and observers; property-based concurrent sums. Payload <=64 KiB, arguments depth <=16, state <=4 MiB, journal <=10,000, lock queue <=100/key. No remote transport or polling is built in this feature.

Binding constraints confirmed: §10 confirmation binding, exact authority, financial admission, halt barrier, stop-only permit, atomic generation allowance and append-only cost settlement. No security/irreversible deviation from these constraints. Compatibility query port and snapshot table organization are documented removable seams, consistent with owner permission to reorganize unapplied schemas.

RED/GREEN: initial halt/read-policy/lock acceptance failed against j00 stubs then passed; future matching generation grant test failed then passed; authority expiry during storage failed then passed; duplicate settlement journal evidence failed then passed; service run ID forwarding failed then passed; SQL observer exception failed then passed; contradictory owner scope and quote bindings/bounds failed then passed. No certified tests were removed or weakened. The j00 absence suite was extended into behavioral B1 acceptance as requested.

Loop Alert (bootstrap only): package test entry resolution failed repeatedly while j00 had no contracts build. The types-condition approach did not resolve the import and SSR types conditions leaked into third-party .d.ts exports. A temporary test-only mapping to the shared package's declared public source entry allowed initial RED. It was removed after j00 built contracts. Final tests use ordinary package public exports. Corepack uses /private/tmp/om-corepack because its default cache is outside the writable sandbox. No tool/root files were changed.

Owner addendum (binding): local-owner midnight; timezone stored and edits deferred to next rollover; never-applied preserved schema can be reorganized; SQLite/better-sqlite3 behind an injected db-shaped shim; desktop default local sandbox; no production local ad writes; no live migration/spend; no commit/push; eleven concurrent lanes untouched.

## Full OM engineering contract (restated)

OM ENGINEERING CONTRACT

1. Feature slices live in top-level features/<name> workspace packages.
   External imports use ONLY @open-marketing/<name>, resolving to index.ts.
   No relative-to-index, alias, deep, dynamic, test or type-only bypass.
   Default feature-to-feature dependency is none; use caller-owned ports.
   Only safety and measure may import canonical policy gates.
   Relocation changes a folder and workspace glob, never consumer imports.

2. Replaceability is the primary architecture constraint.
   Keep core independent of vendor, driver, framework and transport.
   Preserve approved public contracts and mechanical replacement seams.

3. Inject all I/O and app-specific configuration:
   DB, fetch, clock, filesystem, MCP, secrets, logger, IDs and processes.
   One composition root per app; modules never construct dependencies.
   No hidden singleton or global runtime registry.
   Registry instances support unregister/reset/dispose.

4. Owned functions/factories/methods have at most two object parameters:
   fn(requiredArgsObject, optionalArgsObject?).
   Required dependencies/config belong in the first object.
   Foreign callback ABIs use narrow documented, tested wrappers.

5. Cognitive complexity <=10 and max nesting depth <=3 are ERRORS.
   sonarjs/cognitive-complexity is configured at 10.
   All first-party .ts/.tsx/.mts/.cts/.js/.jsx/.mjs/.cjs are covered.
   Cyclomatic complexity and NLOC are measured/reported, NEVER gated.
   A 14-arm exhaustive discriminated-union switch with never default passes.
   No warning downgrade, inline disable, extension escape or hidden source.

6. Separate decisions from effects; fail closed on irreversible actions.
   Module-boundary failures are explicit typed values.
   B1: every port's in-memory double and real adapter pass ONE shared suite.
   Tests live in module-level tests/, outside src/.
   Bug fixes require demonstrated red/green regression evidence.

7. React rule: no functions in .tsx component bodies.
   Inline JSX arrows, nested callbacks and effect functions count.
   Extract handlers/effects/derived logic into hooks/rules modules.
   Canonical rule: AI-Dev-Shop/framework/operations/react-skill-operations.md.

8. Library-first, simplicity and rule-of-two.
   No speculative abstraction or framework.
   Name a real second consumer or concrete replacement/test adapter.

9. Parse at boundaries.
   B3: schema-validate HTTP, MCP results, manifests, CLI and environment.
   Third-party output is tainted until validated.
   Bound inputs, batches, payloads, timeouts, retries and buffers.

10. One server-owned external-tool policy.
    Admitted read-only calls run; other calls use the generic exact card.
    Ad spend: exact confirmation for EVERY call, no budget envelope,
    no reallocation authority, no Always allow or chat-wide spend waiver.
    Destructive calls retain exact confirmation.
    Generation within the daily allowance uses normal write grants,
    including Always allow; default allowance is $10/day.
    Over-allowance or unknown-cost generation needs explicit spend approval,
    with no Always allow or chat-wide waiver.
    Halt allows only typed backend pause/stop calls after local halt.
    Conversions are typed server jobs under a narrow measurement grant,
    with dispatch-time consent recheck and egress audit.
    Plugins cannot weaken policy. Every dispatch rechecks current authority.

11. Server owns vendor credentials, plugin/MCP configuration, safety,
    database and durable workers.
    Agent is a separate process; it talks only to server OM MCP/HTTP.
    No vendor credential/config, product DB, direct vendor egress,
    unrestricted shell or vendor tool exists in the agent.
    Production ad writes/conversions require always-on server.
    Desktop-only/local ad-account mode is sandbox or read-only.
    Vendor SDKs/codecs/OAuth/MCP/backend code stay in their Agent Plugin.
    Extension namespace: io.github.ainsep.openmarketing.

12. B2: external writes use stable idempotency keys and ONE jobs outbox.
    Domain intent and enqueue commit atomically.
    Unknown non-idempotent outcomes reconcile; never blindly retry.
    B4: irreversible actions fail closed; errors are explicit boundary values.
    B5: ledgers and audit append; corrections append linked records.
    B6: one composition root per app; no dependency construction in modules.
    B7: injected clock; no hidden time reads.
    B8: propagate run/correlation/trace IDs through logs, jobs and egress.

DELIVERY
- Use Codex gpt-6.1-sol, high reasoning.
- Start from the preserve-only OM tree; no Open Design compatibility runtime.
- Preserve unrelated dirty/untracked work; do not reset it.
- Read OM/Tovu/Jini as needed; no sibling source dependency.
- Jini registry releases or documented removable local shims only.
- Root manifests, lockfile, contracts and composition have one integrator.
- Never edit another active job's files; report NEEDS.
- Never apply a live migration without its explicitly assigned operation.
- Run corepack pnpm om:check and matching package tests/builds/contracts.
- User-facing capabilities close HTTP + studio + om CLI together.
- No live spend/destructive provider effect/live migration in automated tests.
- Report CHANGED FILES, TESTS, CONTRACTS, MIGRATIONS, RISKS, NEEDS, HANDOFF.

Final evidence: 123 tests PASS across memory/SQLite; typecheck/build PASS; own ESLint zero errors/warnings; boundaries and 73 gate tests PASS; metrics cognitive max 8/nesting 2. Coverage: statements/functions 100%, branches 84.08%. `om:check` remains externally blocked by media-library receipts and studio output provenance; root typecheck reports media-library's unfinished methods. Exact errors, contract additions, integration NEEDS and product-runtime PARTIAL status are in HANDOFF.md. No remaining implementation work inside the current lane is planned; next owner is Coordinator/Code Inspection and the server integrator.
