---
name: snapchat-ads
description: Inspect Snapchat organizations, ad accounts, campaigns, existing creatives and TOTAL reports through Open Marketing server tools.
---
Use only the installed OM server catalog. Never request tokens in chat, configure vendor HTTP in the agent, or bypass the ONE server policy. Connect/reconnect using the existing server integration token flow once Snapchat wiring lands.

Use `list_organizations`, then `list_accounts` with the selected organizationId. Server composition binds the chosen account for `list_campaigns`, `list_creatives` and `report`. Pass the literal command `kind`. Pages default/max 100 (minimum 50); use a returned nextCursor as cursor in a new explicit call. Never follow provider URLs. Organization discovery has a 100-row cap and no undocumented pagination.

Use `report` with window.start/end ISO timestamps at midnight in the account timezone, at most 366 days apart. Omit campaignId for account spend only; supply one campaignId for spend/impressions/swipes. Campaign ownership is read first. TOTAL is the only granularity. Missing/empty data is not zero. Preserve currency, micro-currency strings, requested/provider windows, retrieval time and finalization metadata; endpoint inclusivity is unverified.

Launch uses the existing OM grouped exact card after the server freezes one traffic campaign → one squad → one existing WEB_VIEW ad, all explicitly PAUSED. Wait for parent readback; report unknown/partial references without retry, resume or activation. Server wiring is pending. Offline SIGN_UP delivery is server-only under current measurement grant/consent; never relabel web events or request a direct conversion tool. No activation, media upload, arbitrary HTTP or OAuth descriptor. An expired pasted token requires reconnect; the plugin does not refresh it. Missing admission/access yields a typed denial. Do not infer live vendor eligibility from synthetic fixtures. Evidence: ../../io.github.ainsep.openmarketing/evidence/primary-sources.json.
