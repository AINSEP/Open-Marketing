# Amazon Ads — R1

Server-only portable plugin, disabled/unadmitted by default. After the integrator wires it,
use OM's existing owner connection ingress to paste ONE sealed JSON value:
`{"clientId":"your-approved-app","accessToken":"your-token","expiresAt":1792886400000,"region":"NA"}`.
`expiresAt` is epoch milliseconds calculated from the returned OAuth expiry, never a fixed lifetime.
Choose NA/EU/FE explicitly. Tokens stay on the server. Reconnect on expiry or rejection.
Amazon app approval and the `advertising::campaign_management` grant are prerequisites.
HTTP loopback support remains unverified: no OAuth descriptor, client secret or refresh token here.

Accounts are Amazon profiles. Only `list_accounts` accepts a null configured profile.
`list_campaigns` takes `adProduct: "SP" | "SB"`, `maxResults` (1–100), and optional `nextToken`;
it returns one page. Profiles are capped at 100 with an explicit error above the cap.
Campaign lists return identity, name, dates and observed state, without interpreting budget/spend.
`request_report` takes a preset (`spCampaigns` or `sbPurchasedProduct`) and inclusive ISO dates
(at most 31 days). It is an ordinary write under the ONE host policy/outbox.
Poll with separate `get_report` calls; `download_report` accepts only the report ID.
SP rows contain traffic/cost; SB rows describe purchased products, not campaign spend.
Only the verified PENDING/COMPLETED lifecycle states and fixed preset columns are accepted.
Other lifecycle states/configurations fail closed. Locations never appear in tool results.
Downloads accept only `offline-report-storage-us-east-1-prod.s3.amazonaws.com`, the exact host
in Amazon's official Postman example; other buckets/region forms return unavailable before storage egress.
Downloads forward no Ads auth and reject redirects. Campaign end dates may be absent or null.
Limits: 64KiB input, 1MiB responses/compressed report, 8MiB decoded, 10,000 rows, 15s per fetch.
Zero retries. Unknown report creation requires host reconciliation, never automatic resubmission.

Integration must supply `createDeadlineSignal({ timeoutMs })` for each 15s fetch/body deadline,
and guarded fetch that rechecks admission, connection/profile ownership, halt
and authority immediately before EVERY request (including storage), and claims report writes in
the existing outbox. This plugin adds no policy, registry, worker, store or service startup.
No live calls were made. Fixtures are synthetic and tests were written without execution.
Deferred: server/catalog/build/coverage wiring and acceptance tests (integrator), studio (DS2),
SP PAUSED hierarchy (R2), SB deployment pending schemas, production product resolution, conversions.
No dependency upgrade, contract edit, migration, commit or push.

Evidence and blocked references: `io.github.ainsep.openmarketing/evidence/primary-sources.json`.
Public entry: `io.github.ainsep.openmarketing/src/index.ts`; source and tests typecheck together.
