# Apple Search Ads — R1

Disabled/unadmitted v5 fixture implementation: accessible organizations (`list_accounts`), campaign pages (`list_campaigns`), daily campaign reports (`report`). It is not wired into OM yet. No deployment capability or placeholder is advertised.

## Connection

Follow [Apple's OAuth setup](https://developer.apple.com/documentation/apple_ads/implementing-oauth-for-the-apple-search-ads-api?changes=_4): invite an API-role user, generate an EC key pair, upload the public key, sign an ES256 JWT client secret (expiry less than 180 days), and exchange it using `client_credentials` and `searchadsorg`. Paste only the resulting access token into OM's existing server-sealed integration flow. Tokens last one hour; obtain and paste a replacement after expiry. This plugin performs no token exchange, JWT signing, renewal or browser callback. Loopback support and separate application-approval requirements remain unverified.

## Server handoff

Import only `io.github.ainsep.openmarketing/src/index.ts` through the package's public entry. `invokeAppleSearchAds({context, operationId, command, dependencies}, {signal})` returns an `Outcome`; `appleSearchAdsTools` supplies the three strict command schemas/effects. No factory, registry or module startup exists.

Inject `configuration: {scope, connectionId, accountId, currency}`, current `admitted`, scoped `credentials.access`, guarded `fetch`, clock and observer. Discovery alone accepts `accountId:null` (and unknown `currency:null`); reports need a bound currency. Every other operation needs a bound account. The host must check current plugin/connection/account authority at credential access and at actual egress. The plugin checks admission before credentials and again after the await. Admission false means zero credential lookup/network. Do not supply bare fetch in production.

Commands: `{kind:'list_accounts'}`, `{kind:'list_campaigns', offset?:0, limit?:100}`, `{kind:'report', startDate:'2026-10-22', endDate:'2026-10-23', offset?:0, limit?:100}`. Report dates are inclusive UTC days, at most 90 days apart with start at most 90 days ago; no future dates. Results preserve Apple's campaign/date granularity, decimal money, source, retrieval time, currency and distinct tap/total installs. Empty means no data/access unconfirmed. Pagination is explicit and always labelled `coverage:'page'`; no account totals or completeness are inferred. ACLs accept the documented array and singleton shapes; unpaged ACL results are capped at 100.

One fixed HTTPS v5 request, 64 KiB input/request, 1 MiB streamed response, 15-second fetch/body deadline, no redirects, retries or automatic pagination. A malformed, foreign, duplicate or inconsistent page fails atomically. HTTP 401 requires reconnect; 429 returns limit_exceeded without retry. Broker expiry is respected when supplied; otherwise the broker owns expiry. Observations carry existing correlation/trace/run identifiers and sanitized outcomes only.

## Outstanding work

Integrator: add Apple catalog/invoke branches and the exact `list_accounts`/`accountId:null` exception to server binding; preserve scoped connection and final authority checks. Append this package to root `om:build-plugins`, and bind `tests/contract/dispatch-suite.ts` to the real server adapter. Remove no restrictions or gates elsewhere in this lane. Existing bundled-only host checks conflict with owner upload policy and remain integrator work.

Apple [marks Campaign Management API deprecated](https://developer.apple.com/documentation/apple_ads/useracllistresponse). Exact sunset/support evidence is unverified: establish support before live admission. Platform API v1 is a separate replacement decision; there is no fallback. R2 PAUSED deployment, the campaigns owner's `app_install` objective, production app/creative resolution and DS2 connection/UI guidance remain deferred. No conversion upload, browser OAuth, signing-key custody, migration or dependency addition.

## Verification handoff

Tests are fixture-only and written, not run, per dispatch. The shared suite targets plugin and host adapters. No test suite, build, install, om:check, vendor call or migration is authorized in R1; one package `typecheck` is permitted. TypeScript/esbuild/Vitest/Zod pins mirror LinkedIn; no Jini API/dependency is added. Coordinator owns packaging and broader checks.

R1 result (2026-10-24): the single `corepack pnpm run typecheck` in this package passed (exit 0). No tests/builds/installs/vendor calls ran; no shared files, contracts or migrations changed, and nothing was committed/pushed. Source, scope and requirements were re-read before handoff. Runtime/host acceptance and support evidence remain open; next routing is integrator, then T1, DS2 and separately approved R2.

Architecture review: server-only I/O/credentials; public contracts import only `@open-marketing/contracts`; pure codecs and injected effects; read tools only; no registry, outbox, policy implementation or shared-file edits. Documentation added for public/boundary behavior. Reuse: OM contracts schemas/types, installed Zod and native fetch/Response/AbortSignal; LinkedIn is style/provenance only. Project-memory and governance ADR-index files were absent; approved plan/review and architecture v2 supply boundaries.

Static function review (runtime evidence remains INCONCLUSIVE because test execution is prohibited):

| Assessment units | Disposition | Findings | Local fix |
| --- | --- | --- | --- |
| encodeCommand, decodePagination, failure | INCONCLUSIVE | No unresolved static finding | Fixed URLs, typed failures, explicit page scope |
| decodeReport, validRow | INCONCLUSIVE | No unresolved static finding | Reject foreign/duplicate/mixed-currency/date rows atomically |
| invokeAppleSearchAds, prepare | INCONCLUSIVE | No unresolved static finding | Snapshot input before awaits; reject scope/account mismatch |
| dispatch, resolveCredential, checkTime | INCONCLUSIVE | No unresolved static finding | Extract credential parsing; recheck expiry/admission |
| send, httpFailure, readBody, decodeJson | INCONCLUSIVE | No unresolved static finding | Separate JSON parse from bounded streaming; cancel on abort |
| decode, decodeList, observe | INCONCLUSIVE | No unresolved static finding | Strip provider extras; isolate observer failures |

Skepticism pass checked misleading variable names, unsafe integer conversion, duplicate campaign/date rows, partial invalid pages, caller mutation across awaits, token echoes, input/response bounds and final authority ownership. No unresolved Critical/High semantic findings recorded. All seams have direct fixture inputs; adapter tests assert public receipts and outbound bytes, with mixed-validity regressions. Coverage and mechanical lint metrics were not measured under the dispatch's no-test/no-build limits. Native fetch and abort/listener callbacks retain their foreign ABIs; owned boundaries take object arguments. No certified tests were changed. Runtime self-validation is unrun for the same instruction.
