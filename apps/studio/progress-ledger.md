# TF4 studio failure repairs — 2026-10-25

Programmer(Direct). Lane: apps/studio only. No commits or pushes.

- Read both cloud reports; authoritative cleanup report has the same 42 failures as baseline.
- Repaired jsdom stylesheet fixture reads using Node's URL constructor, avoiding Vite asset rewrites; kept theme/contrast assertions and shipped CSS unchanged.
- Updated stale labelled-section role, retired landing copy, reviewed icon weight, attachment copy, unknown-write response and asynchronous HTTP cleanup expectations.
- Restored pending approval/surface events in savedMessages, including histories without assistant text; avoided adding text events to ordinary replies without slots or usage.
- Added three regression cases for empty/user/assistant history, multiple surfaces, repeated conversion and immutable session input. Existing browser approval/chart assertions remain.
- Sole `corepack pnpm --filter @open-marketing/studio typecheck`: exit 0 (source and tests). Afterwards, only moved the existing spend-card fixture render after its headless receipt and added an explanatory comment; no recheck under the one-run limit.
- Tests, builds, installs, indexing, om:check and runtime/browser validation were not run, per dispatch. Cloud red/green confirmation remains required.
- Static architecture review: no contract, policy, dependency, composition, migration or TSX changes. savedMessages remains pure, object-input, bounded linear time/space. No recorded source findings after checking mutation, empty histories, multiple slots, sample usage and variable meanings; mechanical lint/coverage not run.
- Handoff: cloud-run studio tests, especially the shared CSS setup, exact surface spend card, chart inventory and transport cleanup. Preserve concurrent changes outside this lane. Historical entries below are retained.

---

# Studio domain pages progress — w3-studio-pages

Programmer(Direct). Lane: apps/studio. Continuation attempt 2.

## Current objective

Complete the approved sample domain pages using existing shell/API/cards. Exactly one lane typecheck; tests written but not run. No commits, installs, builds or cross-lane writes.

## Resume evidence and completed work

Initial lane status/diff showed only types.ts and validation.ts modified by the interrupted attempt. Both edits were retained. Existing j18 ledger/handoff read; its prior typecheck correction remained unverified at resume. Graph MCP tools were unavailable; direct source reads confirmed the shell, API, card and navigation seams.

Implemented three small named fixture blocks, domain canvases for all existing routes, shell API/runtime wiring, display preparation in the existing hooks module, missing-domain fallback, existing-style extensions and one domain test file. Extended the existing API adapter suite with enriched repeated snapshot evidence. All 14 planned files stay in this lane.

## Latest verification

Sole continuation typecheck: `corepack pnpm --filter @open-marketing/studio typecheck`, exit 2. Source compilation passed; test compilation failed with TS2769 (unsupported `exact` in ByRoleOptions), five occurrences in the new domain tests and three pre-existing occurrences in approval-ui.test.ts:24 and chat.test.ts:15/:30. Root cause: copied query-option pattern is not part of the installed role-query ABI. Replaced the five new occurrences with anchored name regexes; no second check authorized. Existing two test files are outside the approved map and remain NEEDS.
Tests are written, not run. No test suites, builds, installs, om:check or dev server launched. Static diff whitespace review was clean before handoff updates.

## Next actions

1. Integrator: correct the three pre-existing role-query options and recheck test compilation, including the new-file correction.
2. Integrator: run tests/build/om:check and inspect desktop/mobile layout when authorized.
3. j22: bind validated server read models/actions and shared adapter suite; preserve exact card identity and honest unknown outcomes.

## Deferred

All action methods absent from the current port, live refresh/persistence/reconciliation, CAC and safety calculations, authoritative paid-sending semantics and rendered review. No test or runtime success claim. Full current scope/risks and static audit are in HANDOFF.md; j18 history follows.

---

# Studio shell progress (j18 historical record)

Programmer(Direct), job j18. Scope: apps/studio only.

## Current objective

Deliver the sample studio shell, preserved OM chat intent, generic server-owned exact cards and integration seams under the no-test-run dispatch.

## Completed implementation

Feature navigation and sample center canvases; FAB/docked chat; native composer; bounded transcript/card/run state; API/read-model port; recorded sample adapter; SSE reconnect/replay and idle-expiry handling; structured navigation with render acknowledgement; policy/expiry-controlled exact cards; host DI and lifecycle; acceptance suites and shared adapter suite written.

## Latest verification and hypothesis

One `corepack pnpm --filter @open-marketing/studio typecheck` invocation exited 2 with TS2742 at useOMChatPane: its inferred card-list return referenced a private Zod utility declaration. The explicit OMChatPaneModel interface now uses public OM/React types. No recheck was run because only one typecheck was authorized. The script stopped before compiling tests.

No tests, om:check, builds, installs or dev server were run. Read HANDOFF.md for the full static architecture/function-quality review and remaining risks. No commit/push. Unrelated work preserved.

## Next actions

1. Recheck named return type and test compilation once verification is authorized.
2. Run retained studio tests/build and aggregate gates through the integrator.
3. Open the preview with `corepack pnpm --filter @open-marketing/studio dev`; inspect desktop/mobile focus, zoom and panel stacking.
4. Agree the four StudioPayload display envelopes with j22 and bind the HTTP/SSE adapter; apply the same API suite to sample and real adapters.
5. Revisit published Jini presentation primitives when npm access is available.

## Constraints and deferred work

No shared-contract/root/lockfile/backend/other-app edits. No vendor calls, real credentials or spend. Domain canvases/settings editing, live run reconciliation, durable transcripts and published Jini migration remain deferred. Details and removal seams are in HANDOFF.md.
