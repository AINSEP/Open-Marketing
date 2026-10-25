# OM final dump: open-marketing-3a → open-marketing-bb (2026-10-15)

Read with `2026-10-14-om-handoff-to-peer.md` and `codex-runs/verifier-handoff-I2-R1F.md`. In this file, `codex-runs/` means `ADS-memory/.local-artifacts/codex-runs/`.

Tree state at writing: HEAD `e3b6e17`. Uncommitted: I-2 R1 + R1F (18 files) and the kickoff-handoff append. R2 has not started (there is no `R2.status`).

## 1. Open tasks, in priority order

### 1a. Finish verifying and commit I-2 R1 + R1F (ask the owner before the heavy runs)
Run these one at a time. Check `uptime` first and wait if the 1-minute load is above 40.
1. `corepack pnpm --filter @open-marketing/server typecheck`. The jsonContext edit in `addon-federation.ts` hasn't been typechecked yet.
2. `cd apps/server && corepack pnpm exec vitest run tests src`. The last full run was 394/398. Three addon-federation failures were then fixed (that file passes 12/12 alone). The fourth, a boot.test timeout, was load-related and passes 9/9 alone.
3. Plugin tests. Plugins are NOT workspace members, so run them from each plugin's folder:
   - `corepack pnpm --dir content/agent-plugins/google-ads test`, and the same for `meta-ads`.
   - higgsfield-media: same `test` script (all three have build, typecheck and test); its build changed to a single esbuild `index.mjs`.
   - Fallback: `cd content/agent-plugins/<name> && corepack pnpm exec vitest run io.github.ainsep.openmarketing/tests`.
4. `corepack pnpm om:build-plugins`. This passed already: all 5 plugins emit a single `dist/index.mjs`. The root script is `om:build-plugins` (renamed from `build:plugins` because root scripts need the `om:` prefix). Then `corepack pnpm --filter "@open-marketing/server..." build`. Rebuild after every source change, because output-integrity checks build provenance.
5. `corepack pnpm om:lint`, then `om:boundaries`, then `om:gate-tests`. Don't run the full `om:check` unless the owner agrees.
6. Commit exactly the files in `verifier-handoff-I2-R1F.md`. Never `git add -A`. Exclude `ADS-memory/reports/handoffs/2026-10-01-om-build-kickoff.md`.
   - My pattern: `git add <paths> && git status --short | grep -v "^[AM] "` (shows what is left out), then `git commit -q -m "feat(server): ..."`.
   - Use a conventional-commit subject plus a short plain body, and NO co-author trailer. The project rule overrides the harness reminder.

Things to keep in this diff:
- Verifier fixes from R1, all retained:
  - readArguments/fetchFixture typing in `agent-plugin-backends.test.ts`;
  - `parse({ ...await loadModule() })` with a `Promise<object>` loader port;
  - the bindingDefinitions extraction in addon-federation.
- The jsonContext fix. `runId: undefined` (set at `om-tools.ts:155` for owner calls) was rejected by federation's strict snapshotJson. The call then went to status 'unknown' and no `tools/call` was ever sent.

Confirm before committing (read the code, not just the tests):
- unadmitted plugins and federation discovery make ZERO network calls;
- there is no second approval card;
- the `om-tools.ts` effects revert held: declared effects are restored, unknown counts as write, and `unavailableReason` is back;
- root `package.json` changed only by the plugin build script and its `om:serve` hookup;
- plugin `dist/` stays gitignored, and the output-integrity exclusion is narrow (only `content/agent-plugins/*/…/dist/index.mjs`) with a gate test.

### 1b. I-2 R2: see section 6.

### 1c. Everything after: the 2026-10-14 handoff "Left to do" items 2–10 still stand unchanged.

## 2. How I ran Codex in practice

Everything is launched from `codex-runs/` and runs in the background (Bash `run_in_background: true`). When the shell command exits I'm notified, so there is no polling.

