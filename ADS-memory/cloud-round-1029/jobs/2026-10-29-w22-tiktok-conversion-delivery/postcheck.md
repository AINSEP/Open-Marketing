### 2026-10-29-w22-tiktok-conversion-delivery: verdict SMALL FIXES (one stale README sentence); otherwise ready

All paths below are under content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/ unless stated otherwise.

Ledger (checked against the code):
1. Source, FIX 1 (factory and configuration): FIXED.
   - src/events.ts:49-61 defines `createConversionDelivery(PluginCapabilityDependencies & { authority })`.
   - The configuration is parsed once without I/O (:50), using the extended `pluginConfigurationSchema` with `settings.conversionConfiguration.pixelId` and the existing pixel regex (:17).
   - A malformed configuration returns invalid_input from both deliver and reconcile through `prepareConversion` (:66) before any authority, credential or fetch call.
   - Removed, with no remaining references (rg): `createTikTokEventsBackend`, the local configuration schema, `tiktokServiceContextSchema` and the egress `Dependencies`.
2. FIX 2 (request and event): FIXED. :13-16 copy Meta's shape: identifier and digest maps ≤16, `value: moneySchema.optional()`, `orderRef`, contracts `serviceContextSchema` and `measurementGrantSchema`, `deliveryId`. Types are `z.infer` aliases under the old names (:24-27). The outcome matches Meta's (:18).
3. FIX 3 (checks): FIXED.
   - checkConversionAuthority (:98-104) checks age ≤7 d via the named `maxEventAgeMs` (:21), revoked/expired, then grantMatches.
   - grantMatches (:106-113) checks configuration and grant scope against the context, connection and account against the configuration, destination and purpose against the event, and `definitionIds.includes`.
   - The mode, configuration destination/purpose and payloadSchema checks are gone.
4. FIX 4 (mapPayload): FIXED.
   - (a) Event name uses `Object.hasOwn` (:87-88).
   - (b) Non-strict projection (:19, :89-90); a malformed known key returns invalid_input without echoing it.
   - (c) Missing page URL or identifier returns the exact "not sent" message (:92) before authority, credentials or fetch, because mapPayload runs inside prepareConversion (:77).
   - (d) Value uses the Intl exponent (:93); there is no `properties` key when value is absent (:94).
5. FIX 5 (payload schema): FIXED. src/events-payload.ts:10 has a strict, optional `properties{value nonneg finite, currency ^[A-Z]{3}$}`. The strict `userSchema` stays (:8), and the docstring is updated (:5-7).
6. FIX 6 (send): FIXED.
   - dispatch (:116-135) is unchanged apart from Meta's spread shape (`...prepared.request, configuration, payload, execute`). The consumed-callback guard and observer remain.
   - send (:138-147) builds `createTikTokFetchEgress({ fetch, credentials: createTikTokCredentials(dependencies), observer })` per call. There is no factory- or module-level cache.
   - A valid ACK returns delivered with `{accepted:true, processed:null, attributed:null, observedAt}`.
   - reconcile (:55-60) validates, then returns unknown with no I/O.
7. FIX 7 (evidence): FIXED per report.md (+5/−2, inspectedAt kept). Not separately diffed: low risk, and manifests.test pins only inspectedAt.
8. FIX 8 (complexity): FIXED. I counted with the eslint-plugin-sonarjs 3.0.5 rule: nested callbacks are scored separately, and `||`/`??` don't count.
   - Scores: prepareConversion 7, mapPayload 6, checkConversionAuthority 3 (only `&&` sequences and ifs count), dispatch 5 (its callback 3), send 2.
   - Nesting is ≤2 everywhere.
