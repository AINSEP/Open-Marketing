# Apple Search Ads — Apple Ads Platform API v1

Run A migrates the existing disabled plugin to v1: ad-account discovery, bounded campaign queries, App Store/Search Match/manual-CPT translation, PAUSED deployment/readback and GET-only recovery. This is fixture-based implementation awaiting execution and host integration; it is not a server/studio launch integration. No report command or canonical reporting capability is available.

Apple confirms [v5 sunset on 2027-01-26, with errors afterwards](https://ads.apple.com/adsdam/app-store/us/en_us/documents/api-preview-guide.pdf#page=4). Owner merge target: 2026-12-15. There is no v5 fallback.

## Connection and account selection

[OAuth](https://developer.apple.com/documentation/apple-ads-platform-api/implementing-oauth-for-the-apple-ads-platform-api) still uses ES256 client secrets, `client_credentials`, `searchadsorg` and one-hour access tokens. The plugin continues to accept server-brokered tokens; it adds no signing, exchange, renewal, cache or browser flow. Supply tokens through the server-sealed integration flow, never chat.

Discover accounts with `{kind:'list_accounts'}`. [ACLs](https://developer.apple.com/documentation/apple-ads-platform-api/access-overview) return `result.acls[]`, each with `adAccount:{id,name,orgId}` and `roles`. They do not provide currency/timezone. Explicitly reselect an **ad account** after migrating; never automatically reinterpret a saved organization ID. No database migration is included.

Inject existing `configuration:{scope,connectionId,accountId,currency}`, admission, credentials, guarded fetch, clock and observer. `accountId` means the selected `adAccount.id`. Discovery permits null and omits account context; scoped requests send `X-AP-Context: adAccountId=…`. Host origin/account binding must be updated before admission. Host credentials and fetch must recheck current authority after awaits and at egress.

## Confirmed requests and shapes

| Operation | v1 request and response | Apple evidence |
| --- | --- | --- |
| Discovery | `GET /v1/acls`; `result.acls[].adAccount` and `roles` | [Access](https://developer.apple.com/documentation/apple-ads-platform-api/access-overview) |
| Campaign list | `POST /v1/campaigns/query`; sorting by ID ascending; body pagination `{offset,pageSize,fetchTotalCount:true}`; `result:[]` and `{offset,pageSize,totalCount}` | [Calling conventions](https://developer.apple.com/documentation/apple-ads-platform-api/calling-apple-ads-platform-api) |
| Campaign create/read | `POST /v1/campaigns`, `GET /v1/campaigns/{id}`; `adAccountId`, promoted app, `dailyBudget.value`, targeting include arrays, `MANUAL_CPT`/`TAP` | [Create](https://developer.apple.com/documentation/apple-ads-platform-api/post-campaigns), [read](https://developer.apple.com/documentation/apple-ads-platform-api/get-campaigns-_id_) |
| Ad-group create/read | `POST /v1/adgroups`, `GET /v1/adgroups/{id}`; numeric `campaignId`, `CPT`, `bidStrategy.bid`, Search Match | [Ad groups](https://developer.apple.com/documentation/apple-ads-platform-api/adgroups-endpoints), [App Store example](https://developer.apple.com/documentation/apple-ads-platform-api/journey-app-store-ads) |
| Ad create/read | `POST /v1/ads`, `GET /v1/ads/{id}`; numeric `adGroupId`, creative, name/status; omit read-only campaign/account IDs from creation | [Ads](https://developer.apple.com/documentation/apple-ads-platform-api/ads-endpoints) |
| Creative preflight | `GET /v1/creatives/{id}`; account identity, `destination.parameters.adamId`, App Store destination, `VALID`, non-deleted | [Creative endpoints](https://developer.apple.com/documentation/apple-ads-platform-api/creatives-endpoints), [object](https://developer.apple.com/documentation/apple-ads-platform-api/creative) |

All successful payloads require `result`; legacy `data` and bare receipts are rejected. [Errors](https://developer.apple.com/documentation/apple-ads-platform-api/calling-apple-ads-platform-api) validate bounded code/message/details and return sanitized failures, including HTTP errors; provider text never reaches receipts or logs. Bounds remain 100 rows, 64 KiB request/input, 1 MiB streamed response, 15-second attempts, no redirects, automatic pagination or retries. Pagination always says `coverage:'page'`, never complete account totals.

## Deployment and recovery

Keep the four public functions and object arguments through `src/index.ts`: `invokeAppleSearchAds`, `translateCampaign`, `deployCampaignPaused`, `readCampaignDeployment`. Translation preserves the existing `app_install` subset only; it adds no shared objective. Frozen plans include app/creative provenance, targeting, exact decimal budget/bid, finite UTC dates and all three `PAUSED` statuses. Readback normalizes exact decimal equivalence, country ordering and documented suffix-free UTC timestamps.

The server owns the exact approval card and single jobs outbox. Creative preflight precedes creation; durable dispatch checkpoints precede each create; candidate IDs are saved before acknowledgement checkpoints. Each parent must match approved configuration, account/parent identity, `PAUSED`, `systemStatus:'NOT_RUNNING'` and `deleted:false` before its child. Failed acknowledgements/readbacks/checkpoints return `unknown` with retained IDs; never retry or continue an uncertain create. Recovery only GETs saved IDs. Parent IDs outside safe JSON-number range stop child creation without rounding. No activation or rollback is implemented.

## Deferred integration and verification

Keep disabled/unadmitted metadata, declare no reporting capability until supported, and use canonical `["write","ad_spend"]` effects for any later `campaign.deploy` admission. Server origin/account binding, capability wiring, host dispatch-suite binding, packaging, production metadata and launch-objective compatibility remain NEEDS. No shared contract, manifest, lockfile, server or migration changes belong to AP1.

Reporting date boundaries, watermarks/freshness/finality and restatement semantics are unresolved; no successful batch or account metadata lookup is implemented. Future reporting must satisfy the existing integer-micros metrics contract. Create idempotency remains unverified; no retry guarantee is invented. Apple Maps, keywords, creative creation, conversions and browser OAuth stay unsupported.

Tests are synthetic fixtures, written but not run. This run permits exactly one final `corepack pnpm --dir content/agent-plugins/apple-search-ads typecheck`; no tests, builds, installs, indexing, live vendor calls or migrations. Runtime/coverage/lint evidence remains unavailable under that limit. Reuse: existing bounded transport, credential broker, pure translation, checkpoints and shared dispatch suite; public OM contracts and installed Zod/native fetch. Published Jini 0.6.12 OAuth and credentialed-HTTP declarations were inspected; no additional library behavior is needed for this migration.

Static architecture audit: PASS for this lane's dependency, DI, pure-codec, fail-closed, server-owned authority and no-retry boundaries; no mechanical lint claim. Changed public schemas/page semantics and report type are documented; existing public function signatures are retained. No new functions, ports, factories or dependencies. Test changes follow the approved v1/report-disabled behavior; integrity assertions were preserved.

| Function assessment units | Disposition | Finding / local review |
| --- | --- | --- |
| encodeCommand, decodePagination, prepare, dispatch, checkTime, decode, decodeList | INCONCLUSIVE | Execution prohibited; direct request/page/report-denial fixtures written |
| send, decodeJson and provider envelopes | INCONCLUSIVE | Execution prohibited; bounds/cancellation/errors/expiry fixtures written |
| translateCampaign, validPlan and payload schemas | INCONCLUSIVE | Execution prohibited; exact money/identity/schedule fixtures written |
| deployCampaignPaused, readCampaignDeployment, readStep, checkInput, creationRequest, decodeRow | INCONCLUSIVE | Execution prohibited; independent hierarchy and GET-only recovery fixtures written |
| createStep | INCONCLUSIVE | Precision risk fixed locally: retain unsafe string IDs, deny numeric child dispatch; regression written |

Static skepticism reviewed variable meanings, exact decimal scale, numeric ID conversion, legacy/result envelopes, cross-account/parent mismatch, unknown outcomes and cross-await mutation. No unresolved static Critical/High finding recorded. Runtime evidence, red/green proof, complexity/coverage metrics and self-validation remain unavailable because this dispatch prohibits their execution. Owned signatures retain object arguments; existing foreign callbacks retain their ABIs. No out-of-lane file or progress-ledger artifact was created.

Run A verification: the sole `corepack pnpm --dir content/agent-plugins/apple-search-ads typecheck` passed (exit 0). Lane whitespace check passed; exactly the 13 approved existing files changed, no files created. Tests/builds/installs/om:check/indexing/live vendor operations and migrations were not run. No commits or pushes. Pre-completion re-read confirmed v1 coverage, disabled reporting, parent/checkpoint ordering, bounded transport and unchanged integration ownership. Handoff: integrator refreshes metadata/bindings, then separately authorized fixture and host/runtime verification.
