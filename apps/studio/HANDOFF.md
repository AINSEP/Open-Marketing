# Studio domain pages handoff — w3-studio-pages

Programmer(Direct): Existing Creative, Media, Campaigns, Settings, Measure, Connections, Plugins and Activity routes now show detailed sample evidence through StudioApiPort.snapshot. Owners can inspect costs and provenance, review exact sample cards, see campaign blockers and halt receipts, and distinguish source-labelled reports. The persistent preview notice explains that sample choices perform no external action.

To inspect later, run `corepack pnpm --filter @open-marketing/studio dev` and use the existing feature rail. This job did not start a dev server. The j18 handoff below is historical; this section supersedes its domain-page deferrals and verification status for this continuation.

## Changed files

All 14 planned files are within apps/studio; the interrupted run's types/schema edits were retained.

- src/shared/api/types.ts, validation.ts: optional `StudioSnapshot.pages` with creative, campaigns and operations read models; strict bounded schemas.
- src/shared/api/sample-data.ts: three named fixture blocks; six generation examples, three assets/drafts/reports/connections/plugins, four halt/activity receipts and the two allowance settings. Added one over-allowance exact card; retained the existing cards and sample API methods.
- src/app/Shell.tsx: passes the existing API/runtime into WorkspaceCanvas.
- src/widgets/workspace-canvas/ui/WorkspaceCanvas.tsx, WorkspaceCanvas.hooks.ts: compose domain views; format money, associate exact cards and original assets outside component bodies. Missing pages shows “Domain details unavailable”.
- src/widgets/workspace-canvas/ui/CreativeMediaCanvas.tsx, CampaignSafetyCanvas.tsx, OperationsCanvas.tsx: native cards/details and existing navigation links; no second design system or state library.
- src/styles.css: extends existing cards, facts and responsive grid without new tokens or layout system.
- tests/domain-pages.test.ts, tests/api-port.test.ts: domain display/approval cases and one enriched-snapshot case in the existing shared adapter suite.
- HANDOFF.md, progress-ledger.md: continuation and integration evidence.

## Tests and verification

Tests written, not run. Domain tests exercise unknown cost, pending/failed/unknown outcomes, generation-card association, original/crop and dedupe evidence, blocked/unavailable review even with a referenced card, approval acknowledgement while a draft stays paused, separate local/remote halt state, both allowance labels and revisions, the three report truth models, mixed-currency CAC unavailability, reauthentication/revoked authority, linked operation/job/audit evidence and optional-page absence. Adversarial boundary cases include one invalid generation in a valid batch, nested secret text, plugin MCP/token fields, long display strings and a 101-item list. Existing exact-card forgery/deduplication/expiry coverage was retained without duplication in the adapter suite.

Exactly one lane typecheck was invoked in this continuation:
`corepack pnpm --filter @open-marketing/studio typecheck`
Result: **FAILED, exit 2**. `tsc --noEmit` completed successfully; `tsc -p tsconfig.tests.json` reported TS2769 for unsupported `exact` options in role queries: five in the new domain-pages file and three pre-existing occurrences (approval-ui.test.ts:24; chat.test.ts:15 and :30). The new file now uses anchored accessible-name regexes instead. That correction was not rechecked; existing files outside the approved map were left untouched. No typecheck pass claim is made. No tests, aggregate checks, builds, installs, live calls or migrations are authorized in this job. Rendered review and coverage/complexity measurements remain unavailable.

## Contracts

`StudioSnapshot.pages?` is an additive lane-local presentation model: creative (generations/assets), campaigns (drafts/halts/allowances), operations (reports/connections/plugins/measurementGrant/activity). Each collection is capped at 100, existing display-string and aggregate payload bounds remain, and unknown/plugin-config fields are rejected. The optional field preserves shell-only adapters; partial/malformed page objects reject the snapshot instead of inventing defaults. Money remains the shared Money type; unavailable money is null with supplied cost evidence.

`StudioApiPort.snapshot` and `approve` signatures are unchanged. No new method, route, factory, shared-package export or dependency was added. WorkspaceCanvas now requires the same api/runtime used by the shell. ApprovalCard is reused unchanged and receives the associated card verbatim. A blocked/unavailable server review exposes no launch card. Browser code does not calculate safety, allowance rollover, reservations or CAC.

