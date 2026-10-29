# Phase 4 fixer F1 (2026-10-29)

Env: PATH=/opt/node24/bin. No git writes, no lockfile/package changes.

## 1 whatsapp-sends: DONE
- `content/agent-plugins/whatsapp-business/io.github.ainsep.openmarketing/src/rates.ts`: removed `"1": "North America"`. Unmapped +1 numbers now take the max-rate path; the doc comment says so. 1809/1829/1849 are kept.
- `.../tests/broadcast.test.ts`: updated the expectations.
  - +1555 marketing: 40001n/"max"; auth: 60000n/"max". Added a +1876 → "max" row.
  - Quote cents: 2→5 and 4→6.
  - pricingEvidenceId: ["max","marketing","0.040001"].
- Commands: `pnpm test` → 116/116 pass; `pnpm typecheck` → EXIT 0; `pnpm build` → dist rebuilt (536.8kb). All run from content/agent-plugins/whatsapp-business.

## 2 meta-postal-resolution: DONE (root signal still absent, FOLLOW-UP)
- `apps/server/src/composition/campaigns.ts`:
  - The port `prepare(input, optional?: CallOptions)`.
  - `prepareEffect(input, optional?)` forwards `optional` to `required.prepare`.
  - Added the `CallOptions` type import.
- `apps/server/src/composition/index.ts:387` (one exact edit, done last): `prepare: (input, optional) => pluginBackends?.prepareCampaign(input, optional) ?? ...`.
- `apps/server/src/composition/agent-plugin-backends.ts` prepareDestination now says 'Plugin unadmitted or account binding not current: '. No test pins the old text.
  - om-tool-coverage.ts `startsWith('Plugin unadmitted:')` only reads tool `unavailableReason` (:1061), not this runtime failure, so it is unaffected.
- meta-ads dist rebuilt (`pnpm build`, 623.5kb); the meta-ads suite is 464/464 pass.
- FOLLOW-UP: the root caller `om-tools.ts:340 definition.prepareEffect({context, call})`, and the `OmToolDefinition.prepareEffect` type in om-tool-types.ts, carry no signal. In production the signal therefore stays undefined until om-tools passes one.

## 3 tiktok-conversion-delivery: DONE
- README.md:30 was already replaced in commit dd7bf32 (it has the exact postcheck text), so no edit was needed.
- Rebuilt the dist and computed `tiktokEventsSchemaFingerprint` from it (`import(dist/index.mjs)`), the same as src/events.ts:23 (sha256 of JSON.stringify(z.toJSONSchema(payload schema)))). The value moved from 2fa7895d… to 8646427ea13bead0282b49124a44bff4a3d52f26ada5482248a73a472f5a2c68.
- Wrote it to `content/agent-plugins/tiktok-ads/plugin.json:138` and `.../io.github.ainsep.openmarketing/capabilities.json:119`.
- Proof: manifests.test.ts passes, and the full tiktok suite is 320/320.

## 4a serve.ts bodylessGet: FOLLOW-UP (intent unclear)
- serve.ts:66 `metaGet` already requires `init.body === undefined`.
- integrations.test.ts:523-528 ("refuses GET outside the two Meta token paths") passes.
- No notes describe the intended "swap", so I made no change.
- The integrations.test.ts run had 2 failures, both outside my lane: the "credential-bearing card URLs" tests expect 'Invalid credential card or asset' but get 'Integration operation unavailable or denied'.

## 4b bindCatalogScope `ids`: NOT APPLICABLE
`ids` is used. catalog.ts:55 passes it to bindMeasurementGrants, which spreads it into `createSqlMeasureAudit` (which requires `ids`) in conversions.ts changeGrant. eslint is clean. I made no change.

## 4c agent-plugin-backends.test.ts Meta prepared plan: DONE (Meta part); other failures FOLLOW-UP
- Edits to `apps/server/tests/agent-plugin-backends.test.ts`:
  - Prepared Meta `ad.destinationUrl`.
  - Fixture creative row '987' (`account_id 123`, `object_story_spec.link_data.link`).
  - socialCampaign money keys in parsed order (`{minorUnits,currency}`). The server derives the constituent operationId with JSON.stringify `hash([operationId, target])` over the *stored/parsed* target, so the fixture's key order must match.
  - Dropped 'meta-ads' from "rejects unverified %s destinations": Meta now carries destinationUrl and verifies it by creative GET before any POST.
- Result: 24 failed → 14 failed (106 pass). The Meta path now runs end to end: creative GET, 3 POSTs, readback.
- Remaining failures, all outside the Meta plan:
  - The LinkedIn fixture does not serve `GET /rest/adAccounts/123` (protocol_mismatch), which breaks about 10 social-deployment tests.
  - om_message_* tools now appear in the catalog lists (2 tests).
  - The twilio-sms and whatsapp-business real read factories return unavailable (2 tests).
- FOLLOW-UP (src): `hash` in agent-plugin-backends.ts uses JSON.stringify, so it depends on key order. Consider canonicalDigest.

## 4d Fingerprint sweep: DONE
- Ran the manifests tests for all 15 plugins that have one, plus every plugin's full suite, and grepped for fingerprint failures.
- Only Reddit was stale: report.metrics.v1 and campaign.status.v1 went from 7b3e2322… to fb1c856dfc858b4718dfb80402ddc6ab04e1953020c81c599c258a882c93f187. I recomputed them the repo's way: sha256(metrics-status.ts + transport.ts).
- Files: `content/agent-plugins/reddit-ads/plugin.json`, `.../io.github.ainsep.openmarketing/capabilities.json`. The Reddit manifests test passes 2/2.
- Meta activation row 38b1a8bb… (meta-ads plugin.json:98, capabilities.json:19) is pre-existing/known and was left alone. The meta suite is green regardless.
- Non-fingerprint plugin failures noted, not fixed:
  - amazon-ses 2, resend-email 2 (mail policy wiring)
  - kakao 1, line 4, microsoft 10, reddit adapter 1, vk 1, x 5, yandex 12
  - google-ads: factory test expects 4 capabilities, gets 5 (campaign.validate.v1)
  - gbp: boundaries.test failed
  - higgsfield: 6 test files failed to load ("node_modules missing" warning)

## 4e Chart deps: FOLLOW-UP
ADS-memory/todos.md:26/:295 says "chart dependency locking → lockfile NEEDS: lock reproducible chart dependencies". That needs package/lockfile changes, so it is out of bounds for a fixer.

## 4f 593 provenance entries: FOLLOW-UP
- The mechanism is development/scripts/build.mjs, the package `build` wrapper. It writes `.om-generated.json` receipts (owner, sourceDigest, toolchain, outputs). output-integrity.mjs verifies them.
- In this checkout `outputIntegrity({})` reports 0 failures, because no dist is tracked.
- Refreshing means running each feature/package `build` (and `pnpm om:build-plugins`) AFTER the concurrent lanes (measure, web-events, server) finish. Building now would attest in-flight sources.

## Typecheck/tests
- `pnpm --filter`-equivalent `pnpm typecheck` in apps/server (tsc --noEmit && tsc -p tsconfig.tests.json): EXIT 0.
- apps/server tests/campaign-launch.test.ts: 15/15.
- apps/server tests/agent-plugin-backends.test.ts: 106 pass / 14 fail (was 97/24).
- Plugins: whatsapp 116/116, tiktok 320/320, meta 464/464, reddit manifests 2/2.

NET LINES (my files): +24 −19
