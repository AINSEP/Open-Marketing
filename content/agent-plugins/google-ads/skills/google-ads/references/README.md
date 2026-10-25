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
- [Agent Plugins v1.1.0](https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.1.0.md) closes MCP entries to transport fields. OM metadata is under `plugin.json.extensions["io.github.ainsep.openmarketing"]`; declaration envelopes are in the namespace's `bindings/` directory.

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

The plugin is disabled/unadmitted. The portable MCP entry uses Node **24.2.0** and the packaged `io.github.ainsep.openmarketing/bin/mcp-server.mjs`, which loads TypeScript using Node's built-in type stripping. No transpilation, npm install, network schema retrieval, or `npx` is required to launch. Its default vendor/authority ports return unavailable. `--fixture` selects handwritten local responses, never a vendor endpoint.

The authenticated OM server loads the namespace public `src/index.ts` only after package trust/admission. Inject `AccountBinding`, `ClockPort`, `CredentialPort`, bounded `HttpPort`, and `HostAuthorityPort`. `createGoogleRestTransport` contains the fixed v26 endpoint mapping; `createHttpAdapter` bounds response bytes and deadlines and emits correlated observations. Do not expose these factories, credential ports or fixture authority to the agent runtime.

`HostAuthorityPort.dispatch` must recheck installed plugin/schema pins, current account/connection/credentials, current exact approval, required audit and halt under account dispatch serialization. Hold that serialization through the supplied callback. Reads are fixed GAQL; no public query/HTTP/mutation payload exists. `preview` returns the effect for the exact call and current controlled plan, with independently obtained billing evidence. There is no budget envelope or automatic spend permission.

Adapt `OperationJournalPort` to the ONE jobs outbox's durable operation metadata. Atomic claim precedes transmission; append outcomes and preserve unknown claims across crashes. In-memory journals are test-only. `findCampaign` must isolate scope AND connection/customer, not just the Google customer ID. Paused plan assets are resolved by the host's vendor mapping; the generic campaigns DTO does not contain Search keywords/copy/targeting, so host composition must supply the frozen `SearchPlan` alongside its campaign mapping. No feature contract was changed.

`billing` must supply complete account-local same-day history, including pending/uncertain budget changes and owner changes outside OM. Missing history denies spend. Evidence must be fresh within 30 seconds and match the account day. `productionVerified=false` denies activation/budget mutation in production. The default local binding is sandbox or read-only. Production billing-control evidence and always-on deployment remain adoption gates.

`createStopBinding` is a distinct backend-only sparse campaign-status binding, with a CURRENT halt epoch and stop permit checked by `StopAuthorityPort`. It never reactivates children or edits budget. Campaign pause is idempotent; the server owns durable stop jobs and uncertain-outcome reconciliation. A stopped result requires the requested campaign statuses to read back PAUSED.

`createConversionBinding({ binding, configuration, transport, journal, authority, now })` returns backend-only `deliver` and `reconcile`, preserving capability ID `google-ads.conversions.v1` and `Outcome<{ status: "delivered" | "unknown" }>`. No agent tool exposes either method. Configuration is exactly:

```ts
{
  api: "data-manager-v1",
  cloudProjectId: string,
  eligibility: "verified" | "unavailable",
  actionIds: Record<string /* OM definitionId */, string /* numeric Google action ID */>,
  loginCustomerId?: string
}
```

The closed event input is exactly:

```ts
{
  eventId: string,
  definitionId: string,
  eventType: string, // grant category; action selection uses definitionId
  occurredAt: number, // epoch milliseconds, integer, 0..4102444800000, not future
  destination: string,
  purpose: string,
  gclid?: string, // 1..256 characters, /^[A-Za-z0-9_-]+$/
  hashedEmail?: string, // /^[a-f0-9]{64}$/, contacts-prepared SHA-256
  hashedPhoneNumber?: string, // same digest shape; copied unchanged
  adUserData: "GRANTED" | "DENIED", // GRANTED required for delivery
  adPersonalization?: "GRANTED" | "DENIED",
  valueMicros: string, // 1..18 decimal digits, 0..Number.MAX_SAFE_INTEGER
  currency: string // uppercase 3-letter code matching bound account
}
```

IDs/category/destination/purpose/project are non-empty, at most 256 characters. Require at least one GCLID or digest. Raw email/phone, IP, sessions, additional fields, invalid timestamps and unsafe values reject. Configuration maps 1..100 definitions to numeric action IDs (1..19 digits); optional manager ID is ten digits. Definition IDs are not restricted to signup/trial. The current shared MeasurementGrant type still limits eventTypes to signup/trial; the contracts owner must extend grants before other event categories can be admitted. Arbitrary definitions within a covered category already map independently.