Sample settings display USD $10/day for image generation, America/Los_Angeles, owner-local midnight, usage/reservations and revision outcome. Paid sending displays USD $5/day with pending authoritative semantics. Neither setting grants ad-spend authority. Fixtures are repeatable after reload; no durable workflow restoration is claimed.

Shared contracts/manifests/lockfile/composition were untouched; no migration, commit or push occurred.

## Architecture audit and pre-completion

Static audit: PASS within the approved sample scope. Checked all changed files for studio-only ownership; app → widget → feature/shared public-entry imports; no backend feature/vendor/plugin runtime imports; injected API/runtime; no nested TSX functions; bounded strict read models; original/crop evidence; server-decided review/allowance/halt/report states; existing routes and generic approval reuse. Mechanical architecture/complexity gates and rendered UI checks were not run, so this is not a gate-pass or production-readiness claim.

Requirements re-read against the approved file map. Existing tests were not deleted or weakened. Dirty/untracked work in other lanes was preserved. Discovery used direct source reads because codebase-memory MCP tools were not available. No extra files or unplanned runtime actions were added. No separate certified test/hash artifact was supplied; the approved dispatch is the active implementation contract.

## Reuse, documentation and function quality

Pattern priming: the owner-approved plan explicitly requires the existing WorkspaceCanvas/render helpers, hook-derived display models and unchanged ApprovalCard style. Those source files were the seed; no new visual direction or approval flow was invented.

Reuse: domain inspection; inspected WorkspaceCanvas, navigation public entry, Shell and styles; extended existing native cards/details and route links, with view-specific evidence models required by the approved plan.
Reuse: exact review; inspected features/approve public entry, UI/hooks/rules and existing API suite; used unchanged ApprovalCard and approve acknowledgement.
Reuse: validation/formatting; inspected shared/api types/validation/sample and shared Money schema; used installed Zod/parseBoundary and Intl.NumberFormat, retaining nulls and evidence.
Backend public indexes for creative, media-library, campaigns, safety, measure, credentials and plugins were read for boundaries only; none is imported into the browser. The planner's documented Jini availability check was reused; no dependency installation or registry request was needed for this continuation.

Documentation: StudioPages, optional pages, WorkspaceCanvas props/renderer and view-model preparation are documented; renderer markup and obvious private mappers inherit the nearest parent docs. Hook complexity is linear in bounded lists, with bounded Maps for associations, no I/O and no retained state. No new external-I/O code exists; approval effects remain owned by the existing feature.

| Assessment units | Disposition | Findings | Local fix / direct seam |
| --- | --- | --- | --- |
| Snapshot schemas / optional pages | NO_RECORDED_FINDINGS (static) | No policy calculation; strict aggregate rejection retained | domain-pages boundary cases |
| Money formatting / creative/campaign/operation display preparation | NO_RECORDED_FINDINGS (static) | Linear bounded mapping; null stays unavailable; ready state is supplied | domain-pages rendered evidence and card association cases |
| Domain renderers / Shell wiring | RECOMMENDED | Low:UI: responsive layout/zoom/focus not rendered in this dispatch | Existing native semantics and grid reused; integrator rendered review needed |

Critical/High findings: none in static review; mechanical measurements not available. No all-units zero-findings claim. Name audit checked cost observations, estimate/actual distinction, original links, server remaining amount, localBarrier versus remoteStop and source/CAC/restatement labels. Callback scalar signatures are limited to native Array.map rendering wrappers, not owned port APIs. Every changed logic path has a direct snapshot/display seam; missing-card/empty-list rendering also remains reachable via injected snapshots. Coverage metrics and red/green evidence cannot be claimed because the owner prohibited test execution.

Self-validation: not run; tests/builds/dev startup were excluded by this dispatch. No browser or runtime success claim. Suggested review status: sample implementation awaiting integrator evidence.

## Left out, risks and needs

- Generation submission, file upload/dedupe execution, crop editing, campaign editing/launch dispatch, halt submission and allowance mutation remain deferred; current port has no such methods.
- OAuth browser flows, plugin install/update/revoke and measurement-grant editing remain deferred; pages show status/recovery guidance only.
- Live refresh, durable restoration, job/event reconciliation and persistence remain deferred. Fixed fixtures are examples, not evidence of live workflows.
- Server decides CAC, safety, daily eligibility/reset/reservations and grants. No browser arithmetic or midnight scheduler was added.
- j22 must map validated responses into these read models, supply missing actions, and apply the shared adapter suite to a recorded HTTP fixture.
- Safety/server owner must confirm owner-local midnight integration and authoritative paid-sending allowance semantics. The safety public index and current JOBS notes already describe owner-local rollover; this lane changes no shared policy.
- Integrator must correct the three pre-existing ByRoleOptions `exact` errors in tests/approval-ui.test.ts and tests/chat.test.ts, recheck the corrected new domain tests, then run tests/build/om:check and rendered desktop/mobile review when authorized. Static typecheck alone does not prove UI or acceptance success.

