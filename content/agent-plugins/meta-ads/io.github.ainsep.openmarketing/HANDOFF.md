# w3-meta-ads-capi handoff — Programmer(Direct)

The Meta plugin now accepts contacts-produced SHA-256 digests, preserves the shared OM event ID, assembles captured click attribution, and includes explicit test-event/consent metadata in the server-only CAPI payload. Campaign creation reuses the existing PAUSED codec; activation remains a separate exact-card operation. These are backend building blocks for server integration. The plugin stays disabled and unadmitted, so no user can make an unverified hosted write.

Continuation: inspected the lane's status/diff first, retained the five partially edited CAPI/entry/fixture files, and finished the remaining approved tests, metadata and documentation. No new files, dependency installs, shared-contract edits, migrations, commits or pushes. Campaign production code is unchanged. No live provider requests or credentials were used; documentation browsing was read-only.

## Campaign launch — W20 (2026-10-28)

Launch v2 translates traffic with ONE existing single-link creative to a PAUSED hierarchy. Country targeting, up to 200 postal codes, or one radius are supported. At prepare time, postal codes use Graph API v26.0 [Targeting Search](https://developers.facebook.com/docs/marketing-api/audiences/reference/targeting-search/) GET /search (`type=adgeolocation`, `location_types=["zip"]`, `q`, `country_code`, `limit=100`); exactly one exact-name in-country zip is required and its key is used verbatim. Lookups are sequential with a 30 s aggregate deadline, 15 s/request and 1 MiB/response; large lists may time out. No supplied mappings, cache, retry or pagination. Postal and radius replace countries. Radius preserves coordinates/value, explicitly sends `kilometer`, and accepts 1–80 km without intersecting listed countries; see [Basic Targeting](https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting/). The approved review verified search fields; this run received HTTP 429 from the reference and confirmed the route/version against Meta's official [SDK search](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/targetingsearch.py) and [v26.0 configuration](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/apiconfig.py).

The ad's destinationUrl is bound into the plan and its existing digest. Before any checkpoint or creation POST, one scoped creative GET must prove account ownership and an exact `object_story_spec.link_data.link` match. Existing-post, video-only, carousel and dynamic creatives refuse. The GET additionally requests `asset_feed_spec` to reject dynamic evidence even alongside link data. The [AdCreative reference](https://developers.facebook.com/docs/marketing-api/reference/ad-creative/) documents link data and tracking `url_tags`; tags append click-time parameters and are ignored here. No creative URL is rewritten. Reconciliation verifies the ad's creative ID without another creative GET, because the destination is effectively immutable. Readback ignores descriptive location fields/default `location_types`, sorts postal keys, and refuses extra geography or changed radius/coordinates/units.

W22 postal regressions are written in campaign-translation.test.ts, with the existing deployment suite retained; tests were not run. `corepack pnpm --dir content/agent-plugins/meta-ads typecheck` passed (exit 0) on the permitted rerun after changing the search limit to a string. The approved extra server typecheck stopped at unrelated reporting.ts:51–52 nextCursor errors before server tests could compile. Shared contracts and hosted commands are unchanged; MetaPausedPlan is derived from the deployment Zod schema, which now requires ad.destinationUrl. W22 removes optional resolved.postalCodes; translateCampaign is now async and requires context, call-scoped dependencies and target.connectionId, with optional CallOptions. USD exponent 2 and existing minor-unit budget semantics remain. Plugin disabled/unadmitted flags are unchanged.

Deferred/NEEDS: Coordinator rebuilds Meta dist and refreshes the executable bundle digest together with the awaited generic server integration (source and regression included in W22); never pair rebuilt async translation with the old synchronous caller. The older social deployment fixture still needs prepared Meta ad.destinationUrl = `https://example.test/landing`, creative 987 with account_id `123` and matching link data. Production metadata preparation, HTTP + om-tool + CLI + Studio acceptance, multi-ad/creative cloning, leads/sales, special categories, other creative forms and campaign.validate.v1 remain follow-ups. This source change does not establish production feature availability. W22 edits no declared fingerprint input or manifest; the Coordinator refreshes the executable bundle digest.

## CHANGED FILES

All paths below are relative to `content/agent-plugins/meta-ads/`:

- `io.github.ainsep.openmarketing/src/capi-normalization.ts`: removes all email/phone/external-ID normalization and hashing; `mapMetaIdentifiers` validates lowercase 64-hex digests, maps Meta arrays and assembles paired click fields into fbc.
- `io.github.ainsep.openmarketing/src/capi.ts`: validates click time against occurrence, test/consent metadata, assembles root test code/event consent fields and forwards the complete payload to authority.
- `io.github.ainsep.openmarketing/src/index.ts`: required rename export; no compatibility alias. This eleventh file is the Coordinator-required caller/export update beyond the original ten-file map.
- `io.github.ainsep.openmarketing/tests/capi-fixtures.ts`, `tests/capi.test.ts`: fixed contacts hashes, original/assembled consent-key checks, admission/egress fences, payload and uncertainty cases.
- `io.github.ainsep.openmarketing/tests/contract/gateway-suite.ts`: creation without spending fields/automatic activation, independent activation evidence/current host denial, unavailable behavior and incomplete readback cases for both existing gateways.
- `plugin.json`, `io.github.ainsep.openmarketing/capabilities.json`: matching refreshed conversion fingerprint; disabled/unadmitted declarations retained.
- `io.github.ainsep.openmarketing/evidence/primary-sources.json`: reachable Meta source evidence and failed documentation checks on 2026-10-13; reproducible local-codec fingerprint method.
- `README.md`, this `HANDOFF.md`: contacts/backend seam, integration obligations and availability limits.

## TESTS — written, not run

No tests, om:check, builds or installs were run, per this dispatch. No passing tests, red/green evidence or coverage percentage is claimed. No existing assertion was removed or weakened; the old normalization assertions were updated to the explicitly approved contacts-only handoff.

CAPI cases assert unchanged digests, explicit external-ID mapping, rejection of raw/uppercase/malformed values alongside valid identifiers, paired/bounded click fields, safe integer click milliseconds, click time at occurrence and one millisecond after it, contradictory supplied fbc, root test code, event consent fields (including false/zero/empty options), no invented defaults, malformed metadata rejection before authority/egress, consent denial for original and assembled keys, withdrawal during credential resolution, unverified admission even for test events, stable event/delivery IDs, and no resend after timeout/ambiguous acknowledgement during reconciliation.

The existing `gateway.test.ts` instantiates the same shared suite for the direct double and hosted wrapper with an injected local host fixture. Added cases assert one PAUSED creation without budget fields, creation authority cannot activate, independent activation evidence plus current exact host authority are required, unverified claims return typed unavailable before handoff, and incomplete hierarchy readback remains unknown. These fixtures do not prove a real host card implementation or live Meta behavior.

## TYPECHECK

Exactly one typecheck ran for this continuation:

`./node_modules/.bin/tsc --noEmit -p content/agent-plugins/meta-ads/tsconfig.json`

**PASS — exit 0, no diagnostics.** No subsequent source/test edits and no second typecheck. This validates TypeScript only; fixtures were not executed.

## CONTRACTS

No `packages/contracts`, feature, root manifest, lockfile, composition or other plugin file changed. Backend events now require `definitionId` and measurement grants bind 1..16 open definition IDs; signup/trial vendor mappings remain. The required exported function rename is `normalizeMetaIdentifiers` → `mapMetaIdentifiers`, with no alias. The existing `NormalizedMetaIdentifiers` result type remains to avoid an unrequested type rename.

Contacts is the ONLY normalizer/hasher. Present `identifiers.email`, `phone_digits`, `external_id` must contain lowercase SHA-256 digests; the plugin maps them unchanged to `em`, `ph`, `external_id`, while the accepted plus-form `phone` digest is ignored. Raw identifiers reject the entire request. Optional paired `fbclid`/`click_time_ms` strings assemble `fb.1.<captured milliseconds>.<click ID>`; the backend checks the captured time is no later than occurrence. A supplied fbc is preserved unless it contradicts assembled attribution. No dispatch-time substitution or implicit subject export occurs.

`MetaCapiRequest` adds optional `test: { eventCode }` and server-approved `consent` fields. `MetaCapiPayload` adds root `test_event_code` and event-level `opt_out`, `data_processing_options` ([] or ["LDU"]), country and state. Consent semantics are not inferred, and test/consent metadata never grants authority.

The existing authority port's dispatch argument now includes `payload`. Server composition must check CURRENT grant/consent for original keys and assembled attribution, approve metadata, verify Graph version/dataset/capability admission, bind the exact payload to durable deliveryId, append egress audit and keep the fence through credential resolution/POST. Missing consent is forbidden; unverified admission is unavailable before egress. Payload and original event are both available to this authority.

The shared OM eventId supplies Meta event_id. The durable deliveryId supplies the operation key. Measure/jobs retain duplicate suppression and ONE outbox. Unknown outcomes reconcile without resending; the plugin adds no dedupe store, retry or reconciliation endpoint.

Tier A A6 mapping is done (w20-gmeta-conversion-delivery): `createConversionDelivery` consumes measure's open `definitionId` and the shared `MeasurementGrant.definitionIds` directly with A3 dependencies; only `signup`→CompleteRegistration and `trial`→StartTrial website events carrying `client_user_agent` and `event_source_url` are sent, and every other definition (including qualified/won, since Conversion Leads requires a Meta lead-ad lead_id) is refused unsent.

Portable `mcp.json` is unchanged, closed and empty. All OM metadata remains in the existing extension namespace. Conversion fingerprints hash concatenated `src/capi-normalization.ts` and `src/capi.ts` bytes in that order; they are proposed local-codec fingerprints, never proof of hosted schemas or admission.

Reuse: identifier assembly; inspected the existing lane mapper/backend, public measure entry and contracts; used existing strict Zod validation and simple string assembly; normalization/hashing owner is contacts per this dispatch, with no plugin fallback.
Reuse: campaign writes; inspected encodeCommand, adapter, evidence and readback; used unchanged production PAUSED/exact activation code and extended the existing shared hosted/double suite. No new adapter, port, registry or bundled server.

## RISKS / architecture audit

Architecture audit: **WARNING — hosted evidence, integration and runtime validation remain incomplete.** Reviewed the changed source/tests/config/docs against COMMON and the approved file map: lane-only ownership; public imports; pure identifier mapping; injected clock/authority/egress/observer; inert factories; strict bounded one-event requests; current consent and exact server authority; stable IDs; no retries/outbox duplication; credential isolation; namespace isolation; disabled admission. No known lane/dependency ownership violation remains. Mechanical lint, complexity, nesting and runtime gates were not run; no gate G claim.

Meta's CAPI parameter, campaign reference and fbp/fbc docs returned HTTP 429 on 2026-10-13. Hosted overview/setup and detailed customer-information docs returned unreadable retrieval errors. No authenticated tools/list was captured. Reachable Meta-owned SDK source supports root test_event_code, event_id/event_name identity and event-level consent field names; campaign SDK source includes PAUSED/ACTIVE. Meta WooCommerce source supports the millisecond fbc format. These establish model evidence only. Exact regional consent semantics, explicit opt_out false acceptance, current Graph-version admission, account/dataset permissions, hosted write behavior and per-event reconciliation remain unverified. Missing evidence must keep capabilities unavailable. The fixture Graph version and seven-day OM age bound do not assert current vendor eligibility or limits.

Function-quality self-review (static; runtime/coverage evidence remains unmeasured):

| Unit | Disposition | Findings / local action | Direct written evidence |
| --- | --- | --- | --- |
| identifiersSchema / mapMetaIdentifiers | NO_RECORDED_FINDINGS | Single pure validation/assembly boundary; no hashing, raw input rejected atomically, conflicting fbc rejected. | capi.test.ts digest/attribution cases |
| buildUserData / hasMatchIdentifier | NO_RECORDED_FINDINGS | Fixed field mapping, omissions explicit, no fabricated match identifier. | capi.test.ts external-only/click-only/no-match cases |
| prepareConversion / request schemas | NO_RECORDED_FINDINGS | Strict metadata and click/occurrence checks; one complete outgoing payload. | capi.test.ts test/consent/age/invalid-metadata cases |
| dispatchConversion / backend | INCONCLUSIVE | Medium:integration — expanded payload binding requires a real server authority adapter and shared runtime verification. Existing seams remain, no speculative implementation added. | capi.test.ts authority/fence/timeout/reconciliation cases |
| gatewaySuite / capiFixture | INCONCLUSIVE | Runtime validation intentionally forbidden in this dispatch. Host/card behavior is simulated, never certification. | gateway.test.ts both gateway variants; capi.test.ts |

No unresolved Critical/High semantic finding from static review; mechanical metrics unavailable. Complexity: bounded identifier/request validation O(n) time/space where n is field/payload bytes, fixed field mapping O(1), one bounded POST with no internal retries. CAPI input/ACK <=16KiB, click ID <=220 characters, identifiers/URLs bounded; timeout <=60 seconds. Reviewed variable names for captured versus dispatch time, occurrence versus delivery identity, original versus assembled identifiers and ACK versus observed state. Adversarial fixtures cover valid-plus-invalid identifiers, conflicting attribution, repeated delivery IDs and lost acknowledgements with no reconciliation resend. No coverage metric or function-quality PASS claim is made without execution.

Documentation: mapMetaIdentifiers/identifier seam and request/payload/authority are documented; backend factory and MetaConversionInput comments updated; existing helper comments now describe mapping rather than normalization. README includes caller metadata examples and exact authority responsibilities. No additional optional factory parameters or layers were introduced.

## NEEDS

1. Contacts owner supplies the agreed digest/attribution mapping. The plugin never falls back to hashing.
2. Server integrator adapts open conversion definition IDs and grants to the existing signup/trial contract, supplies trusted test/consent metadata, and updates authority to inspect/bind the exact payload using existing jobs/audit. A future definition-ID-based vendor mapping needs its own approved contract scope.
3. Host owners capture authenticated tools/list plus primary/account behavior evidence; verify Graph version, dataset permissions and consent-option semantics; implement bounded credentialed egress and current consent fences. Keep hosted writes and backend admission unavailable until verified.
4. Shared dependency owner upgrades the host to `@jini-ai/agent-plugins@0.4.4`, including manifest/lockfile work. No dependency addition or publication verification was attempted in this continuation.
5. Coordinator/TestRunner run lane regressions, portable host-inspector suite, actual host/credentialed egress shared suites, builds and `corepack pnpm om:check`. A real credentialed CAPI adapter is not implemented here.
6. OAuth, full hierarchy/creative orchestration and bundled write-server fallback remain deferred. A recorded owner decision is required before implementing a fallback; historical acceptance of a pattern is not authority for this job.

## HANDOFF / pre-completion

Next route: server/contacts/host integrators → evidence verification → independent Code Inspection/TestRunner → admission decision. Source changes for the two approved paths are complete; production availability remains blocked by the explicit NEEDS above.

Requirements and required changes were re-read, initial partial work preserved, and lane status/diff reviewed. Whitespace review with `git diff --check -- content/agent-plugins/meta-ads` found no errors before final documentation. No tests were deleted or weakened to manufacture a green result. No external memory/session/progress-ledger file was edited; this handoff is the permitted continuation record. Runtime self-validation was not run because tests/builds/live calls are prohibited. No loop alert was triggered. No commit or push.
