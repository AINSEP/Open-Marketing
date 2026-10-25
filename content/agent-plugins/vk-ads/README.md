# VK Ads — R1 evidence hold

This is a partial, disabled integration, not a usable reporting or campaign plugin.
The package records the official Chrome capture and validates the documented account
and AdPlans response fields. No tools/capabilities are advertised. Admission defaults
to false; setting it true still returns `unavailable` before credentials or network.

The capture documents `GET /api/v3/user.json` and `GET /api/v2/ad_plans.json`, but omits
the API hostname from its relative request examples. Do not guess `.com` versus `.ru`
or follow redirects with a Bearer token. Confirmation of an official absolute request
example is needed before adding transport. This run's official-page retrieval and DNS
failed; browser access was unavailable under the current approval policy.

`list_accounts` means the token's one account, not an invented advertiser multi-account
endpoint. Once transport is evidence-ready, verify its identity against the server binding
before campaign reads. Campaign decoding strips unconsumed fields, rejects malformed,
duplicate or oversized pages atomically, and returns explicit pagination. Timezone is null.
The server owns sealed paste-token entry/custody; never put credentials in tool arguments.
No token issuance, refresh, OAuth flow, store, API version option or new policy is added.

`report` returns `unavailable`: spend units/currency, timezone and the statistics
campaign-to-ad_plan/ad_group mapping remain unverified. No missing metric becomes zero.
Creation, activation, budget changes, conversions, agency clients and arbitrary HTTP are
absent. R2 is deferred. No runtime.json, OAuth metadata, migration or new dependency.

Future verified transport must retain the approved 15-second deadline, 1MiB streamed
response cap, 100-row page cap, 31-day report cap, no redirects and zero automatic retries.
These are OM limits, not vendor guarantees. No network implementation is included while held.

NEEDS: absolute API-origin evidence; metric semantics; integrator-owned account onboarding,
server catalog/guarded fetch, build registration and host acceptance; DS2 UI integration.
No shared dispatch suite is added until a real host binding consumes it alongside fixtures.
Tests are synthetic and written, not run. Coordinator owns runtime and integrated validation.
