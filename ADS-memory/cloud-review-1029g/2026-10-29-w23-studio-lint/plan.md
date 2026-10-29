Software Architect(Direct):

1. **Summary**

This job makes the genuine Studio lint fixes without changing displayed text, requests, approvals, or test expectations. It also removes filesystem access from the contracts test package while preserving the manifest assertions. Most chart findings appear to come from missing dependencies, so the plan avoids rewriting working chart callbacks. One build run covers the local fixes; the global lint target also requires the Coordinator actions below.

2. **Files**

- `apps/studio/src/shared/api/http.ts` — (edit) extract request-body encoding into one private helper.
- `apps/studio/tests/addons.test.ts` — (edit) calculate the OAuth status query before the route switch.
- `apps/studio/tests/leads.test.tsx` — (edit) import its fixture; move remaining nested callbacks to module scope.
- `apps/studio/tests/support/leads.ts` — (new) relocate the existing lead fixture and its data unchanged.
- `apps/studio/tests/shell.test.ts` — (edit) explicitly type the native CSS.escape shim.
- `apps/studio/tests/conversion-grants.test.ts` — (edit) schema-parse the unknown input before accessing `grantId`.
- `apps/studio/src/widgets/workspace-canvas/ui/AlertsFeed.tsx` — (edit) type `renderObservation` as its native array callback.
- `packages/contracts/tests/assistant.test.ts` — (edit) remove the filesystem import and relocate only the manifest integration test.
- `apps/studio/tests/model-manifests.test.ts` — (new) retain that integration test’s existing assertions.
- `apps/server/tests/integration-oauth-vendors.test.ts` — (edit) change the unused exchange argument from `unknown` to an object type.
- `apps/server/tests/integrations.test.ts` — (edit) make the same fixture-signature correction.

No chart source edits are planned pending dependency restoration.

3. **Public contracts**

- Unchanged: `createHttpStudioApi(required: Dependencies): StudioApiPort`.
- Private helper: `requestBody(required: { body?: unknown; rawBody?: Blob }): string | Blob | undefined`.
- Test support only: export the relocated `fixture(required: { items?: LeadDisplay[]; conflict?: boolean } = {})` and existing `unattributed` fixture.
- OAuth doubles retain `exchange(required: Record<string, unknown>, optional?: CallOptions)`.
- `renderObservation` uses `Parameters<string[]['map']>[0]`, the documented foreign-callback exception.
- No production exports, shared schemas, commands, or chart ABI changes.

4. **Approach**

1. After round 1029f merges, reread these files and skip already-resolved findings.
2. Extract only HTTP body encoding. Preserve raw-blob precedence, absent-body handling, JSON serialization, and its position inside the existing `try`.
3. Move the addons OAuth-status query expression outside the switch, reducing nesting without adding a helper or route registry.
4. Relocate the leads fixture into the existing test-support directory. Keep the TSX filename; use module-level callbacks for `waitFor` and malformed output.
5. Apply the existing typed foreign-callback pattern to `renderObservation` and CSS.escape. Keep their callers and rendered output unchanged.
6. Change only the two unused OAuth fixture parameter annotations; preserve transport behavior and optional signals.
7. Move the real-manifest test intact into Studio’s tests, using its existing native `FileURL` reading pattern. Keep pure schema tests in contracts.
8. Replace the unsafe grant-property access with schema parsing of the whole input using the picked grant-ID schema with unknown keys stripped.
9. Preserve existing behavioral assertions. These are refactorings and typing corrections; no additional behavioral test matrix is needed.
10. At the end, run `corepack pnpm om:lint` once and one serial package-scoped typecheck each for Studio, contracts, and server. Run no tests, builds, or `om:check`. Report remaining findings separately from provenance failures.

5. **Reuse**

