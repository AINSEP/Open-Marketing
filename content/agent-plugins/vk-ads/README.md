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
