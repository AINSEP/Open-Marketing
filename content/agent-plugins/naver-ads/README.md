# Naver Search Ads

Disabled/unadmitted server-loaded OM agent plugin. Three read tools: `list_accounts`,
`list_campaigns`, `report`. R2 adds saved-reference readback; launches remain unavailable.
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

R2 exports `translateCampaign`, `campaignDeploymentPlanSchema`,
`deployCampaignPaused`, and `readCampaignDeployment` through the same public entry.
Translation and deployment return non-retryable `not_implemented` before checkpoint,
credentials or network. Unadmitted deployment returns `forbidden`. No POST, activation,
rollback, standalone creation tool or write capability is shipped.

[Official FAQ](https://github.com/naver/searchad-apidoc/wiki/FAQ) supports an inclusive Naver end date: `CAMPAIGN_ENDED` applies when
today is later than the configured end date. OM's `TimeWindow` does not specify end
inclusion, so exact neutral-to-vendor mapping still needs an integrator decision.
The [official specification](https://raw.githubusercontent.com/naver/searchad-apidoc/gh-pages/assets/json/ncc-heroes-ncc.json) marks `AdRequest.userLock` as `#optional-update`; paused TEXT_45
creation also needs verification. Neither fixture metadata nor caller flags override
these prerequisites. OAuth and server conversion delivery remain unsupported.

Readback accepts `{context,operationId,plan,references,dependencies}` with existing
R1 dependencies. The strict plan freezes customer/key owner, creative ID/digest,
existing channel, names, explicit KRW budgets/CPC, vendor KST dates and paused controls.
Fixed CPC requires `adgroup.systemBiddingType:"NONE"` in the saved plan and vendor
readback. The [official specification](https://raw.githubusercontent.com/naver/searchad-apidoc/gh-pages/assets/json/ncc-heroes-ncc.json)
defines `NONE`/`ML` separately from `bidAmt`; a matching bid alone is insufficient.
Missing or `ML` vendor mode returns `unknown`, preserving every saved reference
and stopping before child reads. Plans missing `NONE` are rejected before I/O.
It is a saved observation contract, not an executable creation plan. References are
a flat map: `campaign`, `adgroup`, `ad`, `keyword_0` through `keyword_19` (plan order).
Only exact saved IDs are queried, parents first, followed by SITE channel verification.
Every entity must match ownership, parentage, content, controls and `userLock:true` /
`status:PAUSED`. Incomplete/mismatched evidence returns `unknown` with all validated
references retained. `acknowledged` means current readback matches saved vendor
controls; it does not prove neutral schedule translation or launch readiness.
There are at most 24 GETs, each using fresh broker access, the 15s deadline and 1MiB
response bound. No discovery scans, writes or retries occur during reconciliation.
Deferred: exact end mapping, paused-create proof, create/checkpoint sequence and
partial-create fixtures, grouped-card/outbox/server wiring, build registration and
HTTP/MCP/CLI/Studio integration. Integrator/T1 own runtime validation and tests.

R2 handoff: partial delivery. Source review checked lane ownership, public imports,
injected I/O/time, bounds, secret redaction, parent ordering and no create/retry path.
Architecture review: WARNING until end mapping, paused-create evidence and guarded
server integration close. Existing tests were preserved; new fixtures have not run,
so runtime validation, coverage and red/green evidence are unavailable by dispatch.
The single lane typecheck, `corepack pnpm --dir content/agent-plugins/naver-ads typecheck`,
passed with exit code 0. No tests, builds, installs or `om:check` were run.

| Assessment unit | Disposition | Finding / local action |
| --- | --- | --- |
| Translation / deployment denial | INCONCLUSIVE | Fixtures written; execution prohibited. No override or write path. |
| Plan / input validation | INCONCLUSIVE | Aggregate/cycle/size fixtures written; reference bounds included in the same envelope. |
| Readback orchestration / expected controls | INCONCLUSIVE | Partial-ID and parent-mismatch fixtures written; all refs retained. |
| Entity / SITE channel verification | INCONCLUSIVE | Ownership, content, budget, date, pause and channel fixtures written. |
| Signed GET / credential / body boundaries | INCONCLUSIVE | Fault, redaction, revocation, cancellation and body-limit fixtures written. |

Documentation: new public symbols and non-obvious I/O invariants documented inline.
Reuse: server owns policy, broker, guarded fetch and outbox; inspected LinkedIn
deployment checkpoints and Naver R1 transport. Readback reuses their injected
contracts and Node crypto; transport helpers remain private because R2 cannot edit
R1 transport. Integrator may consolidate those helpers in a separately approved edit.
