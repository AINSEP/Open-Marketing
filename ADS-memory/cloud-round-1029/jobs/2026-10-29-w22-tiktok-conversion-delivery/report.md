Programmer(Direct): TikTok now exports the conversion-delivery factory A3 expects. Once the Coordinator rebuilds the plugin and the settings/metadata jobs land, granted signup/trial conversions can send one guarded Events API request. Unsupported definitions or missing page/identifier fields return a typed unsent refusal before authority, credentials or fetch. Acceptance remains separate from processing and attribution.

Implemented B1 only, following review.md's cuts, fixes and Coordinator override. No new user surface, transport, port, retry, journal or dependency.

## CHANGED FILES

All paths below are under content/agent-plugins/tiktok-ads/, except the three job records. Counts compare the actual working tree at this run's start with this run's final files, preserving prior dirty work; they are not changes against HEAD.

| File | Added | Removed | Change |
|---|---:|---:|---|
| io.github.ainsep.openmarketing/src/events.ts | 59 | 37 | Replace old factory/configuration/events with canonical A3 input; projection, Money, grant binding and accepted-only diagnostics |
| io.github.ainsep.openmarketing/src/events-payload.ts | 2 | 2 | Optional strict value/currency properties; projection documentation |
| io.github.ainsep.openmarketing/src/index.ts | 1 | 1 | Export createConversionDelivery in place of createTikTokEventsBackend |
| io.github.ainsep.openmarketing/src/transport.ts | 3 | 3 | Canonical serviceContextSchema and direct payload import, avoiding the new events/transport cycle |
| io.github.ainsep.openmarketing/tests/fixtures.ts | 14 | 12 | Server configuration, measure event, fetch-only conversion fixture; expose existing fetch/credentials to factory tests |
| io.github.ainsep.openmarketing/tests/events.test.ts | 143 | 86 | Migrate assertions once on fixture fetch and add only approved regressions |
| io.github.ainsep.openmarketing/evidence/primary-sources.json | 5 | 2 | Append two property fields and one hashing/value/currency evidence line; retain inspectedAt |
| README.md | 2 | 2 | Only factory bullet and final definition-mapping sentence |
| **Lane total** | **229** | **145** | **+84 net lines** |

Required job records: ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-tiktok-conversion-delivery/progress.md, typecheck.txt and report.md. No other files edited. plugin.json, capabilities.json, manifests.test.ts and dist were deliberately untouched, as required by the trim.

## TESTS — written, not run

tests/events.test.ts exercises the real exported factory with canonical configuration and a recording fixture fetch. New assertions cover:

- One Events POST; user exactly email/phone, preserving the phone hash while dropping phone_digits/fbc/gclid; original authority event/digest map preserved; accepted/processed/attributed diagnostics and no properties when value is absent.
- Unrelated ip stripped while a valid email survives.
- Missing event_source_url: typed invalid_input with the explicit not-sent reason and zero authority/payload, credential and fetch calls.
- Granted qualified and constructor definitions: typed not-sent refusal with zero fetch.
- Money conversion: USD 1234 → 12.34, JPY 500 → 500, KWD 1234 → 1.234.
- Malformed settings: deliver and reconcile refuse before any authority, credential or fetch call.

Migrated existing signup/trial, grant/account/scope/purpose, malformed digest/URL, age, withdrawal during credential lookup, cancellation, duplicate claim/execute, ambiguous receipt/network failure, no-I/O reconciliation, secret redaction, observer exception and partial-invalid-batch assertions. Removed the duplicated memory/fetch Events loop and obsolete mode/payloadSchema/eventType rows per the review. The shared transport/gateway fixture({kind}) and their suites remain.

The existing capabilities.test.ts real-createCapabilities catalog test remains unchanged; no duplicate catalog test added. Regression cases are written to reject the previous API/input/projection/value behavior; RED/GREEN has NOT been demonstrated because the owner explicitly prohibits test execution. No coverage or runtime result is claimed.

## TYPECHECK

Command: corepack pnpm --dir content/agent-plugins/tiktok-ads typecheck

Result: EXIT 0, first and only invocation. Compiler included src and tests; no diagnostics. Exact output: typecheck.txt.

No vitest, jest, playwright, test suites, om:check, builds, installs, indexing, node scripts, live vendor calls, commits or pushes.

## CONTRACTS

