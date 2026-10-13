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
    Owner-approved amendment (2026-10-12): bounded unattended workflows
    (journeys, broadcasts, audience syncs, offline imports) run under a
    ServiceGrant approved ONCE on an exact versioned definition with caps.
    Consent and caps are rechecked at EVERY dispatch. Ad spend remains
    exact confirmation per call. Paid-sending (for example SMS) has a
    default allowance of $5/day through safety's allowance mechanism.

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
