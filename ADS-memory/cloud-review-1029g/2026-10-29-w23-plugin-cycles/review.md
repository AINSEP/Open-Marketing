# Trim review: 2026-10-29-w23-plugin-cycles
VERDICT: APPROVED WITH CUTS

Cycle check against `cloud-round-1029e/out/cycles.json`: the plan's "16 runtime cycles" is correct. The runtime cycle ids are snapchat 39, 41, 43, 44, 45, 46 (6); microsoft 32, 33, 34 (3); pinterest 35, 36 (2); meta 30, 31 (2); amazon 26; google 27; twilio 48. That makes 16. Cycles 28, 29, 37, 38, 40, 42, 47, 49, 50, 51 (google schemas/types, line, reddit, resend, snapchat capi↔ports and commands↔ports, twilio commands↔ports and transport↔ports, vk, whatsapp) are type-only. Do not touch them except where the same move removes them for free, e.g. snapchat 40/42 and twilio 47/49 vanish once the type declarations are in a leaf.

CUTS:
1. Cut the two test additions: `meta-ads/.../tests/read-capabilities.test.ts` (reporting-path characterization) and `twilio-sms/.../tests/dispatch.test.ts` (malformed-credential secret sentinel). The job is behaviour-identical and nothing in this build can run them. Unrun new assertions cannot be proven to fail, and the brief says no test runs. If a characterization gap matters, it goes to a later job. This also removes the secret-handling risk of adding credential fixtures blind.
2. Cut the instruction to fingerprint `meta-ads/.../evidence/primary-sources.json` unless the build proves the Instagram fingerprint it contains hashes a file this job edits. Read the `files` list of that fingerprint first. `conversionFingerprint` (capi-normalization.ts, capi.ts) is not touched. If the Instagram block hashes `instagram.ts`, `instagram-fetch.ts` or `ports.ts`, recompute it exactly as listed; otherwise leave the file alone.
3. Cut "allow one corrective typecheck rerun per package" retries beyond one, and cut running any package-wide typecheck concurrently. Run `om:boundaries` once, then one plugin typecheck at a time (they are heavy together). No tests, builds or `om:check`.

FIXES:
1. Fingerprints (required exact steps, or the edit is cut). Every plugin hashes a different file set:
   - Snapchat: `tests/adapter.test.ts:160-166` shows the rule. `report.account-spend.v1`→`reporting.ts`, `campaign.create-paused.v1`→`campaign-translation.ts`, `conversion.deliver.v1`→`capi.ts`, `report.metrics.v1`/`campaign.status.v1`→`metrics-status.ts` plus `transport.ts` appended, and every other capability→`commands.ts`. Each hash is SHA-256 of the raw file bytes, updated in that order. Moving declarations out of `commands.ts`, `capi.ts`, `transport.ts` or `reporting.ts` changes their hashes.
   - For each of the other six plugins the build must open that plugin's own manifest test first (`amazon-ads/tests/plugin.test.ts`, `google-ads/tests/read-capabilities.test.ts`, `meta-ads/tests/manifests.test.ts` and `fixtures.ts`, and the microsoft, pinterest and twilio manifests/dispatch tests) to read which file(s) and which concatenation order produce each `schemaFingerprint`. Then recompute with `shasum -a 256` over those bytes in that order. Do not assume one file per row.
   - Prefer the plan's direction of moving declarations INTO leaves, but note a leaf (`ports.ts`) is often itself hashed or imported by a hashed file. Edit a hashed file only where the cycle needs it, and for each edited hashed file list old and new value per row in the handoff.
   - Write `plugin.json` and `capabilities.json` rows identically (they must stay equal; the tests `toMatchObject` them).
   - After source acceptance the Coordinator rebuilds dist and the source-digest integrity data (`development/scripts/source-digest.mjs` hashes every file under the plugin path). Keep the existing NEEDS line.
2. Meta `instagram-fetch.ts:69` (complexity 11): extract the predicate verbatim, evaluation order unchanged, signature `isAdsReportingRequest({ input, reportingPath }): boolean` private. Check the extracted function stays ≤10.
3. Meta cycle 31 (`instagram.ts→instagram-fetch.ts` runtime, `instagram-fetch→instagram` type): moving the dispatch/request types into `ports.ts` is correct. Check `ports.ts` does not then import `instagram.ts` or `instagram-fetch.ts` at runtime.
4. Google cycle 27: moving `readContext`/`readAccount`/`search`/account schema into `transport.ts` is OK only if `transport.ts` does not then import `read-capabilities.ts`/`hosted.ts`. Keep the `read-capabilities.ts` re-exports so test and index imports are unchanged.
5. Keep every existing export name available from its current module. Re-export from the old module wherever tests, `index.ts` or the manifests import the old path.

