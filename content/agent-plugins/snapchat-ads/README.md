# Snapchat Ads — R1 reads/auth

This inert Agent Plugins 1.1.0 package adds organization/account discovery, campaign and existing-creative listing, and TOTAL reporting. It ships disabled/unadmitted. Server catalog wiring is deferred, so these commands are not yet available in the application. No distribution was built.

The sole public entry is `io.github.ainsep.openmarketing/src/index.ts`. Package exports mirror LinkedIn; this content package stays outside workspace globs. Existing root tooling and exact dependency pins are reused; no install, workspace, lockfile, contract or migration change.

```ts
const adapter = createSnapchatAdsAdapter({
  configuration, admitted, gateway, credentials, fetch: guardedFetch, clock, observer,
});
await adapter.invoke({ context, operationId, command: { kind: "list_campaigns" } }, { signal });
```

Configuration is server-owned: scope, connectionId, accountId (null for discovery), currency, timezone, apiVersion:"v1", pluginDigest. Currency/timezone must be resolved from the chosen account, never assistant guesses; discovery may use placeholder USD/UTC until selection. Credentials resolve on every request through `credentials.access({connectionId, accountId})`. An optional expiresAt is epoch milliseconds; omitted expiry remains the server broker's responsibility.

Paste an authorized Marketing API access token through OM's existing server credential storage after integration. Never paste secrets into chat. Snap documents OAuth authorization-code auth, the snapchat-marketing-api scope (which permits reads AND writes), 3,600-second access tokens and refresh tokens. R1 sends only GETs and adds no refresh service. Expired/401 tokens require reconnect. Snap's FAQ specifies an SSL redirect; loopback permission and detailed app approval remain UNVERIFIED, so no OAuth descriptor is supplied. [Authentication](https://developers.snap.com/marketing-api/Ads-API/authentication), [FAQ](https://developers.snap.com/marketing-api/Ads-API/faq).

The initial admitted flag denies before credential access. After each credential resolution, gateway.dispatch must enforce OM's existing read policy, current plugin/connection/account or selected-organization authority and cancellation. Supply the existing guarded fetch to revalidate at actual egress after any awaited checks. The gateway receives the exact frozen request and canonical read EffectEnvelope with operation identity and request digest; it must not create a second approval/outbox. Injected observer events contain operation/outcome and run/correlation/trace IDs only. Broker/provider exceptions and bodies never appear in failures.

Each ordinary read makes one GET. A campaign report makes a campaign ownership GET followed by the stats GET; both resolve credentials and cross the current host fence separately. Ownership must match the configured account, requested ID and exactly one campaign. A failure stops before stats. There are zero automatic retries, redirects or pagination loops. Each request has a 15s timeout, input cap 64KiB, streamed response cap 1MiB and page cap 100. Paged commands accept pageSize 50–100 and bounded cursor; links must match the fixed origin/path, and only a validated cursor escapes. Organization discovery rejects over 100 rows; pagination there is undocumented. Limits are OM bounds, not vendor guarantees.

Reporting requires ISO start/end at account-local midnight with offsets (maximum 366 days). TOTAL only; account stats request spend, campaign stats request spend/impressions/swipes. Micros and counters remain decimal strings; unsafe numeric values reject. Missing fields stay absent; an empty response is no_data_access_unconfirmed. Provider windows, if supplied, must match requested instants. Finalization fields remain provider evidence, without inferring final totals or half-open accounting semantics. [Measurement](https://developers.snap.com/marketing-api/Ads-API/measurement), [monetary values](https://developers.snap.com/marketing-api/Ads-API/monetary-values).

R2 owns PAUSED deployment and narrowly configured offline CAPI. Integrator owns server registration, null-account discovery authority, root om:build-plugins, and running the shared tests/contract-suite.ts against real host composition with injected responses. DS2 owns connection/reconnect and existing tool/result UI. Existing production preparation/execution sandbox guards and bundled-only executable-agent-plugin host restriction remain shared NEEDS; the latter conflicts with the owner's uploaded-plugin rule. No new Snapchat trust gate is added.

Validation: fixtures written, not run. One final lane typecheck only; tests/builds/om:check/install/live calls are prohibited in this run. Integrator/T1 must run adapter and host acceptance, including authority revocation between ownership and stats. No red/green or coverage claim. Documentation includes public API, boundary and resource semantics. Architecture audit by inspection: plugin-only vendor code; canonical contracts import; injected I/O/time; no stores/services/registries/automatic refresh. Function/runtime validation remains inconclusive until fixture execution.

Reuse: copied LinkedIn's approved inert package, bounded fetch, broker/gateway and public-receipt fixture patterns; vendor codecs remain separate because Snap envelopes, UUIDs, cursor links and micro-currency differ. Installed @jini-ai/agent-plugins@0.4.6 and @jini-ai/oauth@0.2.2 expose generic infrastructure, no Snap implementation found. No Jini dependency/upgrade requested; JU1 owns upgrades. Research records verified official REST docs, CAPI-only official SDK alternatives, blocked app activation details and unresolved idempotency/sunset/loopback facts in evidence/primary-sources.json.

Function review handoff (inspection only; no measured complexity, coverage or runtime result):

| Units (tiny mappers inherit their caller's assessment) | Disposition | Direct fixture evidence written | Residual finding |
| --- | --- | --- | --- |
| createSnapchatAdsAdapter/invoke, prepare, validateBinding, boundInput | INCONCLUSIVE | inert import/factory, admission, foreign scope, invalid/cyclic/oversized commands, DST/windows | Runtime assertions unexecuted |
| dispatch, resolveCredential, beforeEgress | INCONCLUSIVE | expiry, revoked admission after credentials, cancellation, duplicate execute, second-fetch revocation | Real host shared-suite execution deferred |
| send, rejection, readBody, decode, observe | INCONCLUSIVE | redirect/signal request, 401/403/429/503, malformed/oversized stream, thrown transport, redaction | Timeout/telemetry failure not runtime-validated |
| encodeCommand, decodeList, checkOwnership, nextCursor | INCONCLUSIVE | fixed paths, all read projections, partial/duplicate/foreign pages, hostile cursor URLs | Real account compatibility unverified |
| reportWindowValid, decodeReport, windowMatches | INCONCLUSIVE | account-only spend, micros precision, missing data, DST, IDs/types/windows, duplicate aggregates | Provider endpoint inclusivity unverified |

All public APIs/types/schema descriptors are documented inline; no new doc exemption. By inspection, no unresolved security/architecture finding; mechanical function-quality validation and runtime evidence remain INCONCLUSIVE. Each loop is bounded by 100 records or 1MiB; network fan-out is explicitly one GET or two for campaign reports. Standard Zod/array/fetch callbacks use their foreign ABI; other owned functions take objects. No certified tests were supplied; the approved R1/review scope is the implementation authority.

The single authorized typecheck, `npx --no-install tsc --noEmit -p tsconfig.json` from this package, exited 2 with TS2339 at commands.ts:78 (computed-key inference widened paging). Added the explicit type for that schema-validated projection and refreshed compatibility fingerprints. No second typecheck was run; the correction still needs integrator verification.
