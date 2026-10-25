# OM handoff: open-marketing-3a → open-marketing-b5 (2026-10-25)

The owner started b5 to take over. 3a stays up as an adviser. Ask 3a anything over SendMessage (the session is named "open-marketing-3a").

## Read first
1. `ADS-memory/todos.md`: the whole backlog, prioritised. This is the source of truth for what's next.
2. `ADS-memory/reports/2026-10-24-om-roadmap-phases.md`: Phases 0–4 from the 4-model debate. One owner decision is open: a new `performance` slice vs extending `measure`.
3. Memory: `~/.claude/projects/-Users-la-Programming-Open-Marketing/memory/MEMORY.md`, especially these notes:
   - codex-cbm-per-run (NO indexing);
   - debate-lineup;
   - om-roadmap-phases;
   - om-design-direction;
   - owner engineering rules;
   - ask-before-heavy-test-runs.

## State at handoff
- Branch: `om/clean-slate`, HEAD `2359518`, working tree clean except `ADS-memory/todos.md`, this file and the older handoff docs.
- 2026-10-24: about 50 commits. Highlights:
  - Jini 0.6.12 upgrade (`897e15f`);
  - studio redesign DS2 R1/R2 + theme pack + picker;
  - Jini ChatPane parity pass;
  - site guide;
  - vendor credential cards (5 plugins, neutral monograms);
  - Meta OAuth; TikTok paused launch; Google v26 / LinkedIn 202610;
  - assistant tools/runtime;
  - multi-vendor model broker + usage (migration v22);
  - Higgsfield durable completion;
  - 12 new ad plugins (R1 + R2 committed): amazon, pinterest, reddit, snapchat, microsoft, x, line, naver, kakao, yandex, vk, apple-search;
  - 4 messaging plugins (R1 committed): resend-email (ported from Tovu), twilio-sms, whatsapp-business, amazon-ses.
- **Nothing is running.** Codex credits are spent until reset; the owner said: no new Codex jobs now.
- `om/clean-slate` was pushed to the private remote `ainsep` (owner allowed it once, for a cloud plan that was dropped). Do NOT push again unless the owner asks. Never `git fetch ainsep`.
- The studio dev server may still be running at http://127.0.0.1:3005 (sample data, from 3a's session). If it breaks after dependency changes:
  - run `corepack pnpm --filter @open-marketing/contracts build`;
  - restart vite with `--force` (delete `apps/studio/node_modules/.vite`).

## Codex mechanics (when credits return)
- Tooling lives in `ADS-memory/.local-artifacts/codex-runs/`:
  - `run-phase-retry.sh <abs-dir> <phase> <sandbox>` (env `WEB=1`, `IMG=`). **Never set CBM=1.**
  - `mkimpl.sh <job> <label> "<scope>" "<typecheck>" [notes]`, with `INPUTS=inputs-2026-10-24.md` (it carries the LOAD RULES line);
  - `mkreview-1024.sh` (plan review);
  - `mkcr-1024.sh` (read-only code review);
  - auto scripts `auto{review,build,cr,fix}-plugins*.sh`, plus `queue-1024.sh` (MAX concurrency).
- Flow: plan → review (Codex read-only; Claude subagents for visual/design) → build → Codex code review → fix run → **Coordinator re-runs the typecheck** → commit with explicit paths (never `git add -A`, no co-author trailer).
- Gotchas learned on 10-24:
  - Codex often reports "typecheck corrected but not rerun". Always rerun it yourself before committing. 3a committed one broken change and had to fix it.
  - `apps/server/src/composition/index.ts` and `migrations.ts` are shared by many jobs. Serialize or tell each job to keep edits localized and re-read before patching.
  - Migrations must be contiguous. The current last one is v22 (`0005_chat_backend.sql`); the next free is v23.
  - The owner allows up to ~12–16 parallel Codex jobs as long as none index the repo or run full test suites.
  - Vendor docs that block bots (Meta, TikTok, VK, Reddit, Amazon, X, Yandex, Pinterest) were read with a Claude-in-Chrome subagent. The facts are in `codex-runs/2026-10-24-*/evidence-chrome.md`.

## Owner preferences learned
- **Reuse:** Jini first. Anything reusable goes into Jini, never copied into OM. Missing pieces are Jini asks.
- **Design:** the Tovu-admin look. UI parity is judged by side-by-side screenshots. A Claude-in-Chrome pass happens before showing the owner.
- **Debates:** Opus 5.5 + Sonnet 5.5 subagents + Codex 6.1 Sol high + Gemini 4 Argon. The coordinator doesn't vote.
- **Replies:** brief. The owner uses voice dictation, so "Jenny" means Jini and "Tofu"/"Tobu" means Tovu.

## Open owner decisions
1. `performance` slice vs extend `measure` (P0).
2. Official vendor logos under each vendor's brand guidelines (currently neutral monograms).
3. Whether the new sleek black/white theme becomes OM's default.

## Safe "basic stuff" b5 can do without Codex (suggested by 3a)
- **Housekeeping:** commit `ADS-memory/todos.md` and the handoff docs (docs commit, explicit paths). Add `ADS-memory/tmp/` to `.gitignore`. Delete `/Users/la/Programming/autofix.log`, a stray log written by 3a's script.
- **Verification, read-only, light:** run per-package typechecks for the 16 new plugin folders (`corepack pnpm --dir content/agent-plugins/<p> typecheck`, one at a time) and list failures in todos.md.
- **Agent Plugins 1.0.0 sweep:** an exact mechanical change, safe by hand. Set `$schema` to the published 1.0.0 URL in every `content/agent-plugins/*/plugin.json` and `mcp.json`, and update `PLUGIN_SCHEMA`/`MCP_SCHEMA` in `features/plugins/src/portable.ts` and the fixtures. Then typecheck `@open-marketing/plugins`.
- **Owner Q&A:** answer questions about state from todos.md and the roadmap.
- Do NOT start the roadmap phases, the Jini infra swap or a test pass without the owner.
