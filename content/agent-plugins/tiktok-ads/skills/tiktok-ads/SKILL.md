---
name: tiktok-ads
description: Inspect TikTok advertisers, build disabled website traffic ads, activate with exact spend approval, pause entities and read account spend through OM server tools.
---

# TikTok Ads

Use the ONE OM server tool catalog/dispatcher. Tokens, OAuth configuration and direct vendor calls stay on the server. Current plugin capabilities are disabled and unadmitted until addons/Coordinator integration; fixtures are not live vendor evidence. Read [the plugin README](../../README.md) for setup and [official evidence](../../io.github.ainsep.openmarketing/evidence/primary-sources.json) for v1.3 / Events 2.0 fields inspected 2026-10-13 and UNVERIFIED limitations.

- Inspect the bound advertiser with `tiktok_ads.get_advertiser`. This does not enumerate all OAuth-authorized accounts. Use `get_campaigns`, `get_adgroups`, `get_ads` with at most 100 rows/page and explicit IDs when inspecting a known entity.
- Create a hierarchy one step at a time: `create_campaign_paused`, `create_adgroup_paused`, `create_ad_paused`. The supported path is ordinary website traffic, existing video and AUTH_CODE identity, HTTPS landing page. Supply existing parent/location IDs, budgets and account-local schedule start. Each creation sends DISABLE explicitly and is a normal write through existing write grants; it does not require a spend card.
- A create acknowledgement alone proves no status. The adapter performs a filtered readback. If the result is a failure or unknown, tell the user honestly, show the known ID when provided, inspect it, and ask to pause if needed using `pause_entity`. Never automatically repair, activate, rebuild or repeat the create.
- `activate_entity` requires the server's exact spend card for EVERY call. Fill the existing exposure/limit request fields through the host workflow. Never substitute Always allow, a chat-wide waiver or a budget envelope. Explain that ENABLE readback is operational status, not guaranteed effective serving.
- `pause_entity` disables one campaign/group/ad using normal write policy. Never clear a local halt or invoke a generic status update as a backend halt bypass.
- `report` retrieves account-total spend for at most 31 inclusive account-local dates. Preserve advertiser, currency/timezone, period, pagination and retrieval time. Incomplete/empty reports are not complete spend snapshots; never derive OM CAC from platform-attributed conversions.

`stop`, `deliver` and `reconcile` are typed server backends, not assistant tools. Signup/trial Events jobs require the current measurement grant and exact-payload consent recheck. Contacts supplies lowercase SHA-256 identifier digests; never send raw identifiers or hash a supplied digest again. Preserve the OM event ID across browser/server channels; the backend converts occurrence milliseconds to Unix seconds. An accepted Events request is not conversion attribution proof.

Use stable server-issued operation/delivery IDs. The server's ONE jobs outbox owns durable claims; this plugin never retries writes. A timeout or malformed write receipt remains unknown. Events reconciliation returns unknown without resending because no verified per-event readback exists. Admission and account/grant authority must remain current through credentialed egress.

Do not invent OAuth scope names or broaden supported commands into media uploads, audiences, deletion, budget edits, Smart+, shopping or organic posting. Report those as outside the current plugin scope.
