# Handoff — Open Marketing build kickoff (2026-10-01, session open-marketing-e5)

## State at handoff
- **Repo reset:** Open Design was removed. History was replaced with one commit, `afb04b10` "Open Marketing: initial commit", on branch `om/clean-slate`. The `ainsep` remote (GitHub AINSEP/Open-Marketing) is untouched: its `main` still has the old history. **Don't `git fetch ainsep`** (it would re-download about 1.6 GB). Nothing is pushed.
- **Backups:** `~/Programming/OM-backups/2026-10-01-pre-wipe.tar.gz` (uncommitted work) and `2026-10-01-om-history.bundle` (the 5 OM-only commits plus 2 branches).
- **Architecture:** `ADS-memory/reports/2026-10-01-om-target-architecture-v2.md` is authoritative (v1 is superseded).
- **Running when the session paused (the owner said "don't start anything else"):**
  - **j00 skeleton** (Codex gpt-6.1-sol high): workspace, gates, 4 app shells, contracts, 12 feature contracts, plugin skeletons. It was near the end: lint green, 51 gate fixtures passing. It is NOT committed; the Coordinator commits after review. The sandbox couldn't run `git mv`, so moves happened in the working tree.
  - **safety feature** (Codex): started early as the first feature for owner review.
  - Results are copied on completion to `ADS-memory/.local-artifacts/codex-runs/2026-10-01/` (j00/, features/<name>/{prompt.md,result.md,run.jsonl}, research/).
- **The auto-launcher of the remaining features was DISARMED.** Don't relaunch without the owner.

## UPDATE overnight: j00 was KILLED at its 2-hour background limit
- It had no final result.md. The work is on disk.
- Its last progress message: 73 conformance tests pass; lint has no source-rule failures; the only lint failure is missing media-library build provenance. **The media-library expanded contract fails typecheck/build.** That breakage comes from the early media-library Codex job the Coordinator started and then stopped mid-run (its half-written files are in features/media-library/). It was "completing pinned dependencies and handoff records" when killed.
- Fix first: reset features/media-library to a consistent contract (or re-scope it onto @jini-ai/cms/media, per step 3 below), then rerun `corepack pnpm om:check` and finish j00's verification and handoff with a short Codex job. Don't rerun all of j00.
- **The safety job COMPLETED successfully** (before its cap). 123 tests pass across memory and ephemeral SQLite. Typecheck, build, lint and boundaries pass for safety, plus 73 workspace gate tests; coverage is 100% statements/functions and 84% branches. Usage guide: features/safety/README.md; full report: features/safety/HANDOFF.md. Its NEEDS: the server SQLite/Jini shim, durable approval/evidence adapters, jobs/credentials integration, review UI/CLI wiring and lockfile reconciliation. The whole-repo `om:check` is still blocked by the media-library breakage above. The run artifacts were copied to ADS-memory/.local-artifacts/codex-runs/2026-10-01/.
- When relaunching Codex jobs, use a 2-hour max timeout and keep jobs small, or detach them, so long jobs aren't killed.

## Next steps (in order)
1. Review j00's result.md. Run `corepack pnpm om:check` yourself. Check whether j00 wired PGlite: the owner chose **SQLite** (PGlite measured ~350 MB vs ~6 MB). Fix the db driver in one place if needed. Commit j00 (OM work only, no co-author trailers).
2. Review the safety result. Show the owner its plain-English summary and usage example for feedback.
3. **Before relaunching media-library and creative:** add `@jini-ai/cms` (published, `./media` and `./media/import`) and `@jini-ai/integrations` (published, `./media-providers`) in ONE install, then re-scope both as thin OM layers. media-library builds on cms/media (OM adds provenance, cost, rights and ad-placement crop presets). creative builds on media-providers (async generation jobs). They are marked HELD in the run folder.
4. Add "check published @jini-ai/* first; report what you reuse" to every remaining feature prompt, then launch the rest with the owner's go. The owner wants all of them in parallel (prompts are in the run folder; launcher: `run-features.sh` skips `started`/done jobs).
5. **Research to verify** (`research/google/result.md`, `research/meta/result.md`):
   - Google: the report claims developer tokens were sunset on 2026-09-09 and that new integrations face `UploadClickConversions` restrictions. Verify against primary docs before the google-ads plugin design.
   - Meta: its docs were blocked (403/429/login), so its claims are partly unverified.

## Owner decisions this session (binding)
- Apps: studio, desktop, server, plus a separate agent process. Features live in top-level `features/`, imported by package name only.
- Complexity: cognitive ≤10 and nesting ≤3 as errors; cyclomatic reported only.
- No budget envelope. Halt allows stop-only pause calls. Conversions run as a typed server process. The production backend is always-on. The desktop default is local sandbox.
- Image generation: a $10/day allowance that resets at midnight in the owner's **local** time.
- Schema: reorganize freely (`0001_spine.sql` was never applied). DB: **SQLite**.
- Plugin namespace: `io.github.ainsep.openmarketing`.
- Engineering principles B1–B8 are ratified (now in AI-Dev-Shop a896c71). The full owner rule list is in `development/COMMON.md`.
- Use Codex gpt-6.1-sol (high) for most work; the owner wants to use up Codex quota.

## Peer sessions
- tovu-e2: owns the Tovu→Jini extraction (oauth, mcp/federation, platform/secrets, agent-plugins/lifecycle, identity). Nothing is published yet.
- tovu-0d: the @jini-ai/db lane.
- ai-dev-shop-4a: engineering-principles integration (done, pushed).
