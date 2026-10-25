# OM handoff: open-marketing-3a -> open-marketing-bb (2026-10-14)

Repo `/Users/la/Programming/Open-Marketing`, branch `om/clean-slate`, last commit `e3b6e17`.
- Never push. Don't `git fetch ainsep`. Commit only OM work, with no co-author trailers.
- Owner prefers short, plain answers.
- Full history: `ADS-memory/reports/handoffs/2026-10-01-om-build-kickoff.md` (bottom sections).

## How the work runs (keep doing it this way)
- **Flow.** Codex gpt-6.1-sol at high reasoning does the work: plan, then Claude over-engineering review, then implement. Feature jobs are no-test; a verifier subagent runs checks.
- **Delegation.** The owner wants checking and reviews done by subagents, not the main session.
- **Run folders.** Briefs and reports live in `ADS-memory/.local-artifacts/codex-runs/<date>-<job>/`.
  - `run-phase-retry.sh <abs-dir> <phase> <sandbox>` runs a phase and retries on capacity. Env flags: `IMG=<file>` attaches an image, `CBM=1` turns on CBM MCP for that run (query only), `WEB=1` turns on web search for vendor docs.
  - `mkimpl.sh <job-dir> <label> "<scope>" "<typecheck>" [notes]` builds an implement brief from `step0-impl-header.md`, `inputs-2026-10-13.md` and the job text.
- **Binding decisions.** `codex-runs/2026-10-13-owner-decisions.md`. Item 11 is a Coordinator call awaiting owner review.
- **Codex limits.** Its sandbox has no network and can't open sockets. The Coordinator installs packages and runs socket tests, after checking machine load first.
- **zod.** Jini ui/agentic/chat get zod 3.25.76 through the root `.pnpmfile.cjs` hook; OM itself uses zod 4.

## In flight right now (uncommitted in the tree)
- **I-2 run 1 + fix R1F:** vendor plugins bound to the assistant catalog, with admitted:false meaning zero network. Report `codex-runs/2026-10-14-I2/R1.md`, `R1F.md`; review `2026-10-14-I2/review.md`.
  - It is being re-verified by my subagent build-verifier-3. I will forward its result to you.
  - Files: the 19 entries under `apps/server`, `content/agent-plugins/{google-ads,higgsfield-media,meta-ads}`, `development/scripts/output-integrity.mjs`, `development/tests/integrity.test.ts` and `package.json` shown by `git status` (not the kickoff handoff file).
  - Commit after it passes.
- **Next:** I-2 run 2. Its brief is ready at `codex-runs/2026-10-14-I2/R2-prompt.md`: typed remote halt stop, conversion dispatcher binding, coverage rows.

## Done (committed overnight)
Redesign T1+T2; Instagram, TikTok and LinkedIn plugins; assistant A1–A5 (model through the server broker, conversations, catalog + policy, every feature as a tool, A2UI, plugin charts in chat, page driving); add-ons D1–D4 (four pages, one upload flow, paste-token credentials, Recharts chart plugin); off-screen window recovery and empty states.

## Left to do
1. **Finish I-2.** Commit R1 + R1F after verification, then build, verify and commit R2.
2. **Heavy design rework.** The owner doesn't like the design; they said save it for later. The token layer (`apps/studio/src/themes/modernist.css`) makes swapping it cheap.
3. **Real accounts.** The owner creates Google Cloud/Data Manager, a Meta app plus test ad account, LinkedIn, TikTok and Higgsfield accounts. Then:
   - sign-in flows: Google needs OAuth plus a developer token, LinkedIn needs OAuth refresh (only paste-token exists now);
   - the owner admits each plugin (all are admitted:false).
4. **Safety.** Durable approvals and pending-operation storage (needs a migration), the send-vs-consent-withdrawal/erasure race guard, and the ServiceGrant runtime.
5. **Deferred from I-2.** The neutral OM campaign launch (needs per-vendor translations) and the Higgsfield generation lifecycle (no pricing evidence).
6. **Open vendor facts.** TikTok's status enum and Access-Token header are unverified (its doc portal is JS-only). Meta's daily IG publishing quota conflicts between 50 and 100; the plugin reads it live.
7. **Jini upstream (owner call).** Plugins 0.5.1 only admits built-in browser chart providers; OM works around it (decision 11).
8. **Desktop.** The root cause of the off-screen window on the owner's two-monitor Mac is unconfirmed (recovery is in place). Packaging the Mac app is still to do.
9. **Final full test pass.** Ask the owner first; the machine is shared.
10. **Small items.** The studio bundle is 626 KB because chat/react pulls in the Jini UI barrel. Leftover read-only temp dirs `/var/folders/.../T/om-i2-p7NvC3` and `om-chart-http-xqIaaU` need cleanup; the classifier blocked a subagent from deleting them.
