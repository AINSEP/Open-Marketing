# Studio shell handoff

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

`ended`, `cancelled` and `error` are terminal run kinds. Unexpected stream EOF is unavailable. The API event adapter should delegate reconnect behavior to `createEventClient`, injecting its SSE transport, observer, clock, timers and abort factory. It requires the authenticated versioned run event route `/api/agent/v1/runs/<runId>/events`, a cursor and bounded retry delays. Approval responses copy card ID, operation ID and arguments digest; displayed arguments are parsed clones and never redacted/reconstructed before approval.

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
