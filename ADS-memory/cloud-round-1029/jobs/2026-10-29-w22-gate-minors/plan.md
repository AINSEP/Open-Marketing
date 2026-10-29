Software Architect(Direct): Persona loaded from `AI-Dev-Shop/agents/software-architect/skills.md`.

**1. Summary**

One build run will address the confirmed small findings, starting with preventing a claim handler’s null result from triggering another dispatch. Owners will regain tag-free tracking snippets when plugin backends are absent, and coverage metadata will correctly identify the Studio lead inbox. The remaining changes reuse existing schemas, tests, SQL and publication outcomes. The stale LinkedIn finding is disputed; the weekly permanent-error notice is deferred because it needs coordinated display changes.

**2. Files**

All paths below are edits unless marked new. Caller/type files marked NEEDS require explicit lane approval before item 2 proceeds.

- `features/jobs/src/handlers.ts` — wrap successful claim-handler diagnostics as `{ settled }`.
- `features/jobs/src/ports.ts` — distinguish claim-handler presence from its nullable diagnostic. **NEEDS**
- `features/jobs/src/service.ts` — adapt claim ownership to durable-state readback. **NEEDS**
- `features/jobs/src/types.ts` — type the outbox claim-result envelope. **NEEDS**
- `features/jobs/src/outbox.ts` — unwrap owned results; only absence selects ordinary dispatch.
- `features/jobs/tests/contract/service-suite.ts` — real-registry null-result regression over memory and SQL repositories.
- `features/jobs/tests/outbox.test.ts` — adjust envelope fixtures; retain fallback and failure assertions.
- `apps/server/tests/agent-plugin-backends.test.ts` — mixed read/write validator regression.
- `features/safety/src/paid-sending.ts` — rename the operation-name parameter.
- `features/brand/index.ts` — export existing revision-number schemas.
- `apps/server/src/om-tools.ts` — consume those schemas.
- `apps/server/src/om-tool-coverage.ts` — identify the two lead tools’ Activity inbox coverage.
- `apps/server/tests/om-tools.test.ts` — coverage-label assertions.
- `apps/server/src/alerts/rules.ts` — deterministic string tie-break.
- `apps/server/src/alerts/index.ts` — remove three unused weekly exports.
- `apps/server/tests/weekly-report.test.ts` — mixed-case ID ordering regression.
- `apps/server/src/composition/tracking.ts` — require plugin backends only when campaign tags are requested.
- `apps/server/src/composition/identity.ts` — derive allowed properties from the existing schema.
- `apps/server/tests/p1-tracking.test.ts` — tag-free success and tagged missing-host refusal.
- `content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/src/posts.ts` — observe publication status/error code.
- `content/agent-plugins/google-business-profile/plugin.json` — refresh the changed source fingerprint.
- `content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/capabilities.json` — matching fingerprint.
- `content/agent-plugins/google-business-profile/io.github.ainsep.openmarketing/tests/capabilities.test.ts` — update and extend outcome assertions.
- `apps/server/src/alerts/provider-settings.ts` — reuse one SQL statement literal.
- `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-gate-minors/progress.md` **(new)** — implementation progress and verification record.

**3. Public contracts**

- Export existing `revisionNumberSchema` and `expectedRevisionSchema` through `@open-marketing/brand`; no new schemas.
- Narrow existing `JobDispatchPort.dispatchClaim(required: ClaimedJob, optional?: CallOptions)` to `Promise<Outcome<{ settled: unknown } | null>>`.
- Existing `OutboxPorts.dispatchClaim(required: { job: OutboxJob; signal?: AbortSignalPort })` returns `Promise<{ settled: ProcessResult } | null>`.
- `JobHandler.handleClaim` remains unchanged. Its returned diagnostic never determines persisted completion.
- No new commands, HTTP routes, factories, ports or named interfaces.

**4. Approach**

