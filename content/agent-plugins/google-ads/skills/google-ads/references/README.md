# Google Search plugin evidence and server setup

Checked against primary sources on **2026-10-12**. These documents establish provider semantics; they do not establish OM's account access or runtime readiness.

- Google [sunset developer tokens on September 9, 2026](https://developers.google.com/google-ads/api/docs/get-started/dev-token). API access follows the Cloud project owning the OAuth client/service account. This plugin uses v26 bearer OAuth and omits `developer-token`. The server supplies a manager `login-customer-id` only when appropriate. [Authentication headers](https://developers.google.com/google-ads/api/rest/auth), [OAuth](https://developers.google.com/google-ads/api/docs/oauth/overview), [version schedule](https://developers.google.com/google-ads/api/docs/sunset-dates).
- The June 15 restriction on [`UploadClickConversions`](https://developers.google.com/google-ads/api/docs/deprecations) survives token sunset. New integrations must use Data Manager API. OM eligibility is unverified, so the default capability is unavailable. The typed Data Manager v1 path is implemented; legacy UploadClickConversions delivery and hashing helpers were removed. Production eligibility remains unverified. [Offline conversion guide](https://developers.google.com/google-ads/api/docs/conversions/upload-offline).
- Manual Search language criteria were removed on September 30. The narrow plan has no language field/criterion. [Current deprecations](https://developers.google.com/google-ads/api/docs/deprecations).
- Google [test accounts](https://developers.google.com/google-ads/api/docs/best-practices/test-accounts) do not serve ads or have active billing. They cannot verify billing or conversion uploads. A paused production account is not a test account. No real OM test-account evidence was supplied or obtained; all fixture account IDs are invented.
- Supported average daily Search budgets have [daily and monthly billing limits](https://support.google.com/google-ads/answer/10486637), rather than a served-cost cutoff. [Same-day changes](https://support.google.com/google-ads/answer/10487143) retain the day's highest budget for the daily limit and alter the remaining monthly exposure. The plugin represents unchanged monthly exposure as 30.4 times the budget and changed monthly exposure as billed-to-date plus the new budget times remaining calendar days. Conservative flight authority uses the daily billed bound across the finite flight, with an extra day for timezone boundaries. Campaign total budgets are deferred.
- Atomic creation follows Google's [mutate guidance](https://developers.google.com/google-ads/api/docs/mutating/best-practices): negative temporary parent IDs, parent-first operations, `partialFailure=false`. Campaign, ad group, keywords and RSA are all PAUSED. Every normal mutation invokes host dispatch independently. Configuration readback checks Search-only networks, Manual CPC, presence targeting, non-shared DAILY budget, child types/counts, RSA and keyword content, and finite flight dates.
- Data Manager [ingestion](https://developers.google.com/data-manager/api/reference/rest/v1/events/ingest) supports `validateOnly=true`: validation runs without ingestion and returns errors rather than results. The plugin accepts an empty successful preflight response without requiring a request ID; field warnings or malformed responses reject. A real ingestion receipt only establishes acceptance. [Request diagnostics](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve) use `GET /v1/requestStatus:retrieve?requestId=...`. Matching single-destination SUCCESS, one event and no processing errors establishes `delivered`, meaning processed, not matched or attributed.
- Data Manager [consent](https://developers.google.com/data-manager/api/reference/rest/v1/Consent) accepts both ad user data and ad personalization. OM GRANTED/DENIED map to CONSENT_GRANTED/CONSENT_DENIED. [Offline mapping](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events) uses the action owner's operating account and an UPLOAD_CLICKS action; optional manager login is in `destination.loginAccount`, not a Google Ads header. Digests copy unchanged to [UserData](https://developers.google.com/data-manager/api/reference/rest/v1/UserData) emailAddress/phoneNumber fields with encoding HEX. Contacts alone owns normalization/hashing. Stable transactionId is the supplied eventId; journal identity also binds OM definition, account scope and connection.
- [Agent Plugins v1.1.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.1.0.md) closes MCP entries to transport fields. OM metadata is under `plugin.json.extensions["io.github.ainsep.openmarketing"]`; declaration envelopes are inline rows in the extension's `capabilities` array and mirrored in the namespace descriptor.

## v26 migration — checked 2026-10-24

Search and mutate now use `/v26`; the destination validator rejects `/v25`. Data Manager stays on `/v1`. The [official v26 release notes](https://developers.google.com/google-ads/api/docs/release-notes#v26) list these breaking changes:

| Change | OM impact |
| --- | --- |
| Local Services PMax requires `country_code` and `listing_id` | None: OM creates Search campaigns. |
| Enhanced Conversions setting replaced by `enablement_setting` | None: OM does not read that setting. |
| Hotel bid-modifier fields renamed; `HotelDateSelectionType` becomes `DateSelectionType` | None: OM uses no hotel targeting. |
| Hotel criterion error reasons renamed | None: OM does not interpret those reasons. |

No consumed request field or enum needs changing. Existing schema-byte fingerprints remain valid. Earlier endpoint evidence dates below remain historical; fixtures do not prove live acceptance.

## Host integration

The plugin is host-composed only (`hostEntry`), starts disabled/unadmitted, and has no standalone launcher.

The authenticated OM server loads the namespace public `src/index.ts` only after package trust/admission. Inject `AccountBinding`, `ClockPort`, `CredentialPort`, bounded `HttpPort`, and `HostAuthorityPort`. `createGoogleRestTransport` contains the fixed v26 endpoint mapping; `createHttpAdapter` bounds response bytes and deadlines and emits correlated observations. Do not expose these factories, credential ports or fixture authority to the agent runtime.

`HostAuthorityPort.dispatch` must recheck installed plugin/schema pins, current account/connection/credentials, current exact approval, required audit and halt under account dispatch serialization. Hold that serialization through the supplied callback. Reads are fixed GAQL; no public query/HTTP/mutation payload exists. `preview` returns the effect for the exact call and current controlled plan, with independently obtained billing evidence. There is no budget envelope or automatic spend permission.

Adapt `OperationJournalPort` to the ONE jobs outbox's durable operation metadata. Atomic claim precedes transmission; append outcomes and preserve unknown claims across crashes. In-memory journals are test-only. `findCampaign` must isolate scope AND connection/customer, not just the Google customer ID. Paused plan assets are resolved by the host's vendor mapping; the generic campaigns DTO does not contain Search keywords/copy/targeting, so host composition must supply the frozen `SearchPlan` alongside its campaign mapping. No feature contract was changed.

`billing` must supply complete account-local same-day history, including pending/uncertain budget changes and owner changes outside OM. Missing history denies spend. Evidence must be fresh within 30 seconds and match the account day. `productionVerified=false` denies activation/budget mutation in production. The default local binding is sandbox or read-only. Production billing-control evidence and always-on deployment remain adoption gates.

`createStopBinding` is a distinct backend-only sparse campaign-status binding, with a CURRENT halt epoch and stop permit checked by `StopAuthorityPort`. It never reactivates children or edits budget. Campaign pause is idempotent; the server owns durable stop jobs and uncertain-outcome reconciliation. A stopped result requires the requested campaign statuses to read back PAUSED.

`createConversionDelivery` takes A3's `PluginCapabilityDependencies` plus its server authority callback, with canonical settings `conversionConfiguration: { actionIds: Record<definitionId, numericActionId> }` and optional `loginCustomerId`; measure supplies `{ context, event, grant, deliveryId }` with contacts-prepared `identifiers.email`, `phone` and/or `gclid`, while unrelated identifier keys are ignored. It sends one bounded Data Manager `events:ingest` POST after current server consent checks, with no preflight or plugin journal; `delivered` means accepted only (`processed` and `attributed` remain unknown), and monetary values convert from the supplied currency's minor units. Ingestion returns `receiptId` for the measure ledger; reconciliation with that saved receipt makes one bounded [request-status GET](https://developers.google.com/data-manager/api/reference/rest/v1/requestStatus/retrieve), reporting processed/failed independently of acceptance and leaving attribution unknown (no receipt means no I/O). Refresh explicitly after Google’s [recommended initial 30-minute wait](https://developers.google.com/data-manager/api/devguides/diagnostics); the canonical broker need not attest scope/project metadata, and Google enforces the OAuth scope.

Cross-account action ownership, partner links, batching, adjustments, additional identifier families, enhanced web conversions and action discovery remain deferred. Host OAuth onboarding, durable jobs/authority composition, real project/account/action evidence and production admission are outside this lane.

Reporting returns observed **served cost**, not billed spend or a blended conversion total. Adapt it to `PlatformReportingPort` with the explicit timezone/period and append-only snapshot lineage required by measure. Billing limit checks require billed-cost evidence separately.

## Library reuse and shim removal

Inspected installed `@jini-ai/mcp@0.4.3`: public `createMcpToolServer`, `McpToolDef`, `McpServerLike` and stdio transport seams. Its default server implementation requires the optional `@modelcontextprotocol/sdk` peer (manifest requests `^1.29.0`; installed SDK is 1.24.0). npm registry verification was attempted but blocked by DNS/network access, and npmjs/registry pages were inaccessible through browsing. No release freshness claim is made.

The dependency-free `mcp.ts` is a **removable local compatibility shim**, implementing initialization, ping, tool catalogue/calls and bounded newline frames. Replace it with Jini's public server factory and a packaged compatible MCP SDK when the integrator can install/bundle and verify that path; retain the ONE shared capability suite. The local schema subset is likewise self-contained and explicitly supports only the JSON Schema keywords emitted by this plugin. It never fetches remote schemas. Shared OM DTOs are imported as types; the host remains responsible for canonical contract/schema validation and policy. No sibling project source was copied or imported.

## Verification status

Data Manager tests are **written, not run**. The shared conversion suite covers a transport double and the real REST/bounded HTTP adapter using handwritten responses only. This job permits exactly one lane typecheck; its final result is recorded in HANDOFF.md. No tests, builds, installs, `om:check`, live vendor calls or migrations run. Consult the lane handoff before admission.

Integrator: validate portable manifests with `@jini-ai/agent-plugins@0.4.4` (Agent Plugins spec 1.1); the previously inspected installed version was 0.4.3. No dependency pin/install occurred in this lane. The older j12 progress ledger predates the Data Manager work; HANDOFF.md is the current continuation record.

## Canonical metrics reads — checked 2026-10-26

`createCapabilities({fetch, credentials, clock, observer, wait, configuration})`
returns `report.metrics.v1`, `campaign.status.v1` and `tracking.tag.v1` handlers.
Parse configuration with the shared `pluginConfigurationSchema`: exactly
`{scope, connectionId, accountId, pluginDigest, settings}`. Settings are tainted
plugin-install metadata, never authority, account facts or credential identity.
The server invoker owns admission, approval and egress audit; setup performs no I/O.

The credential broker receives `{connectionId, accountId}` per request and must
return `accessToken`, the selected ten-digit `customerId`, optional ten-digit
`loginCustomerId` and optional `developerToken`. Identity is validated in the
plugin and must match the selected account before egress. The current shared
broker only promises token/expiry: carrying stored Google identity is an integrator
NEED. No settings fallback is accepted. Report currency/timezone come from a
bounded Google customer query, including for empty reports.

Google's [conversion metrics are doubles](https://developers.google.com/google-ads/api/fields/v26/metrics).
OM preserves source decimal text and uses contracts `decimalToMicros` to round
conversions and conversion value half-even to millionths. Spend arrives in micros.

Google Search has [fixed pages of up to 10,000 rows](https://developers.google.com/google-ads/api/docs/reporting/paging).
This plugin queries consecutive 30-day windows with `LIMIT 1001`; saturated
multi-day windows split in half and their parent rows are discarded. At most
1,000 rows per response and 5,000 retained rows per report fit the bounded read
path. The whole report allows 32 requests (including account metadata), 30 seconds,
and 1 MiB/15 seconds per request. No retries or page-token traversal are added.

A saturated single day, truncated rows or unvisited windows returns
`complete:false`, `dataThrough:0`, `freshness:"stale"`. Fully visited, unsaturated
windows can be complete, including exactly 5,000 rows. Oversized/malformed/failed
responses remain typed failures. Status/tag reads reject continuation tokens.
Fixtures do not establish account-spend reconciliation or production admission.

## Search terms and exact negatives — checked 2026-10-28

- [search_term_view v26](https://developers.google.com/google-ads/api/fields/v26/search_term_view) aggregates terms at ad-group level and excludes Performance Max. Campaign/ad-group fields do not segment; ad_group_ad fields do.
- [Reporting segmentation](https://developers.google.com/google-ads/api/docs/reporting/segmentation) permits core dates in WHERE without SELECT. OM's half-open, <=31-day campaign report therefore returns period aggregates, top 50 by served cost. Google omits some low-volume terms, so even `truncated:false` never means total waste.
- [GAQL grammar](https://developers.google.com/google-ads/api/docs/query/grammar) governs literals. OM accepts numeric scope IDs and restricted, normalized keyword text; callers cannot supply GAQL.
- [CampaignCriterion v26](https://developers.google.com/google-ads/api/reference/rpc/v26/CampaignCriterion) and [AdGroupCriterion v26](https://developers.google.com/google-ads/api/reference/rpc/v26/AdGroupCriterion) define negative criteria and their scoped resource names. OM validates membership, checks for an existing EXACT negative, and creates at most one criterion per approved call. A valid single mutate ACK establishes creation; malformed ACK/transport uncertainty stays `unknown`, with no automatic retry.
- The [criteria guide](https://developers.google.com/google-ads/api/docs/targeting/criteria) limits campaign keywords to exclusions. [KeywordInfo v26](https://developers.google.com/google-ads/api/reference/rpc/v26/KeywordInfo) caps text at 80 characters and 10 words. OM supports EXACT only, with a fresh exact card per negative and no retained grant. Local read-only mode blocks this write; production admission/always-on hosting remain prerequisites.

The existing HTTP tools endpoint, agent `om_tool_call`, Studio assistant and CLI all discover these plugin tools generically after the plugin bundle is rebuilt, installed and admitted. For example, replace the fixture connection/account and pass this selection on stdin:

```sh
om tools call vendor_google_ads_search_terms_report --input-file - <<'JSON'
{"operationId":"search-terms-example","connectionId":"selected-connection","accountId":"1234567890","arguments":{"campaignId":"201","days":{"start":"2026-10-01","end":"2026-11-01"}}}
JSON
```
