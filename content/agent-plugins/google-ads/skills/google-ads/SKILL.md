---
name: google-ads
description: Plan and inspect bounded Google Search campaigns through the OM server host; includes platform-specific campaign planning/review guidance.
---

The plugin starts disabled and unadmitted. Connection credentials and plugin configuration belong to the OM server. When admitted, the agent can use `list_accounts`, `read_campaign`, `read_budget`, `report` and `search_terms_report`. `add_negative_keyword` adds one EXACT exclusion through the same generic OM tools catalog; each call requires its own exact Allow/Cancel card, with no Always allow or retained grant. Local vendor account mode remains read-only, so this write needs an admitted always-on server.

Use scoped account/campaign/budget reads and reports first. A Search plan has a finite flight, explicit geography, exact/phrase keywords, a responsive Search ad, and a non-shared average daily budget. Search partners and Display are excluded. Google automatically determines Search languages; do not add manual language criteria.

Paused creation and its readback/reconciliation run through OM's host campaign deployment (`deployCampaignPaused`/`readCampaignDeployment`) after owner approval. `activate`, `set_budget` and ordinary `pause` are unavailable to the agent through `createTools`. Describe the budget as an average: for this supported campaign model the maximum billed daily amount is twice the highest budget configured that account day. Same-day reductions do not erase the earlier higher limit. Served cost can differ from billed cost. Polling/pause is not an exact spend cutoff.

Operation IDs are host-owned and stay stable. Unknown results go to host reconciliation, never a resend or a changed ID to bypass an uncertain write. Reconciliation never sends a second mutation. A partially created or changed hierarchy remains unknown until owner recovery.

For an unknown negative-keyword result, stop and explain the uncertainty. After owner review, a separately approved call checks for that exact negative first and returns `already_present` without mutating when found. Never automatically retry or bypass the host's refusal to replay an operation ID.

Backend halt-stop and conversions are not agent tools. A stop permit cannot activate or change budget. Conversion delivery requires the measurement service grant, current consent and verified API eligibility. The typed Data Manager v1 backend validates each immutable event with validateOnly before ingestion, then reconciles processing by the saved request ID. Contacts supplies normalized SHA-256 digests; this plugin validates their shape only. Actions are selected by OM definitionId. Processing success does not establish attribution. Production eligibility remains unverified, so keep admission disabled.

See [verified sources and host setup](references/README.md). Instructions and annotations never grant execution authority.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

OM's bounded Search plan is one ad group with exact/phrase positive keywords on Google Search only: traffic uses manual CPC; leads/sales use MaximizeConversions / MaximizeConversionValue without targets.
Leads require an existing SUBMIT_LEAD_FORM/WEBSITE goal; sales require PURCHASE/WEBSITE. Every unrelated observed goal is set non-biddable; missing goals refuse creation. Production preparation is still deferred.
OM also supports individually approved EXACT negatives at campaign or ad-group scope. Broad positive matching, phrase/broad negatives, shared negative lists, negative removal, other bidding strategies, Performance Max and Demand Gen remain owner-run changes in Google Ads.

- Keep Search ad groups focused on a recognisable intent and matching destination.
- For Performance Max (PMax), group text, images, videos, logos and final URLs
  around a coherent theme; campaigns can contain multiple asset groups.
- For Demand Gen, review the campaign and proposed ad groups against the intended
  audience and creative. Check current Google Ads docs for where Demand Gen
  audiences, locations and channels are set; do not assume Search structure fits.

### Targeting

- Exact matches the same meaning or intent; phrase includes meaning; broad reaches related
  searches. Google stresses Smart Bidding with broad match
  for owner-run campaigns; it is outside OM's bounded Search plan.
- Use `search_terms_report({ campaignId, days: { start, end } })` before proposing
  specific negatives: account-local dates are half-open, at most 31 days, with
  the top 50 terms by served cost. Google omits some low-volume terms; the report
  is partial even when `truncated` is false and never establishes total waste.
- Explain business irrelevance using the owner's offer and observed spend/clicks;
  zero conversions alone is insufficient evidence. Keep missing metrics unknown.
  Spend is integer account-currency micros; vendor conversions are integer
  millionths, using the vendor's configured conversion definitions/attribution.
- Default to an ad-group EXACT negative, naming its campaign, ad group and text.
  Check self-blocking against positive keywords and valuable intent first; use
  campaign scope only when the exclusion fits every ad group. Never substitute
  a generic negative list. Call `add_negative_keyword({ target, text })` once per
  proposed negative; each exact text/scope needs its own approval card. Match
  type is always EXACT and is not an input option.
- Check each negative's scope and its own broad/phrase/exact matching rules for
  self-blocking. Negative broad requires all terms; negatives do not expand to
  close variants, so review synonyms and singular/plural coverage separately.
- Check current Google Ads docs for PMax search themes and negative controls.

### Creative

- For RSA headline/description/path limits use the ad-copy-variants skill.
- Keep the Search promise and PMax asset theme consistent with the destination.
  Review PMax Final URL expansion: it can substitute a different landing page.
  Missing PMax video may be generated from other assets; inspect the result.
- Review Demand Gen creative previews against the intended audience and channels; check current Google Ads docs for PMax and Demand Gen asset requirements.

### Budget/bidding

- Smart Bidding optimizes conversions or conversion value and requires conversion
  tracking. Review the selected goal and value quality before proposing it;
  weak actions, duplicate signals or unreliable values can reward the wrong result.
- Check current Google Ads docs for strategy eligibility, conversion-history
  recommendations and budget requirements; do not invent universal minimums.
- Frequent budget, target or goal changes during learning can reset it; recommend reversible, measured changes rather than a fixed learning duration.

### Measurement pitfalls

- Primary actions enter Conversions and bidding when their goal is used for bidding.
  Secondary actions normally enter All conversions for observation; a custom goal
  uses included actions for bidding even when marked secondary. Inspect that exception.
- Enhanced Conversions supplement measurement with hashed first-party data;
  check current Google Ads docs for setup and customer-data policy requirements.
- Consent-mode modeled conversions enter Google's Conversions column and bidding;
  they are not observed outcomes. Check current Google Ads docs for modeling
  eligibility; implementation alone does not guarantee modeled reporting.
- Hashing or tracking setup never establishes consent or OM delivery eligibility.
  OM conversion delivery still needs the measurement grant and current consent.

For shared brief, copy, testing and attribution methods use strategy-and-brief, ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)
