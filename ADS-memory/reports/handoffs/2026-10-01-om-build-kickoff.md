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

## UPDATE 2026-10-02 morning
- j00 finished (j00-finish job) and was committed with safety as 59db645. om:check reported green, with 310 tests across 18 packages.
- 11 remaining feature jobs launched in parallel in NO-TEST mode (owner's call: a final Codex gpt-6.1-sol agent runs all tests and fixes issues at the end). Run folder: ADS-memory/.local-artifacts/codex-runs/2026-10-02-features/<name>/ (status: ok|failed).
- Codex credits may run out mid-batch; they reset at 10:00 local. Failed jobs keep their files on disk. Relaunch them with a "continue from what's on disk" prompt, not from scratch.
- Owner decision: lifecycle messaging delivery goes through vendor PLUGINS (Twilio, AWS SES/SNS, SMTP and other outside senders). The generic messaging features (journeys, messaging ledger, deliverability, preferences, templates) come later.
- 10:05 relaunch of the 9 interrupted jobs failed immediately. Codex reports "usage limit … try again at Oct 8th, 2026 6:11 PM" (a weekly limit, NOT a 10:00 daily reset). A few runs also logged "invalid peer certificate: UnknownIssuer" reconnect errors. Continuation prompts are ready in each job folder (prompt.md has the CONTINUATION section; first-attempt logs are in attempt1/). Partial work is committed in 3e2648f.

## UPDATE 2026-10-12
- All 12 core features, 3 plugin cores (higgsfield, google-ads, meta-ads) and the studio shell are committed (8d0b12a, 13bbfa9). Tests are written but not run.
- Debate A (MVP: contacts, web-events, forms, privacy + step 0) and Debate B (post-MVP: 7 packages) are synthesized: ADS-memory/.local-artifacts/swarm-consensus/runs/2026-10-12-om-{next,later}-features/consensus-report.md
- Owner approved: the ServiceGrant model for unattended workflows (approve once, with caps) and a $5/day paid-sending allowance.
- agy hit its individual quota; both agy jobs produced nothing. Parked until the quota resets.
- Jini: tovu-85 is adding Agent Plugins v1.1 support to @jini-ai/agent-plugins; publishing awaits owner OK.
- Next: step 0 on Codex (Debate A scaffold + transaction spike + golden tests + Debate B Tier A reservations A1–A9).

## UPDATE 2026-10-12 night (open-marketing-17 took over from open-marketing-d5)
- Owner: work autonomously overnight; don't wait on answers. caffeinate -dimsu running 15h. d5 stays open as advisory only (no work).
- New owner rule: every Codex job goes plan-only → Claude over-engineering review → implement the approved plan.
- @jini-ai/agent-plugins 0.4.4 published (spec 1.0 + 1.1). OM pins exactly 0.4.3 in features/plugins; the bump goes in the next install.
- Data-model review: codex-runs/2026-10-12-datamodel-review/{result.md,coordinator-review.md}. Step 0 split: 0a DB bridge + global UUID workspace IDs ∥ 0b measure amendment → 0c scaffolds + spike + golden + Tier A.
- Running: wave3 plans (studio-pages, desktop, google-ads-dm, meta-ads-capi, om-cli) in codex-runs/2026-10-12-wave3/; step0a/step0b plans.
- 23:10 the Mac crashed mid-run (load was ~220 earlier). Three jobs had already failed with Codex "model at capacity". Partial work stayed on disk.
- 23:35 relaunched as continuation attempts via codex-runs/overnight.sh: batch A (step0a, step0b, google-ads-dm, om-cli) → batch B (desktop, meta-ads-capi, studio-pages). run-codex-retry.sh retries capacity failures 4× with 5-min waits. Attempt-1 logs are in each job's attempt1/. Next: review + commit each lane; step0c plan after 0a.
- Overnight commits on om/clean-slate: cbd11e0 step0a · 80f218f google-ads Data Manager · 0128c8c om CLI · f32c3e1 step0b measure · e852b24 desktop · 212c6a4 meta-ads CAPI · 2b6f905 studio pages · 376c406 step0c run 1 (scaffolds + Jini kernel + install). Each lane typechecks; tests written, not run.
- Codex's sandbox has no network: installs must be run by the Coordinator (CI=true corepack pnpm install --no-frozen-lockfile).
- Pre-existing test-typecheck failures for the final test-fix pass: features/creative tests/support/jini.ts (MediaGenerationRequestInit.dispatcher), features/credentials tests (4 errors).
- Running: step0c run 2 (spike, golden, A9, SEAMS, needs, COMMON). Next: plan the 4 MVP feature jobs (briefs drafted in codex-runs/2026-10-13-mvp-features/).
- 01:00–02:25: step0c run 2 (aaf90f3; spike 15/15 → A1 + ASYNC acceptance), MVP features contacts 4d24256, web-events 9e27e84, forms 0305ec4, privacy 8aeb7df; test tsconfigs declaration:false (decf0e3); server feature deps + om bin (e81551a); integration I1 local boot (f34a9e9) — verified live: om:serve boots, all 16 migrations apply on real SQLite, owner auth, studio served, `om status` works, clean SIGTERM; boot/spike/migration tests 30/30.
- For the final test-fix pass: boundaries gate findings (core-to-adapter in jobs/measure/workspaces memory/sql, workspaces sql cycle, studio Shell fsd-edge, studio react-rule nonliteral import); creative + credentials test typecheck errors.
- Running: integration I2 (owner API + studio HTTP adapter). Then I3 (forms/web-events ingress + acceptance worker + adapters), I4 (agent subprocess + om ask).
- 02:45–03:50: integration I2 owner API + studio HTTP (049a605; allowance now uses host local timezone), I3 forms/landing/async acceptance (fe247b4; fixed forms root-cause error mapping, 503→400), I4 agent subprocess + om ask (33fa07f). All verified live on fresh state roots: /f/lead → worker → contact + 2 consent records + bound visit; om ask streams a labeled sandbox reply from the supervised agent child; SIGTERM reaps it.
- 03:52 full baseline (all built): ~1,750 package tests pass; failures campaigns 16 (pre-existing), media-library 4, studio 1, plugins 1, workspaces 1; om:lint/om:metrics crash on a parser option; 4 stale skeleton gate tests; boundary findings; creative/credentials test typecheck. Running: final test-fix pass (codex-runs/2026-10-13-testfix/).

## UPDATE 2026-10-13 05:10: the MVP-2 roadmap is complete and green
- Test-fix pass: TF1 2a15e99 (all package tests green; campaigns card-normalization bug, media blob aliasing bug, lint/metrics parser crash, boundary relocations, stale tests), TF2 99fc8cf (91 lint diagnostics fixed in code; signature rule now type-based for upstream callbacks with conformance tests; gate-test timeouts).
- Verified by the Coordinator: `corepack pnpm om:check` exit 0; every workspace package's tests pass (incl. socket suites); plugins google-ads 96, meta-ads 190, higgsfield 58; live smoke: `om:serve` boots, /f/lead → contact + consent, `om ask` via the supervised agent child, clean shutdown.
- How to run: `corepack pnpm om:serve`, open the printed OM_READY URL; CLI: `OM_STATE_ROOT=~/... node apps/server/dist/composition/cli.js status` (bin `om` declared in apps/server).
- Notes for the owner: plugin packages under content/agent-plugins are not pnpm workspace members (higgsfield's hand-made node_modules link broke once; consider adding them to the workspace). Codex's sandbox has no network and blocks loopback listeners: installs and socket tests are Coordinator-run. Studio chat → agent runs, real model execution, vendor OAuth/admission, durable approvals, dispatch barrier, ServiceGrant runtime and packaging remain deferred. Desktop Electron app not launched live (tests only).
- Next candidates (owner decides): post-MVP Wave 0 (Debate B), real agent runtime, studio chat wiring, vendor account setup (Google Cloud/Data Manager, Meta app + test ad account, Higgsfield).

## 2026-10-13/14 overnight batch 2 (owner asleep; autonomous; caffeinate 16h)
- Decisions: ADS-memory/.local-artifacts/codex-runs/2026-10-13-owner-decisions.md (green #00C896, desktop persists theme via persist: partition + fixed OM_PORT, Anthropic key on server, model loop in agent via server broker, A2UI Jini v1.0, charts = plugins only, plugins unrestricted, assistant does everything).
- Inputs: 2026-10-13-tovu-dive-merged.md, 2026-10-13-tovu-answers-{84,54}.md, inputs-2026-10-13.md.
- Installed @jini-ai/desktop-host 0.4.2 (apps/desktop).
- Running: ui-theme T1 build; plans for 2026-10-14-{assistant,addons,linkedin-ads,tiktok-ads,instagram} (vendor plans use Codex web search: run-phase-retry.sh WEB=1).
- Flow: plan -> subagent over-engineering review -> build, lanes sequenced for shared server/studio files.
- Committed so far: d306d86 ui-theme T1, 7098427 Jini deps, f2d7f79 instagram, a80ae85 ui-theme T2, 3b4eb60 contracts I-0, 777253c tiktok-ads, 4f8dc3f assistant A1 (broker spike; both halves verified over real sockets), 12d9546 addons D1 (paste-token credentials), e017d6c linkedin-ads.
- Verification by subagent build-verifier (typecheck, package tests, om:lint, om:boundaries per build); cycle fixes went back to Codex (F1 runs).
- Running: assistant A2 || addons D2. Then strictly: D3 -> A3 -> A4 -> D4 -> A5, then I-2 (composition/agent-plugin-backends.ts binding meta/instagram, linkedin, tiktok, higgsfield to tool sources).
- Not visually checked: the redesign (screen locked overnight).
- More commits: af5ebdc deps (diagnostics 0.5.2, platform 0.5.6, yaml 2.8.1) + boundaries exception (only server serve.ts may import plugin code by computed URL), 421ded2 assistant A2 + addons D2 (end-to-end agent Jini -> real server broker -> fixture upstream PROVEN), 8bae639 addons D3 (pages, nav, CLI, boot wiring).
- Verifier replaced once (context limit): build-verifier-2. Classifier blocked it twice (lint rerun after editing my script; deleting leftover read-only temp dirs) — not worked around; leftover /var/folders/.../T/om-i2-p7NvC3 predates runs.
- Running: assistant A3 (catalog/dispatcher/MCP route). Then A4 -> D4 -> A5 -> I-2.
- More commits: a21a63e A3 (catalog/dispatcher/MCP; unknown outcomes never retried), 8788a5f A4 (policy-gated writes, om tools CLI), bf7969a A4b (catalog wired to real services; expired quotes refused), aa62a69 deps (Jini UI peers; .pnpmfile.cjs gives Jini ui/agentic/chat zod 3), 346e3d5 D4 (Recharts plugin; OM admits chart providers itself — decision #11 for owner review), fa21da0 (studio main.ts may load chart bundles; micromark-extension-gfm), bcbadcd A5 (A2UI, charts in chat, page driving).
- Verifiers: build-verifier-3 now; batch-reviewer finished (context full).
- Running: I-2 R1 (vendor plugins -> catalog, admitted:false = no network). Then I-2 R2 (typed halt stop, conversions, coverage), then final verification.

## 2026-10-17 — open-marketing-6b took over from bb (Codex-credit day; no tests run by owner request)
Committed (each Codex plan → review → implement → Codex read-only review → fix → typecheck → commit):
- bb40598, 018b9a2 I-2 R1/R2: vendor plugins in the catalog; typed halt stop; conversion binding; per-binding MCP isolation; bundle-byte revision fence; halt-barrier + lifecycle/binding rechecks.
- c6948cb P1: `om:package` → unsigned x64 .app/.dmg with bundled official Node 24.2.0 (not yet built; needs the Node tarball + fresh builds).
- dab8c16, 9175867 S1: durable confirmations/tool operations (migrations v19/v20); $5/day paid-send budget; privacy block-then-persist; transactional egress admission. ServiceGrant deferred.
- 9b6226b, 7b9d6f9 O1: Google + LinkedIn OAuth (HTTP/CLI/assistant), client ID/secret pasted and sealed (no env). Meta/TikTok sign-in open.
- 90590dd, e088d2f C1: neutral campaign drafts, plugin translators, one grouped exact launch card.
- 37a3947, 2abf90b C2: PAUSED/DRAFT deployment + readback (Google/Meta/LinkedIn), read-only reconciliation, optional sealed Google developer token (Google sunset tokens 2026-09-09).
Held: DS1 design (reviewed, codex-runs/2026-10-17-design; theme architecture from tovu-67 binding). Open: TikTok deploy, Meta/TikTok OAuth, Higgsfield pricing, API version upgrades, studio UI for all of the above, full test pass.