Use the owner's OAuth Cloud project, enable Data Manager API and obtain per-advertiser `https://www.googleapis.com/auth/datamanager` via the [OAuth Web Server flow](https://developers.google.com/data-manager/api/devguides/concepts/deploy). Request offline access; the server stores advertiser refresh tokens encrypted and handles callback/refresh. CredentialPort.access receives the bound advertiser connection/account, required scope and project. Data Manager requires returned `scopes` and matching `cloudProjectId` metadata attested by the broker; missing/mismatched metadata fails before egress. The agent never receives a token, project configuration or authenticated HTTP port. Google Ads Search still uses its separate authorization scope. No API key, partner-link route, SDK or new dependency is introduced.

Adapt ConversionJournalPort.get/claim/append to existing durable measure state in the ONE outbox. Claims must be atomic and append-only evidence must retain requestId, digest, status and bounded diagnosticStatus across process restarts; the latest view must not regress terminal/success evidence during concurrent reconciliation. Read existing records before preflight; reject changed payload/configuration, including the OAuth project, under the same event/definition identity. Two concurrent validations may run, but only one claim ingests. A valid payload changed during preflight also rejects before claim. Loss of receipt/storage leaves unknown and never authorizes resubmission. No verified lookup by OM transaction ID is implemented. Reconcile performs one GET, without a polling loop. FAILED/PARTIAL_SUCCESS yield non-retryable failures and owner recovery; processing/ambiguous/malformed evidence remains unknown. Diagnostics use a closed single-destination event projection; unsupported fields and non-event statuses cannot establish delivery. Documented processing warnings on an otherwise clean SUCCESS are permitted; preflight field warnings reject.

The server-owned ConversionAuthorityPort rechecks CURRENT consent, grant/source identity, schema, connection, project, operating-account action ownership/type/status, import window, production prerequisites and egress audit. One authority dispatch serializes preflight plus ingest through the supplied callback; consent/configuration changes must cancel egress or wait for that critical section. The plugin also rechecks supplied grant/consent after preflight. Reconcile has its own read-only authority dispatch. Keep trusted binding/configuration/event data stable for the duration of a call. Supply bounded HttpPort.get for diagnostics; Search-only HTTP adapters cannot ingest conversions. Each HTTP request remains limited to 15 seconds and 1 MiB, rejects redirects and propagates run/correlation/trace observations without payloads or credentials.

Cross-account action ownership, partner links, batching, adjustments, additional identifier families, enhanced web conversions and action discovery remain deferred. Host OAuth onboarding, durable jobs/authority composition, real project/account/action evidence and production admission are outside this lane.

Reporting returns observed **served cost**, not billed spend or a blended conversion total. Adapt it to `PlatformReportingPort` with the explicit timezone/period and append-only snapshot lineage required by measure. Billing limit checks require billed-cost evidence separately.

## Library reuse and shim removal

Inspected installed `@jini-ai/mcp@0.4.3`: public `createMcpToolServer`, `McpToolDef`, `McpServerLike` and stdio transport seams. Its default server implementation requires the optional `@modelcontextprotocol/sdk` peer (manifest requests `^1.29.0`; installed SDK is 1.24.0). npm registry verification was attempted but blocked by DNS/network access, and npmjs/registry pages were inaccessible through browsing. No release freshness claim is made.

The dependency-free `mcp.ts` is a **removable local compatibility shim**, implementing initialization, ping, tool catalogue/calls and bounded newline frames. Replace it with Jini's public server factory and a packaged compatible MCP SDK when the integrator can install/bundle and verify that path; retain the ONE shared capability suite. The local schema subset is likewise self-contained and explicitly supports only the JSON Schema keywords emitted by this plugin. It never fetches remote schemas. Shared OM DTOs are imported as types; the host remains responsible for canonical contract/schema validation and policy. No sibling project source was copied or imported.

## Verification status

Data Manager tests are **written, not run**. The shared conversion suite covers a transport double and the real REST/bounded HTTP adapter using handwritten responses only. This job permits exactly one lane typecheck; its final result is recorded in HANDOFF.md. No tests, builds, installs, `om:check`, live vendor calls or migrations run. Consult the lane handoff before admission.

Integrator: validate portable manifests with `@jini-ai/agent-plugins@0.4.4` (Agent Plugins spec 1.1); the previously inspected installed version was 0.4.3. No dependency pin/install occurred in this lane. The older j12 progress ledger predates the Data Manager work; HANDOFF.md is the current continuation record.
