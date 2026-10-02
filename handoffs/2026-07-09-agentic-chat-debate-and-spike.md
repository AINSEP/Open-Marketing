# Handoff — Agentic chat: two-round debate + Phase-0 spike — 2026-07-09

## TL;DR
Ran the real multi-model `/debate` (2 rounds) on **how to build ONE agentic chat** for Open
Marketing, then designed the mechanism and **built + partially ran a Phase-0 spike** for the
one make-or-break risk. Outcome is decided and grounded in verified code. Claude passed the
critical 120-second blocked-tool test; codex is unconfirmed (a CLI-flag hang, not a mechanism
failure). No product code written yet — next session builds Phase 1 (or finishes the codex
test first).

## The decision (verified against real code, not opinion)
Swarm: Claude Opus 4.8 (primary) + `claude-fable-5` + `codex gpt-5.5` + `Gemini 3.1 Pro` (via
`agy`; the plain `gemini` CLI is dead for this account — `IneligibleTierError`).
Reports: `AI-Dev-Shop/ADS-project-knowledge/.local-artifacts/swarm-consensus/runs/2026-07-09-*.md`.

- **Substrate = B (unanimous):** keep OD's native `ChatPane`/`ChatComposer`/`AssistantMessage`
  (~12k lines, keyed to `/api/runs` + SQLite). Do NOT rebuild the chat on CopilotKit. Retire
  `CopilotSidebar` from the main surface. (Parity gap ~10:1 in shipped code.)
- **Brain = (b):** the OD CLI agent behind `POST /api/runs` IS the orchestrator.
  `registerCapability('default')` (`apps/daemon/src/agui-copilot/registry.ts`) becomes a THIN
  DELEGATE that opens a run and re-yields its stream — not a second agent loop.
- **Transport = one brain, two transports:** `/api/runs` + SSE primary (ChatPane already
  renders it → view parity free); `/api/copilotkit` kept only as the EXTERNAL ag-ui endpoint
  delegating to the same run engine. Repo already ships the bridge: `GET /api/runs/:id/agui`
  (`routes/runs.ts:1325`), `packages/agui-adapter/encode.ts`, `apps/web/src/runtime/tool-renderers.ts`.
- **App-control = a NEW "Action Channel":** share GenUI's request/respond/timeout *grammar*,
  fork its *storage* (GenUI surfaces are human-input-shaped: closed kind enum → defaults to
  `confirmation`, F8 answer cache would replay a stale "navigate", wrong `respondedBy` values,
  pollutes the human inbox). Routing rule: mutate durable state → daemon-exec; needs the live
  viewport → browser-exec.

## Round-2 landmines (all code-verified — these rewrote the naive plan)
1. **The GenUI respond route wakes no waiter and emits nothing** (`apps/daemon/src/routes/genui.ts:67`
   uses `respondSurfaceRow`, not `respondSurface(..,emit)`); `requestOrReuseSurface` is
   non-blocking; `markTimeout` (`genui/store.ts`) has ZERO callers → rows leak. **Build the
   waiter layer first.** (Found by codex + fable independently.)
2. **The daemon INACTIVITY WATCHDOG is the real boss** (`server.ts:6996-7067`). It SIGTERMs a
   quiet child, DROPS to a 60s quiet period once any live artifact is registered, and
   **reclassifies the kill as `success`**; it can also RESTART the run with a fresh child
   (`watchdogRetryRestarted`, `server.ts:6940-6947`). A blocked tool emits no stdout → must
   PUMP the run's inactivity timer while an action is pending (`noteAgentActivity`, ~`server.ts:971`).
   (Found by fable only.)
3. **"Inject an MCP server into the run tool bundle" is NOT a real seam.** MCP is injected only
   for `mcpDiscovery === 'mature-acp'` (`runtimes/mcp.ts:13`); `.mcp.json` write is Claude-only;
   **codex would get no MCP tools.** The universal path is `OD_TOOL_TOKEN` + `od tools …`
   wrapper commands run via the agent's own Bash tool (`server.ts:1145-1167`). → **Ship
   wrapper-first**; MCP is an enhancement.
4. **The daemon does NOT set `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` / `MCP_TOOL_TIMEOUT`
   today** (grep = 0 hits). Pinning them in the spawn env is net-new Phase-1 work.
