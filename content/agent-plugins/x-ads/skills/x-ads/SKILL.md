---
name: x-ads
description: Read X Ads reports and prepare one-country paused traffic launches through OM's server tools.
---

Use only admitted X tools from OM's server catalog. Never call X directly or request secrets in chat. Connection setup uses OM's server-sealed pasted credential entry; browser sign-in is pending O2.
List accounts/campaigns one page at a time; pass the returned cursor explicitly. Reports need account/campaign IDs, a whole-hour half-open window of at most seven days, and one placement. CAMPAIGN reports impressions/clicks/spend; ACCOUNT reports impressions only, with unsupported clicks/spend left null. Explain that campaign spend is currency micros and a placement subtotal, preserve null/unavailable metrics, and do not sum platform-attributed conversions or infer zero from no data.
Use OM's grouped launch flow for one existing eligible post and one country; require server-resolved funding, positive explicit bid and finite start/end. All parents are created PAUSED and read back before children. Unknown results retain references (including targeting); reconcile with reads only and never resend a create. Conversions are server-job-only under current measurement grant/consent, never assistant tools. No activation, editing, media upload or post publishing. Unavailable server binding means setup is still needed. Every action uses OM's ONE server policy; never offer a plugin-specific permission or spend waiver.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Review the connection between the campaign's intended outcome, each group's
  audience and the existing post selected for promotion.
- OM's current launch covers one eligible post and one country, with parents
  PAUSED; a broader campaign structure is a plan to review, not something OM
  will build automatically. The existing launch constraints above still apply.
- Check current X Ads docs and account evidence for objective eligibility;
  a platform planning option does not establish an OM capability.

### Targeting

- Keyword targeting can use search and post activity; check current X Ads docs
  for how it matches. Do not infer the audience from a keyword's wording alone.
- Ask what account evidence supports each proposed audience and exclusion.
  Describe intended new-customer and returning-customer coverage separately
  when both are in the plan, and flag possible overlap for review.
- Check current X Ads docs for targeting limits and available options; carry
  no universal keyword count or audience-size threshold into a recommendation.

### Creative

- Review the selected post and destination together: the promise, offer and
  next action should remain consistent after a click.
- Consider the surrounding conversation and visible replies when reviewing
  suitability. Flag reputational concerns in the supplied evidence without
  claiming that targeting guarantees a particular surrounding context.
- Check current X Ads docs for format and placement specifications; propose
  drafts for owner review without promising uploads or new post publishing.

### Budget/bidding

- Relate a proposed budget and bid to the intended traffic outcome and observed
  evidence. A popular organic post alone does not justify a larger paid budget.
- Check current X Ads docs for bidding and budget rules. Leave feasibility
  unresolved when account evidence is missing; invent no spend minimum,
  bid floor or automatic scaling rule.

### Measurement pitfalls

- Keep organic reactions to the post separate from paid campaign evidence;
  social attention alone does not demonstrate destination visits or sales.
- Identify the placement and reporting window behind each comparison. A
  placement subtotal should not be described as complete account performance.
- Preserve unavailable outcomes and reporting gaps; do not turn engagement
  into attributed business results that the supplied evidence cannot support.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)
