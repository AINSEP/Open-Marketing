# OM cloud round 1029d — COVERAGE ANALYSIS ONLY (no code changes)

You are the COORDINATOR. Delegate to 2–3 **Sonnet** subagents (e.g. A: apps/*, B: features/* + packages/*, C: content/agent-plugins/* + content/plugins/*). This round MEASURES and REPORTS. Do not edit source or tests.

## Hard caps (shared credit)
- Wall clock: stop new work at 40 min; write the report and push by 45 min.
- Sonnet subagents only. Max 1 retry per package if a run fails for environment reasons; then record it and move on.
- No live vendor calls/credentials/spend. `pnpm install --frozen-lockfile` only; no lockfile/package.json/config edits committed. Node 24: `PATH=/opt/node24/bin:$PATH`.
- Setup: build the dists tests need (contracts first, features, `@open-marketing/agent`, plugin dists google-ads, linkedin-ads, meta-ads, tiktok-ads, twilio-sms, whatsapp-business). higgsfield-media cannot build here → record as ENV.

## What to run
For EVERY package with tests (apps/*, features/*, packages/*, content/agent-plugins/*, content/plugins/*): run its vitest suite with coverage, `--coverage.enabled --coverage.provider=v8 --coverage.reporter=json-summary --coverage.reporter=text-summary --coverage.all` (include all source files, so untested files count as 0%), scoped to that package's `src/` (exclude tests, fixtures, dist, generated files). `@vitest/coverage-v8@3.2.4` is already installed at the root. Pass/fail counts are recorded alongside, but failing tests are NOT fixed.

## Report — `ADS-memory/cloud-round-1029d/COVERAGE.md` (+ raw `json-summary`/text output as `.txt`/`.json` in `ADS-memory/cloud-round-1029d/out/`)
1. **Overall** lines / branches / functions / statements for the workspace, and per group (apps, features, packages, plugins).
2. **Per-package table:** lines %, branches %, functions %, tests passed/failed, sorted lowest-lines first.
3. **Risky paths** (call out separately, with per-file numbers): money & spend (features/safety, campaign launch/approval in apps/server, plugins' budget/quote code), consent & privacy (features/web-events, features/privacy, features/policy, consent in apps/server/src/inbound/public.ts), approvals (features/safety rules, om-tools approval cards), conversions/measure (features/measure, conversion delivery in plugins), credentials/secrets (features/credentials).
4. **Untested files:** every `src/` file at 0% lines (path + size in lines).
5. **Lowest 25 files** by lines covered (≥30 lines), with %.
6. **Recommendation:** a realistic threshold per group (e.g. global line %, and a higher bar for the risky paths), and the 10 highest-value gaps to close first. State clearly: this is measurement only, nothing was changed.

## Output
Branch `cloud/om-round-1029d` from `main`; commit only files under `ADS-memory/cloud-round-1029d/` (explicit paths, no co-author trailers); push; never push to main.
