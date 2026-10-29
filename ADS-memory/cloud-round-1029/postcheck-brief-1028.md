# Opus POST-CHECK of one wave-1028 Codex build (2026-10-28): shared brief

Repo: /Users/la/Programming/Open-Marketing, branch om/cleanup-1025, HEAD 867bb92. Everything is uncommitted (several waves mixed in the working tree). About 10 other Codex jobs are editing OTHER lanes right now; judge only this job's lane and ignore unrelated diffs.

## Material (job dir: ADS-memory/.local-artifacts/codex-runs/<job>/)
- `job.md` (what it had to do), `plan.md`, `review.md` (the trim: CUTS, FIXES, APPROVED SCOPE, plus any COORDINATOR OVERRIDE at the end — APPROVED SCOPE + overrides are what the build had to deliver), `B1.md` (its report), `progress.md`.
- Shared rules: `ADS-memory/.local-artifacts/codex-runs/ctx-wave-1028.md`. Engineering contract: `development/COMMON.md` (cognitive ≤10, nesting ≤3, `fn(required, optional?)`, DI, types derived from Zod, money in integer micros, one general approval rule, no hard-coded vendors in core).
- Vendor-neutral jobs (vn-*): binding design `ADS-memory/reports/2026-10-27-vendor-neutral-design.md` (§5 "Revision 10-27").

## What to do
1. **Ledger:** one line per APPROVED SCOPE item (and override): FIXED / PARTIAL (why) / NOT DONE / WRONG (why) / DEFERRED-OK / DEFERRED-NOT-OK. Verify in the code (`git diff HEAD -- <lane paths>`), not in B1.md. Look hard for quietly dropped guarantees, behaviour changes in "behaviour-preserving" refactors, stubbed work, tests that assert nothing or can't fail, and "done" claims with no code behind them.
2. **Files outside the lane** the job touched (compare `git status` for paths not in job.md/review.md): list them.
3. **New problems** (BLOCKER / MAJOR / MINOR / OVERENG), each with file:line and a concrete failure scenario. Check: secrets echoed, capability/token caching across calls, vendor names added in core, new complexity-gate breaches (count cognitive complexity by reading), net lines actually reduced where the job promised a reduction.
4. **Disputes and deferrals:** rule on each.
5. **Typecheck:** read B1.md's TYPECHECK section; if it reports a failure, explain the cause and smallest fix.
6. Verdict: ready to commit | small fixes (list them precisely, file:line, so a short Codex fix run or the Coordinator can apply them) | needs another run.

## HARD RULES
- READ-ONLY except your output file. No git add/commit/stash/checkout/reset.
- NEVER run tests, builds, typecheck, lint, om:check, pnpm or codebase-memory indexing. Use Read, rg, git diff/status/show, ls.
- Never touch /Users/la/Programming/Tovu or /Users/la/Programming/tovu-integration-clones/*.
- Drop anything you can't back with file:line.

## Output
Write `<job dir>/postcheck.md`:
```
### <job>: verdict …
Ledger: <item>: FIXED | PARTIAL (why) | …
Outside lane: …
New: [SEVERITY] file:line: defect. Failure: … Fix: …
Disputes/deferrals: …
Typecheck: …
Small fixes: numbered, exact
```
Then reply with a 4-line summary: verdict, counts, top problem, net lines.
