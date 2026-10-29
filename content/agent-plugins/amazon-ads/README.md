# Amazon Ads — R1/R2

Server-only portable plugin, disabled/unadmitted by default. Owner connection setup is unavailable.
NEEDS: server-owned Amazon OAuth/refresh with an HTTPS callback, app approval and the
`advertising::campaign_management` grant. Calculate token expiry from OAuth responses and keep
tokens on the server. The manual short-lived token/epoch-expiry card has been withdrawn.
The legacy sealed credential parser remains for host fixtures; it is not an owner setup flow.

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
SB deployment pending schemas, production product resolution, conversions.
No dependency upgrade, contract edit, migration, commit or push.

Evidence and blocked references: `io.github.ainsep.openmarketing/evidence/primary-sources.json`.
Public entry: `io.github.ainsep.openmarketing/src/index.ts`; source and tests typecheck together.

R2 provides `campaignDeploymentPlanSchema` and `deployCampaignPaused` for one explicit SP automatic
campaign → group → product ad, all explicitly PAUSED. Only seller SKU or vendor ASIN, fixed MANUAL
bidding, exact daily budget, and ISO calendar dates are accepted. Amounts must fit profile currency
precision; 1,000,000 per amount is an OM input bound, not a documented vendor quota or spending cap.
The plan contains the profile country/currency/timezone. These and seller/vendor type are read back
before dispatch. Each indexed 207 acknowledgement is checkpointed and each parent read back before
its child. Readback uses fixed POST `/sp/{campaigns,adGroups,productAds}/list` calls filtered by ID.
Every approved field must match; strict nested comparisons may stop on vendor-added defaults.
Known IDs survive mixed item errors, missing/failed ACK checkpoints and subsequent failures.
There is no automatic retry, rollback, activation, name-based discovery or create continuation.
The host must reject repeated dispatch checkpoints for the same operation/step and retain receipts
when a checkpoint fails. It owns the ONE grouped exact card, outbox and every live egress fence.

R2 remains **partial and not admitted**. `translateCampaign` checks one marketplace/creative/digest/bid,
then returns typed `unavailable`: profile timezone and inclusive/exclusive campaign date boundaries
remain UNVERIFIED. No rounding or calendar mapping is inferred, including across DST changes.
Explicit-date plans remain for integrator fixtures until the neutral mapping is evidenced.
`readCampaignDeployment` verifies saved IDs with the documented read-only POST list endpoints,
including profile ownership, exact fields and PAUSED state. Missing/mismatched rows stop, retaining
all references. It never checkpoints, scans names, resends a create or continues a partial deployment.
The R2 review resolves GET-only reconciliation to these vendor-documented query methods; the host
must classify the exact list endpoints as reads and recheck authority on each request.

Owner Chrome evidence confirms HTTPS-only redirects and reporting v3 deprecation on 2027-06-30.
Reporting also requires `Amazon-Ads-AccountId`; its acquisition and host binding remain unresolved
in R1 and block admission. Do not equate this header with a profile ID or guess a value.
No server/studio/root files changed; no migration or shared contract changes.

Fix wave 2026-10-26: `createCapabilities({fetch,credentials,clock,observer,wait,configuration})`
accepts the shared server ABI and returns `{}` without credentials or network work. Canonical
`report.metrics.v1` and `campaign.status.v1` declarations and stub handlers are removed, so the
server does not offer reads that always fail. Legacy adapters are unchanged. Completed-report
selection and effective status evidence remain prerequisites for future canonical implementations.
OAuth/refresh remains deferred: the manual token/expiry card stays withdrawn. See
[Amazon authorization](https://advertising.amazon.com/API/docs/en-us/guides/account-management/authorization/authorization-grants)
and [refresh tokens](https://developer.amazon.com/docs/login-with-amazon/refresh-token.html).
