---
name: tiktok-ads
description: Inspect TikTok advertisers, build disabled website traffic ads, activate with exact spend approval, pause entities and read account spend through OM server tools.
---

# TikTok Ads

Use the ONE OM server tool catalog/dispatcher. Tokens, OAuth configuration and direct vendor calls stay on the server. Current plugin capabilities are disabled and unadmitted until addons/Coordinator integration; fixtures are not live vendor evidence. Read [the plugin README](../../README.md) for setup and [official evidence](../../io.github.ainsep.openmarketing/evidence/primary-sources.json) for v1.3 / Events 2.0 fields inspected 2026-10-13 and UNVERIFIED limitations.

- Inspect the bound advertiser with `tiktok_ads.get_advertiser`. This does not enumerate all OAuth-authorized accounts. Use `get_campaigns`, `get_adgroups`, `get_ads` with at most 100 rows/page and explicit IDs when inspecting a known entity.
- Create a hierarchy one step at a time: `create_campaign_paused`, `create_adgroup_paused`, `create_ad_paused`. The supported path is ordinary website traffic, existing video and AUTH_CODE identity, HTTPS landing page. Supply existing parent/location IDs, budgets and UTC schedule start. Each creation sends DISABLE explicitly and is a normal write through existing write grants; it does not require a spend card.
- A create acknowledgement alone proves no status. The adapter performs a filtered readback. If the result is a failure or unknown, tell the user honestly, show the known ID when provided, inspect it, and ask to pause if needed using `pause_entity`. Never automatically repair, activate, rebuild or repeat the create.
- `activate_entity` requires the server's exact spend card for EVERY call. Fill the existing exposure/limit request fields through the host workflow. Never substitute Always allow, a chat-wide waiver or a budget envelope. Explain that ENABLE readback is operational status, not guaranteed effective serving.
- `pause_entity` disables one campaign/group/ad using normal write policy. Never clear a local halt or invoke a generic status update as a backend halt bypass.
- `report` retrieves account-total spend for at most 31 inclusive account-local dates. Preserve advertiser, currency/timezone, period, pagination and retrieval time. Incomplete/empty reports are not complete spend snapshots; never derive OM CAC from platform-attributed conversions.

The server may call the declared read-only `report.metrics.v1` (daily metrics) and `campaign.status.v1` capabilities; they are not assistant tools and add no write or spend authority.

`campaign.halt-stop.v1`, `deliver` and `reconcile` are typed server backends, not assistant tools. Signup/trial Events jobs require the current measurement grant and exact-payload consent recheck. Contacts supplies lowercase SHA-256 identifier digests; never send raw identifiers or hash a supplied digest again. Preserve the OM event ID across browser/server channels; the backend converts occurrence milliseconds to Unix seconds. An accepted Events request is not conversion attribution proof.

Use stable server-issued operation/delivery IDs. The server's ONE jobs outbox owns durable claims; this plugin never retries writes. A timeout or malformed write receipt remains unknown. Events reconciliation returns unknown without resending because no verified per-event readback exists. Admission and account/grant authority must remain current through credentialed egress.

Do not invent OAuth scope names or broaden supported commands into media uploads, audiences, deletion, budget edits, Smart+, shopping or organic posting. Report those as outside the current plugin scope.

The existing grouped campaign launch now includes TikTok: one fixed campaign → group → ad under the owning exact card/job, all DISABLE with scoped configuration readback before children. It supports country-only website traffic, USD daily budget, exact finite UTC-second start/end, and one existing image or one video plus cover with CUSTOMIZED_USER identity. Landing URL is required. Dynamic daily/lifetime/total budgets, other formats/objectives and unmapped metadata are unsupported before network. Reconciliation reads saved IDs only; never resume or recreate missing children. FROZEN means terminated. Endpoints remain v1.3 because v2.0 equivalence is unverified; admission remains false.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Review campaign purpose, ad-group outcome and ad destination together;
  website traffic is a different result from a completed site conversion.
- Explain how each proposed ad group serves the campaign's intended audience
  before recommending additional groups or a different objective.

### Targeting

- Treat audience interests and intent as planning assumptions to review;
  the OM grouped launch path supports country-only website traffic.
- Do not describe that country selection as applying a detailed audience plan.
  Check current TikTok docs for targeting options and account eligibility.

### Creative

- TikTok recommends vertical 9:16; keep key content in the safe zone from
  TikTok's current ad specs. This is a recommendation, not a universal minimum.
- Review whether the existing creative feels native to TikTok and makes the
  intended action clear. Check the applicable safe-zone template for the format
  and region; do not infer a resolution minimum from creative best practices.

### Budget/bidding

- Assess the budget against the supported traffic outcome and destination;
  a desired purchase result does not turn traffic delivery into purchase optimization.
- Check current TikTok docs for bidding options. Use account-specific evidence
  for a proposed allocation instead of universal budget or learning thresholds.

### Measurement pitfalls

- Treat engagement and video views as creative-response evidence;
  neither proves a site visit completed the business action.
- Review site-conversion evidence separately before calling traffic profitable.
  Identify the selected outcome behind a reported result before comparing ads.

Use om-playbook's strategy-and-brief for briefs, ad-copy-variants for copy field limits, creative-test-plan and creative-fatigue-review for creative methods, analytics-attribution-basics for attribution, and landing-page-cro for destination/message consistency.

[Provenance](PROVENANCE.md)
