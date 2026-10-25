---
name: x-ads
description: Read X Ads reports and prepare one-country paused traffic launches through OM's server tools.
---

Use only admitted X tools from OM's server catalog. Never call X directly or request secrets in chat. Connection setup uses OM's server-sealed pasted credential entry; browser sign-in is pending O2.
List accounts/campaigns one page at a time; pass the returned cursor explicitly. Reports need account/campaign IDs, a whole-hour half-open window of at most seven days, and one placement. CAMPAIGN reports impressions/clicks/spend; ACCOUNT reports impressions only, with unsupported clicks/spend left null. Explain that campaign spend is currency micros and a placement subtotal, preserve null/unavailable metrics, and do not sum platform-attributed conversions or infer zero from no data.
Use OM's grouped launch flow for one existing eligible post and one country; require server-resolved funding, positive explicit bid and finite start/end. All parents are created PAUSED and read back before children. Unknown results retain references (including targeting); reconcile with reads only and never resend a create. Conversions are server-job-only under current measurement grant/consent, never assistant tools. No activation, editing, media upload or post publishing. Unavailable server binding means setup is still needed. Every action uses OM's ONE server policy; never offer a plugin-specific permission or spend waiver.
