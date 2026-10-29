# Trim review: 2026-10-29-w22-tiktok-conversion-delivery
VERDICT: APPROVED WITH CUTS

The gap is real in the current tree:
- A3 loads only `module.createConversionDelivery` (apps/server/src/composition/agent-plugin-backends.ts:772, :794-798) and passes `PluginCapabilityDependencies & { authority: { dispatch(call) } }`.
- TikTok still exports the old `createTikTokEventsBackend({ configuration, authority, egress, clock, observer })` (src/index.ts:10, src/events.ts:45).
- The old configuration is a local strict schema with `pixelId/destination/purpose/payloadSchema/mode` (events.ts:17), not `pluginConfigurationSchema`.
- The old event needs `eventType` and has no `identifierDigests`/`value` (events.ts:14). Measure's `ResolvedConversionInput` has no `eventType` (features/measure/src/types.ts:43-45), so every A3 call fails parsing today.
- Strict identifiers (events.ts:13) reject contacts' `phone_digits`/`fbc`/`gclid` keys (contacts rules.ts:8,127).

The precedent to copy is Meta's built factory: meta-ads src/capi.ts:10-162 (event schema :12, configuration :14, outcome :15, definition map :16, `mapPayload` :73-83, `grantMatches` :95-102, `dispatchConversion` :105-116). Copy the shape only; no cross-plugin import.

Plan claims checked:
- DISPUTED items are correct. `definitionIds` grants are already used (events.ts:92). The post-credential fence already exists (transport.ts:64).
- `tiktokServiceContextSchema` (events.ts:15) is byte-identical to contracts `serviceContextSchema` (packages/contracts/src/values/index.ts:21), so replacing it is a correct dedupe.
- The transport.ts import change is required, not optional. events.ts will import `createTikTokFetchEgress`/`createTikTokCredentials` from transport.ts, and transport.ts:6 imports from events.ts, which would create a cycle. Import the payload schema from `./events-payload.js` instead.
- `uncertainFailure` must stay in events.ts. adapter.ts:9,137 and capabilities.ts:9,45 import it.

Vendor facts:
- Endpoint `POST open_api/v1.3/event/track/` with the `Access-Token` header. Existing transport.ts:11,75-78, unchanged.
- Body: `event_source:"web"`, `event_source_id` = pixel code, and `data[]` items of `{event, event_time (Unix s), event_id, user{email, phone, external_id}, page{url}, properties{value, currency}}`.
- Sources:
  - https://business-api.tiktok.com/portal/docs?id=1771100865818625, which is already in evidence/primary-sources.json:358.
  - Value is a plain number and currency is ISO 4217: https://developers.liveramp.com/authenticatedtraffic-api/docs/supported-parameters-for-tiktok-events-api
