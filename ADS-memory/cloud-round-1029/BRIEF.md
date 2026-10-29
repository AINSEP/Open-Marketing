# OM cloud round 2026-10-29 — brief for the cloud coordinator

You are the COORDINATOR of one Claude Code cloud session on AINSEP/Open-Marketing `main`. The owner wants a coordinator that delegates most of the work to SUBAGENTS: you plan, assign, merge, integrate, commit and report; subagents read, build, review and fix. Batch work: 3–5 subagents per phase, each covering several jobs (never one subagent per tiny item).

## Hard caps (a cloud session cannot be stopped from outside — obey these yourself)
- Wall clock: stop new work at 4 h 00 min; write the report and push by 4 h 15 min.
- Models: you Opus; subagents Opus for build/review, Sonnet for mechanical steps (dist rebuilds, fingerprint sweeps, typecheck triage).
- Per failure: at most 2 fix→recheck loops, then record it in the report and move on.
- Scope: ONLY the items below. Anything else you find → report "FOLLOW-UP", don't build it.
- No live vendor calls, real credentials, spend or sends. Fixtures only. Never touch other repos.
- Dependencies: `corepack pnpm install --frozen-lockfile` only. Never re-resolve the lockfile or add packages (if one is truly needed → FOLLOW-UP).

## Where things are
- Engineering contract: `development/COMMON.md` (complexity ≤10, nesting ≤3, `fn(required, optional?)`, types from Zod, money in integer micros, one approval rule, no hard-coded vendors in core). Shared job rules: `ADS-memory/cloud-round-1029/ctx-wave-1029.md` (ignore its "no tests on this machine" lines — that rule is for the owner's laptop; tests are allowed HERE).
- Per-job material: `ADS-memory/cloud-round-1029/jobs/<job>/` — `job.md`, `plan.md`, `review.md` (trim; its APPROVED SCOPE + `## COORDINATOR OVERRIDE` = exactly what to build), `B1.md`/`progress.md` (what a build did), `postcheck.md` (review of a build), `coordinator-note.md`.
- Review method: `postcheck-brief-1028.md` (ledger vs APPROVED SCOPE, outside-lane files, new problems with file:line, verdict, exact fixes). Here you MAY run typechecks/tests.
- Integration list: `integration-pass-74.md`.

## Phase 1 — baseline (1 Sonnet subagent)
`corepack pnpm install --frozen-lockfile`; rebuild the contracts dist FIRST, then every feature dist and every plugin dist (`om:build-plugins` if present; google-ads, meta-ads, tiktok-ads, twilio-sms, whatsapp-business, resend-email, amazon-ses, openai/anthropic/google model plugins, google-business-profile, …; brand has never been built). Then all package typechecks; save raw output to `ADS-memory/cloud-round-1029/out/baseline-typecheck.txt`. List every error (not counts).

## Phase 2 — build the 5 approved jobs (2–3 Opus subagents, in this order where files overlap)
Build exactly each review.md APPROVED SCOPE + COORDINATOR OVERRIDE; write tests; keep progress.md in the job folder.
1. `2026-10-29-w22-consent-banner` (uses installed `@jini-ai/cookie-consent@0.6.15-rc.2`; see coordinator-note.md) → THEN `2026-10-29-w22-contacts-meta-identifiers` (same tracking endpoint).
2. `2026-10-29-w22-pacing-month-lifetime` → THEN `2026-10-29-w22-results-followups` (both edit apps/server/src/alerts/**; re-read before editing).
3. `2026-10-29-w22-sms-composer` (independent).

## Phase 3 — review (2 Opus subagents, batched)
Post-check per postcheck-brief, writing `postcheck.md` in each job folder: the 5 Phase-2 builds plus the 3 built-but-unreviewed jobs `2026-10-29-w22-conversion-delivery-diagnostics`, `2026-10-29-w22-gate-minors`, `2026-10-29-w22-conversion-settings`.

## Phase 4 — fixes (2 subagents)
- Every fix the Phase-3 post-checks list.
- Pending fixes from earlier post-checks (exact text in each job's postcheck.md):
  - whatsapp-sends: `rates.ts:21` remove `"1": "North America"` + update the dependent test expectations;
  - meta-postal-resolution: thread CallOptions/cancel signal through `apps/server/src/composition/campaigns.ts:172/:193` and `index.ts:377`; optional message text `'Plugin unadmitted or account binding not current'`;
  - tiktok-conversion-delivery: recompute `tiktokEventsSchemaFingerprint` from the rebuilt dist → `plugin.json:135` + `io.github.ainsep.openmarketing/capabilities.json:119` (after conversion-settings' plugin.json edit, which is already in).
- Integration items from `integration-pass-74.md` (serve.ts bodylessGet + integrations.test.ts swap; drop unused `ids` from bindCatalogScope; agent-plugin-backends.test.ts Meta prepared plan; fingerprint sweep; chart deps; generated-output provenance entries).

## Phase 5 — verify
Rebuild dists touched since Phase 1, `om:lint`, all typechecks, then the test suites ONCE (`corepack pnpm om:check` or package tests). Raw output → `out/*.txt`. Fix what's in scope (2-loop cap); list the rest.

## Commits and report
- Work on branch `cloud/om-round-1029` (create from `main`); push after EACH phase so progress survives. Commit in logical batches with explicit paths (no `git add -A`), conventional messages, NO co-author trailers. Do not push to `main` — the local coordinator fast-forwards main after reading your report.
- Write `ADS-memory/cloud-round-1029/REPORT.txt`: per job a ledger line (built/reviewed/fixed, verdict, net lines); every remaining error with file:line; test summary + path to raw output; FOLLOW-UPs; time used.

## Do NOT do (deferred, owner-known)
Production conversion worker (W23), Google lead-form contract, contact-level consent withdrawal, passing message intent to plugins, Jini attachment-helper swap, P1-7 owner identity / deadline / packing (wait for Jini rc.3), openai-responses activation, any Tovu work.
