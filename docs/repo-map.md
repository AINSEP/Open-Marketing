# Repository Map

**Purpose:** This doc is the progressive-disclosure guide for repository
structure, ownership, common workflows, and "where should I look?" questions.
Root `AGENTS.md` remains the canonical source for mandatory repository-wide
contracts such as daemon data paths, command boundaries, cross-package rules,
UI/CLI exposure, and validation requirements.

## First reads

- Agent framework: `AI-Dev-Shop/AGENTS.md`.
- Root contracts: `AGENTS.md`.
- Product and onboarding: `README.md`, `docs/i18n/README.zh-CN.md`,
  `QUICKSTART.md`.
- Contribution and environment: `CONTRIBUTING.md`,
  `docs/i18n/CONTRIBUTING.zh-CN.md`.
- Architecture and protocols: `docs/spec.md`, `docs/architecture.md`,
  `docs/skills-protocol.md`, `docs/agent-adapters.md`, `docs/modes.md`.
- Roadmap and references: `docs/roadmap.md`, `docs/references.md`,
  `docs/code-review-guidelines.md`,
  `specs/current/maintainability-roadmap.md`.

## Workspace directories

Workspace packages come from `pnpm-workspace.yaml`: `apps/*`, `packages/*`,
`tools/*`, and `e2e`.

### Apps

- `apps/web` is the Next.js 16 App Router + React 18 web runtime. Do not
  restore `apps/nextjs`.
- `apps/daemon` is the local privileged daemon and `od` bin. It owns `/api/*`,
  agent spawning, skills, design systems, artifacts, and static serving.
- `apps/desktop` is the Electron shell. It discovers the web URL through
  sidecar IPC.
- `apps/packaged` is the thin packaged Electron runtime entry. It starts
  packaged sidecars and owns the `od://` entry glue.

Read `apps/AGENTS.md` before app edits. Read app-local `AGENTS.md` files when
present, including `apps/daemon/AGENTS.md`, `apps/packaged/AGENTS.md`, and
`apps/landing-page/AGENTS.md`.

### Packages

- `packages/contracts` is the pure TypeScript web/daemon app contract layer.
- `packages/sidecar-proto` owns the Open Design sidecar business protocol.
- `packages/sidecar` owns the generic sidecar runtime.
- `packages/platform` owns generic OS process primitives.

Read `packages/AGENTS.md` before package edits.

### Tools

- `tools/dev` is the local development lifecycle control plane.
- `tools/pack` is the local packaged build/start/stop/logs control plane,
  packaged updater harness, installer identity/registry validation surface, and
  mac beta release artifact preparation surface.
- `tools/serve` is the local fixture-service control plane. Its first service
  is `tools-serve start updater` for deterministic updater metadata and
  artifacts.

Read `tools/AGENTS.md` before tool edits. Read `tools/pack/AGENTS.md` before
touching packaged updater code, release-channel identity, installer behavior,
or updater UI. Read `tools/serve/AGENTS.md` before fixture-service edits.

### E2E

`e2e` owns user-level end-to-end smoke tests and Playwright UI automation. Read
`e2e/AGENTS.md` before editing tests or commands.

### Extension and content surfaces

- `skills/` contains functional skills the agent invokes mid-task. Read
  `skills/AGENTS.md`.
- `design-templates/` contains the rendering catalogue: decks, prototypes,
  image/video/audio templates. Read `design-templates/AGENTS.md` and
  `specs/current/skills-and-design-templates.md`.
- `design-systems/` contains brand `DESIGN.md` files. Read local schema guides
  when editing schema-owned files.
- `craft/` contains universal brand-agnostic craft rules that a skill can opt
  into via `od.craft.requires`.
- `plugins/` contains plugin surfaces. Read `plugins/AGENTS.md`.
- `mocks/` contains replay-based mock CLIs for `opencode`, `claude`, `codex`,
  `gemini`, `cursor-agent`, `deepseek`, `qwen`, `grok`, the ACP family
  `devin`/`hermes`/`kilo`/`kimi`/`kiro`/`vibe`, and the AMR `vela` CLI. See
  `mocks/README.md`.

## Inactive or placeholder directories

- `apps/nextjs` and `packages/shared` have been removed. Do not recreate or
  reference them.
- Local runtime data, `.tmp/`, Playwright reports, and agent scratch
  directories must stay out of git.
- For daemon-managed data paths, read root `AGENTS.md` section
  **Daemon data directory contract**. Do not restate or improvise path
  conventions elsewhere.

