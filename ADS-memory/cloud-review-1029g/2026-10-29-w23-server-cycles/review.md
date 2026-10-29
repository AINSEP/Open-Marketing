# Trim review: 2026-10-29-w23-server-cycles
VERDICT: APPROVED WITH CUTS

Checked against `cloud-round-1029e/out/cycles.json` (24 apps/server cycles, all with a runtime edge; `features/measure` cycle 53) and the current code. The cut set (`agent-plugin-backends→om-tools`, `identity→agent-plugin-backends`, `provider-settings→agent-plugin-backends`, `inbound/integrations→om-tools`) sits on every one of the 24 server cycles. I computed this from the JSON: no server cycle survives those four edge removals. The measure move is also sound: `rules.ts→types.ts` is the runtime edge and `types.ts→rules.ts` is type-only.

CUTS:
1. Drop the new `owner-route-contracts.ts` and the whole `routes` table move. No cycle needs it. `om-tool-types.ts:7` only type-imports `routes`, and `cli/http.ts` imports nothing back from it. It is a 60+ line relocation with a new file, and it reaches `inbound/owner.ts`, `composition/agent.ts`, `om-tool-coverage.ts` and `ports.ts` through re-exports. The boundary fix below is a few lines.
2. Drop `apps/server/src/om-tools.ts` as a body edit beyond deleting the `toolPolicy` definition and adding `export { toolPolicy } from './om-tool-types.js'` (keep the re-export: `composition/addon-federation.ts:13` and `om-tools.ts:346` use it). Do not touch anything else in that hub.

FIXES:
1. CLI boundary (`cli/http.ts:10`, rule `cli-shortcut` in `development/scripts/boundaries.mjs`): add a tiny leaf `apps/server/src/lead-route-schema.ts` containing only `export { leadSchema } from '@open-marketing/leads';`. `cli/http.ts` imports `leadSchema` from `../lead-route-schema.js`, and `routes.setLeadStage` stays byte-identical. The rule checks the resolved target, so the leaf passes. It is outside `/cli/` and `/composition/`, and the leaf is app code, not a feature. This replaces the plan's DISPUTED direction and its 60-line table move. Note: the plan says "11 files, one new"; it becomes ~10 files, one new, much smaller.
2. `toolPolicy` into `om-tool-types.ts`: it needs only the `OmToolPolicy` type already declared there (line 50). Add no new imports. Copy the body and its doc comment exactly, including `@complexity`.
3. `AgentPluginState` into `addons.ts`: keep the identical object type. In `agent-plugin-backends.ts` replace the declaration with `import type { AgentPluginState } from '../addons.js'` and `export type { AgentPluginState }`. This keeps the `composition/addons.ts:32` and `addon-federation.ts:15` imports working. Optionally repoint those two to `../addons.js`, but they are not needed for any cycle, so skip them to keep the diff small and the locks short.
4. `agent-plugin-backends.ts` still imports `formRetryPolicy` from `./forms.js` and `processingAllowed` from `./identity.js` (lines 27, 29). Those are runtime edges but are not in any remaining cycle after the cuts. Leave them. The `om:boundaries` check at the end is what proves this.
5. `features/measure`: move `dispatchRecordSchema` (rules.ts:28) to `types.ts`. First confirm every identifier the schema uses (`idSchema`, `digestSchema`, `epochSchema`, `appErrorSchema`, …) is already imported in `types.ts`; do not add imports from `rules.ts`. Keep `export { dispatchRecordSchema }` in `rules.ts` because `delivery/dispatcher.ts:6` imports it from there. `types.ts` imports `z` already.

REUSE: shared declarations → existing owners: `addons.ts` (AgentPluginState), `om-tool-types.ts` (toolPolicy, OmToolDefinition), measure `types.ts` (dispatchRecordSchema). Nothing new except the one-line leaf above. Jini/Tovu: none found. This is a structural import move, with no mechanism to reuse.

DUPLICATES: none found. The plan's own Tovu/Jini search found only composition patterns that do not apply. No new mechanism is added.

OVERLAP:
- With cloud round 1029f (`cloud/om-round-1029f`, diff against main): 1029f edits `apps/server/src/composition/agent-plugin-backends.ts`, `composition/identity.ts`, `inbound/integrations.ts`, `om-tool-types.ts` and `om-tools.ts`. These are 5 of this plan's files. The build starts after 1029f is merged and must re-read each of those 5 files first, and re-grep that every targeted edge still exists in `out/cycles.json` terms. If a 1029f change already removed an edge, skip that step and report DISPUTED. Do not revert 1029f's changes.
- With the other two plans: no file is edited by two plans. The studio plan edits `apps/server/tests/integrations.test.ts` and `integration-oauth-vendors.test.ts`; this plan edits no tests. Assigned to this job: all of `apps/server/src/**` and `features/measure/src/**`. Not shared.

OWNER DECISIONS (defaults): none. Type-only cycles are fixed only where the same move removes them.

APPROVED SCOPE for B1:
1. `addons.ts`: add `AgentPluginState`. `agent-plugin-backends.ts`, `identity.ts`, `alerts/provider-settings.ts`: import it from `addons.ts`.
2. `om-tool-types.ts`: add `toolPolicy`. `om-tools.ts`: delete the body and re-export from `om-tool-types.ts`. `agent-plugin-backends.ts`: import `toolPolicy` and the `OmToolDefinition` type from `om-tool-types.ts`. `inbound/integrations.ts`: import `OmTools` from `om-tool-types.ts`.
3. `features/measure/src/types.ts` + `rules.ts`: move `dispatchRecordSchema`.
4. New `apps/server/src/lead-route-schema.ts` + `cli/http.ts` import swap.
5. Verify once each, serially: `corepack pnpm om:boundaries` (server and measure no-cycles = 0, `cli/http.ts:10` gone), `corepack pnpm --filter @open-marketing/server typecheck`, `corepack pnpm --filter @open-marketing/measure typecheck`. No tests, builds or `om:check`. `bootServer` untouched, so its complexity stays at 10.

LOCKS-FILES: apps/server/src/addons.ts, apps/server/src/composition/agent-plugin-backends.ts, apps/server/src/composition/identity.ts, apps/server/src/alerts/provider-settings.ts, apps/server/src/om-tool-types.ts, apps/server/src/om-tools.ts, apps/server/src/inbound/integrations.ts, apps/server/src/cli/http.ts, apps/server/src/lead-route-schema.ts (new), features/measure/src/types.ts, features/measure/src/rules.ts (lock groups: w14-alerts, w13-server-composition, w15-backends, w13-om-tools, w14-surface, w20-measure)
