# Agent Entry Point

Read this file first when entering the repository. This repository boots agent
behavior from `AI-Dev-Shop/AGENTS.md`; that is mandatory, not optional. This
root file then adds the project-specific boundaries, lookup map, and mandatory
contracts the AI Dev Shop framework must respect while working here.

## AI Dev Shop framework

Before doing user-facing work, read and follow:

- `AI-Dev-Shop/AGENTS.md`

That file is the canonical multi-agent software-development framework for this
repo. It governs coordinator modes, pipeline behavior, agent routing, startup,
slash-command conventions, and delegated-agent rules. If it conflicts with this
file on agent-framework behavior, `AI-Dev-Shop/AGENTS.md` wins. If the question
is about repository layout, code ownership, commands, daemon data paths,
validation, or contribution boundaries, this root file and the docs it links are
the project-specific source of truth.

## Repository map

For workspace layout, package ownership, common commands, PR/review workflow,
web UI conventions, and "where should I look?" questions, read:

- `docs/repo-map.md`

After entering these directories, also read their local agent guide before
editing:

- `.github/AGENTS.md`
- `apps/AGENTS.md`
- `packages/AGENTS.md`
- `tools/AGENTS.md`
- `e2e/AGENTS.md`
- `skills/AGENTS.md`
- `design-templates/AGENTS.md`
- `plugins/AGENTS.md`

For packaged updater code, release-channel identity, installer behavior, or
updater UI, read `tools/pack/AGENTS.md` section "Packaged auto-update
architecture and harness" before editing.

## Architecture and protocols

For system topology and protocol detail, read:

- `docs/architecture.md`
- `docs/spec.md`
- `docs/skills-protocol.md`
- `docs/agent-adapters.md`
- `docs/modes.md`

## Code discovery

This project uses codebase-memory-mcp to maintain a knowledge graph of the
codebase. Prefer graph tools over grep/glob/file-search for code discovery:

1. `search_graph` — find functions, classes, routes, variables by pattern.
2. `trace_path` — trace callers, callees, impact, or data flow.
3. `get_code_snippet` — read specific function/class source code.
4. `query_graph` — run Cypher queries for complex patterns.
5. `get_architecture` — get high-level project structure.

Fall back to `rg` or direct file reads for string literals, error messages,
configuration, non-code files, or when the graph is stale or insufficient.

# Mandatory Root Contracts

These contracts are intentionally kept in root `AGENTS.md` because they are
repository-wide rules and other docs point here as the canonical source.

## Daemon data directory contract

This section is the only repository-wide source of truth for daemon-managed
data paths. Every README, guide, deployment note, and operational handoff that
mentions daemon data paths must point here instead of restating the rules.

This boundary is strict. Do not introduce concrete filesystem examples for the
daemon data directory, recommended data directory, shared data directory,
deployment mount, or example data directory. If existing code exposes a legacy
fallback, treat it as implementation detail or a known escape candidate, not as
a documentation pattern to copy. If a change needs a data-path rule that is not
covered here, request a core-maintainer decision in the PR instead of inventing
a new convention.

The daemon has one active data-root truth source:

- On daemon startup, `apps/daemon/src/server.ts` resolves `OD_DATA_DIR` into
  `RUNTIME_DATA_DIR`.
- All daemon-owned data paths must derive from `RUNTIME_DATA_DIR` or from a
  constant derived from it, such as `PROJECTS_DIR` or `ARTIFACTS_DIR`.
- `PROJECTS_DIR` is the managed-project root. Imported-folder projects are the
  explicit exception: they use `metadata.baseDir` for the user-selected
  external workspace.
- `ARTIFACTS_DIR`, SQLite, app config, memory, MCP config/tokens, automation
  state, plugin state, connector credentials, generated files, logs owned by
  sandbox mode, and agent runtime homes are daemon data and must remain under
  the resolved daemon data root unless this file names a specific exception.
- Agent subprocesses receive the resolved daemon data root as `OD_DATA_DIR`.
  They must inherit the daemon's truth source instead of guessing their own
  data path.

Development propagation:

- `tools-dev` owns sidecar runtime/log/ipc namespacing.
- `tools-dev --namespace <name>` does not, by itself, define daemon data
  isolation.
- A development run that needs an isolated daemon data root must pass
  `OD_DATA_DIR` into the daemon process environment. After that, the daemon
  resolves it once and all daemon data paths flow from `RUNTIME_DATA_DIR`.

Packaged propagation:

- `tools-pack` / `apps/packaged` own packaged channel and namespace layout.
- Packaged code resolves the final namespace-scoped daemon data root before
  spawning the daemon.
- The packaged daemon receives that final data root as `OD_DATA_DIR`; daemon
  code must not infer packaged data paths from app names, Electron `userData`,
  ports, channel names, or namespace names.

Sanctioned exceptions:

- `OD_MEDIA_CONFIG_DIR` is a narrow override for `media-config.json` only. It
  is not a second daemon data root.