- HTTP encoding: extend the existing expression in `shared/api/http.ts`; retain its injected fetch, deadlines, and outcomes. Existing `tests/http-api.test.ts` supplies behavioral coverage.
- Addons routing and leads fixtures: reuse their current implementations; introduce no replacement transport or fixture framework.
- Foreign callbacks: copy the typing pattern already used by `apps/studio/src/pages/measure/ui/MeasurePage.tsx:50`; retain the current lint rule.
- Manifest reading: reuse `apps/studio/tests/shell.test.ts`’s `readFileSync` plus native `FileURL` pattern. Reuse exported contracts schemas.
- Grant parsing: reuse `measurementGrantSchema`; add no handwritten input type.
- Published `@jini-ai/ui@0.6.15-rc.2` already provides `ChartRenderInput`, `ChartMountOptions`, and the object-shaped lifecycle ABI.
- Searched Tovu’s `apps/admin/src/lib/api.ts` and chart-provider integration; searched the current Jini clone’s admin transport and chart implementation. Their transports have different policies, so replacing OM’s transport would exceed this job. No sibling code or source-only API is needed.
- Registry verification was attempted but unavailable through browsing and local DNS. Installed declarations were inspected. No additional OSS dependency is proposed.

6. **Deliberately left out**

- No ports, registries, layers, configuration options, retries, or transport replacement.
- No TSX extension renaming, lint exceptions, or weakened assertions.
- No changes to approval, consent, money, vendor protocols, or server startup.
- **DEFERRED:** findings outside the permitted lane, including chart tests, other server tests, Google tests, and Higgsfield.
- No chart-loop rewrites merely to compensate for unresolved dependencies.

7. **NEEDS**

- `COORDINATOR: restore the chart plugins’ already-declared dependencies, including @jini-ai/ui@0.6.15-rc.2, echarts@6.1.0 and chart.js@4.6.1; no dependency installation by this job.`
- `COORDINATOR: rebuild both chart plugin artifacts and refresh their integrity metadata after dependency/source verification.`
- `COORDINATOR: assign remaining signature findings in apps/server/tests/consent-limit.test.ts:9 and apps/server/tests/om-tools.test.ts:668.`
- `COORDINATOR: assign Google test findings in campaign-deployment.test.ts:452 and read-capabilities.test.ts:341 under content/agent-plugins/google-ads/io.github.ainsep.openmarketing/tests/.`
- `COORDINATOR: verify the three chart-test findings after restoring dependencies; any surviving edits require a separate lane assignment.`
- `COORDINATOR: resolve the contracts generated-output provenance failures reported by om:lint.`
- Meta complexity belongs to the plugin job; Higgsfield remains excluded.
- No new dependency versions, shared-contract changes, or migrations requested.

8. **Unverified facts and risks**

- **DISPUTED as source defects:** the chart report includes already-object-shaped `mount`/`update` signatures and native callbacks: ECharts `provider.ts:75–147` and Chart.js `provider.ts:66–125`.
- Both plugin dependency directories are absent. Read-only module resolution confirmed that Jini chart imports and vendor imports fail.
- Read-only type inspection resolving the installed Jini declarations restored valid object types or native callback provenance for **16 of 19** chart-source findings. The remaining three depend on absent vendor declarations and remain unverified.
- **DESIGN NOTE:** repair dependency resolution before changing these callbacks; otherwise one environment problem would cause repeated unnecessary source edits.
- This lane cannot independently establish “zero rule findings outside Higgsfield” until the listed external findings are resolved.
- No vendor API behavior changes are planned. Existing typed failures and write safeguards remain unchanged.
- This planning run made no file edits and ran no tests, lint, builds, or package typechecks.

9. **Size estimate**

- **11 files:** 9 edits, 2 new test files.
- Approximately **+85 / −65 lines; net +20**, mostly relocated tests.
- Production: roughly 10 added lines across 2 files. Tests: roughly 140 added/removed/moved lines across 9 files.
- One build run: approximately **60–80 minutes**, excluding Coordinator dependency restoration and artifact rebuilds.