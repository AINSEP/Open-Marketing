# VK Ads — R1 reads and authentication

The server adapter exposes `list_accounts` and `list_campaigns` after host
admission. Packaging stays disabled/unadmitted by default. Admission false performs
zero credential, clock or network I/O. Use the existing server connection flow;
never paste credentials in chat or tool arguments. Server/studio/CLI wiring is
integrator-owned and remains deferred; this package alone does not enable a UI.

The sealed broker accepts a pasted Bearer token. Fresh tokens already stored in a
client credential record can also be read, but client issuance and refresh return
`unavailable`. VK permits only five live tokens per client/user. The existing broker
cannot durably record issuing/unknown state and reconcile an issued-but-unsaved
token, so this adapter makes no token POSTs or saves, even after recreation.
Replace expired tokens through the server connection flow. No token deletion or
authorization-code/loopback OAuth is provided.

`list_accounts` returns the token's single `/api/v3/user.json` identity; currency is
reported there, timezone is unknown. Every campaign call checks this identity
against its server binding. `list_campaigns` fetches one AdPlans page: limit 1–100,
offset 0–1,000,000, explicit nextOffset, no automatic paging.

Statistics are unavailable and unadvertised: the reviewed official capture does not
establish the users/summary response envelope. Recognized `report` commands return
`unavailable` before credential, deadline or network access, even when admitted.
Report input bounds remain in place for explicit rejection of malformed requests.
Currency/units, timezone and campaign statistics mapping also remain unverified.

Transport uses https://ads.vk.ru, refuses redirects, has one 15-second invocation
deadline from the injected server `deadline({timeoutMs:15000})` function, combined
with caller cancellation; 64KiB input and 1MiB streamed response caps; zero retries.
The server must provide guarded fetch with current policy/binding/revision checks
and durable egress audit. This plugin does not certify that composition binding.
Official evidence is recorded in `io.github.ainsep.openmarketing/evidence/primary-sources.json`.
Fixtures are synthetic; no vendor acceptance or live calls are claimed. R2 creation,
activation, budget edits, uploads, conversions and agency clients remain deferred.
Coordinator owns tests/build/om:check; this run writes tests and typechecks once.

R2 remains held for operation-specific evidence. The Chrome capture verifies explicit
`status: "blocked"` for campaign/group creation, parent IDs and existing banner assets.
One complete traffic package still needs objective/settings, targeting, banner-pattern
roles, currency budget steps and schedule timezone/end-date evidence. Banner status at
creation is unverified. Campaign creation requires `ad_groups`; empty-list acceptance
needs verification for parent readback before children. Nested creation alone does not
satisfy that ordering. No write capability is advertised.

To unblock R2, capture official creation/acknowledgement/readback examples for that
format. R2F web retrieval failed; browser navigation required unavailable approval.
See the evidence file's `r2` record. Idempotency remains unknown: no create retries.
Conversions, integrator-owned grouped approval/outbox/guarded egress and DS2 UI remain deferred.

The public `translateCampaign`, `deployCampaignPaused` and `readCampaignDeployment`
boundaries return non-retryable `unavailable` without I/O. Deployment checks admission
first (`forbidden`), then cancellation (`cancelled`). `campaignDeploymentPlanSchema`
rejects every payload; inputs remain unchanged and no success receipt exists. Guards
do not establish translation, approval, paused creation, partial-ID retention or recovery acceptance.