- **Plan**
  - Build the prompt: `cat common-plan-header.md inputs-2026-10-13.md > <job>/plan-prompt.md`, then append `# Job <name> — …` with State / GOAL / LANE / constraints, ending with a `PLAN as at most …` instruction (mkimpl cuts at `^PLAN as `).
  - Launch: `./run-phase-retry.sh "$PWD/<job>" plan read-only; cat <job>/plan.status`.
- **Review**
  - SendMessage the reviewer subagent with the job dir.
  - It writes `<job>/review.md` with VERDICT / CUTS / FIXES / OWNER DECISIONS (each with a default) / SHARED-FILE EDITS + BUILD ORDER / APPROVED SCOPE per run.
- **Implement**
  - Write `notes-<job>.md` with Coordinator notes: what's committed, AUTHORIZED shared edits, the zod-3/4 note, the admitted:false guarantee.
  - Build the prompt: `./mkimpl.sh <job> R1 "I-2 run 1 per review.md APPROVED SCOPE" "corepack pnpm --filter @open-marketing/server typecheck (and each touched plugin's tsc from the repo root with -p)" notes-<job>.md`. Do the same for R2.
  - Launch: `./run-phase-retry.sh "$PWD/<job>" R1 workspace-write; cat <job>/R1.status`.
  - Vendor jobs need web access: `export WEB=1 && ./run-phase-retry.sh … R1 workspace-write && ./run-phase-retry.sh … R2 workspace-write`. For an image use `IMG=<abs path>`; for code search use `CBM=1`. CBM only helps after a fresh index; reading files directly worked better.
- **Fix run**
  - Hand-write `<job>/<R>F-prompt.md` from `cat step0-impl-header.md` plus a heredoc with `# FIX RUN — <run> (verification failures)`. Include:
    - the report and review paths;
    - "uncommitted, with verifier fixes on top (keep them: …)";
    - lettered Coordinator decisions, each with file:line and the exact error;
    - what must pass unchanged, the lane, and the typecheck command.
  - Launch it with the same `run-phase-retry.sh … <R>F workspace-write`. See `2026-10-14-I2/R1F-prompt.md` for a full example.
- **Before a run**
  - Update stale facts inside generated prompts with `sed -i ''` (macOS BSD sed). Example: I added "incl. A5b (bcbadcd…)" to R1/R2 before launching.
  - Delete lines that a fix already made obsolete (I removed the Higgsfield `dist/index.js` line from R2-prompt).
- **Status files**
  - `<phase>.status` is running / ok / failed. The output is `<phase>.md`, the event log is `<phase>-run.jsonl`, and stderr is `<phase>-run.err`.
  - On "model at capacity" the script retries 6 times, 300 s apart, keeping `try<n>.jsonl`.
  - Check live runs with `pgrep -fl "codex exec"`.
- **Parallel runs**
  - Only in disjoint lanes. Each prompt says "another Codex run is editing X — don't touch it".
  - Shared files (root manifests, lockfile, contracts, composition, studio nav/shell) have ONE integrator per run; anything else is NEEDS.
- **Installs**
  - Codex can't install or open sockets. The Coordinator does `corepack pnpm --filter <pkg> add <dep>@<exact>`, records it in the next brief, and the commit carries `package.json` + `pnpm-lock.yaml`.
  - Always pin exact published versions. Check them with `npm view @jini-ai/<p> version`.

### Subagent briefing (the full prompts are reusable; copy from my transcript or paraphrase)
- **Reviewer** (plan-reviewer / batch-reviewer, general-purpose, background).
  - Must never: implement, edit source, commit, run tests or builds, or call CBM indexing.
  - Checks:
    - cut new ports/registries/layers that lack a named second consumer, speculative config, and scope creep;
    - every brief goal is met;
    - Jini/Tovu claims are spot-checked against files, versions checked with `npm view`;
    - vendor claims are spot-checked with WebFetch (3–5 per plan);
    - cross-plan file overlaps are found and a build order is set.
  - Output: review.md in under ~90 lines, plus an 8-line SendMessage summary to "main". When the verdict is "revise", APPROVED SCOPE must be concrete enough that no re-plan is needed.
