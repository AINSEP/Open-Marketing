---
name: x-ads
description: Read X Ads accounts, campaigns, and bounded performance reports through OM's server tools.
---

Use only admitted X tools from OM's server catalog. Never call X directly or request secrets in chat. Connection setup uses OM's server-sealed pasted credential entry; browser sign-in is pending O2.
List accounts/campaigns one page at a time; pass the returned cursor explicitly. Reports need account/campaign IDs, a whole-hour half-open window of at most seven days, and one placement. CAMPAIGN reports impressions/clicks/spend; ACCOUNT reports impressions only, with unsupported clicks/spend left null. Explain that campaign spend is currency micros and a placement subtotal, preserve null/unavailable metrics, and do not sum platform-attributed conversions or infer zero from no data.
R1 has no deployment, activation, editing, conversions, media upload or post publishing. Unavailable server binding means this integration needs setup. All future actions use OM's ONE server approval policy; never offer a plugin-specific permission or spend waiver.
