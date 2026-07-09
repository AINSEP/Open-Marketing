# Handoff — agui-copilot chat (2026-06-30)

## TL;DR
The ag-ui / CopilotKit chat is **wired end-to-end and works when driven through the
daemon API**, but the **frontend chat currently fails** with:

```
[CopilotKit] Error (agent_run_error_event): Error: engine exited 1:
event: {type: 'RUN_ERROR', message: 'engine exited 1: '}  agentId: 'default'
```

This is **not** a transport/adapter bug (those are fixed). It is the local CLI
engine (`claude` / `codex`) **exiting with code 1 and empty stderr** on the
freeform path, in the environment where the user's daemon runs. Still needs fixing.

## What works (verified this session, no browser — pure curl)
Against the dev daemon on `:17456` (launched via tools-dev from a normal shell):

- `POST /api/copilotkit` built-in command `help` → streams real `TEXT_MESSAGE_CONTENT`, no error.
- Freeform `what model are you?` → `"I'm Claude (Opus 4.8), running inside Open Marketing…"`.
- Freeform `what is a good launch tagline?` → full multi-paragraph Claude answer.
- `which claude codex gemini` → all present (`/usr/local/bin/claude`, `~/.npm-global/bin/{codex,gemini}`).

So the registry, the neutral capability port, the ag-ui adapter, the CopilotKit
runtime, the raw-http mount, and content-type normalization are all good. The
`clone()` regression (custom `capability` field dropped on per-run clone) is fixed.

## The remaining bug: `engine exited 1:` (empty stderr)
Origin: `apps/daemon/src/marketing/engine.ts` → `runCliEngine` → `runProcess`:

```ts
child.on('close', (code) => {
  if (code === 0) resolve(stdout.trim());
  else reject(new Error(`engine exited ${code ?? 'null'}: ${stderr.trim().slice(0, 300)}`));
});
```

`engine exited 1: ` with nothing after the colon ⇒ the spawned CLI exited 1 and
wrote **nothing to stderr**. The freeform path reaches the engine (so detection
+ resolveEngineId succeeded and a binary WAS found and run — otherwise the error
would be `No local engine is available` or `not available on this host`).

### Why it reproduces for the user but not here
The daemon I tested was launched from an interactive shell via
`pnpm tools-dev run daemon` → it inherits the full PATH **and** an authenticated
`claude` session. The user runs their own daemon (note: `apps/daemon/package.json`
now also exposes an `om` bin — rebrand in progress) in "another window", likely
with a **different environment**. `claude -p` exiting 1 silently most commonly
means, in order of likelihood:

1. **Auth / session not present in the daemon's env** — `claude` not logged in,
   or `CLAUDE_*` / config dir not visible to that process. (Often exits 1; the
   "please run /login" notice can go to stdout, not stderr → swallowed.)
2. **Usage/rate limit or quota** hit on that account → exit 1.
3. **Stripped PATH / different cwd** when launched via the `om` bin / packaged /
   GUI launcher (the daemon-data + PATH contract differs from a terminal launch).
   See AGENTS.md "Daemon data directory contract" and the detection.ts PATH caveat.
4. **Concurrent invocations** — the user pasted the error 3×; CopilotKit may fire
   multiple runs and `claude -p` instances could collide. Lower likelihood.

The blocker to diagnosing is that **`engine.ts` throws away the real signal**:
`claude -p` prints errors/login prompts to **stdout** (or just exits), but
`runProcess` only includes `stderr` in the error. With empty stderr we're blind.

## Recommended fix sequence (next session)
1. **Make the failure legible first (cheap, do this before guessing).** In
   `apps/daemon/src/marketing/engine.ts` `runProcess`, on non-zero exit include:
   the resolved **binary path**, the **args**, the **exit code**, AND a tail of
   **stdout** (not just stderr). Re-run the same curl and read the real cause.
   - Test with: `curl -sN -X POST http://127.0.0.1:<port>/api/copilotkit -H 'Content-Type: application/json' -d '<agent/run body, content "what model are you?">'`
     (full body shape is in this file's git history / the old captured request).
2. Once the cause is visible, fix accordingly:
   - If auth: ensure the daemon process can see the user's `claude` login (env /
     home dir), or surface a clean "engine not signed in" message instead of a
     raw exit-1, and ideally fall back gracefully.
   - If PATH/env (om/packaged launch): align the launcher env with what detection
     expects (login-shell PATH probe), per the detection.ts caveat.