- Added createConversionDelivery(required: PluginCapabilityDependencies & { authority: TikTokConversionAuthorityPort }): TikTokEventsBackend. Removed the superseded createTikTokEventsBackend implementation/export; no compatibility wrapper.
- Configuration parses once without I/O using pluginConfigurationSchema extended with settings.conversionConfiguration.pixelId and the existing pixel/advertiser validation.
- TikTokEventsConfiguration, TikTokConversionEvent, TikTokEventsRequest and TikTokConversionOutcome derive from Zod. Requests match measure's event fields, including identifierDigests and optional Money/orderRef; no eventType.
- Grant checks bind configuration/context/grant scope, connection/account, event destination/purpose, definitionIds, expiry/revocation and the seven-day occurrence bound. A3 retains mode, grant-integrity, consent, dispatch and durable audit authority. No plugin-local admission gate.
- Project through non-strict z.object for only email, phone, external_id and event_source_url; validate the final single-event payload strictly. Original identifiers/digests go to authority without projection.
- Preserve original eventId and floor epoch milliseconds to Unix seconds. Money uses minorUnits and Intl currency exponent.
- Keep authority.dispatch({...request, configuration, payload, execute({isCurrent})}), its consumed-callback guard and observer. Construct existing credential/egress adapters per send; no token/capability cache. One guarded POST; no preflight or retry.
- Valid code-zero ACK returns delivered with accepted:true, processed:null, attributed:null and injected observedAt. Ambiguous outcomes stay unknown; reconcile validates without authority, credential or fetch access.
- uncertainFailure remains unchanged because adapter.ts and capabilities.ts still consume it.
- Shared contracts/manifests/lockfile/composition unchanged. Migrations: none.

## REUSE

Reuse: request/configuration/grant/outcome pattern; inspected meta-ads/src/capi.ts, google-ads/src/conversions.ts, w20-gmeta review/postcheck and A3 conversionCall. Used their approved shape as a style precedent, without cross-plugin imports. TikTok owns its vendor-specific codec per the binding design.

Reuse: single credentialed send, deadline, bounded receipt, post-credential fence and telemetry; searched existing TikTok src/transport.ts, commands.ts and capabilities.ts. Called createTikTokCredentials/createTikTokFetchEgress, boundTikTokJson, decodeTikTokAcknowledgement and failure; retained the existing transport implementation.

Reuse: pure schemas and parsing; called contracts pluginConfigurationSchema, serviceContextSchema, measurementGrantSchema, moneySchema, digestSchema and parseBoundary. Used built-in Intl for the approved currency exponent, as Meta already does.

Reuse search: searched Tovu/apps and upcoming ai-traces-jini/packages read-only for event/track/, business-api.tiktok, minorUnitExponent and maximumFractionDigits; no reusable TikTok Events delivery or currency-exponent implementation found. Inspected installed @jini-ai/platform@0.6.15-rc.2 dist timeout declarations; retaining this plugin's existing bounded transport is the approved scope. The trim independently searched all installed Jini rc.2 dist packages and found no TikTok delivery helper. No unpublished API or stale /Users/la/Programming/Jini API claim used. No new JINI ASK.

## VENDOR EVIDENCE — checked 2026-10-29

Current technical facts were checked using TikTok primary sources and official indexed documentation. Direct developer-portal rendering requires JavaScript; indexed official content supplied the field tables.