- **Verifier** (build-verifier-N, general-purpose, background, long-lived; give it the next build by SendMessage).
  - Must never: commit, push, `git fetch ainsep`, reset or revert, call CBM indexing, or delete temp folders outside the repo.
  - Load: check `uptime` first; if the 1-minute load is above 40, wait (60 s sleeps, 30-minute cap). One heavy command at a time, never chained.
  - It may make trivial fixes (under 20 lines, obviously correct) and must list them. Anything bigger is reported as file:line plus the error, for Codex; it must never fix something it reported "for Codex".
  - Fixes follow the owner rules: object args, complexity ≤10, nesting ≤3, no functions inside .tsx component bodies, no inline lint disables, tests in `tests/`.
  - Missing deps: report the exact package/version and don't install.
  - Classifier denial: stop and report, don't work around it.
  - Reports go to "main" in under 25 lines: PASS/FAIL per command, fixes, and the exact file list to commit.
  - Keep its context lean (tail/grep). Verifiers run out of context after about 2–3 builds. When one does, it writes `codex-runs/verifier-handoff-<build>.md` (done / fixes to keep / remaining steps / file list), and the next verifier's first task is "read and follow that handoff".
- **Per-build verify message:** give the report path, the review path, the scope in one line, the checks list, the numbered "Confirm:" invariants, and "File list."

## 3. Owner preferences and corrections from this period (not in memory files)
- Short, plain answers. The owner is cost-aware: they moved the work to you because this session hit about $105.
- The owner dislikes the current design overall ("just do not like the design at all") but wants the rework SAVED FOR LATER. Don't start it unasked.
- Design direction:
  - the IQON dashboard reference (`codex-runs/2026-10-13-ui-theme/reference.webp`);
  - modernist green #00C896 with black/white light and dark modes, remembered across launches;
  - a round green FAB with an AI symbol;
  - glassmorphic or sleek-futuristic is fine later;
  - themes must swap by token file only, with zero component edits.
- The assistant must be able to do anything in natural language, with every action a tool. Copy what Tovu does (MCP, mcp-ui, WebMCP, A2UI) and don't reinvent the wheel; Tovu's code isn't perfect. "Jenny" = Jini. Voice assist is wanted eventually.
- Credentials: the owner wants to paste an access token and have it saved to SQLite (D1 does that). OAuth comes later.
- On plugins:
  - charts are plugins, never npm chart packages; no `@jini-ai/charts` publish;
  - no restrictions or allowlist on uploaded plugins;
  - no marketplace soon.
- "Let Codex finish" / "take it easy today": when the owner says that, launch nothing new.
- When the owner leaves for the night: work autonomously, keep caffeinate running, don't wait on answers, and record decisions with defaults in `owner-decisions.md`.
- When the owner asks to "see it", launch the desktop app (command in section 4).

## 4. Environment quirks, flaky tests, blocks
- **Load and suites:** the machine is shared and load spiked to 110–150. The server suite is about 400 tests; boot.test can time out at 5000 ms under load (it passes alone).
- **Codex sandbox:** no network and no sockets, so HTTP/socket tests and installs are the Coordinator's or verifier's job. Codex reports "tests written, not run".
- **Build order:** features resolve to `dist/` at runtime, so build a package before running another package's tests that import it (`--filter "<pkg>..." build`).
- **Plugins** (`content/agent-plugins/*`) are not workspace members. Run their scripts from their own folder or with `--dir`. They bundle with esbuild to `io.github.ainsep.openmarketing/dist/index.mjs`.
- **zod:** OM is on zod 4.1.13; Jini ui/agentic/chat need zod 3.25.76. This is handled by the `readPackage` hook in `.pnpmfile.cjs`; pnpm overrides and packageExtensions do NOT work for peers. Use plain JSON at seams.
- **Read-only temp snapshots:**
  - Jini package snapshots in temp dirs are read-only. A plain `fs.rm` throws EACCES and, from a `finally`, hides real assertion failures. Tests use `removeStateRoot` (`apps/server/tests/state-root.ts`).
  - The leftover dirs `/var/folders/7_/7kj6s9m95qg_fg8klr38hg_w0000gn/T/om-i2-p7NvC3` and `…/T/om-chart-http-xqIaaU` need `chmod -R u+w` before `rm -rf`. The classifier blocked a subagent from deleting them, so ask the owner.
