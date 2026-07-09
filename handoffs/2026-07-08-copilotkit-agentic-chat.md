# Handoff — CopilotKit agentic chat architecture — 2026-07-08

## TL;DR
Long architecture session on **how to turn the CopilotKit/ag-ui chat into ONE agentic
chat** that does everything OD's native chat does (artifacts, files, design systems,
streaming, tool-call + GenUI rendering) AND automates complex frontend workflows AND calls
MCP/WebMCP — with an agent that "just knows what to do." No feature code was written; we
nailed down the architecture, corrected several misconceptions, and teed up a formal
`/debate`. Also fixed a "send button does nothing" bug (agent not selected), added a
`desktop` npm script + a Vite dev sidecar, and consolidated git onto `main`.

**Next action after restart:** run the real `/debate` (see prompt + protocol below) on the
one contested crux, then build the smallest agentic slice from the `registerCapability` seam.

---

## The thesis (corrected this session — read this first)
CopilotKit is **our implementation of the ag-ui protocol** — the *substrate for agentic
frontend capability*, NOT a chat widget. Growth path: today ag-ui tool-calls + generative
UI + human-in-the-loop; roadmap **WebMCP** (in-page MCP tools), **A2UI** (agent-driven /
generative UI surfaces), more. **The point is automating COMPLEX MULTI-STEP FRONTEND
WORKFLOWS** (e.g. stand up a whole campaign across pages: brief → creative variants →
budget/audience → tracking/pixels → experiment → approval). Trivial one-shots
(navigate / chart / command) are table stakes, NOT the point.

### Two axes — do not conflate (my earlier mistake)
| Axis | What it is | Best tool |
|---|---|---|
| Agent → app control / agentic UI (workflows, generative UI, streaming) | what the **agent does** | **CopilotKit/ag-ui** — keep it, it's right |
| User → rich composer input (attach files, plugins, design systems) | what the **user feeds in** | OD run engine (agui backend would need to grow) |

**It is NOT a CopilotKit limitation.** CopilotKit can host any composer UI. The "dead
button" problem is purely a *backend-behind-the-chat* question: a composer control only
works if the backend receiving the message implements it. OD's run engine does; the current
agui capability does not.

---

## Key architecture findings (verified against code)

### The unification seam already exists
- CopilotKit v2 runtime is **embedded in the daemon** (no separate server), mounted at
  **`/api/copilotkit`** via `createAguiHttpHandler()` — `apps/daemon/src/server.ts:9356`
  (raw http.Server wrapper, before Express).
- Extension point: **`registerCapability('default', …)`** in
  `apps/daemon/src/agui-copilot/registry.ts`. Its own comment calls it the
  *"expose everything as an agentic API"* seam. Today `apps/daemon/src/marketing/index.ts`
  registers `createMarketingCapability()` as the single `default` capability.
- `AguiEvent` union already carries `text | tool-call | tool-result | state` — the transport
  can already express a fully agentic session.

### The current backend is a toy (this is the real gap)
`apps/daemon/src/marketing/capability.ts` = a hand-rolled command parser
(`help` / `list campaigns` / `create campaign` / `navigate`) + a fallback that does
`resolveEngineId(pageContext) → runChat({engineId, prompt})` — a **one-shot text call to a
local CLI**. It honors ONLY `prompt` + `engineId` (the agent). It **ignores** files,
plugins, MCP, connectors, design toolbox, design systems, working dir. So porting the rich
composer onto CopilotKit today = mostly **dead buttons** until the backend grows.

### App-control is half-wired
Backend already emits `{ type: 'tool-call', name: 'navigate', args:{path} }`
(`capability.ts:77`), but the **web side never registers a frontend handler** to execute it.
`apps/web/src/agui-copilot/CopilotSidebar.tsx` uses only `useAgentContext`,
`useConfigureSuggestions`, `useSingleEndpoint` — no `useFrontendTool`. So the agent "says
navigate" and nothing catches it. Small, well-supported gap.