- `OD_LEGACY_DATA_DIR` is a migration source for legacy data import only. It is
  not an active daemon data root.
- External tool homes such as `CODEX_HOME` are integration inputs, not daemon
  data roots. The daemon must not describe them as Open Design runtime data.
- Agent/project-cwd skill staging aliases are not daemon data roots.
- Manifest metadata keys and CSS identifiers are semantic namespaces, not
  filesystem path conventions.

Known escape candidates that must not be reused:

- Module-level defaults that point at a cwd-relative legacy data directory.
- Helper defaults such as `defaultRegistryRoots()` that recompute a data root
  from `process.env.OD_DATA_DIR` or a cwd fallback instead of receiving
  `RUNTIME_DATA_DIR`.
- `openDatabase(projectRoot)` calls that rely on its fallback instead of
  passing the resolved data root.
- Script help text or examples that suggest concrete legacy data directories.

Do not extend these escape patterns. When a fix is obvious, route the path
through `RUNTIME_DATA_DIR` or an explicit data-root argument. When it is not
obvious, block the PR and request core-maintainer guidance.

## Root command boundary

- Use `pnpm tools-dev` as the only local development lifecycle entry point.
- Keep root scripts reserved for true repo-level checks and tools control-plane
  entrypoints: `pnpm guard`, `pnpm typecheck`, `pnpm tools-dev`,
  `pnpm tools-pack`, and `pnpm tools-serve`.
- Do not add or restore root lifecycle aliases: `pnpm dev`, `pnpm dev:all`,
  `pnpm daemon`, `pnpm preview`, or `pnpm start`.
- Do not add root aggregate `pnpm build` or `pnpm test` aliases. Build/test
  commands must stay package-scoped (`pnpm --filter <package> ...`) or
  tool-scoped (`pnpm tools-pack ...`).
- Do not add root e2e aliases; e2e package commands and ownership rules live in
  `e2e/AGENTS.md`.
- Ports are governed by `tools-dev` flags: `--daemon-port` and `--web-port`.
- `tools-dev` exports `OD_PORT` for the web proxy target and `OD_WEB_PORT` for
  the web listener; do not use `NEXT_PORT`.

## Boundary constraints

- Workspace packages come from `pnpm-workspace.yaml`: `apps/*`, `packages/*`,
  `tools/*`, and `e2e`.
- Runtime target is Node `~24` and `pnpm@10.33.2`; use Corepack so the pnpm
  version pinned in `package.json` is selected.
- New project-owned entrypoints, modules, scripts, tests, reporters, and
  configs should default to TypeScript.
- Residual JavaScript is limited to generated output, vendored dependencies,
  explicitly documented compatibility build artifacts, and the allowlist in
  `scripts/guard.ts`.
- Tests under `apps/`, `packages/`, and `tools/` live in a
  package/app/tool-level `tests/` directory sibling to `src/`; keep `src/`
  source-only and do not add new `*.test.ts` or `*.test.tsx` files under
  `src/`. Playwright UI automation belongs to `e2e/ui/`, not app packages.
- App packages must not import another app's private `src/` or `tests/`
  implementation as a shared helper. In particular, `apps/web/**` must not
  import `apps/daemon/src/**`; web/daemon integration belongs behind HTTP APIs,
  `packages/contracts`, and app-local provider boundaries.
- Cross-app, cross-runtime, or repository-resource consistency checks belong in
  `e2e/tests/` when they need to observe more than one app/package boundary;
  promote reusable logic to a pure package instead of borrowing another app's
  private source.
- Keep shared API DTOs, SSE event unions, error shapes, task shapes, and
  example payloads in `packages/contracts`; update contracts before wiring
  divergent web/daemon request or response shapes.
- Keep `packages/contracts` pure TypeScript and free of Next.js, Express, Node
  filesystem/process APIs, browser APIs, SQLite, daemon internals, and sidecar
  control-plane dependencies.
- App business logic must not know about sidecar/control-plane concepts. Keep
  sidecar awareness in `apps/<app>/sidecar` or the desktop sidecar entry
  wrapper.
- Sidecar process stamps must have exactly five fields: `app`, `mode`,
  `namespace`, `ipc`, and `source`.
- Orchestration layers (`tools-dev`, `tools-pack`, packaged launchers) must
  call package primitives; do not hand-build `--od-stamp-*` args or
  process-scan regexes.
- Packaged runtime paths must be namespace-scoped and independent from
  daemon/web ports; ports are transient transport details only.
- Default runtime files live under `<project-root>/.tmp/<source>/<namespace>/...`;
  POSIX IPC sockets are fixed at `/tmp/open-design/ipc/<namespace>/<app>.sock`.
- `apps/nextjs` and `packages/shared` have been removed; do not recreate or
  reference them.
- Local runtime data, `.tmp/`, Playwright reports, and agent scratch
  directories must stay out of git.

## Capability exposure: UI and CLI

Every user-facing capability must be reachable through both the web UI and the
`od` CLI (`apps/daemon/src/cli.ts`). Shipping a feature with only one of the two
surfaces is a regression.