## Development baseline

- Runtime target is Node `~24` and `pnpm@10.33.2`.
- Use Corepack so the pnpm version pinned in `package.json` is selected.
- New project-owned entrypoints, modules, scripts, tests, reporters, and
  configs should default to TypeScript.
- Residual JavaScript is limited to generated output, vendored dependencies,
  explicitly documented compatibility build artifacts, and the allowlist in
  `scripts/guard.ts`.

## Windows native

macOS, Linux, and WSL2 are the primary supported paths. Windows native is
best-effort.

- Historical Windows-specific friction is documented in closed issues #10, #96,
  #100, #203, and #315.
- Install Node 24. Either `winget install OpenJS.NodeJS.LTS` or download from
  `https://nodejs.org`. Verify with `node --version`; the WinGet LTS pointer
  rolls to the next major in October 2026.
- Do not use Node 22.
- `corepack enable` fails with EPERM on Windows because it cannot write shims to
  `Program Files`. Use `npm install -g pnpm@10.33.2` instead.
- `better-sqlite3` has no prebuilt binary for win32/Node 24; `pnpm install`
  will compile it from source via node-gyp. Visual Studio Build Tools 2022 or
  newer is required.

## Local lifecycle

Use `pnpm tools-dev` as the only local development lifecycle entry point. Do not
add or restore root aliases such as `pnpm dev`, `pnpm dev:all`, `pnpm daemon`,
`pnpm preview`, or `pnpm start`.

Common lifecycle commands:

```bash
pnpm tools-dev
pnpm tools-dev start web
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
pnpm tools-dev status --json
pnpm tools-dev logs --json
pnpm tools-dev inspect desktop status --json
pnpm tools-dev inspect desktop screenshot --path /tmp/open-design.png
pnpm tools-dev stop
pnpm tools-dev check
pnpm tools-serve start updater
```

## Validation commands

Run root checks before marking regular work ready:

```bash
pnpm guard
pnpm typecheck
```

Use package-scoped checks that match the files changed:

```bash
pnpm --filter @open-design/web typecheck
pnpm --filter @open-design/web test
pnpm --filter @open-design/web build
pnpm --filter @open-design/daemon test
pnpm --filter @open-design/daemon build
pnpm --filter @open-design/desktop build
pnpm --filter @open-design/tools-dev build
pnpm --filter @open-design/tools-pack build
pnpm --filter @open-design/tools-serve build
```

Packaged build examples:

```bash
pnpm tools-pack mac build --to all
pnpm tools-pack mac install
pnpm tools-pack mac cleanup
pnpm tools-pack win build --to nsis
pnpm tools-pack win install
pnpm tools-pack win cleanup
pnpm tools-pack linux build --to appimage
pnpm tools-pack linux install
pnpm tools-pack linux build --containerized
```

## GitHub automation

Read `.github/AGENTS.md` before editing `.github/workflows/`,
`.github/scripts/`, `.github/actions/`, PR follow-on automation, `workflow_run`
trusted writes, CI handoff artifacts, or workflow topology checks.

CI-related GitHub automation uses two layers:

- Business workflows own product or validation decisions. `ci.yml` is the main
  low-privilege PR, merge-queue, and manual validation workflow.
- Atomic capability workflows own reusable trusted operations. `comment.atom.yml`
  publishes pure text PR comments, `autofix.atom.yml` applies same-repository
  patches, and `report.atom.yml` materializes advanced comments that need
  trusted dependencies, secrets, or report generation before upsert.

Do not add a new business-named follow-on workflow such as
`foo.comment.atom.yml` or `bar.autofix.atom.yml` without first trying to express
the flow as a `ci.yml` producer plus the existing `comment`, `autofix`, or
`report` capability.

## PR expectations

- Opening a PR uses `.github/pull_request_template.md`; fill every section.
- "Why" must answer both the author's use case and the pain being addressed.
- "What users will see" describes the change from a user's perspective.
- The Surface area checklist must reflect actual surfaces touched, including
  extension points (`skills/`, `design-systems/`, `design-templates/`, `craft/`),
  CLI flags, env vars, i18n keys, and new root `package.json` dependencies.
- If any UI surface is checked, attach screenshots showing the entry point.
- For bug-fix PRs, link the red-spec test that reproduces the bug and confirm it
  went red on `main` and green on the branch.
- `CONTRIBUTING.md` covers PR scope, title format, dependency policy, and the
  issue-first rule for non-trivial features.