- [Events API 2.0 web request](https://business-api.tiktok.com/gateway/docs/index?doc_id=1771100865818625&language=ENGLISH): POST open_api/v1.3/event/track/, Access-Token, web pixel source, single data item fields, required page, Unix seconds and event_source_id/event/event_id dedupe identity. properties.value is numeric; currency is ISO 4217.
- [TikTok identity normalization and hashing](https://business-api.tiktok.com/gateway/docs/index?doc_id=1739585700402178): E.164 includes the leading plus before SHA-256. This is the primary source used for sending contacts phone unchanged, rather than Meta's phone_digits digest.
- [Standard events](https://ads.tiktok.com/resources/help/article/standard-events-parameters?lang=en): CompleteRegistration and StartTrial match the two approved definitions.
- [Event deduplication](https://ads.tiktok.com/resources/help/article/event-deduplication?lang=en): identical event/event_id Events API submissions deduplicate within 48 hours. No automatic retry authority inferred.

Review URLs retained for the handoff: [portal entry](https://business-api.tiktok.com/portal/docs?id=1771100865818625), [LiveRamp parameter reference](https://developers.liveramp.com/authenticatedtraffic-api/docs/supported-parameters-for-tiktok-events-api), [Tealium connector reference](https://docs.tealium.com/server-side-connectors/tiktok-events-connector), [Amplitude destination reference](https://amplitude.com/docs/api/content/data/destination-catalog/tiktok-ads-event-stream). The implementation's technical claims above use TikTok primary sources.

## RISKS / DEFERRED

- Tests and live/runtime behavior are unverified under the owner's execution restriction. Typecheck is not runtime proof.
- The rebuilt schema fingerprint will differ because properties was added. Manifest equality checks are expected to remain unsatisfied until the Coordinator rebuilds dist and writes the new fingerprint.
- Token/pixel eligibility and processing/attribution remain unverified; admission is unchanged. No receipt readback or blind resend.
- Existing uncertainFailure semantics can classify some pre-send transport failures as unknown. The approved plan explicitly retains that helper; diagnostics/measure owns further classification.
- README's untouched identifier paragraph still says extra fields fail atomically; the updated factory bullet documents projection correctly. CUT 6 permits only two README spots, so this stale sentence was deliberately left for the Coordinator.
- No qualified/won/purchase mappings, ttclid/IP/UA/cookie collection, hashing, account preflight, retries, new settings UI, transport replacement, diagnostics extension or runtime build added.

## DISPUTED / ALREADY FIXED

- Current source already used grant.definitionIds (old events.ts:14,92); this run retained the canonical grant and updated binding to A3's configuration, rather than rebuilding a grant contract.
- src/transport.ts:64 already rechecked authority/cancellation after credentials; retained unchanged. Only its schema imports/context union changed.
- No other requested defect was disputed.

## ARCHITECTURE AND QUALITY REVIEW

Static architecture audit: PASS for the scoped source boundary. Checked vendor code stays in the plugin, only public contracts imports, injected I/O/clock, no new runtime registry/dependencies, one dispatch with server authority, unchanged uncertainty and bounded transport, pure schemas/mapping, schema-derived data types, object parameters, complexity <=10/nesting <=3 by source inspection. Runtime verification remains PARTIAL because test/build/probe execution is forbidden.

| Unit | Disposition | Findings | Local fix / direct assertion |
|---|---|---|---|
| createConversionDelivery and deliver/reconcile wrappers | NO_RECORDED_FINDINGS | None in scope | Canonical real-factory, malformed settings and no-I/O reconcile assertions |
| prepareConversion | NO_RECORDED_FINDINGS | None in scope | Cancellation, invalid event/configuration, age/grant and pre-authority refusal assertions |
| mapPayload | NO_RECORDED_FINDINGS | None in scope | Extra-key, constructor/qualified, known malformed key, missing URL, exact body and three-currency assertions |
| checkConversionAuthority / grantMatches | NO_RECORDED_FINDINGS | None in scope | Migrated binding/revocation/expiry/occurrence assertions; static configuration-scope check |
| dispatch / execute callback | NO_RECORDED_FINDINGS | None in scope | Retained duplicate callback, withdrawal, claim and authority-exception assertions |
| send | NO_RECORDED_FINDINGS | None in scope | Exact POST, credential fence, acknowledgement diagnostics and unknown/no-resend assertions |

Time/space: bounded request parse O(b), maps <=16 entries, grant membership <=16 definitions; projection/money/guards O(1); one existing <=15s fetch and <=1MiB receipt. No new fan-out. Existing failure-helper behavior is an explicit retained risk, not a new mechanism.

Zero-findings skepticism: reread request/configuration shapes, unknown-key projection versus strict egress, original digest handoff, event-name own-property guard, callback consumption, after-credential fence, clock use, uncertainty and number conversion. Variable names describe the values they hold; no stale eventType/mode/payloadSchema configuration reads remain. No new in-scope source defect found by static review; unexecuted tests/coverage and integration dependencies remain explicit limits.

Documentation: factory and projection are documented; payload projection comment and public factory README are stale-doc-updated. Surviving schema-derived type aliases follow the documented request/outcome factory contract; no new documentation layer. No lint/docs tool run was authorized.

Pre-completion: re-read APPROVED SCOPE/FIXES/CUTS; retained unique assertions except explicitly removed host-owned/deleted behavior; verified source/test export uses via rg; compared eight edited lane files with run-start content; final typecheck EXIT 0. No out-of-lane edits or new runtime modules. No self-validation attempts because the owner prohibits test/build/runtime runs.

## NEEDS

- Coordinator: rebuild content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/dist/index.mjs.
- Coordinator: after rebuilding, recompute tiktokEventsSchemaFingerprint from dist and write it to plugin.json:135 and io.github.ainsep.openmarketing/capabilities.json:119, following review.md OWNER DECISION 1. Refresh packaging integrity metadata if required.
- Coordinator: serialize that manifest update after W22-CONVERSION-SETTINGS's pixelId declaration; that job owns extending manifests.test.ts:12.
- W22-CONVERSION-SETTINGS: supply settings.conversionConfiguration.pixelId.
- W22-CONTACTS-META-IDENTIFIERS: supply consented event_source_url. Until supplied, TikTok signup/trial delivery refuses not sent.
- Measure owner / W22-CONVERSION-DELIVERY-DIAGNOSTICS: preserve pre-send not-sent reasons through the dispatcher; no shared outcome extension in this lane.
- Coordinator: correct the stale README extra-fields sentence if expanding the documentation scope.

## HANDOFF

B1 source/tests/docs implementation is complete within scope; first typecheck passed. Ready for the Coordinator's postcheck and serialized integration steps above. No commit/push. All prior unrelated dirty/untracked work preserved.