## Handoff

Review the 14 lane files and resolve/recheck the test-compilation blockers, then integrate j22 against the unchanged StudioApiPort with optional pages. Keep sample labels until replacing fixtures with authoritative server results. Full j19–j21 acceptance and HTTP/studio/CLI parity remain open. The shell's existing chat/navigation/card behavior and composition replacement seam are retained.

---

# Studio shell handoff (j18 historical record)

Programmer(Direct): The studio now has a sample operator workspace with feature navigation, a central canvas, the preserved global assistant FAB and docked panel, and generic exact-argument approval cards. Run `corepack pnpm --filter @open-marketing/studio dev` from the repository root to inspect it. This command was not launched during implementation.

All default content is clearly labelled sample data. Chat accepts a sample message and returns a hand-written response; `open campaigns` demonstrates a structured navigation action. Choosing an approval records a preview decision and never dispatches a vendor call. Live HTTP/SSE bindings and domain editors remain deferred.

## Changed files

- `package.json`, `tsconfig.json`: lane-local Vite dev script and ES2024 library declarations for native `Promise.withResolvers`.
- `src/app/Shell.tsx`, `Shell.hooks.ts`: routing, navigation, boot data, focus, center canvas and shared chat composition.
- `src/composition/index.ts`, `src/composition/adapters/browser.ts`, `src/main.ts`, `src/index.ts`: explicit host mounting, injected browser/time/IDs/timers, lifecycle cleanup and public integration types.
- `src/shared/api/{index,types,validation,events,sample,sample-data}.ts`: API port, bounded local read models/payloads, secret rejection, resumable event client and in-memory sample adapter.
- `src/shared/navigation/index.ts`, `src/shared/ui/{index,port-snapshot.hooks}.ts`: explicit routes and object-shaped store subscriptions.
- `src/features/navigate/{index,model/controller}.ts`: validated structured actions, replay protection, render acknowledgements, timeout/no-browser/supersession/disposal results.
- `src/features/chat-run/{index,model/session}.ts`: headless bounded transcript/card state, start/run deadlines, event replay protection, local stop, server cancellation receipts and navigation results.
- `src/features/approve/index.ts`, `model/rules.ts`, `ui/ApprovalCard{,.hooks}.ts[x]`: exact arguments/digests, server-offered choices, expiry, submission locks and honest acknowledgement states.
- `src/widgets/om-chat/{OMChatPane.tsx,OMChatPane.hooks.ts,index.ts}`: preserved app-global panel intent, keyboard focus/Escape, native composer, messages and generic cards.
- `src/widgets/workspace-canvas/{index.ts,ui/WorkspaceCanvas.tsx,ui/WorkspaceCanvas.hooks.ts}` and `src/styles.css`: replaceable sample canvases and responsive dark studio presentation.
- `tests/{shell,chat,approval,approval-ui,navigation,events,session,api-port,react-rule}.test.ts`, `tests/support/{runtime,studio}.ts`: acceptance tests and deterministic host doubles.
- `HANDOFF.md`, `progress-ledger.md`: integration and continuation records.

## Tests and fresh evidence

Tests: **written, not run**. The retained cases exercise route/focus changes; panel entry/Escape/FAB focus return; sample native navigation; exact card JSON and immutable response identifiers; generation allowance choice distinction; spend/destructive grant rejection; expiry; nested secrets; SSE reconnect/cursor replay, conflicting identity, foreign scope, limits, malformed frames and idle expiry; terminal versus unexpected EOF; cancellation/late-start races; repeated stop honesty; and actual canonical TSX-rule rejection of JSX arrows/nested effects.

`tests/api-port.test.ts` contains a reusable adapter contract suite. It currently targets the sample API. j22 should apply the same suite to a real HTTP adapter using a local recorded server fixture. No claim of B1 real-adapter parity is made yet.

Exactly one lane typecheck was invoked:

```text
corepack pnpm --filter @open-marketing/studio typecheck
```

