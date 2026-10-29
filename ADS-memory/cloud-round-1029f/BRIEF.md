# OM cloud round 1029f — failing tests, 4 product fixes, risky-path coverage

You are the COORDINATOR. Delegate to 3 subagents (Sonnet; ONE Opus allowed for item B3, the SQLite concurrency fix). Context: `ADS-memory/cloud-round-1029c/REPORT.txt` (owner questions), `ADS-memory/cloud-round-1029d/COVERAGE.md` (failing suites + coverage), `ADS-memory/cloud-round-1029e/HEALTH.md`. Engineering rules: `development/COMMON.md` (complexity ≤10, nesting ≤3, fn(required, optional?), types from Zod, money in integer micros, one approval rule, no hard-coded vendors in core).

## Hard caps (shared credit)
- Stop new work at 70 min; write `ADS-memory/cloud-round-1029f/REPORT.txt` and push by 75 min.
- Run only affected test files/packages; one final run of each package you changed. No full workspace suite.
- Max 2 fix→recheck loops per item, then list it and move on. Priority order below.
- No live vendor calls/credentials/spend. `pnpm install --frozen-lockfile` only; no lockfile/package.json changes. Node 24: `PATH=/opt/node24/bin:$PATH`. Build contracts, om-db, om-clock and the needed feature/plugin dists first.
- **Never weaken a test** (no deleting assertions, no `.skip`, no sleeps to dodge races, no loosening consent/approval/spend checks). Stale test → update; product bug → fix product.
- **Smallest change.** No refactors or file moves: a separate Codex job will untangle import cycles in apps/server hub files and plugins afterwards; keep edits minimal so it can build on top.

## A. Failing suites (from COVERAGE.md §2): triage each as stale test / product bug / ENV, fix
google-ads (1: extra `campaign.validate.v1` capability — check whether the capability list or the test is wrong), microsoft-ads (10), x-ads (5), line-ads (4), yandex-direct (13), meta-ads (2: 5,000-row tests time out — raise that test's timeout only if the code is correct), amazon-ses + resend-email (2 each: `MAILER_SEND_REFUSED_NO_DURABLE_PATH`), kakao-ads, reddit-ads, vk-ads, google-business-profile (boundaries test), apps/desktop (1), features forms (1) / jobs (3) / safety (2) (SQLite — likely fixed by B3), apps/studio `tests/conversion-grants.test.ts:97` typecheck (2 errors).

## B. Owner-approved product fixes (each with a regression test)
1. **Cancel stops all egress:** deployment execution gets the run's abort signal (`apps/server/src/composition/agent-plugin-backends.ts` ~:1107-1115 guardedFetch has `required.signal` undefined), so after cancel NO request leaves — including Meta's creative-destination GET. Test: agent-plugin-backends "sends nothing when the owning run is cancelled during the final awaited approval verification" passes unchanged.
2. **TikTok pause after halt = definite refusal:** when the gateway refuses before any network call, return a typed refusal/not-sent failure, not `{status:'unknown'}` (tiktok-ads `adapter.ts` ~:203 `uncertain()`); "unknown" stays only when bytes may have left. Test: agent-plugin-jobs "commits halt before enqueue…" passes unchanged.
3. **SQLite single-handle contention:** concurrent work must wait its turn instead of failing "handle already has a transaction" (`createSqlitePool.connect` in packages/om-db or the server pool). Queue/serialize on the handle, or move the pre-lane reads out of the transaction — pick the smallest correct fix. Tests: agent-plugin-jobs "closes the admission-to-fetch gap…", "retains the subject lane…", ingress-worker "holds form withdrawal outside SQLite…", plus the features jobs/forms/safety SQLite tests — all without sleeps.
4. **Chat image canonical name:** `apps/server/src/runs.ts` ~:179 `readRunImage` must take the canonical name from OM's own stored ref record, not `asset.record.originalFilename ?? ref.name` (Jini rc.2 sets originalFilename null). Test: owner-api "freezes canonical refs and resolves only the current run images…" passes unchanged.

## C. Risky-path coverage (add tests only; no source change unless a test exposes a bug)
`features/campaigns/src/launch.ts` (branches 57%), `features/measure/src/adapters/sql-links.ts` (56%), `sql-grants.ts` (68%), `links/links.ts` (67%), `apps/server/src/inbound/public.ts` (73%, consent endpoint). Target ≥85% branches each; re-measure with v8 coverage for those files.

## Output
Branch `cloud/om-round-1029f` from `main`; push after each of A, B, C; explicit-path commits, no co-author trailers; never push to main. `REPORT.txt`: per item done/partial/skipped with file:line and cause; before→after failing counts per package; new branch % for section C files; every remaining failure; time used. Raw output as `.txt` in `ADS-memory/cloud-round-1029f/out/`.