REUSE: relocate existing declarations into existing leaves (`ports.ts`, `evidence.ts`, `transport.ts`, `commands.ts`). The "pass functions in instead" alternative from job.md is not needed anywhere. No new files, no new factories.

DUPLICATES: none found. The plan searched Tovu (apps/, packages/, its cycle-refactor report) and published `@jini-ai/{agent-plugins,integrations}@0.6.15-rc.2`; none provides a vendor codec or schema leaf to reuse. Source-only Jini APIs are not used.

OVERLAP:
- With cloud round 1029f: 1029f edits `twilio-sms/.../src/broadcast.ts`, `src/index.ts` and `tests/broadcast.test.ts`, plus tiktok-ads, reddit-ads and yandex-direct files. Twilio `commands.ts`, `ports.ts`, `transport.ts` are not on its list, but `src/index.ts` is. Do not edit `index.ts`; if a re-export fix needs it, report NEEDS. The runs.ts, backends.ts, om-db and tiktok `adapter.ts` edits do not touch this lane. Re-read all twilio files first and re-confirm cycle 48 still exists.
- With the other two plans: no shared files. The studio plan's NEEDS mention Meta complexity as "belongs to the plugin job"; that is this job, and the studio plan does not edit meta-ads. Google test findings (`campaign-deployment.test.ts:452`, `read-capabilities.test.ts:341`) are unassigned and stay out of this job (cut #1 already avoids editing `read-capabilities.test.ts` for Meta; the Google file is a different path).

OWNER DECISIONS (defaults): size. 41 files with fingerprint recompute is the top end of 90 minutes. Default order below; if time runs short at 75 minutes, stop after the plugin in progress and mark the rest DEFERRED. Twilio and Amazon go last (single cycle each).

APPROVED SCOPE for B1 (priority order):
1. Snapchat: `ports.ts` as declaration leaf (schemas/types moved from `commands.ts`/`capi.ts`; configuration schema consumed by `capi.ts` and `transport.ts`). Recompute the rows listed above.
2. Microsoft-ads and Pinterest-ads: `ports.ts` owns command/report schemas; reporting stops importing from commands.
3. Meta-ads: context validation to `evidence.ts`, Instagram types to `ports.ts`, extract the predicate (complexity 11→≤10). No test edit.
4. Google-ads: shared reads to `transport.ts` (cycle 27).
5. Amazon-ads: date schema/presets into `commands.ts` (cycle 26).
6. Twilio-sms: command/read types and credential schema into `commands.ts` (cycle 48). No test edit.
7. Recompute and write fingerprints per FIX 1; list old/new values.
8. Run `corepack pnpm om:boundaries` once (plugin runtime cycles must be 0 for these seven; ignore other lanes' findings) and a serial per-plugin typecheck.

LOCKS-FILES: content/agent-plugins/snapchat-ads/** (src/ports.ts, src/commands.ts, src/capi.ts, src/transport.ts, plugin.json, capabilities.json), content/agent-plugins/microsoft-ads/** (src/ports.ts, src/commands.ts, src/reporting.ts, plugin.json, capabilities.json), content/agent-plugins/pinterest-ads/** (src/ports.ts, src/commands.ts, src/reporting.ts, plugin.json, capabilities.json), content/agent-plugins/amazon-ads/** (src/commands.ts, src/reporting.ts, plugin.json, capabilities.json), content/agent-plugins/google-ads/** (src/transport.ts, src/read-capabilities.ts, src/hosted.ts, plugin.json, capabilities.json), content/agent-plugins/meta-ads/** (src/evidence.ts, src/read-capabilities.ts, src/audiences.ts, src/ports.ts, src/instagram.ts, src/instagram-fetch.ts, plugin.json, capabilities.json, evidence/primary-sources.json only if FIX 1 requires), content/agent-plugins/twilio-sms/** (src/commands.ts, src/ports.ts, src/transport.ts, plugin.json, capabilities.json) (lock groups: w14-gmeta-plugins, w18-google, w20-twilio; snapchat-ads, microsoft-ads, pinterest-ads and amazon-ads have no lock group in w22-lock-groups.md, so the Coordinator should lock those directories by path)