- The CLI is the embeddability contract. External agents drive Open Design
  through `od` subcommands; they do not render the web UI.
- Both surfaces must call the same `/api/*` endpoints. Do not let the CLI talk
  to one shape and the UI to another. The daemon HTTP layer is the single source
  of truth, with `packages/contracts` carrying the shared DTOs.
- The CLI form must support `--json` for machine-readable output and accept
  long-form prompts via `--prompt-file <path|->`.
- Adding a new capability is a three-step closure: HTTP endpoint in
  `apps/daemon/src/*-routes.ts` with a contract type in
  `packages/contracts/src/api/`, UI surface in `apps/web/src/`, and
  `od <capability>` subcommand in `apps/daemon/src/cli.ts` registered through
  `SUBCOMMAND_MAP`. Land all three in the same PR.
- The PR template's Surface area checklist must reflect both surfaces, or
  explain why the missing surface is genuinely not applicable.

## Release channel model

- `beta` is the daily R&D/development validation channel. It is optimized for
  fast development feedback and is not part of the stable promotion gate.
- `prerelease` is the internal validation channel for stable delivery. Stable
  releases remain gated by validated prerelease artifacts.
- `preview` is an independent early-access channel with stable-like release
  rigor. It should use preview versions such as `X.Y.Z-preview.N`, publish to
  the `preview` R2 channel, publish updater feeds under `preview/latest`, and
  follow stable's platform policy including the existing optional Linux
  enablement.
- `stable` is the formal delivery channel. Do not make stable promotion depend
  on preview; stable continues to depend on prerelease only.
- Public packaged app identity must stay channel-distinct: stable uses
  `Open Design`, beta uses `Open Design Beta`, prerelease uses
  `Open Design Prerelease`, and preview uses `Open Design Preview`. Do not ship
  beta, prerelease, or preview mac DMGs whose drag-install app bundle is
  `Open Design.app`.
- Windows beta updater validation must use the real beta namespace
  `release-beta-win`; otherwise a local beta-like namespace can create a
  separate uninstall registry key while looking like the same `Open Design Beta`
  app. See `tools/pack/AGENTS.md` for the architecture map and high-confidence
  acceptance harness.

## Validation strategy

- After package, workspace, or command-entry changes, run `pnpm install` so
  workspace links and generated dist entries stay fresh.
- For agent-stream / parser changes (`apps/daemon/src/claude-stream.ts`,
  `json-event-stream.ts`, `qoder-stream.ts`, etc.), replay a recorded session
  through the mock CLIs in `mocks/` to verify event shapes round-trip without
  burning provider budget. PATH-overlay activation:
  `export PATH="$PWD/mocks/bin:$PATH" OD_MOCKS_TRACE=<8-char-id> OD_MOCKS_NO_DELAY=1`.
- Treat every `pnpm-lock.yaml` change as requiring a Nix pnpm deps hash refresh
  check. `nix/pnpm-deps.nix` is a generated lock artifact; use
  `pnpm nix:update-hash` only when intentionally maintaining Nix packaging, then
  re-run `nix flake check --print-build-logs --keep-going`.
- Before marking regular work ready, run at least `pnpm guard` and
  `pnpm typecheck`, plus the package-scoped tests/builds that match the files
  changed. Do not use or add root `pnpm test`/`pnpm build` aliases.
- For local web runtime loops, prefer
  `pnpm tools-dev run web --daemon-port <port> --web-port <port>`.
- For e2e tests that need a tools-dev daemon/web runtime, use the shared
  tools-dev harness under `e2e/lib/tools-dev/` and the framework suite adapters
  (`e2e/lib/playwright/suite.ts`, `e2e/lib/vitest/suite.ts`). Do not hand-spawn
  `tools-dev` from test cases.
- Playwright UI tests must import `test`/`expect` from `@/playwright/suite`,
  not directly from `@playwright/test`; type-only imports from
  `@playwright/test` remain fine.
- On a GUI-capable machine, validate desktop by running `pnpm tools-dev`, then
  `pnpm tools-dev inspect desktop status`.
- Stamp/namespace changes must validate two concurrent namespaces and run
  desktop `inspect eval` plus `inspect screenshot` for each namespace.
- Path/log changes must run `pnpm tools-dev logs --namespace <name> --json` and
  confirm log paths are under `.tmp/tools-dev/<namespace>/...`.

## Git and PR policy

- Git commits must not include `Co-authored-by` trailers or any other co-author
  metadata.
- Opening a PR uses `.github/pull_request_template.md`; fill every section, not
  just the title.
- For bug-fix PRs, link the red-spec test that reproduces the bug and confirm it
  went red on `main` and green on the branch.
- Use `docs/code-review-guidelines.md` as the repository-wide review standard.
- Before reviewing changes under `apps/`, `packages/`, `tools/`, or `e2e/`,
  read that directory's `AGENTS.md` and apply its local boundaries.