5. **A single 25s "long-poll" only beats undici's ~300s header timeout — NOT the agent-facing
   Bash/MCP tool timeout.** Design fork: X = one long blocking call; Y = tool returns "pending"
   within 25s and the agent re-calls (also feeds the watchdog). Phase 0 must decide X vs Y.
6. **The AG-UI relay drops all tool activity:** `AGUI_NATIVE_EVENT_KINDS` admits only `tool_call`,
   which nothing emits (`routes/runs.ts:308` vs `chat.ts:455`) — the encoder branch is dead
   code. "Two transports" needs an event-mapping fix before external ag-ui clients see tools.
7. **Security:** raw-mounted `/api/copilotkit` bypasses the Express bearer middleware
   (`server.ts:3414` vs `:3423`); bind `OD_TOOL_TOKEN`→run; allowlist navigate via `parseRoute`;
   defer form-fill behind a human confirmation surface.
8. **Acceptance test is broken by today's code:** the regex would name the campaign
   "Summer Launch and take me to it" and never navigate (`marketing/capability.ts:152`); and
   `/campaigns` isn't even a parsed route (`apps/web/src/router.ts:55`). Slice needs the regex
   GONE + a real route.

## Phase-0 spike — BUILT + partially RUN
Location: `.tmp/spikes/app-control-round0/` (gitignored throwaway). Isolates the CLI-side
blocked-tool tolerance (no daemon needed). Files: `sleep-server.mjs` (fake browser: actions
stay pending until `/respond` or `autoResolveMs`; `/wait` long-polls), `wrapper-navigate.sh`
(Bash-tool path), `mcp-navigate.mjs` (stdio MCP path), `README.md` (matrix + exact commands +
go/no-go + a documented Spike-2 for the watchdog, which needs a live `tools-dev` daemon).

Results so far:
- ✅ Plumbing smoke-tested (wrapper X/Y + MCP handshake→call→resolve).
- ✅ **Claude, 20s wait** — passed.
- ✅ **Claude, 120s wait** — passed with ZERO config changes (Haiku model; Bash-tool timeout is
  client-side so a cheap model is a valid proxy). → **GO for wrapper-first.**
- ❓ **Codex, 120s** — UNCONFIRMED. First run hit codex's network sandbox (`curl (7)`); the
  retry with `--dangerously-bypass-approvals-and-sandbox` HUNG (10+ min, never executed).
  See `reference_codex-cli-testing-gotchas` memory. Re-run with
  `codex exec -c sandbox_mode="workspace-write" -c sandbox_workspace_write.network_access=true`.

## State
- Git: clean on `main` at `9d343ab68` (fork `ainsep` = local). No product code changed this
  session. Only new files: the two consensus reports + two context packets under
  `AI-Dev-Shop/ADS-project-knowledge/.local-artifacts/…` and the spike under `.tmp/` (both
  gitignored). This handoff is the only tracked new file.
- Note: root `AGENTS.md` was edited (by the user/linter) to a "Directory guide" layout this
  session — intentional, keep it.

## Next session — start here
1. (Optional, quick) Finish the codex 120s test with the config-flag network approach; fill the
   README matrix. If codex also survives → wrapper-first is fully proven for both agents.
2. Build **Phase 1** — the daemon Action Channel: contracts (`packages/contracts`) for the
   app-control request/result/manifest; `app_control_actions` table + waiter registry +
   execute/wait/respond/claim routes; a sweeper (give `markTimeout` a caller); run-terminal +
   cancel hooks to fail pending waiters; the watchdog inactivity pump; add the event kinds to
   `AGUI_NATIVE_EVENT_KINDS` + encoder. Exit: daemon vitest green for resolve/deadline/cancel/
   no-browser/late-respond-409/replay-idempotency.
3. Then Phase 2 (wrapper delivery + `od tools app-control`), Phase 3 (browser executor in the
   durable SSE provider — NOT ProjectView — with tab lease + idempotency), Phase 4 (thin
   delegate + relay fidelity + retire CopilotSidebar), Phase 5 (CLI closure + security).
4. Ship all three surfaces (HTTP + web + `od` CLI) in the same PR per root AGENTS.md.