1. **Claim ownership first:** wrap successful handler diagnostics, including null. The service retains one durable readback and wraps its resulting `ProcessResult`; the outbox unwraps it. Null means no claim handler. Errors/throws never select ordinary dispatch.
2. Extend the existing shared service suite with a real registry whose claim handler acts and returns `{ ok: true, value: null }`. Assert one claim invocation, zero ordinary handler calls and no extra dispatch/completion. Preserve durable-state and unresolved-state behavior.
3. Parameterize the existing validator test with an admitted `effects: ['read', 'write']` row. Require `forbidden`, zero fetches and zero credential accesses. Production refusal already exists; change only the test.
4. Change the tracking host guard to apply only when `campaignKeys` is nonempty. Test absent and empty keys succeeding without a host, and tagged requests refusing before I/O. Derive identity’s property allowlist using `Object.keys(landingPropertiesSchema.shape)`; retain its subject restriction.
5. Export/import the two existing brand revision schemas, preserving the tool’s existing 60 KiB kit limit. Add the Activity inbox coverage label only for `om_leads_list` and `om_leads_set_stage`.
6. Replace `localeCompare` with direct string comparison, returning zero for equal IDs. Add a tied-spend `Z`/`a` regression. Delete only the unused weekly barrel exports.
7. Report GBP `result.value.status` on success and `result.error.code` on failure. Extend existing receipt/error cases, update the real-factory expectation to `"published"` and recompute both fingerprint rows.
8. Rename only `admitted`’s string parameter `write` to `operation`; preserve boolean storage-write flags. Leave `reserve` alone. Reuse one local SQL text constant for the existing provider-settings writes, preserving transaction and omitted/null semantics.
9. Write tests without running them. At the end, run each changed package’s typecheck once, sequentially: jobs, safety, brand, server and GBP; one corrective rerun per failing package is allowed. No tests, builds, `om:check`, installs or live calls.

**5. Reuse**

- Claim handling: extend `handlers.ts:89`, `service.ts:68` and `outbox.ts:56`; use `tests/contract/service-suite.ts` and existing outbox doubles.
- Validator protection: extend `agent-plugin-backends.test.ts:862`; retain the server’s existing read-only effect check.
- Tracking: reuse `webEventInstallSource`, public `landingPropertiesSchema` and `p1-tracking.test.ts`; no snippet mechanism changes.
- Brand: reuse `features/brand/src/schemas.ts:7-8`; remove duplicate numeric declarations.
- Alerts: extend `weeklyReportCandidate` and its existing fixture builders.
- GBP: extend the existing real-factory and receipt-mapping tests; no transport or credential parsing changes.
- Settings: retain `putMailProviderSettings` and its existing transactional writes/tests.
- Sibling search covered Jini/Tovu claim handlers, outboxes, weekly reporting, tracking schemas and settings patterns. Tovu’s `contracts/core/events/jini-outbox-adapter.ts` uses Jini’s event outbox; it has no matching OM claim-handler diagnostic seam.
- Verified installed `@jini-ai/cms@0.6.15-rc.2` outbox declarations and `@jini-ai/platform@0.6.15-rc.2` mail exports. Neither replaces these local corrections. No additional OSS dependency is warranted.
- npm registry checks were attempted through shell and web access but failed; no registry publication claim is made.

**6. Deliberately left out**

- **DISPUTED item 9:** the cited LinkedIn imports are used: `LinkedInInvocation` at lines 252/291 and `dispatchSuite` at line 7. No LinkedIn edit.
- **DEFERRED item 6, permanent weekly read failure:** `alerts/jobs.ts:78` still returns before notice creation. The existing report schema and Studio projection have no explicit unavailable-report state. Relabeling the error merely changes retry classification; it does not show owners the missing week. Defer this tail rather than invent report facts or expand this lane into Studio.
- No `reserve` refactor, outbox replacement, observability plumbing, new retry behavior, collector URL changes or unrelated cleanup.

**7. NEEDS**

- `LANE EXTENSION: features/jobs/src/ports.ts, features/jobs/src/service.ts, features/jobs/src/types.ts — required caller/type changes for item 2; lock with handlers.ts and outbox.ts.`
- `COORDINATOR: rebuild the google-business-profile plugin dist after source and fingerprint changes.`
- `FOLLOW-UP: permanent weekly read failures need an unavailable-report representation through server alerts + Studio, with HTTP/om-tool/CLI visibility preserved.`
- No installs, package manifests, lockfile changes, migrations or `packages/contracts` changes.

**8. Unverified facts and risks**

- No vendor API behavior changes are proposed; vendor documentation was not revalidated.
- Registry availability remains unverified. Installed rc.2 declarations are the reuse evidence.
- Claim diagnostics remain non-authoritative: persisted state controls completion; unsettled attempts remain stale for existing reconciliation.
- Tests will be written and typechecked, not executed. Runtime regression evidence remains outstanding.
- Recheck listed files before implementation because parallel jobs may make findings stale. `bootServer` is untouched.

**9. Size estimate**

24 existing files plus one progress file; approximately 75–90 minutes including sequential typechecks. Estimated production/metadata diff: +25–45/−20–35 lines; tests: +80–120/−5–15 lines. Expected net addition: roughly 70–140 lines; report actual additions/removals at handoff.