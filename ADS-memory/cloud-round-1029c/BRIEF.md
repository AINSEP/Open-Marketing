# OM cloud round 1029c — fix the remaining failing tests ONLY

You are the COORDINATOR. Delegate to 2–3 **Sonnet** subagents, batched by cluster. Context: `ADS-memory/cloud-round-1029b/REPORT.txt` ("REMAINING ERRORS" + "FINAL PACKAGE TESTS") and its raw outputs in `ADS-memory/cloud-round-1029b/out/`. Engineering rules: `development/COMMON.md`.

## Hard caps (shared credit — obey strictly)
- Wall clock: stop new work at 40 min; write `ADS-memory/cloud-round-1029c/REPORT.txt` and push by 45 min.
- Sonnet subagents only. No Opus subagents.
- Run ONLY the failing test files (plus a final run of apps/server and apps/studio package tests). No full workspace/plugin suites, no lint/om:check.
- Max 2 fix→recheck loops per failing test; then list it with its cause and move on.
- No live vendor calls, credentials or spend. `pnpm install --frozen-lockfile` only; no lockfile/package.json changes. Node 24: `PATH=/opt/node24/bin:$PATH`.
- Setup before tests: build `@open-marketing/agent` and the plugin dists the server tests import (google-ads, linkedin-ads, meta-ads, tiktok-ads, plus twilio-sms and whatsapp-business if their tests need them). higgsfield-media cannot build here — mark its 1 test ENV and skip.

## Scope: the 35 apps/server + 18 apps/studio failures from round 1029b
- server: agent-plugin-backends.test.ts (15: LinkedIn adAccounts fixture, om_message_* in catalog lists, twilio/whatsapp read factories unavailable, campaign deployment unavailable), agent-plugin-jobs.test.ts (5: halt/SQLite "Outbox SQL transaction failed"), om-tools.test.ts (3), ingress-worker.test.ts (3), addons.test.ts (3), migrations.test.ts (2), catalog-composition (1), owner-api (1), brand-surfaces (1), site-guide (1).
- studio: addons.test.ts (8), shell.test.ts (5), browser-tools, chat-parity, conversion-grants, jini-chat-transport, navigation (1 each).

## Rule for each failure
Find the cause first. **Stale test** (the product changed on purpose, e.g. new om_message_* tools in a catalog list) → update the test. **Product bug** → fix the product with the smallest change and keep the test. Never weaken a test to make it pass (no deleting assertions, no `.skip`, no loosening security/consent/approval checks). If unsure whether it's intended behaviour, list it as OWNER QUESTION and leave it.

## Output
Branch `cloud/om-round-1029c` from `main`; push after each cluster; explicit-path commits, no co-author trailers; never push to main. `REPORT.txt`: per failing test — fixed (test|product) / owner question / env / still failing, with file:line; final pass/fail counts per package; raw output as `.txt` in `ADS-memory/cloud-round-1029c/out/`; time used.
