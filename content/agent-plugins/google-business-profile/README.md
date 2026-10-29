# Google Business Profile Agent Plugin — B1

Agent Plugins **1.0.0**, disabled and unadmitted by default. This self-contained
package lists one page of locations and reads daily performance for one
server-bound location, and implements owner-approved text Updates. It does not become
available in OM until the server integration below is completed.

## Google access and API status

Verified against Google's documentation on **2026-10-25**; no live account queried.

- Google requires API access approval for the Cloud project. Applicants must
  manage a verified profile active for at least 60 days, with a website representing
  the listed business. Obtain the project number, submit “Application for Basic
  API Access” through the [GBP API contact form](https://support.google.com/business/contact/api_default)
  using an owner/manager email, then await approval.
  [Google prerequisites](https://developers.google.com/my-business/content/prereqs).
- After approval, enable the relevant APIs (Business Information and Business
  Profile Performance for these reads) and configure an OAuth client and redirect
  URI. The descriptor requests authorization code + PKCE, offline access and
  `https://www.googleapis.com/auth/business.manage`. That scope includes management
  privileges; publishing uses the server approval path. OM's server owns token storage,
  refresh, client secrets and reconnect.
  [Google setup](https://developers.google.com/my-business/content/basic-setup),
  [Performance authorization](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries).
- **v4 localPosts CRUD is not marked deprecated in the current reference or
  deprecation schedule.** Its separate `accounts.locations.localPosts.reportInsights`
  method was discontinued **2023-02-20**, without a replacement. Do not interpret
  that as retirement of all localPosts methods. Publishing uses localPosts.create.
  [localPosts reference](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts),
  [Google deprecation schedule](https://developers.google.com/my-business/content/sunset-dates).

## Reads and meanings

`listLocations({context, pageToken?}, options?)` performs one Business Information
v1 GET with `readMask=name,title`, `pageSize=100`. It returns the next-page token
without traversing it. The account is fixed by the host binding.
[Location listing](https://developers.google.com/my-business/reference/businessinformation/rest/v1/accounts.locations/list).

`readPerformance({context, days: {start, end}}, options?)` reads the selected
location through Performance v1 `fetchMultiDailyMetricsTimeSeries`, requesting
seven series. OM dates are half-open `[start,end)`, limited to 366 days. The adapter
subtracts one calendar day from the exclusive end for Google's inclusive range.
[Performance method](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries),
[DailyRange](https://developers.google.com/my-business/reference/performance/rest/v1/DailyRange).

| Native output | Meaning | OM report mapping |
| --- | --- | --- |
| `callClicks` | Call-button clicks, not completed calls or leads | None |
| `websiteClicks` | Profile website-link clicks | `clicks` |
| `directionRequests` | Requests for directions, not visits | None |
| `views` | Sum of desktop/mobile × Maps/Search profile impressions | `impressions`, not deduplicated reach |

Counts remain decimal integer strings; summation uses bigint, including beyond
the JavaScript safe-integer range. A dated point with omitted `value` means zero;
an absent day/series is null. All four impression series must exist for a day's
`views`; a partial set produces null. Duplicate series/dates, invalid/non-integer
counts, unexpected breakdowns and dates outside the request fail validation.
[Google TimeSeries zero semantics](https://developers.google.com/my-business/reference/performance/rest/v1/TimeSeries).

`reportMetrics` implements the frozen `PluginCapability<"report.metrics.v1">` ABI.
Only account grain is supported, and **accountId is `locations/{locationId}`**,
not the parent Google account. `connectionId` and location must match the host
binding. Only an independently verified IANA timezone is supplied in
`binding.reportingContext`. Count-only reports use currency `"XXX"` (no currency),
`dataThrough:0` and stale/incomplete coverage. Without timezone, reports return
`unavailable`; native reads still work. Spend and conversions are unsupported and omitted. Supported
but missing click/impression data is null. Coverage/finality/lag have not been
verified live, so reports conservatively remain `complete:false`, `freshness:stale`,
`finality:provisional`, `restated:false`.

Standalone MCP remains read-only. No scheduler, reviews, media, migrations or
plugin-local approval policy is added.

## Host setup and fixtures

Import the package public entry, then inject dependencies:

```ts
const plugin = createGoogleBusinessProfilePlugin({
  binding: {
    scope, connectionId, accountName: "accounts/100", locationName: "locations/200",
    reportingContext: { timezone: "America/Los_Angeles" },
  },
  fetch, credentials, clock, observer, deadline,
});
const locations = await plugin.listLocations({ context });
const performance = await plugin.readPerformance({ context, days: { start: "2026-09-30", end: "2026-10-01" } });
```

`credentials.access({context,connectionId,signal})` is a host credential broker
returning an Outcome of `{accessToken}`. It must honor cancellation and never
expose tokens to the agent. `deadline.signal({timeoutMs,signal?})` combines the
caller's cancellation with a deadline no longer than the requested 15 seconds.
Native fetch, the broker and the injected deadline implementation must honor the
signal. Example composition: `AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])`
when a caller signal exists. `clock.now({})` supplies retrieval time. The observer
receives operation/outcome and correlation/trace/run IDs, never URLs or tokens.

Native reads reach two fixed Google origins. GET only, no redirects, no retries,
1 MiB decoded-response cap, one page per call. Scope/binding/input validation
precedes credentials. Failures use sanitized OM typed outcomes. No import/factory
starts services; only the executable starts stdio hosting through published
`@jini-ai/mcp@0.6.12` `createMcpToolServer`. No Jini source dependency or custom
MCP protocol implementation is present.

After dependency preparation, `node io.github.ainsep.openmarketing/bin/mcp-server.mjs`
serves two read tools but returns unavailable without authenticated host composition.
Adding `--fixture` enables handwritten data only; use 2026-09-30 through 2026-10-01.
Both standalone modes have no live network path. The embedded library is the host
integration seam.

## Validation and integration handoff

Tests are written, **not run**, per this job's instructions. They share a native
read/scoping contract across the independent in-memory double and the real REST
codec with scripted fetch; additional cases cover precision, missing/zero values,
duplicates, pagination, date limits/leap day, scope/connection mismatches,
credentials, HTTP errors, redirects, body limits, cancellation and read-only stdio.
Runtime/coverage evidence is deferred; no build, install or `om:check` was run.

Run the assigned lane check: `corepack pnpm --dir content/agent-plugins/google-business-profile typecheck`.

Published `@jini-ai/mcp@0.6.12` now resolves at the root. The native tool wrappers
use its public callback contract, preserving cancellation and Zod-derived argument
schemas. This run does not install packages or change shared manifests/lockfiles.

Integrator NEEDS (outside this lane):

- Build/package verification remains integrator-owned. The library build command
  bundles dependencies; no built/upload artifact is produced or verified here.
- Register OAuth metadata in server composition and admit credential-card actions
  for this plugin. Existing fixed host lists do not automatically load it.
- Wire manifest-driven capability invocation and supply the scoped account/location,
  server credential broker, clock/deadline/observer and verified reporting metadata.
- Obtain Google approval and verify real-account access, timezone, coverage lag and
  finality. Fixtures establish codec expectations only. No approval/real-account
  compatibility is claimed. No migration is needed or applied.

Reuse: Google Ads layout/manifest/OAuth conventions; public OM context/outcome and
reporting schemas; published Jini MCP hosting. Jini's capability map and installed
0.6.12 dist expose no GBP codec. Its generic credentialed-HTTP registry was not
introduced for these two fixed endpoints. No core feature imports or copies.

Original native-read architecture audit: source stays in the approved GBP lane. Vendor
logic/configuration stays in this plugin; imports use public contracts/Jini
entries; no core changes, global services, hidden clocks, writes or second outbox.
Data types derive from schemas. Foreign fetch/stream/array callbacks retain their
library ABIs; owned operations use object arguments. Documentation covers public
APIs, bounds and non-obvious rules; obvious leaf schemas/test helpers use their
module documentation. Regression assertions were updated for the approved timezone/date-range changes.

| Assessment units | Static disposition | Direct fixture evidence written |
| --- | --- | --- |
| Factory; listLocations; readPerformance; reportMetrics | No remaining findings | shared contract, detached ABI, scope/metadata and zero-egress cases |
| normalizePerformance; indexSeries; indexPoints; sumViews; mapPerformanceToReport | No remaining findings | duplicate, zero/missing, int64, reordered-series, metadata and date cases |
| readGoogleJson; performGet; readBody; responseFailure; httpFailure | No remaining findings | HTTP/credential errors, body cap, deadline/cancellation, stalled stream |
| sameScope; matchesConnection; requestUrl; addDate; googleDay; validTimezone; failure | No remaining findings | scope, exact endpoint/query, leap-day, malformed input and sanitized errors |
| createReadTools; runCli; standaloneDependencies | Unverified runtime hosting | read-only tool/handler and CLI argument tests; Jini stdio lifecycle not exercised |

Second-pass review checked names/meanings, missing-vs-zero values, duplicate
aggregation, detached calls, credential sanitization and body cleanup. It replaced
a potentially throwing BigInt schema refinement with safe lexical bounds and
ensured discarded bodies are cancelled. These are static corrections; no
red/green, coverage or runtime pass is claimed. Production mapping is O(7*d)
time/space for d<=366; HTTP parsing is O(b) time/space for b<=1 MiB. No unbounded
pagination, per-row network fan-out or input mutation is introduced.

The canonical server entry
`createCapabilities({fetch, credentials, clock, observer, wait, configuration})`
returns an `organic.publish.v1` handler without credentials or fetch calls. No canonical `report.metrics.v1`
row is declared. Native MCP reads, `createGoogleBusinessProfilePlugin().reportMetrics`
and `mapPerformanceToReport` remain available with independently verified host timezone.

**Deferred: canonical reporting until a supported timezone source is assigned.** The
[Location schema](https://developers.google.com/my-business/reference/businessinformation/rest/v1/locations)
and [Performance response](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries)
do not supply a timezone field. No timezone or currency is fabricated. Native reports
remain conservative (`currency:"XXX"`, stale/incomplete, `dataThrough:0`).

The manifests declare only `organic.publish.v1`; canonical reporting remains deferred.
No plugin-local approval gate is introduced.

The [Performance API reference](https://developers.google.com/my-business/reference/performance/rpc/google.mybusiness.performance.v1)
confirms inclusive Google dates, omitted zero values and multi-month requests.
OM accepts up to 366 days; this is an OM input bound, not a verified vendor
retention or maximum-range guarantee. Vendor rejection remains a typed failure.

## Publish an Update

Through Studio chat, the assistant or `om tools call`, select
`vendor_google_business_profile_organic_publish_v1` with one `operationId`,
`connectionId`, `accountId: "accounts/{a}/locations/{l}"` and
`arguments: { text, languageCode? }`. The existing server card requires approval
of that exact location and text for every publish; no retained approval applies.
Text is limited to 1,500 characters by this plugin. One STANDARD text Update is
sent, with no retries, media, CTA, offer, event or schedule.

Results are `published`, `processing`, `rejected` or `unknown`. For `unknown`,
check the profile before doing anything else; never re-post automatically.
Production remains unavailable in the default read-only mode, with admission off
and account-binding setup pending. The binding must store the complete v4 parent.

References: [create](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts/create),
[LocalPost and states](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts),
[deprecation schedule](https://developers.google.com/my-business/content/sunset-dates),
[change log](https://developers.google.com/my-business/content/change-log).