- SCOPE 1, index.ts/transport.ts: FIXED. index.ts:11 exports the new types. transport.ts imports the payload schema from `./events-payload.js` (there is no cycle) and uses contracts `serviceContextSchema`.
- SCOPE 2, fixtures: FIXED. tests/fixtures.ts `eventsConfiguration` = `pluginConfigurationSchema.parse({...settings.conversionConfiguration.pixelId})`, and `eventsFixture` builds the real `createConversionDelivery` with recording fetch, adapted credentials and `wait`.
- SCOPE 3, migrated cases: FIXED. The memory/fetch dual loop is removed, and the CUT 4 rows (mode, payloadSchema, eventType) are deleted.
- SCOPE 4, new cases: FIXED.
  - (a) tests/events.test.ts:75-92 is the real factory with a server-shaped configuration. It asserts one POST to `/v1.3/event/track/`, `user` exactly `{email, phone}`, no `properties`, zero credential/fetch calls before deliver, and one of each after.
  - (b) :100-106.
  - (c) :107-113 (`qualified`, `constructor`).
  - (d) :114-124 (USD/JPY/KWD).
  - (e) :125-132.
- SCOPE 5, docs: PARTIAL. README:22 and the last sentence of :32 are edited. But README.md:30 still says "Raw/mixed-validity/uppercase identifiers and extra fields fail atomically", which is now false (extra keys are dropped by projection). B1 disclosed this and left it because of CUT 6. See small fix 1.
- SCOPE 6, typecheck: FIXED. typecheck.txt shows EXIT 0 on the first run.
- SCOPE 7, report.md: FIXED. It records lines, URLs and NEEDS.
- COORDINATOR OVERRIDE 1:
  - Fingerprint left to the Coordinator: honoured. plugin.json and capabilities.json are not in the B1 file_change log.
  - payloadSchema check dropped: honoured.
  - Phone = contacts `phone` E.164-with-"+" hash: honoured (:19 projects `phone` only; `phone_digits` is dropped and asserted in test :91).
  - Phone source cited (report.md "VENDOR EVIDENCE"): TikTok "identity normalization and hashing", business-api.tiktok.com/gateway/docs/index?doc_id=1739585700402178. That page is JS-rendered and I could not open it. Secondary sources agree that TikTok wants E.164 starting with "+" before SHA-256: the review's Tealium and Amplitude links, plus this postcheck's search (docs.narrative.io/reference/connectors/tiktok-conversions-api and datahash.com TikTok Events API docs). Accepted.

Outside lane: none. The file_change log has only the 8 lane files plus progress.md and report.md.

New:
- [MINOR] content/agent-plugins/tiktok-ads/README.md:30. The stale "extra fields fail atomically" sentence contradicts the new projection. Failure: an operator or agent reading the README expects an extra key (for example `ip`) to refuse the event, but it is silently dropped. Fix: small fix 1.
- [EXPECTED] tests/manifests.test.ts:38 (fingerprint equality) goes red until the Coordinator recomputes `tiktokEventsSchemaFingerprint` from the rebuilt dist, because `properties` changed the payload JSON schema. This is per the override; it is not a defect.
- No secrets echoed: every failure message is a fixed string. There is no capability or token caching, and no vendor names in core.

Disputes/deferrals:
- DISPUTED (definitionIds already in use; post-credential fence at transport.ts:64): correct, and kept.
- Deferred, all OK and owned elsewhere: ttclid/ip/UA, receipt readback and the "not sent" reason collapsing in the dispatcher.

Typecheck: PASS (EXIT 0, `--dir content/agent-plugins/tiktok-ads`). Nothing to fix.

Duplicates: none. Published rc.2 dist has no hits for `event/track` (re-checked with rg). Per the review, Tovu and ai-traces-jini have none either. The bounded transport stays plugin-local.

Net lines: +229/−145 (net +84), per report.md. The events.test.ts migration accounts for +57 of that.

Small fixes:
1. content/agent-plugins/tiktok-ads/README.md:30: replace "Raw/mixed-validity/uppercase identifiers and extra fields fail atomically." with "Raw/mixed-validity/uppercase values for these keys fail atomically; other identifier keys (for example phone_digits, fbc, gclid, ip) are dropped before the strict payload check."
2. Coordinator (already NEEDS):
   - Rebuild the dist.
   - Recompute `tiktokEventsSchemaFingerprint` from the dist and write it to plugin.json:135 and io.github.ainsep.openmarketing/capabilities.json:119, after w22-conversion-settings has edited plugin.json.