- Phone is E.164 WITH the "+" before SHA-256 (https://docs.tealium.com/server-side-connectors/tiktok-events-connector, https://amplitude.com/docs/api/content/data/destination-catalog/tiktok-ads-event-stream). Contacts' `phone` digest is the plus-form hash; `phone_digits` drops the "+" for Meta (contacts rules.ts:121-128). So: send `phone`, ignore `phone_digits`. The plan is correct.
- Dedupe is by pixel + event + event_id, within 48h (https://ads.tiktok.com/resources/help/article/event-deduplication). The OM eventId is preserved. Retries must not be added.
- Contacts has no `ttclid` kind (rules.ts:8). Do not add ttclid, ip or user_agent.

CUTS:
1. **`plugin.json` and `capabilities.json` fingerprint edits (plan §2 rows 7-8, §4.11).**
   - The conversion row is `tiktokEventsSchemaFingerprint` = sha256(JSON.stringify(z.toJSONSchema(tiktokEventsPayloadSchema))) (events.ts:19). That is a runtime value: `shasum` on a source file cannot produce it, and computing it means running code (an esbuild or tsx bundle), which B1 may not do.
   - W22-CONVERSION-SETTINGS also plans to edit `tiktok-ads/plugin.json` (its plan.md:28). That would collide.
   - The Coordinator recomputes it after the dist rebuild (see NEEDS). B1 edits neither file.
2. **"Fingerprint recipe/value" in evidence/primary-sources.json.** The evidence file has no conversion fingerprint row today (`rg 2fa7895d` finds none), so don't add one. The evidence edit is limited to FIX 7.
3. **The memory/fetch dual loop for Events tests (events.test.ts:6).** The new factory gets no injectable egress port, so only fixture-fetch remains. Run the migrated cases once, on fetch. Keep `fixture({kind})` itself, because transport/gateway tests use it.
4. **Tests that only re-prove deleted or host-owned behaviour.** Delete them, don't migrate them:
   - "denies production conversions in %s mode" (events.test.ts:103-107). A3 owns mode (backends.ts:762).
   - The `{ ...grant, payloadSchema: "foreign" }` row (:92). See OWNER DECISION 2.
   - The `{ eventType: "purchase" }` row (:98). The field no longer exists; the strict event schema still rejects it, but that adds nothing.
5. **Extra test matrix beyond the precedent (plan §4.10).** Don't add new cases for "cancellation/withdrawal during credential lookup", "repeated execute", "uncertain acknowledgements" or "secret redaction". Those already exist (events.test.ts:35-56, :131-148); adapt them and stop there. New cases are only those in APPROVED SCOPE 4.
6. **README rewrites beyond two spots.** Edit only README.md:22 (the factory sentence) and the last sentence of :32 (the stale "adapt definition IDs into shared signup/trial grant"). Leave :67-73 alone; they are a historical handoff log.
7. **`typecheck.txt` "edit" as a plan item.** It is just the output of the one typecheck. It is fine to write, but it is not scope.

FIXES:
1. **Factory (events.ts).** Use `export function createConversionDelivery(required: PluginCapabilityDependencies & { authority: TikTokConversionAuthorityPort })`.
   - Parse the configuration ONCE, without I/O, as meta capi.ts:42 does: `pluginConfigurationSchema.extend({ accountId: vendorIdSchema, settings: z.object({ conversionConfiguration: z.strictObject({ pixelId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/) }) }) })`. Reuse the existing pixel regex from events.ts:17 and events-payload.ts:10.
   - A malformed configuration gives `invalid_input` from deliver and reconcile, with zero credential or fetch calls.
   - Delete `createTikTokEventsBackend`, the local `configurationSchema`, `tiktokServiceContextSchema` and the `Dependencies` egress type.
2. **Request/event.** Copy meta capi.ts:10-13 (identifier map ≤16, digest map ≤16, `value: moneySchema.optional()`, `orderRef`, contracts `serviceContextSchema`/`measurementGrantSchema`, `deliveryId: idSchema`). Derive all types with `z.infer`. Replace the hand-written `TikTokConversionEvent`/`TikTokEventsRequest`/`TikTokConversionOutcome` interfaces (events.ts:21-23) with `z.infer` aliases under the same names. Outcome = meta capi.ts:15 shape.
3. **Checks.** Use meta's `checkConversionAuthority` and `grantMatches` (capi.ts:86-102) with TikTok messages:
   - configuration scope equals context scope, and grant scope equals context scope;
   - grant connectionId and accountId equal the configuration's;
   - grant destination and purpose equal the event's;
   - `definitionIds.includes`;
   - not revoked or expired;
   - age within 7 days (keep `604800000` as a named constant).
   Drop the `mode`, `configuration.destination/purpose` and `payloadSchema` checks (events.ts:82,92).
4. **Projection and mapping** in one `mapPayload` (≤10 complexity):
   - (a) Event name: `Object.hasOwn(eventNames, definitionId)` with `{signup:"CompleteRegistration", trial:"StartTrial"}`. Anything else gives `invalid_input` "TikTok conversion not sent: no supported TikTok event for this definition".
   - (b) Project with `z.object({ email: digestSchema.optional(), phone: digestSchema.optional(), external_id: digestSchema.optional(), event_source_url: tiktokUrlSchema.optional() }).safeParse(event.identifiers)`. Unknown keys are stripped; a known key that is malformed gives `invalid_input`.
   - (c) If `event_source_url` is missing, or none of email/phone/external_id is present, return `invalid_input` "TikTok web event not sent: missing event_source_url or a supported identifier". This runs before any authority, credential or fetch call.
   - (d) Value: `properties: { value: minorUnits / 10 ** new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits!, currency }`, only when `value` is present (meta capi.ts:81).
   - Error messages never echo identifier values.
5. **Payload schema (events-payload.ts).**
   - Add `properties: z.strictObject({ value: z.number().nonnegative().finite(), currency: z.string().regex(/^[A-Z]{3}$/) }).optional()` to the data item.
   - Keep the strict `userSchema` as the final egress guard. The projection in FIX 4b feeds it only known keys.
   - Update the docstring at :6, which says "unsupported fields reject the entire event". It is now: the projection drops unknown keys, and the payload stays strict.
6. **Send.**
   - Keep `dispatch` as it is (events.ts:96-115), including the consumed-callback guard and the observer, but pass meta's spread shape (`...request, configuration, payload, execute`).
   - Inside `send`, build `createTikTokFetchEgress({ fetch: required.fetch, credentials: createTikTokCredentials(required), observer: required.observer })` per call, exactly as capabilities.ts:41 does. No module-level or factory-level egress or credential caching.
   - A valid ack gives `{ status: "delivered", diagnostics: { accepted: true, processed: null, attributed: null, observedAt: required.clock.now({}) } }`.
   - Everything else follows `uncertainFailure` and `unknown()`, unchanged.
   - `reconcile` parses the request and returns `unknown` with zero authority, credential or fetch calls.
7. **Evidence** (primary-sources.json, event/track entry :354-388).
   - Append `"data[].properties.value"` and `"data[].properties.currency"` to `confirmedRequestFields`.
   - Append one `confirmedFromOfficialSearch` line: phone = plus-form E.164 SHA-256 → contacts `phone` (not `phone_digits`); value = decimal number converted from Money minor units; currency = ISO 4217.
   - DO NOT change `inspectedAt`: manifests.test.ts:52 asserts the literal `"2026-10-13"` for every endpoint.
   - Put the dated URLs from this review in report.md.
8. **Complexity.** Split as Meta does (`prepareConversion` / `mapPayload` / `checkConversionAuthority` / `grantMatches` / `dispatch` / `send`). Each function ≤10, nesting ≤3, `fn(required, optional?)`.

REUSE:
- Factory, settings, grant and outcome shape → meta-ads src/capi.ts:10-116 (pattern only).
- Money exponent → meta capi.ts:81 and microsoft-ads src/campaign-translation.ts:66.
- Credentials and bounded single POST with post-credential fence → tiktok transport.ts:23-28, :35-72 (`createTikTokCredentials`, `createTikTokFetchEgress`). Per-call construction → capabilities.ts:41.
- Ack decoding → commands.ts:168 `decodeTikTokAcknowledgement`. Bounding → commands.ts:137 `boundTikTokJson`. Failure helper → commands.ts:132.
- Service context → contracts `serviceContextSchema` (values/index.ts:21).
- Configuration → contracts `pluginConfigurationSchema` (capabilities/index.ts:101).
- Fixtures → existing tests/fixtures.ts: `fixture({kind:"fetch"})` fetch recording, `clock`, `now`, `grant`, `serviceContext`.
- Real-factory test: capabilities.test.ts:51-58 and manifests.test.ts:65 already call real `createCapabilities` with a server-shaped configuration. The new real-factory test calls `createConversionDelivery`; there is no second catalog test.

DUPLICATES:
- Jini published 0.6.15-rc.2 (`node_modules/.pnpm/@jini-ai+*@0.6.15-rc.2*/…/dist`): no TikTok, Events API or `event/track` delivery and no money-exponent helper. The only hits are a remixicon CSS glyph and a doc comment in mcp `federation/refusal-notice.d.ts:161` (a `tiktok_publish` tool-id example). Not a fit.
- Jini upcoming (tovu-integration-clones/ai-traces-jini, read-only): no `event/track` or `business-api.tiktok` hits.
- Tovu: no `event/track` or `business-api.tiktok` hits outside node_modules and dist.
- The bounded fetch and response reader is already OM-local in transport.ts and stays as is. Jini's rc.2 bounded reader adoption is a separate cross-plugin concern, not this job.
- None found. No JINI ASK.

OWNER DECISIONS (defaults):
1. **Who recomputes the conversion fingerprint.** Default: the Coordinator, right after the dist rebuild. Run `node --input-type=module -e "import('/Users/la/Programming/Open-Marketing/content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/dist/index.mjs').then(m => console.log(m.tiktokEventsSchemaFingerprint))"` and write the value to `plugin.json:135` and `io.github.ainsep.openmarketing/capabilities.json:119`. manifests.test.ts:38 requires both to equal the export. Alternative: switch the recipe to `shasum src/events-payload.ts`. Rejected: it churns the exported constant and the test.
2. **The `grant.payloadSchema` binding.** Default: dropped, matching Meta and Google. The grant's integrity is enforced server-side by A3's hash comparison of the stored grant (backends.ts:836).
3. **Phone key.** Default: send contacts `phone` (plus-form E.164 hash) and ignore `phone_digits`, `fbc`, `fbp`, `gclid`, `gbraid` and `wbraid`.

APPROVED SCOPE for B1:
1. **Source** (`src/events.ts`, `src/events-payload.ts`, `src/index.ts`, `src/transport.ts`) per FIXES 1-6, 8.
   - index.ts:10-11: export `createConversionDelivery`, `tiktokEventsSchemaFingerprint` and the surviving `z.infer` types. Remove `createTikTokEventsBackend` and `TikTokEventsConfiguration`, or re-alias the latter to the new configuration type.
   - transport.ts:6,15: import `tiktokEventsPayloadSchema` from `./events-payload.js`, and use contracts `serviceContextSchema` in the context union.
   - Update progress.md.
2. **Fixtures** (`tests/fixtures.ts:150-178`).
   - Replace `eventsConfiguration` with `pluginConfigurationSchema.parse({ scope: context.scope, connectionId: "connection", accountId: "123", pluginDigest: binding.pluginDigest, settings: { conversionConfiguration: { pixelId: "fixture-pixel" } } })`.
   - Change `conversion.event` to measure's shape: drop `eventType`; add `identifierDigests` for the same keys; set `destination` to `"tiktok-ads"`, with the grant matching.
   - `eventsFixture({ configuration? })` builds `createConversionDelivery({ configuration, fetch: <recording fetch from fixture({kind:"fetch"})>, credentials: <fixture credentials adapted to the canonical access({connectionId, accountId})>, clock, observer, wait, authority })`. Keep the existing authority double (claims, consent, throwBefore/After).
3. **Migrate the existing `tests/events.test.ts` cases** (fetch only), with CUT 4 removals.
   - Boundary rows at :72-74 become: `{ ip: … }` plus a valid email → delivered with `ip` absent from the payload; `{}` → the "not sent" refusal; raw or uppercase digests → `invalid_input`.
   - The `pixelId: "../evil"` case (:109) moves into settings.
4. **New cases**, written and NOT run:
   - (a) Real-factory: a server-shaped configuration plus fixture fetch, with identifiers `{ email, phone, phone_digits, fbc, gclid, event_source_url }`. Expect exactly ONE POST to `…/v1.3/event/track/` whose body `user` is exactly `{ email, phone }`, with no `phone_digits`, `fbc` or `gclid`. Expect the result `delivered`, with `{ accepted: true, processed: null, attributed: null, observedAt: now }`.
   - (b) Missing `event_source_url` gives `invalid_input` "not sent", with zero credential and zero fetch calls.
   - (c) `definitionId: "qualified"`, granted, gives `invalid_input` with zero fetch. Also add a `constructor` row for the `Object.hasOwn` guard.
   - (d) `it.each` USD 1234 → 12.34, JPY 500 → 500, KWD 1234 → 1.234 in `properties`. No `properties` key when `value` is absent.
   - (e) Malformed settings (missing `conversionConfiguration`) give `invalid_input` with zero calls.
   - Update progress.md.
5. **Docs.** README.md:22 and the last sentence of :32 (CUT 6). primary-sources.json per FIX 7.
6. **Typecheck once:** `corepack pnpm --dir content/agent-plugins/tiktok-ads typecheck`, with one rerun. Record it in typecheck.txt. No tests, builds, installs, om:check, indexing or node scripts.
7. **report.md:** actual +/- lines, the vendor URLs above, and the NEEDS below.

NEEDS (report.md, not B1):
- **Coordinator:**
  - Rebuild `tiktok-ads/io.github.ainsep.openmarketing/dist/index.mjs`.
  - Then recompute `tiktokEventsSchemaFingerprint` from the dist (OWNER DECISION 1) and write it to plugin.json:135 and capabilities.json:119.
  - Serialize this with W22-CONVERSION-SETTINGS's `pixelId` declaration in the same plugin.json, and have that job extend manifests.test.ts:12.
- **W22-CONVERSION-SETTINGS:** supply `settings.conversionConfiguration.pixelId`.
- **W22-CONTACTS-META-IDENTIFIERS:** supply consented `event_source_url`. Until then every TikTok signup/trial is refused "not sent", as Meta's is.
- **Measure owner:** the pre-send "not sent" reason collapses in the dispatcher (same NEEDS as gmeta).

LOCKS-FILES: content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/events.ts, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/events-payload.ts, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/index.ts, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/transport.ts, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/tests/fixtures.ts, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/tests/events.test.ts, content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/evidence/primary-sources.json, content/agent-plugins/tiktok-ads/README.md, ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-tiktok-conversion-delivery/ (lock groups: w20-tiktok)

## COORDINATOR OVERRIDE (open-marketing-f6)
1. Defaults accepted: coordinator recomputes the conversion fingerprint from the rebuilt dist (plugin.json:135, capabilities.json:119), serialized after w22-conversion-settings edits plugin.json; grant.payloadSchema check dropped (as Meta/Google); phone = contacts E.164 `phone` hash with "+". In report.md cite the TikTok source used for the phone format.
