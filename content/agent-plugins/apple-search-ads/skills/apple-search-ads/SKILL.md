---
name: apple-search-ads
description: Discover Apple Ads ad accounts and query campaign pages through OM server tools; reporting is unavailable.
---
Use only server-admitted tools; the v1 plugin remains disabled pending host integration. Connect through server-sealed token custody; never ask for secrets in chat.
Select a discovered **ad account** (`adAccount.id`), not its organization. Require explicit reselection of legacy organization bindings; never guess an ad-account ID.
`list_accounts` returns ad-account identities/roles; `list_campaigns` returns bounded pages, never account completeness. `report` returns `not_implemented` without credential access or network; do not claim metrics support or invent zero spend, dates, watermarks or freshness.
PAUSED App Store install deployment uses the server's exact card and single jobs outbox. Verify each parent before children; never activate, retry unknown creates, roll back or continue partial launches. Reconcile saved IDs with GETs only.
Server origin/account binding, capability/fingerprint refresh, launch-objective compatibility and production metadata resolution remain NEEDS. If unavailable, explain the missing integration/admission; never call Apple directly.