- `docs/code-review-guidelines.md` is the reviewer-facing complement.

## Code review guide

Use `docs/code-review-guidelines.md` as the repository-wide review standard.
Root `AGENTS.md` wins if the two disagree.

Review top-down through:

1. Product relevance test.
2. Forbidden surfaces.
3. Ownership and scope.
4. Matching review lane.
5. Checklist.
6. Comments.
7. Approval bar.

Blocking feedback should focus on correctness, security/secrets, data
integrity, repository boundary violations, contract/migration breakage, missing
required validation, or high-risk maintainability issues.

Only maintainers may close a PR instead of requesting changes, and only when the
change is not salvageable on the existing branch.

## PR-duty tooling

This repository no longer ships a maintainer PR-duty control plane. The former
`pnpm tools-pr` workflow moved to the standalone `PerishCode/duty` project. Do
not recreate `tools/pr`, `@open-design/tools-pr`, or a root `pnpm tools-pr`
script without a new explicit maintainer decision.

## Agent runtime conventions

- `RuntimeAgentDef.promptInputFormat` selects how the daemon writes the prompt
  to a child's stdin. The default `'text'` writes the composed prompt and ends
  stdin immediately. `'stream-json'` wraps the prompt as one JSONL `user`
  message and keeps stdin open so the daemon can stream further user messages
  back in mid-turn.
- Claude (`apps/daemon/src/runtimes/defs/claude.ts`) ships `'stream-json'`
  together with `--input-format stream-json` as generic mid-turn input
  infrastructure.
- `apps/daemon/src/server.ts` tracks `run.stdinOpen` on the run object.
- `applyClaudeStreamJsonRunBookkeeping` closes stdin and records
  `turnCompletedCleanly` when a `turn_end` or `usage` event arrives with a
  non-`tool_use` `stop_reason`.
- The `tool_use` stop reason means the model paused mid tool. Closing stdin
  there would truncate the follow-up response.
- `claude-stream.ts` emits the `turn_end` event after iterating the assistant
  message's content blocks, so the daemon sees the final `stop_reason` and
  every `tool_use` before deciding whether to close stdin.

## Asking the user questions

There is exactly one mechanism for clarifying user intent: the
`<question-form>` markdown artifact the model emits inline.

- The chat renders a `QuestionsBanner` entry point in `AssistantMessage.tsx`.
- The form itself renders in the right-hand Questions tab through
  `QuestionsPanel` and `QuestionFormView`.
- Answers flow back as the next user message through `formatFormAnswers` in
  `apps/web/src/artifacts/question-form.ts` and `POST /api/chat`.
- There is no inline interactive tool card.
- `<question-form>` is valid on any turn, not just turn-1 discovery.
- `run-artifacts.ts:runAskedUserQuestion` powers the
  `run_finished.asked_user_question` analytics signal by scanning streamed text
  for a `<question-form` marker, not by detecting a tool call.

## Chat UI conventions

- `apps/web/src/components/file-viewer-render-mode.ts` decides URL-load vs
  `srcDoc` for HTML previews.
- Bridges such as deck, comment/inspect selection, palette, edit, and tweaks can
  only inject through the `srcDoc` path.
- Add a new disqualifier to `UrlLoadDecision` whenever a feature needs a
  `srcDoc`-only bridge.
- The host keeps both iframes mounted simultaneously and swaps CSS visibility so
  toggling render mode does not cause an iframe reload flash.
- Receive filters use `isOurIframe(ev.source)` to accept messages from either
  iframe; signals that should only come from the active iframe re-check
  `ev.source === iframeRef.current?.contentWindow`.
- TodoWrite UI pins one canonical task list above the chat composer via
  `PinnedTodoSlot` in `ChatPane.tsx`.
- `AssistantMessage.stripTodoToolGroups` removes TodoWrite tool groups from per
  message rendering so there is exactly one TodoCard on screen.
- Clarifying questions render through `<question-form>` and the Questions tab,
  not an inline tool card.
- `dedupeSnapshotToolRetries` collapses snapshot-style tool retries. Non-snapshot
  tools pass through untouched.

## Web CSS ownership

- `apps/web/src/index.css` is an import-only cascade entrypoint. Do not add
  selectors or declarations there.
- Shared global styles belong in `apps/web/src/styles/`: design tokens,
  base/reset rules, primitives, app-shell layout, and legacy cross-component
  selectors that cannot safely be scoped yet.
- Keep domain-level global files grouped by owner, for example `styles/viewer/`
  and `styles/workspace/`.