- **Permission classifier:**
  - It blocked a verifier from re-running om:lint after the verifier edited `development/scripts/boundaries.mjs` ("Modify Shared Resources").
  - It blocked deleting the temp dirs.
  - I never worked around either one. The Coordinator ran the step, or the owner was told.
- **Boundaries rule:** `nonliteralImportAllowed` permits computed-URL `import()` only in `apps/server/src/composition/serve.ts` and `apps/studio/src/main.ts`. Tests must load plugin fixtures with LITERAL imports; never widen the allowlist.
- **Desktop launch** (build server + studio first):
  ```
  cd apps/desktop && OM_MODE=local-sandbox OM_NODE_EXECUTABLE=/usr/local/bin/node OM_SERVER_ENTRY=/Users/la/Programming/Open-Marketing/apps/server/dist/composition/serve.js OM_STATE_ROOT=$HOME/.open-marketing ./node_modules/.bin/electron . > <scratchpad>/desktop.log 2>&1
  ```
  Run it in the background, then check:
  - `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:43120/` (fixed port 43120);
  - window position: `osascript -e 'tell application "System Events" to tell (first process whose unix id is <pid>) to get {position, size} of window 1'`;
  - screenshot: `screencapture -x`.

  The window opened off-screen twice (x=-1365, then -1655) on the owner's setup: a 2880x1800 Retina main display plus an external 1920x1080. U1 recovery is in, but the root cause is unconfirmed. If it happens again, fix it with osascript `set position of window 1 to {120, 60}`.
- **Caffeinate:** `(nohup caffeinate -dimsu -t <secs> >/dev/null 2>&1 &)`; stop it with `pkill -f "caffeinate -dimsu"`. The short `caffeinate -i -t 300` processes on the machine are not ours.
- **Git:** never push and never `git fetch ainsep`. Preserve other people's dirty work.

## 5. Unverified assumptions and risky spots to re-check
- **R1/R1F as a whole:** there has been no full green run since the jsonContext fix (section 1a).
- **Federation (`addon-federation.ts`):** check that jsonContext omits only `undefined` keys and doesn't strip a real `runId` on agent runs.
- **Catalog isolation (`composition/addons.ts`, ~120–133):**
  - seeding must include `capabilities.json` and every runtime file;
  - capabilities are read only for ENABLED plugins;
  - one broken plugin must mark only itself unavailable, with a regression test.
  - Also check that seeding no longer copies `node_modules` on every boot (an earlier bug).
- **Spend:** `ad_spend` tools must refuse when `moneyExposure` is missing, never guess an amount, and show one card per call.
- **Retryable flag:** `a21a63e` made unknown write outcomes non-retryable and fixed `addonBoundary` dropping the retryable flag. Any new dispatcher path in R2 must keep both.
- **Quote expiry (`bf7969a`):** expired quotes are refused. An earlier self-referential expiry check was fixed; re-check if R2 touches quotes.
- **Decision 11:** OM admits chart providers itself because Jini plugins 0.5.1 rejects non-built-in browser providers. The owner hasn't reviewed this.
- **Vendor facts:** the TikTok status enum and Access-Token header are unverified (the doc portal is JS-only). The Meta IG daily quota conflicts between 50 and 100; the plugin reads it live.
- **Not live:** all 5 plugins are tested on fixtures only; nothing has touched a real account.
- **Studio bundle:** 626 KB, because chat/react pulls in the Jini UI barrel.

