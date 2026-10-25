# Naver Search Ads — R1

Disabled/unadmitted server-loaded OM agent plugin. Three read tools: `list_accounts`,
`list_campaigns`, `report`. No OAuth, writes, deployment or conversions in R1.
Server wiring and Studio presentation are deferred; installing this folder alone
does not make these tools available in OM.

Paste a JSON bundle through OM's existing server credential flow:
`{"apiKey":"YOUR_LICENSE","secretKey":"YOUR_SECRET","customerId":"KEY_OWNER_CUSTOMER"}`.
Use your own or delegated-account credentials; do not collect advertisers' keys.
The broker returns this text unchanged as `accessToken`. Naver parses it locally;
credentials never enter assistant arguments, receipts or observations.

Integrator: import only the package's `.` export and call `createNaverAdsAdapter`
with `configuration`, `credentials`, guarded `fetch`, `createDeadline`, `clock`, `observer`.
The server supplies `createDeadline({timeoutMs})`, returning an `AbortSignal` backed
by its timer (for example, `({timeoutMs}) => AbortSignal.timeout(timeoutMs)`).
Configuration: `{scope,connectionId,accountId,credentialCustomerId,admitted}`.
`credentialCustomerId` identifies the key owner. `accountId` is the selected SA
customer used for entity `X-Customer`; `adAccountNo` is a separate advertiser-center
number. Broker access must validate the selected account's authority. Account
discovery uses the key-owner header. The guarded server fetch must recheck current
admission, connection/account authority and halt under the ONE server policy on
each dispatch and append egress audit with the invocation context IDs.
There is no additional plugin policy, gateway, registry or outbox.

Commands include `kind`: accounts take optional `page`/`pageSize`; campaigns take
optional `cursor`/`pageSize` (mapped to `baseSearchId`/`recordSize`/`selector=NEXT`).
Pages are capped at 100 and returned explicitly, never crawled. A full campaign page
returns its last ID as a continuation candidate; a subsequent empty page ends it.
Report requires `campaignId`, `since`, `until` as KST calendar dates (<=31 days
inclusive). It requests `ids` + `allDays` and validates the documented
`SummaryStatResponse.data` with at most one matching campaign. Other wire shapes
return `protocol_mismatch`; live-account wire verification remains outstanding.
Reports retain source, retrieval time, KST labels and VAT-inclusive KRW spend;
empty data remains no-data/access-unconfirmed. No totals or FX are inferred.

One GET, no redirects or automatic retries; 64KiB input, 1MiB streamed response,
15s fetch/body deadline. `admitted:false` means zero credential/network I/O.
No runtime version prefix is inferred from Swagger metadata. Official evidence and
blocked pages are recorded in `io.github.ainsep.openmarketing/evidence/primary-sources.json`.

Validation: fixture tests written, not run. Integrator must run the shared dispatch
suite with the real server binding, add catalog/HTTP/MCP/CLI coverage and the root
`om:build-plugins` entry. No shared file, dependency pin or migration was changed.