It failed in the source compiler with `TS2742` on the inferred return type of `useOMChatPane`, which referenced a private Zod declaration. The hook now has the explicit public `OMChatPaneModel` return interface and public OM/React aliases. That correction was not rechecked because the dispatch allows one typecheck only. The command's second test-compilation stage did not execute. No pass claim is made.

Whitespace diff inspection was clean before the final named-type correction. No suites, om:check, builds, installs, dev server or browser runtime validation were run. Coverage and mechanical complexity measurements are unavailable under these constraints. No certified tests were provided, deleted or weakened; the two skeleton suites were expanded for the new sample-mode behavior.

## Contracts and integration

Shared contracts were read and left untouched. Reused public contracts/schemas: `Outcome`, `ChatMessage`, `ConfirmationCard`, `ApprovalResponse`, `NavigationAction`, `NavigationResult`, `NavigationTarget`, `RunEvent`, `CancellationReceipt`, `Money`, clock/ID/observer ports, boundary parsing and subscription validation.

`StudioApiPort`, `StudioSnapshot`, `StudioRun`, `StudioPayload`, `StudioRuntime` and `TimerPort` are local caller-owned presentation contracts. They are exported from `src/index.ts`. Supply `api` to `createStudioApp({ root, runtime, browser, api })` to replace the sample API. API adapters must translate exceptions to typed outcomes, validate response bodies, enforce request timeouts, and keep authentication/credentials out of events and read models. Writes must retain exact operation identity/digest and must not be automatically retried.

Supported `RunEvent.payload` display envelopes are:

```ts
{ type: "message", message: ChatMessage }       // full message replacement by ID
{ type: "confirmation", card: ConfirmationCard }
{ type: "navigation", action: NavigationAction }
{ type: "status", text: string }               // not trusted as completion evidence
```

`ended`, `cancelled` and `error` are terminal run kinds. Unexpected stream EOF is unavailable. The active `createHttpStudioApi.events` transport polls the owner route `/api/runs/<runId>/events?after=<cursor>`, using the injected runtime for cancellation, 15-second request deadlines and one-second polling intervals. Failed pages are not retried automatically. Approval responses copy card ID, operation ID and arguments digest; displayed arguments are parsed clones and never redacted/reconstructed before approval.

Navigation applies only shared allowlisted targets. Its promise resolves `completed` after the Shell confirms that target's committed canvas. No-browser, failed write, timeout, changed replay and superseded/detached cases resolve `failed`. The session acknowledges this actual result through `acknowledgeNavigation`.

No plugin manifest/configuration was added. The closed MCP schema and extension namespace requirement were reviewed against [Agent Plugins 1.1.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.1.0.md).

## Reuse

- Chat and UI: checked installed `node_modules`, npm registry and offline cache for `@jini-ai/chat`, `@jini-ai/ui`, `@jini-ai/protocol`. None was installed or cached; registry lookup failed with DNS `ENOTFOUND`. Read the permitted Jini checkout's public package descriptions and `MessageList`, `Composer`, chat-pane and page-action surfaces. No registry version is claimed verified. The daemon pane's runtime/store types differ from OM's server-owned run protocol. Used native HTML/React as a removable presentation adapter; no sibling source imports or unpublished dependencies.
- Validation and cards: reused shared OM schemas and installed Zod, keeping authority in the server. The client rejects contradictory broad grants on spend/destructive cards as additional friction; generation choices remain exactly those supplied by the server.
- Navigation/timers: used native same-document hash routes, AbortController and Promise.withResolvers with injected host effects. Native structured OM action/result validation replaces command execution; the existing command recognizer remains a compatibility parser only.

## Architecture audit

**WARNING / partial verification.** Static review found changes confined to this lane, downward FSD imports through slice public entries, no backend feature/server/plugin implementation imports, one composition root with subordinate browser adapters, no imports into sibling checkouts, no credentials/configuration/vendor calls, no functions defined inside TSX render bodies, injected clock/timers/IDs, bounded state and explicit failures. Root mechanical gates were not run.

The supplied shell and chat skeleton were the style seed. The dispatch's specified layout and canonical hook/rules placement governed implementation. No new brand strategy or domain workflow was added. Existing dirty/untracked work outside studio was preserved.

