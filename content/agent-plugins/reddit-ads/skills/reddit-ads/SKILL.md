---
name: reddit-ads
description: Discover Reddit businesses and read account or campaign performance through Open Marketing's admitted server tools.
---

Use the OM server catalog and its single tool policy. Never request tokens in chat or perform direct vendor HTTP.
After integrator wiring/admission, `list_businesses` discovers businesses. `report` reads account/campaign spend, impressions and clicks. Include the literal command `kind`; the server binds connection/account/currency.
`list_accounts` and `list_campaigns` currently return NEEDS before credentials/network because current v3 wire evidence is incomplete. Do not invent results or use alternative endpoints.
Report windows are UTC-midnight boundaries, at most 31 days. Results label the requested window; they are provider reports, not neutral reconciled measurement totals. Spend is integer microcurrency; null and empty results do not mean zero.
Request another explicit page using `nextPageToken`; never follow a vendor URL. `incomplete:true` means more data remains, including when an otherwise empty page is returned.
Authentication is paste-token only through the server's `om integrations connect --plugin reddit-ads --token-stdin` flow after catalog integration. On expired/unauthenticated results reconnect with a fresh adsread token. No automatic refresh or browser OAuth is provided.
There are no launch, activation, budget, halt, conversion or destructive tools. Future spend always requires the server's exact card for every call.