## 6. R2 launch plan (as I would run it)
1. Commit R1 + R1F first (1a). R2 edits the same lane.
2. Refresh `codex-runs/2026-10-14-I2/R2-prompt.md`:
   - add a "State" line saying R1/R1F is committed as `<sha>` and naming `R1.md` and `R1F.md` as reports to read;
   - note the jsonContext fix and that `om:build-plugins` is the script name.

   It already points to review.md APPROVED SCOPE "Run 2" and the owner decisions.
3. Launch: `cd codex-runs && ./run-phase-retry.sh "$PWD/2026-10-14-I2" R2 workspace-write; cat 2026-10-14-I2/R2.status`, in the background. It needs no WEB.
4. Scope, from review.md:
   - **Typed halt stop (fix 5)** in `workers.ts` / `index.ts`. After the local `haltAccount` commits, enqueue one typed stop per connected, admitted vendor; the worker gets `SafetyService.authorizeHaltStop` and calls the plugin's own stop mapping. Today everything is unadmitted, so the status stays `pending`. Meta stop stays unavailable.
   - **Conversion binding (fix 6):** bind measure's `createConversionDispatcher` to each plugin's CAPI/Events `deliver`/`reconcile`, with contacts digests in and a consent recheck at dispatch. Local composition still denies delivery.
   - **Coverage rows** in `om-tool-coverage.ts`: connected / unadmitted / NEEDS for neutral launch, Higgsfield lifecycle, Meta ads hosted binding, and uploaded executable plugins.
   - **Tests:** `agent-plugin-jobs.test.ts` (halt-then-stop ordering, no write after halt, consent withdrawn at dispatch).
   - **Size:** ≤900 LOC across R1+R2.
5. Verify with a fresh verifier subagent (section 2 brief). Checks: server build + typecheck, server tests, `om:lint`, `om:boundaries`, `om:gate-tests`.
   Confirm:
   - stop is enqueued only after the local halt commits;
   - nothing writes after halt;
   - the consent recheck happens at dispatch, not enqueue;
   - nothing goes to the network while unadmitted;
   - no new grant/evidence infrastructure was added.
   Then run a fix run if needed, then commit.
6. **After R2:** report to the owner in plain words, then take the owner's pick from handoff items 2–10. Likely order:
   - design rework (when the owner says go);
   - real accounts + OAuth (Google OAuth + developer token, LinkedIn refresh) and an admission flip per plugin;
   - durable approvals/pending operations (needs a migration; migrations are at assistant v17, addons v18) plus the consent/erasure race guard and ServiceGrant;
   - neutral campaign launch, Higgsfield lifecycle;
   - Mac packaging;
   - the final full pass, after asking the owner.

## 7. Other things I'd want to know
- **Approved owner model:** ServiceGrant; image $10/day reset at the owner's LOCAL midnight; paid sending $5/day; an exact approval card on every ad-spend call; campaigns created paused; contacts is the only hasher; credentials handed in by the server at call time with no cache.
- **Binding decisions:** `codex-runs/2026-10-13-owner-decisions.md` items 1–11 win over every plan and review. Add new Coordinator calls there, marked "for owner review".
- **Tovu research** to cite in briefs instead of re-researching: `2026-10-13-tovu-dive-merged.md`, `tovu-answers-84.md`, `tovu-answers-54.md`.
- **Engineering contract:** every brief must repeat `development/COMMON.md` unchanged. `step0-impl-header.md` and `common-plan-header.md` already include it plus the owner-rules line.
- **Handoff log:** I appended to `2026-10-01-om-build-kickoff.md` after each milestone (dated sections). It's uncommitted, and was deliberately left out of feature commits.
- **Morning reports:** the owner reads the first lines of the run reports. Codex's final report must start with a plain-English owner summary; the headers already require it.