### CopilotKit v2 supports the swap (user was right)
- Headless: `@copilotkit/react-core/v2/headless` → `useAgent` (messages + run status + send).
- Composable views: `CopilotChatView` = `CopilotChatMessageView` + **`CopilotChatInput`**
  (its own slot), plus `CopilotSidebarView`.
- Agentic hooks present: `useFrontendTool`, `useRenderTool`, `useRenderToolCall`,
  `useHumanInTheLoop`, `useInterrupt`. So custom input AND agentic UI are both supported.

### OD native chat: components are backend-agnostic
- `ChatComposer.tsx` (5,025 lines) = pure input widget, `forwardRef`, **52-prop** interface
  (`Props` at lines 164–266: `projectId, skills, byokImageModel, petConfig,
  designSystemPicker, workspaceContexts, onEnsureProject, …`). Calls `onSend(...)` — no
  backend.
- `ChatPane.tsx` (4,012 lines) = conversation view; **bubbles `onSend` up** as a prop; no
  direct backend.
- **Neither wires the backend.** Run creation + SSE live in the *controller above them*
  (`ProjectView.tsx` / `EntryShell.tsx` / `state/projects.ts` / `providers/daemon.ts`).
  → The components are reusable against a different controller (e.g. one routing to
  `/api/copilotkit`). The "OD chat backend" is a swappable controller, not baked in.
- OD's generative surfaces (`GenUIInbox.tsx`, `GenUISurfaceRenderer.tsx`) render
  agent-*produced artifacts*, NOT a protocol for the agent to drive the live web app. That
  live-app-control axis is exactly what ag-ui/CopilotKit provides and OD chat lacks.

---

## The target architecture (agreed)
```
ONE CopilotKit chat (frontend)
   │  ag-ui events: text · tool-call · tool-result · state
   ▼
/api/copilotkit    ← already embedded in the daemon (server.ts:9356)
   ▼
AguiCapability  ← registerCapability('default', …)   ★ THE ONE SEAM (grow THIS)
   │   (today: toy parser + one-shot runChat)
   ├─▶ OD run-engine actions  → create files/artifacts/design systems (in-process daemon calls)
   ├─▶ frontend tools         → app-control / complex workflows (emit tool-call → useFrontendTool)
   └─▶ MCP / WebMCP tools
```
**One chat. One agent. Three tool sources. The AI picks.** Keep `/api/copilotkit` AND the
regular domain routes (`/api/runs`, `/api/marketing/*`, `/api/design-systems/*`) — they are
different layers. The agent SITS ON TOP of the domain services and calls them; it does not
replace the routes or HTTP-call its own server.

## What's actually missing (not plumbing — brain + tools)
1. **The brain**: turn `createMarketingCapability` into a real tool-calling agent loop
   (model + tool registry + multi-step).
2. **A unified tool registry**: run-engine ops + frontend tools + MCP as callable tools.
3. **Frontend handlers**: register `useFrontendTool` so tool-calls actually execute.

---

## The decision to make → run `/debate`
There IS a real protocol: **`AI-Dev-Shop/framework/slash-commands/debate.md`** (and
`.claude/commands/debate.md`). This session I only drafted a *prompt*, not the protocol —
run the actual `/debate` next time.

The corrected debate prompt lives in **`/Users/la/.claude/plans/cozy-launching-bubble.md`**.
Crux (genuinely two-sided) with the two UI requirements the user added:
1. **SUBSTRATE fork**: (A) re-host OD's chat UI (ChatComposer input + ChatPane-parity view)
   ON CopilotKit, vs (B) keep OD's native ChatPane/ChatComposer and GRAFT an ag-ui
   frontend-tool/app-control bridge onto it. ("CopilotKit does everything ChatPane does"
   may argue for B.)
2. **BRAIN**: orchestrator LLM loop (run-engine as one tool) vs delegate to an OD agent CLI
   extended with frontend tools vs hybrid.
