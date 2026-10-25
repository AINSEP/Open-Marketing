---
name: microsoft-ads
description: List Microsoft Advertising accounts and Search campaigns and request daily performance through existing OM tools.
---
Use the existing OM agent-plugin discovery/execute routes for list_accounts, list_campaigns and report. These are read effects under the ONE server policy. The plugin stays disabled/unadmitted until host integration and connection setup.
Never request tokens in chat or tool arguments. The server stores access/OAuth credentials and the developer token separately (fixed connection developer-token.microsoft-ads). OAuth requires a configured confidential-web client, S256 PKCE and OM's exact registered callback; use paste-token until available.
Reports use half-open UTC midnight windows, up to 366 days, and preserve scalar decimal strings. Distinguish reported zeros, no_data, expired polling and failures. Account discovery is paged; campaign listing covers Search only. Respect pageLimitReached; never infer missing totals or serving status.
Campaign writes, activation and conversions are unavailable in R1. No direct vendor calls, custom policy or plugin-specific approval flow.