- New component-owned UI styles should default to CSS Modules next to the
  component (`Component.module.css`).
- When touching an existing component with nearby global styles, prefer
  migrating local selectors to a CSS Module if it is small and testable.
- Keep global class names only for deliberate shared contracts: reusable
  primitives, theme hooks, third-party/content styling, cross-component layout,
  or selectors that rely on global cascade/specificity.
- CSS refactors must preserve cascade semantics.

## Web component reuse

- New `apps/web` UI should reuse shared primitives from
  `@open-design/components` when one exists.
- Use `Button` for app buttons and `VisuallyHidden` for screen-reader-only
  text/status content.
- Do not add new raw primitive classes such as `primary`, `primary-ghost`,
  `ghost`, `subtle`, `icon-btn`, or `sr-only`.
- If a needed primitive is missing, prefer adding a small focused primitive to
  `packages/components` with colocated CSS Modules, then consume it from the
  app.
- Keep product-specific layout and workflow styling in the app, not in
  `packages/components`.
- `apps/web` transpiles `@open-design/components` from source during dev.

## i18n keys

`apps/web/src/i18n/types.ts` is the typed `Dict`. Every key must be defined in
all locale files under `apps/web/src/i18n/locales/*.ts`:

- `ar`
- `de`
- `en`
- `es-ES`
- `fa`
- `fr`
- `hu`
- `id`
- `it`
- `ja`
- `ko`
- `pl`
- `pt-BR`
- `ru`
- `th`
- `tr`
- `uk`
- `zh-CN`
- `zh-TW`

Add the key to `types.ts` first; missing translations produce a typecheck
error.

## UI animation philosophy

- Default ease-out for UI transitions:
  `cubic-bezier(0.23, 1, 0.32, 1)`.
- Use asymmetric durations: enter around 200ms, exit around 140ms.
- Accordion expand and collapse uses `grid-template-rows: 0fr -> 1fr`. Pair it
  with opacity fade and the default easing.
- Reuse the shared `.accordion-collapsible` and
  `.accordion-collapsible-inner` class pair.
- Never animate from `transform: scale(0)`. Start from `scale(0.9)` or higher
  with `opacity: 0`.
- For conditionally shown elements, keep them mounted and toggle a CSS class so
  exit transitions can run.

## Bug follow-up workflow

Use this as the default action shape for routine bug follow-ups:

- Lead with a red spec when practical.
- Try the cheapest test layer that can still see the symptom.
- Keep the fix inside the described bug boundary; list adjacent defects as
  follow-ups.
- Prefer fixes that read as invariants over bolt-on guards.
- Diff against the baseline when neighboring suites have pre-existing failures.
- Link the issue from the PR body with `Fixes #N`, `Closes #N`, or
  `Resolves #N`.
- Stage human verification for visible bugs when green specs alone are not
  enough.

For a worked example, see
`e2e/tests/dialog/stop-reconciles-message.test.ts` for issue #135.

## FAQ

### Why is there no root `pnpm dev` / `pnpm start`?

To avoid starting daemon, web, and desktop through inconsistent env, port,
namespace, or log paths. All local lifecycle flows must go through
`pnpm tools-dev`.

### Why should `apps/nextjs` not be restored?

The current web runtime is `apps/web`. The historical `apps/nextjs` layout has
been removed from the active repo shape; restoring it would reintroduce
duplicate app boundaries and stale scripts.

### How does desktop discover the web URL?

Desktop queries runtime status through sidecar IPC. The web URL comes from
`tools-dev` launch status, not from desktop guessing ports or reading web
internals.

### How are sidecar-proto, sidecar, and platform split?

`@open-design/sidecar-proto` owns Open Design app/mode/source constants,
namespace validation, stamp fields/flags, IPC message schema, status shapes, and
error semantics.

`@open-design/sidecar` provides only generic bootstrap, IPC transport,
path/runtime resolution, launch env, and JSON runtime files.

`@open-design/platform` provides only generic OS process stamp serialization,
command parsing, and process matching/search primitives, consuming the proto
descriptor.

### When is `pnpm install` required?

Run `pnpm install` after changing package manifests, workspace layout, command
entrypoints, bin/link-related content, or after adding/removing workspace
packages.

### Can I use Node 22 instead of Node 24?

No. `package.json#engines` specifies `node: "~24"`, which is the only supported
runtime. Older Node versions are not tested and may hit lockfile or dependency
incompatibilities.
