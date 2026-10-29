# Claude TRIM REVIEW of a Codex plan (OM wave 2026-10-28): shared brief

Repo: /Users/la/Programming/Open-Marketing (branch om/cleanup-1025, everything uncommitted). A Codex job wrote a PLAN; its build run starts as soon as you approve. You stand between the plan and the build. The owner's standing complaint is "Codex over-engineers": your job is to cut the plan down to the smallest correct change and to catch wrong fixes before they're built.

## Material (job dir: ADS-memory/.local-artifacts/codex-runs/<job>/)
- `job.md`: what the job must do. It and the shared context win over the plan.
- `plan.md`: Codex's plan.
- Shared context: `ADS-memory/.local-artifacts/codex-runs/ctx-wave-1028.md` (spec pointer, NO OVER-ENGINEERING, Tovu/Jini constraints, shared decisions).
- Spec: job.md plus the audit/report sections it names (read those sections and check the finding against the CURRENT code).
- Engineering contract: `development/COMMON.md` (cognitive complexity ≤10, nesting ≤3, `fn(required, optional?)`, DI, types derived from Zod, money in integer micros).
- The current code in the job's lane. Read it to check the plan's claims.

## What to check
1. **Scope:** every item in job.md is covered, or explicitly deferred with a real reason. Nothing beyond job.md, and no extra options, ports, helpers or files.
2. **Reuse:** for each mechanism (pagination, time budget, chunking, credential parsing), the plan names the existing code it extends. If it invents a new one where an existing one fits, CUT it and name the code to reuse (file:line).
3. **Correctness:** check the plan's approach against the current code and, for vendor behaviour, against the vendor docs (web search). Watch for:
   - money or timezone mistakes;
   - capability or token caching across calls;
   - secrets in error text;
   - `admitted` or authority checks in plugin capability paths;
   - fixes that silently change the contract;
   - tests that assert nothing or can't fail.
3b. **No hard-coded vendors in core (owner rule, 2026-10-27):** CUT any plan step that puts a vendor or provider plugin ID, branch, URL, header or price into apps/*, features/* or packages/contracts. Plugins must be reached only through capability catalog IDs, manifest-declared fields and injected ports.
4. **Bug is real:** if the plan "fixes" something already fixed in the current code, cut it.
5. **Size:** fits one ≤90-minute build run.

## Output
Write `<job dir>/review.md` in exactly this shape (the build prompt reads it):
```
# Trim review: <job>
VERDICT: APPROVED WITH CUTS | APPROVED AS IS
CUTS: numbered; what to drop from the plan and why
FIXES: numbered; changes to the plan's approach (file:line, what to do instead)
REUSE: mechanism → existing code to extend (file:line)
OWNER DECISIONS (defaults): any open choice, with the default the build should take
APPROVED SCOPE for B1: a numbered list of exactly what to build, in priority order
```
Do NOT create `review.approved`; the Coordinator does that after reading your review. Then reply with a 3-line summary: the verdict, the number of cuts and fixes, and the most important change.

6. **Lane:** every file in the plan is inside job.md's lane. About 12 Codex jobs build in parallel; a file outside the lane is a collision, so CUT it or turn it into NEEDS.
7. **No test runs:** the build must never run tests (owner: it would take the machine down). Cut any plan step that runs vitest/pnpm test/om:check/builds.

## HARD RULES
- Edit nothing except `review.md` in the job dir.
- Never run tests, builds, typecheck, lint, pnpm or codebase-memory indexing. Use Read, rg, git diff/show, ls and web search.
- Never touch /Users/la/Programming/Tovu or /Users/la/Programming/tovu-integration-clones/*.
