# OM cloud round 1029b — SMALL, CAPPED follow-up round

You are the COORDINATOR. Delegate the work to SUBAGENTS (batched: 2–3 total). Previous round's report with full context: `ADS-memory/cloud-round-1029/REPORT.txt` (FOLLOW-UPS section). Engineering rules: `development/COMMON.md`.

## Hard caps (credit is shared and nearly spent — obey strictly)
- Wall clock: stop new work at 55 min; write `ADS-memory/cloud-round-1029b/REPORT.txt` and push by 60 min.
- Models: subagents use **Sonnet**. Use one Opus subagent ONLY for item 1a diagnosis if Sonnet is stuck after 15 min.
- Tests: run ONLY the test files you touch, plus at the end one run of `apps/server` and `apps/studio` package tests. No full workspace or plugin suites, no full dist rebuilds (rebuild only a dist you need).
- Per failure: max 2 fix→recheck loops, then list it and move on. Skip anything that doesn't fit; priority order below.
- No live vendor calls/spend/credentials. `pnpm install --frozen-lockfile` only; no lockfile or package.json changes. Node 24: `PATH=/opt/node24/bin:$PATH`.

## Items (priority order)
1. **Server test clusters** (decide per cluster: product bug → fix product; stale test → fix test):
   a. "Sandbox agent did not become ready" — boot.test.ts (10), agent-process.test.ts (5), conversations.test.ts (4).
   b. contacts phone upsert "Invalid identifier" — message-send.test.ts (10), messaging-webhooks.test.ts (3).
   c. integrations.test.ts (2): expected "Invalid credential card or asset", got "Integration operation unavailable or denied".
2. **Cancel signal:** `apps/server/src/om-tools.ts:340` calls prepareEffect without options; add the optional options param to the om-tool-types.ts prepareEffect type and pass `{ signal }` through.
3. **Consent:** POST /consent has no rate limit → reuse the server's existing rate-limit mechanism (search first; do not invent one); `omGrantConsent` calls before the Jini client loads are dropped → queue and replay them once loaded.
4. **SMS composer:** select the connection by id, not list position; a failed connections read shows an error, not an empty list; distinguish lookup failure from "No OM contact".
5. **vk-ads** `tests/dispatch.test.ts:11`: drop the removed plugin-local `admitted`.

## Output
Branch `cloud/om-round-1029b` from `main`; push after each item; explicit-path commits, no co-author trailers; never push to main. `REPORT.txt`: per item done/partial/skipped + file:line, test results (raw output as `.txt` in `ADS-memory/cloud-round-1029b/out/`), every remaining error, time used.