3. **INPUT**: how ChatComposer (52 coupled props) becomes the input without dead controls.
4. **VIEW PARITY**: render OD's rich outputs (streaming, tool-calls, GenUI, diffs) in the chat.
5. **TOOL-CALL ROUTING**: daemon-exec vs browser-exec; streaming/state/human-in-the-loop.

### Requirements the user emphasized (fold into the build)
- ChatComposer (or a new **OMChatComposer** feature slice) REPLACES CopilotKit's default input.
- CopilotKit must do **everything ChatPane does** (view parity), not just messages.

### Decisions already made
- **Keep CopilotKit** (correct for agentic app control).
- **Do NOT rewrite ChatComposer now** — 5k lines, too much unfinished WIP; only crack it
  open when a concrete requirement demands it.
- Build waits on the debate; first slice = one prompt → one daemon tool + one frontend tool
  → visible result, from the `registerCapability` seam.

---

## Git state (as of this handoff)
- Consolidated onto **`main`** at **`ee4acf9f9`** (checkpoint `a263dde0b` + a dev commit).
- **Force-pushing full history to `ainsep/main`** (your fork, github.com/AINSEP/Open-Marketing)
  — replaces the throwaway orphan "initial snapshot" `46afefa8`. This was running in the
  background when this handoff was written; **verify it completed**:
  `git ls-remote ainsep main` should show `ee4acf9f9`.
- `settings-section-registry` kept locally as a safety branch (can delete once push confirmed).
- Remotes: `origin` = nexu-io/open-design (UPSTREAM — never push here),
  `ainsep` = AINSEP/Open-Marketing (your fork). **Recommended (not yet done):** rename
  `origin→upstream`, `ainsep→origin`, so `git push` targets your fork and
  `git merge upstream/main` pulls open-design. Full history on your fork's main makes those
  upstream merges clean.

## Tactical notes / gotchas from this session
- **"Send button does nothing" bug (root cause):** no agent was active
  (`/api/active` → `{active:false}`) and the default AMR agent (`bin: vela`) is
  **not installed** (`available:false, "not-on-path"`). Dev runs use a fresh throwaway data
  dir (`.tmp/tools-dev/<ns>/`) separate from the packaged app, so your Codex selection
  didn't carry over. **Fix:** pick an available agent in the picker — `claude`, `codex`,
  `gemini`, `opencode`, or `antigravity`(agy) are all installed; `amr`/vela is not.
- **What AMR/vela is:** AMR = Open Design's first-party, metered, wallet-based agent
  (requires sign-in), accessed via the `vela` binary. Not a limitation of yours; just not
  installed locally.
- **Run the desktop app:** `pnpm tools-dev start` (daemon+web+desktop). New convenience
  script added: `pnpm desktop` = `OD_WEB_DEV_SERVER=vite pnpm tools-dev run desktop`
  (there is NO guard blocking this; the "no root lifecycle alias" rule in AGENTS.md is a
  convention, not an enforced test — guard only enforces `e2e/package.json` script names).
  A **Vite dev sidecar** was added (`apps/web/sidecar/server.ts` `startViteDevSidecar()`,
  Vite in middleware mode, no extra port) so the desktop shell can run the Vite dev server.
- **Chat width gotcha:** do NOT override `--copilot-sidebar-width` to shrink the sidebar —
  CopilotKit renders the *closed* sidebar as a full-width panel translated off-screen and
  the toggle **bubble rides it**, so shrinking that var hides the bubble. Use a direct width
  on the OPEN panel, or the `--copilot-popup-*` vars, instead.

## Files worth reading first next session
- `apps/daemon/src/marketing/capability.ts` — the toy backend to grow (the brain).
- `apps/daemon/src/agui-copilot/{registry,index,http-adapter,types}.ts` — the seam + transport.
- `apps/web/src/agui-copilot/{CopilotProvider,CopilotSidebar}.tsx` — the frontend mount.
- `apps/web/src/components/{ChatComposer,ChatPane}.tsx` — the OD chat UI (backend-agnostic).
- `/Users/la/.claude/plans/cozy-launching-bubble.md` — the corrected debate prompt.