3. Consider routing the freeform path through Open Design's **own** agent runtime
   later instead of shelling `claude -p` — but that's a bigger change; not needed
   to unblock.

## Do NOT use Playwright MCP to debug this
It burns tokens for little gain here. The bug is server-side and reproducible with
a single `curl` to `/api/copilotkit`. Drive the API directly and read the streamed
SSE body (look for `"type":"RUN_ERROR"` / `"type":"TEXT_MESSAGE_CONTENT"`). NOTE:
an HTTP 200 on this endpoint only means the SSE stream opened — the real outcome
is an event *inside* the body. Always read the stream content, not the status.

## Architecture (so you don't re-derive it)
ag-ui/CopilotKit is the **system-wide agentic interface** (not a marketing feature);
the marketing assistant is just the first registered capability. All CopilotKit /
ag-ui imports are confined behind the adapter.

Daemon — `apps/daemon/src/agui-copilot/` (the only place importing `@copilotkit/*` / `@ag-ui/*`):
- `index.ts` — public API: `createAguiHttpHandler()`, `registerCapability()`
- `registry.ts` — `registerCapability(id, description, capability)` (extension point)
- `types.ts` — the neutral `AguiCapability` PORT (`run(input) → AsyncIterable<AguiEvent>`)
- `agent/base.ts` — `CapabilityAgent` (neutral events → ag-ui). Has the `clone()` override that preserves `capability` (DO NOT remove — ag-ui clones agents per run).
- `agent/events.ts` — ag-ui emit helpers
- `runtime.ts` — builds `CopilotRuntime` from the registry
- `http-adapter.ts` — raw-http match for `/api/copilotkit` + content-type normalization

Daemon — `apps/daemon/src/marketing/` (one capability):
- `capability.ts` — assistant logic, yields neutral events (type-only dep on the port)
- `index.ts` — `registerCapability('default', …)` (side-effect import in server.ts)
- `engine.ts` — CLI detection + `runChat`/`runCliEngine` ← **the failing piece**
- `campaigns.ts` — in-memory store

Daemon wiring — `apps/daemon/src/server.ts`:
- `import './marketing/index.js'` (registers capability) + `import { createAguiHttpHandler }`
- The Express app is wrapped in `createHttpServer((req,res) => aguiChat.matches(url) ? aguiChat.handle(req,res) : app(req,res))` so CopilotKit gets the **raw** Node req/res (Express middleware reshapes it → 415). Built once, after registration.

Web — `apps/web/src/agui-copilot/`:
- `CopilotProvider.tsx` (wraps `CopilotKitProvider`, runtimeUrl `/api/copilotkit`, imports styles + `copilot-theme.css`)
- `CopilotSidebar.tsx` (sidebar + suggestions + page context)
- `index.ts`; consumed by `App.tsx` (no `@copilotkit` import in App.tsx)

## How to run (lean: daemon-only + Vite, avoids Next's memory hog)
```bash
# daemon (whitelist the Vite origin so non-chat /api mutations aren't 403'd)
OD_ALLOWED_ORIGINS=http://localhost:5274 pnpm tools-dev run daemon --namespace agui --daemon-port 17456
# vite UI → point /api at that daemon
OD_DAEMON_URL=http://127.0.0.1:17456 pnpm --filter @open-design/web dev:vite   # serves http://localhost:5274
```
- Origin gate lives in `apps/daemon/src/origin-validation.ts` (env `OD_ALLOWED_ORIGINS`, exact-version'd).
- `/api/amr/models` 500 under Vite is unrelated (AMR/vela not signed in) — ignore.

## Validation commands
- `pnpm --filter @open-design/daemon build`
- `pnpm --filter @open-design/web typecheck`
- `pnpm guard` (currently 55/55; keep dep specs EXACT — no carets)

## Other open work (not chat)
- **SettingsDialog refactor (#2):** only relocated into `apps/web/src/components/settings/`
  (monolith moved + re-export shim + empty `sections/`). Real section extraction TODO.
- **Comment-out/swap OD→marketing (#3):** not started. Per `todo.md`: comment out
  (don't delete) OD content, swap marketing equivalents. (Rebrand already in flight:
  `om` bin, "Open Marketing" copy in the sidebar.)

## Tools
- `codebase-memory-mcp` is healthy (project `Users-la-Desktop-Programming-Open-Marketing`,
  ready) — use it for structure instead of grepping the 9.4k-line server.ts.
- Memory note `feedback_port-from-working-reference.md` captures the recurring
  "read the stream content, not the HTTP status" + "ag-ui clone drops custom fields" lessons.