Design Intent review: overview explains workspace and sample status; navigation/canvas/chat have distinct roles; review controls show arguments and clear policy choices; the existing dark studio basis uses consistent surfaces and spacing; sample metrics and outcomes are labelled; there is no decorative motion; desktop docks the panel and narrow layouts stack it; semantic landmarks, labels, visible focus, Escape, focus return and reduced-motion handling are present. Rendered contrast, zoom, actual dimensions and mobile scroll behavior remain unverified.

## Function quality and direct seams

| Units | Disposition | Findings and smallest next action | Test seam |
| --- | --- | --- | --- |
| Boundary parsing, secret inspection, card preparation, message preparation | NO_RECORDED_FINDINGS | Bounded payloads; rejection preserves exact-review integrity. Server must still redact opaque secrets the client cannot recognize. | approval/events/session tests |
| Event admission, replay decision, connection reader, batch receiver, reconnect/subscription cleanup | NO_RECORDED_FINDINGS | Per-subscription bounded cursor/evidence and read-only retry; transport must honor injected abort. | events tests |
| Navigation selection/apply/begin/rendered/disposal | NO_RECORDED_FINDINGS | One pending action; 100 retained actions; actual render acknowledgement and conflict handling. | navigation and chat tests |
| Chat hydrate/start/accept/payload/consume/stop/disposal | PASS_WITH_ADVISORIES | Medium:IO — cancellation and navigation acknowledgement depend on the future API adapter's bounded timeout contract. Implement timed HTTP requests and typed unknown-outcome errors in j22; do not turn timeout into no-effect/refund evidence. | session tests and API port suite |
| Approval hook and browser timer/route adapters | NO_RECORDED_FINDINGS | Expiry/submission observation locks, explicit host effects; modern ES2024 browser required. | approval-ui/navigation tests; browser smoke still required |
| Shell/panel/canvas hooks and declarative renderers | PASS_WITH_ADVISORIES | Low:UI — actual desktop/mobile layout and zoom not observed; perform rendered review once dev startup is allowed. | shell/chat tests; rendered checks pending |

Critical/High findings recorded: none in static review. This is not a mechanical metric pass. Callback exceptions are limited to React event objects and immediate standard-library/React test callbacks. Owned runtime functions use zero arguments or at most two object arguments; object subscriptions avoid a custom positional callback API.

Every logic-bearing unit has a direct port/rule/state seam. Retained adversarial cases cover repeated IDs, changed replay, partial-invalid payloads, exact expiry, capped streams, stale start receipts and pending cancellation. Local refactors separated replay policy from event admission, moved callback creation out of TSX and removed cancelled start timers. A name audit corrected the UI payload bound from “bytes” to UTF-16 characters. No zero-findings claim is made across the full change.

## Risks

- The sole typecheck failed before its test-compilation stage; the named return-type correction is unverified.
- No live server binding, durable transcript persistence, vendor execution, real account operations, domain editors, settings mutation or history restoration is implemented. Sample approvals perform no spend.
- The generic JSON run payload currently needs an agreed studio display convention with j22. Live tool-result/error payloads outside these narrow envelopes are rejected.
- The UI's key/pattern checks are defense in depth, not a substitute for server credential redaction or dispatch-time authority checks.
- The sample API retains at most 100 runs; event observation at most 1000 raw frames and five configured retries; messages/cards at most 200/50. A fresh sample instance is needed after the run cap.
- A server cancellation receipt of `requested` remains pending and blocks a fresh send until reconciliation; the future adapter must supply follow-up state. The UI does not pretend it was cancelled.
- Native Promise.withResolvers requires a current browser/Electron runtime.

## Needs

- j22: supply validated HTTP/SSE implementation of StudioApiPort; agree/promote the four display payload envelopes to a neutral shared protocol rather than importing studio source into server code; close authenticated receipts/approval/navigation-result routes and bounded timeouts; run the reusable API suite against both adapters.
- Integrator: rerun studio typecheck, then tests/build and required aggregate gates when authorized. Validate desktop/mobile keyboard, zoom, focus and actual layout via the dev command.
- Library follow-up: verify the published Jini chat/UI/protocol releases when registry access is available, then replace the documented native presentation adapters where public types fit. No install or lockfile update is required by this implementation.

## Handoff

Implementation is ready for code review as an unverified sample core, not live readiness. Begin with the named-type correction and studio test compilation, then inspect the preview and bind j22. j19–j21 can replace WorkspaceCanvas through its widget public entry and the injected read model while preserving Shell/chat/approval behavior. No migrations, commits or pushes were performed.
