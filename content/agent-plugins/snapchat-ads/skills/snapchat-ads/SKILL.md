---
name: snapchat-ads
description: Inspect Snapchat organizations, ad accounts, campaigns, existing creatives and TOTAL reports through Open Marketing server tools.
---
Use only the installed OM server catalog. Never request tokens in chat, configure vendor HTTP in the agent, or bypass the ONE server policy. Connect/reconnect using the existing server integration token flow once Snapchat wiring lands.

Use `list_organizations`, then `list_accounts` with the selected organizationId. Server composition binds the chosen account for `list_campaigns`, `list_creatives` and `report`. When admitted, server-invoked `report.metrics.v1` provides account/campaign DAY rows for at most 31 days; `campaign.status.v1` accepts at most 10 campaign IDs. Pass the literal command `kind` for native tools. Pages default/max 100 (minimum 50); use a returned nextCursor as cursor in a new explicit call. Never follow provider URLs. Organization discovery has a 100-row cap and no undocumented pagination.

Use the legacy `report` tool with window.start/end ISO timestamps at midnight in the account timezone, at most 366 days apart. Omit campaignId for account spend only; supply one campaignId for spend/impressions/swipes. Campaign ownership is read first. TOTAL granularity applies only to this legacy tool. Missing/empty data is not zero. Preserve currency, micro-currency strings, requested/provider windows, retrieval time and finalization metadata; endpoint inclusivity is unverified.

Launch uses the existing OM grouped exact card after the server freezes one traffic campaign → one squad → one existing WEB_VIEW ad, all explicitly PAUSED. Wait for parent readback; report unknown/partial references without retry, resume or activation. Server wiring is pending. Offline SIGN_UP delivery is server-only under current measurement grant/consent; never relabel web events or request a direct conversion tool. No activation, media upload, arbitrary HTTP or OAuth descriptor. An expired pasted token requires reconnect; the plugin does not refresh it. Missing admission/access yields a typed denial. Do not infer live vendor eligibility from synthetic fixtures. Evidence: ../../io.github.ainsep.openmarketing/evidence/primary-sources.json.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Map the campaign's business purpose through its squads to the ads and
  existing creatives; review whether the destination supports the same outcome.
- A squad holds targeting, budget, bid, optimization goal, placement and schedule.
  OM's Snapchat tools do not read squad settings; ask the user before reviewing them.

### Targeting

- Review the intended audience's reason to visit the destination within the
  supported traffic/WEB_VIEW path; planning does not add fields to OM's launch tools.
- Keep audience intent and geographic assumptions explicit in the plan.
  Check current Snapchat docs for available audience options and eligibility;
  do not assume a proposed audience can be created or applied through OM.

### Creative

- Review the existing creative on a mobile screen for a recognisable offer
  and next step; verify that the destination delivers what the ad promises.
- Check current Snapchat docs for placement-specific aspect ratios, duration
  and file requirements. An existing creative's ID alone does not demonstrate
  that its message fits this campaign or its destination.

### Budget/bidding

- Assess the squad's allocation and pacing against its declared outcome
  and intended traffic; do not infer business value from delivery volume alone.
- Check current Snapchat docs for bidding options and account constraints.
  Use the campaign's evidence instead of a universal daily budget or bid rule.

### Measurement pitfalls

- A squad's goal can be swipes; a swipe is not a signup.
  Review destination visits and completed business actions as separate evidence.
- Ask whether the measurement path observes the outcome the campaign promises.
  Without that evidence, swipe volume alone cannot establish acquisition success.

Use om-playbook's strategy-and-brief for briefs, ad-copy-variants for copy field limits, creative-test-plan and creative-fatigue-review for creative methods, analytics-attribution-basics for attribution, and landing-page-cro for destination/message consistency.

[Provenance](PROVENANCE.md)
