Software Architect(Direct):

**1. Summary**

Replace TikTok’s older conversion backend with the `createConversionDelivery` factory the server already expects. Valid signup/trial conversions will make one guarded Events API request, using supported identifiers and optional monetary value. Missing required fields will produce a typed “not sent” failure before credentials or network access. Delivery acceptance will remain distinct from processing and attribution.

**2. Files**

All implementation changes stay within these ten existing lane files:

- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/events.ts` — replace the old factory; align configuration, event input, authority and outcomes with A3.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/events-payload.ts` — retain strict single-event payload validation; add optional value/currency properties.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/index.ts` — export the new factory; remove the superseded factory export.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/src/transport.ts` — consume canonical `serviceContextSchema` and import the payload schema directly.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/tests/fixtures.ts` — adapt conversion fixtures to canonical dependencies and measure’s event shape; reuse recorded fetch/credential fixtures.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/tests/events.test.ts` — migrate existing assertions and add factory/projection/value regressions.
- (edit) `content/agent-plugins/tiktok-ads/plugin.json` — update only the conversion fingerprint.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/capabilities.json` — matching conversion fingerprint.
- (edit) `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/evidence/primary-sources.json` — dated conversion evidence and fingerprint recipe/value.
- (edit) `content/agent-plugins/tiktok-ads/README.md` — replace obsolete factory/configuration instructions and identifier-rejection claims.

Required build records, under the authorized job directory:

- (new) `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-tiktok-conversion-delivery/progress.md` — item completion and unfinished work.
- (edit) `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-tiktok-conversion-delivery/typecheck.txt` — permitted typecheck result.
- (new) `ADS-memory/.local-artifacts/codex-runs/2026-10-29-w22-tiktok-conversion-delivery/report.md` — actual changes, line counts, verification limits and handoff.

**3. Public contracts**

- `createConversionDelivery(required: PluginCapabilityDependencies & { authority: TikTokConversionAuthorityPort }): TikTokEventsBackend`.
- `backend.deliver(required: TikTokEventsRequest, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>`.
- `backend.reconcile(required: TikTokEventsRequest, optional?: CallOptions): Promise<Outcome<TikTokConversionOutcome>>`.
- Existing `authority.dispatch(required: { context, event, grant, deliveryId, configuration, payload, execute }, optional?: CallOptions)` retains A3’s `execute({ isCurrent })` shape.
- Configuration derives from `pluginConfigurationSchema`, refined with `settings.conversionConfiguration: { pixelId: string }`.
- Request/event/configuration/payload/outcome data types derive from Zod. Event matches measure’s `ResolvedConversionInput`: no `eventType`; includes `identifierDigests`, `identifiers`, optional `value: Money` and `orderRef`.
- Outcome remains `delivered | unknown`, with optional `{ accepted, processed, attributed, observedAt }` diagnostics.
- Remove `createTikTokEventsBackend`; retain the existing fingerprint export. No new commands or public schemas.

**4. Approach**

1. Rewrite the existing factory in place. Parse canonical configuration without I/O; remove legacy configuration fields for mode, destination, purpose and payload schema. Server/measure retain those authorities.
2. Parse the bounded canonical request using existing helpers and contracts schemas. Check configuration/context/grant scopes, connection/account, definition, destination/purpose, expiry/revocation and occurrence time. Retain the seven-day OM age cap.
3. Project identifiers through `z.object({ email?, phone?, external_id?, event_source_url? })`, stripping unknown keys before strict payload parsing. Preserve the original event and committed digest map for authority; never mutate them.
4. Require captured `event_source_url` and at least one supported digest. Missing fields return redacted `invalid_input` with “TikTok conversion not sent…” and zero credential/fetch calls. Known malformed fields fail validation.
5. Map `signup` → `CompleteRegistration`, `trial` → `StartTrial`; reject other definitions unsent. Preserve `eventId` and floor occurrence milliseconds to Unix seconds.
6. Map optional money to `properties: { value, currency }`, using `minorUnits / 10 ** Intl.NumberFormat(...).resolvedOptions().maximumFractionDigits`. Do not read account metadata.
7. Wrap exactly one send in `authority.dispatch`. Retain the consumed-callback guard. Reuse `createTikTokCredentials` and `createTikTokFetchEgress`, including their fence check after credential resolution. No preflight fetch or retry.
8. Valid code-zero acknowledgement yields `delivered` with `accepted:true`, `processed:null`, `attributed:null`. Ambiguous transport/receipt outcomes remain `unknown`; definite pre-send refusals remain typed failures. Reconcile validates and returns `unknown` without authority, credentials or network calls.
9. Keep `uncertainFailure` unchanged: `adapter.ts:137` and `capabilities.ts:45` still consume it. Delete only superseded conversion implementation and obsolete context-schema duplication.
10. Write fixture-fetch regressions for canonical factory construction, extra-key stripping, phone digest preservation, missing fields, unsupported definitions, money in USD/JPY/KWD, grant mismatch, cancellation/withdrawal during credential lookup, repeated execute, uncertain acknowledgements, no-I/O reconciliation and secret redaction. Preserve unique existing assertions.
11. Recompute the existing JSON-of-Zod payload fingerprint after the final schema edit; verify its serialized bytes with `shasum -a 256`. Update both declaration rows and evidence. Existing manifest tests already compare declarations against the exported fingerprint.
12. Update progress after completed items. Finish with `corepack pnpm --dir content/agent-plugins/tiktok-ads typecheck`; one corrective rerun allowed. No tests, builds, installs or `om:check`.

**5. Reuse**

- Factory/configuration/grant/outcome precedent: Google `src/conversions.ts`, Meta `src/capi.ts`, and A3 `apps/server/src/composition/agent-plugin-backends.ts:759–800`; follow their shape without cross-plugin imports.
- TikTok payload, authority guard, acknowledgement decoding and bounded input: existing `events.ts`, `events-payload.ts`, `commands.ts`.
- Credentials, fixed endpoint, deadline, response bound and post-lookup fence: existing `transport.ts`; no parallel transport mechanism.
- Existing `tests/fixtures.ts` supplies synthetic credentials, fetch recording and authority faults. `tests/capabilities.test.ts:51–58` already calls real `createCapabilities` with canonical configuration and validates catalog output; retain it without duplication.
- Money: existing Google/Meta Intl conversion precedent and contracts `moneySchema`. Identifier hashing stays in contacts.
- Searched Jini/Tovu packages/apps for TikTok Events delivery, `event_source_id`, `phone_digits`, currency exponents and bounded fetch mechanisms; found no reusable TikTok delivery implementation.
- Inspected installed `@jini-ai/platform@0.6.15-rc.2` fetch/response-reader declarations. Existing TikTok transport meets this job; adding a dependency or replacing its reader is unnecessary. Jini’s stale working-tree capability map supplied discovery hints only.
- npm registry checks were attempted but unavailable through web access and local DNS. No new dependency is proposed. No OSS SDK is needed for this single existing REST operation.

**6. Deliberately left out**

- No new port, module, registry, journal, worker, retry policy or compatibility wrapper.
- No new event mappings, raw-identifier hashing, click/cookie/IP/UA collection, or purchase/qualified/won support.
- No configuration UI, HTTP/tool/CLI/Studio changes; W22-CONVERSION-SETTINGS owns their generic closure.
- No local admission or production-mode gate duplicating A3.
- DISPUTED/already fixed: canonical `definitionIds` grants are already used in `events.ts:14,92`; the post-credential fence already exists in `transport.ts`. Reuse both rather than rebuilding them.

**7. NEEDS**

- **Coordinator: rebuild `content/agent-plugins/tiktok-ads/io.github.ainsep.openmarketing/dist/index.mjs` after approval and implementation; refresh packaging integrity metadata if required.**
- **Coordinator: serialize TikTok `plugin.json` edits with W22-CONVERSION-SETTINGS; preserve its declarations and settings.**
- **W22-CONVERSION-SETTINGS: supply `settings.conversionConfiguration.pixelId` through the existing canonical configuration path.**
- **W22-CONTACTS-META-IDENTIFIERS/metadata owner: supply consented `event_source_url` to TikTok conversions; until supplied, delivery refuses unsent.**
- **W22-CONVERSION-DELIVERY-DIAGNOSTICS: preserve TikTok pre-send failure reasons through measure; do not expand the shared outcome contract in this lane.**
- Installs: none. Shared-contract changes: none. Migrations: none.

**8. Unverified facts and risks**

- Official indexed [Events API 2.0 web documentation](https://business-api.tiktok.com/gateway/docs/index?doc_id=1771100865818625&language=ENGLISH) confirms the existing POST endpoint/header, required page URL, SHA-256 identifiers and phone normalization including `+`. Use contacts’ `phone` digest; ignore `phone_digits`, `fbc` and `gclid`.
- The same documentation specifies numeric value/currency properties and deduplication by event source, event name and event ID. Preserve those identities. [TikTok’s deduplication guide](https://ads.tiktok.com/resources/help/article/event-deduplication?lang=en) documents the 48-hour window; it does not justify automatic retries.
- [Current standard-event documentation](https://ads.tiktok.com/resources/help/article/standard-events-parameters?lang=en) confirms both selected event names.
- Direct developer-portal rendering required JavaScript; field details were available through official indexed content. Live token/pixel eligibility, processing/attribution and per-event reconciliation remain unverified. Keep admission unchanged; uncertain outcomes never trigger resend.
- Tests will be written but unexecuted under the owner’s machine-load restriction. This planning run made no file edits or verification runs.

**9. Size estimate**

One build run, approximately 75–90 minutes. Ten existing lane files plus three required job records; no new runtime files. Roughly 180–220 source LOC and 230–280 test/fixture LOC touched; estimated +230/−170 lines overall, about +60 net. Report actual additions/removals after implementation; no requested delivery item is deferred beyond the named integration NEEDS.