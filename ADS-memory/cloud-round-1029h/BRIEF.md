# OM cloud round 1029h — VERIFY the w23 refactors (branch om/w23-cleanup)

You are the COORDINATOR. Delegate to 2–3 **Sonnet** subagents. Branch under test: `om/w23-cleanup` = main `e2ef257a` + 3 behaviour-identical Codex refactors (2114cc1b server/measure cycles; 8fa57a1d plugin cycles + fingerprints; 2e8dbf7e studio/lint). Baseline expectations: `ADS-memory/cloud-round-1029f/REPORT.txt` (main e2ef257a).

## Hard caps
Stop new work at 40 min; write `ADS-memory/cloud-round-1029h/REPORT.txt` and push by 45 min. Sonnet only. No live vendor calls. `pnpm install --frozen-lockfile` only; no lockfile/package.json changes. Node 24: `PATH=/opt/node24/bin:$PATH`. Build contracts, om-db, om-clock, features, `@open-marketing/agent` and all plugin dists first.

## Do
1. `om:boundaries` — count cycles (runtime vs type-only) and boundary violations; expect apps/server + features/measure runtime cycles = 0 and the cli→leads violation gone.
2. `om:lint` and all typechecks (workspace `--no-bail` + every content/agent-plugins/*/ typecheck script; note twilio-sms TS2742 was annotated without a rerun).
3. Run the test suites ONCE: apps/*, features/*, packages/*, and every content/agent-plugins/* with tests (sequentially per group to avoid load flakes).
4. For every failure: is it a REGRESSION from the three w23 commits (`git diff e2ef257a..HEAD`), or pre-existing/ENV per the 1029f report? Fix ONLY regressions, with the smallest change that restores the original behaviour (never weaken a test; max 2 loops each). Plugin fingerprint mismatches: recompute exactly as the plugin's manifests test expects.

## Output
Branch `cloud/om-verify-1029h` from `om/w23-cleanup`; explicit-path commits, no co-author trailers; push; never push to main. `REPORT.txt`: cycles/violations/lint/typecheck counts vs the 1029e baseline; per-package test pass/fail; each failure classified REGRESSION-fixed / REGRESSION-open / PRE-EXISTING / ENV with file:line; raw outputs as `.txt` in `ADS-memory/cloud-round-1029h/out/`; time used.
