Software Architect(Direct):

**1. Summary**

Remove all 24 server import cycles and the measure cycle through declaration moves and import changes. The owner will see identical tools, HTTP routes and behavior. Existing modules can own the shared declarations; no new ports, factories or registries are needed. `bootServer` stays untouched, preserving its complexity of exactly 10.

**2. Files**

- `apps/server/src/addons.ts` — (edit) own the existing `AgentPluginState` declaration outside composition.
- `apps/server/src/composition/agent-plugin-backends.ts` — (edit) import state and tool contracts from their leaf owners; preserve existing exports.
- `apps/server/src/composition/identity.ts` — (edit) import `AgentPluginState` from `addons.ts`.
- `apps/server/src/alerts/provider-settings.ts` — (edit) import `AgentPluginState` from `addons.ts`.
- `apps/server/src/om-tool-types.ts` — (edit) own the unchanged `toolPolicy` function; reference the relocated route table.
- `apps/server/src/om-tools.ts` — (edit) import/re-export `toolPolicy`; consume the relocated route table.
- `apps/server/src/inbound/integrations.ts` — (edit) import `OmTools` from `om-tool-types.ts`.
- `apps/server/src/owner-route-contracts.ts` — (new) own the existing route table and its response schemas.
- `apps/server/src/cli/http.ts` — (edit) consume/re-export that table; remove its direct leads import.
- `features/measure/src/types.ts` — (edit) own `dispatchRecordSchema` alongside its inferred type.
- `features/measure/src/rules.ts` — (edit) import/re-export that schema, removing the reverse dependency.

No adapters, fixtures, tests, manifests or package public indexes need edits. Existing import paths remain available through direct re-exports.

**3. Public contracts**

No package API, command, route, tool ID or data shape changes.

Relocated declarations retain their existing contracts:

- `toolPolicy(required: { effects: readonly string[] }): OmToolPolicy`
- `AgentPluginState` — unchanged lifecycle projection.
- `routes` — unchanged inferred, readonly route/schema table.
- `dispatchRecordSchema` — unchanged Zod schema.
- `ConversionDispatchRecord = z.infer<typeof dispatchRecordSchema>`

**4. Approach**

1. **Server cycles, major:** move `AgentPluginState` into existing `addons.ts`; redirect the identity and provider-settings imports that close cycles.
2. Move the existing classifier into `om-tool-types.ts`. Import both `toolPolicy` and `OmToolDefinition` there from the backend hub, eliminating its dependency on `om-tools.ts`.
3. Redirect inbound integrations’ `OmTools` type import to the same existing leaf.
4. **Measure cycle:** move `dispatchRecordSchema` into `types.ts`; retain its export from `rules.ts`. Keep schema construction and inferred types unchanged.
5. **CLI boundary:** relocate the complete existing route/schema table into `owner-route-contracts.ts`. CLI, tool contracts and tool definitions share that inert table.
6. Preserve existing injected callbacks and composition wiring. The verified cuts require no additional DI seam or `composition/index.ts` change.
7. Run `corepack pnpm om:boundaries`; require zero cycle findings in server/measure and removal of the CLI leads violation. Report unrelated failures separately.
8. Run once each: `corepack pnpm --filter @open-marketing/server typecheck` and `corepack pnpm --filter @open-marketing/measure typecheck`. One corrective rerun per package is allowed. Run no tests or builds locally.

**5. Reuse**

- Extend existing OM owners: `addons.ts`, `om-tool-types.ts`, and measure’s schema-bearing `types.ts`; move declarations rather than duplicate them.
- Reuse the existing route table, schemas, classifier and their test coverage unchanged.
- Reuse installed `dependency-cruiser@17.3.2` and `development/scripts/boundaries.mjs`; add no analyzer.
- Searched Tovu’s `apps/admin/src/integrations/jini-admin/forms-ports.ts` and Jini’s `packages/core/src/composition.ts` for composition patterns. Neither supplies OM’s declarations; no sibling code is copied or imported.
- Checked installed `@jini-ai/core@0.6.15-rc.2/dist/composition.d.ts`. Its daemon composition API is unnecessary for these import moves.
- Attempted npm registry verification; access failed. No dependency addition or upgrade is proposed.

**6. Deliberately left out**

- No broader hub split, new contracts package, generalized helpers or dependency container.
- No changes to retry policies, consent, approvals, dispatch ordering or vendor behavior.
- No new regression tests: this is structural simplification; existing assertions and imports survive.
- No cleanup of unrelated cycles, including `features/jobs`.
- **DEFERRED:** none within this job; all requested changes fit one implementation run.

**7. NEEDS**

- No installs, shared-contract changes, migrations or plugin rebuilds.
- Coordinator: lock the 11 listed files before implementation and provide the approved job directory for required progress bookkeeping.
- Cloud verification runs existing tests after integration.

**8. Unverified facts and risks**

Current static analysis reproduced all 25 targeted cycles. Simulating the proposed import cuts left zero server/measure cycles; this is planning evidence, not verification of implemented changes.

**DISPUTED direction only:** importing directly from `cli/http.ts` into `composition/` would itself violate `cli-shortcut` (`development/scripts/boundaries.mjs:67`). The app-owned route table satisfies the intended separation without weakening that rule.

No vendor APIs change. Existing fail-closed gates remain unchanged. Review must confirm identical schema definitions, table contents and classifier branches. Global boundaries may still fail on findings outside this lane.

**9. Size estimate**

One 60–90 minute implementation run: **11 source files, one new**, approximately **100–130 lines added and 90–120 removed**, mostly relocation; roughly **+10–20 net lines**. Tests: **0 files, 0 LOC**. This planning run made no edits and ran no tests, builds or typechecks.