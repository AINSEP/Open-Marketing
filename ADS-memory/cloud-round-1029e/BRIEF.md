# OM cloud round 1029e — CODE-HEALTH ANALYSIS ONLY (no code changes)

You are the COORDINATOR. Delegate to 2 **Sonnet** subagents (A: complexity + lint; B: cycles + boundaries + typecheck). This round MEASURES and REPORTS — do not edit source, tests or config (temporary configs live outside the repo).

## Hard caps (shared credit)
- Stop new work at 30 min; write the report and push by 35 min. Sonnet only. No live vendor calls. `pnpm install --frozen-lockfile` only. Node 24: `PATH=/opt/node24/bin:$PATH`. Build contracts/om-db/om-clock dists first if typecheck/lint needs them.

## What to run (existing repo tooling — see package.json scripts, eslint.config.mjs, development/scripts/)
1. **Cognitive complexity census** (eslint-plugin-sonarjs, the repo's rule; limit is 10): run ESLint over all source (apps, features, packages, content/agent-plugins, content/plugins; exclude dist) with a TEMPORARY config that sets `sonarjs/cognitive-complexity` to `['error', 0]` and JSON output, so EVERY function's score is captured. Also capture `max-depth` (limit 3) and `om/control-depth` violations from the real config.
2. **Lint:** `corepack pnpm om:lint` (raw output) — findings by rule and by package.
3. **Cycles + boundaries:** `corepack pnpm om:boundaries` (raw). For each `no-cycles` hit, print the full cycle chain (dependency-cruiser), mark runtime vs type-only edges, and group by package. List every non-cycle boundary violation (impure-contracts, cli-shortcut, cross-feature imports, …).
4. **Typecheck:** `corepack pnpm om:typecheck` plus each content/agent-plugins/* `typecheck` script — errors by package (file:line).
5. **Metrics:** `corepack pnpm om:metrics` (raw).

## Report — `ADS-memory/cloud-round-1029e/HEALTH.md` (+ raw `.txt`/`.json` in `ADS-memory/cloud-round-1029e/out/`)
1. **Summary table:** functions measured; count over 10 (violations); count at 8–10 (near limit); max score; nesting violations; lint findings; cycles (runtime/type-only); boundary violations; typecheck errors.
2. **Complexity distribution** per group (apps, features, packages, plugins): histogram buckets 0–5, 6–7, 8–10, 11–15, 16–25, >25.
3. **Every function over 10:** file:line, function name, score, package — sorted highest first. Then the near-limit (8–10) list, top 40.
4. **Cycles:** every cycle chain, grouped by package, runtime vs type-only, plus the 5 files that appear in the most cycles.
5. **Boundary violations and typecheck errors:** full lists with file:line.
6. **Lint by rule** and the top 10 files by findings.
7. **What to work on first:** a ranked list of the 10 highest-value items, weighting risky paths (money/spend, consent/privacy, approvals, conversions/measure, credentials) above the rest. State clearly that nothing was changed.

## Output
Branch `cloud/om-round-1029e` from `main`; commit only files under `ADS-memory/cloud-round-1029e/` (explicit paths, no co-author trailers); push; never push to main.
