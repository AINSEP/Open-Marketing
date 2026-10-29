---
name: reddit-ads
description: Discover Reddit businesses and read account or campaign performance through Open Marketing's admitted server tools, with platform-specific campaign planning/review guidance.
---

Use the OM server catalog and its single tool policy. Never request tokens in chat or perform direct vendor HTTP.
After integrator wiring/admission, `list_businesses` discovers businesses. `report` reads account/campaign spend, impressions and clicks. Include the literal command `kind`; the server binds connection/account/currency.
`list_accounts` and `list_campaigns` currently return NEEDS before credentials/network because current v3 wire evidence is incomplete. Do not invent results or use alternative endpoints.
Report windows are UTC-midnight boundaries, at most 31 days. Results label the requested window; they are provider reports, not neutral reconciled measurement totals. Spend is integer microcurrency; null and empty results do not mean zero.
Request another explicit page using `nextPageToken`; never follow a vendor URL. `incomplete:true` means more data remains, including when an otherwise empty page is returned.
Authentication is paste-token only through the server's `om integrations connect --plugin reddit-ads --token-stdin` flow after catalog integration. On expired/unauthenticated results reconnect with a fresh adsread token. No automatic refresh or browser OAuth is provided.
There are no launch, activation, budget, halt, conversion or destructive tools. Future spend always requires the server's exact card for every call.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Group the plan by business outcome and audience rationale. Keep discovery and
  returning-audience intent distinguishable, with exclusions where supported.
- Keep the selected community context, creative and destination together in the
  recommendation; an offer that fits a topic still needs a useful landing page.

### Targeting

- Compare community and interest targeting against the offer's relevance.
  Check current Reddit Ads docs for how community targeting selects users and
  where ads serve; do not assume impressions appear inside the named subreddit.
- Review any automated targeting or audience expansion in account evidence.
  Record it explicitly rather than attributing all delivery to named communities.

### Creative

- Image Ads pair an image with a headline. Check current Reddit Ads docs for
  supported file types, aspect ratios, dimensions and file limits for the
  selected format and placement.
- Make the offer understandable in the selected community's subject context.
  Consider the questions it could prompt in comments and whether the destination
  answers them; engagement with a discussion is different from purchase intent.

### Budget/bidding

- Review the objective and available bid type together. Check current Reddit
  Ads docs for the bid types available to the objective; choose a proposal that fits the intended result and available data,
  rather than treating cheap impressions as proof of inexpensive acquisition.
- Keep the proposed budget tied to that audience and outcome. Check current
  Reddit Ads docs/account options for constraints; do not invent a daily minimum
  or carry a bid recommendation across unrelated community contexts.

### Measurement pitfalls

- Distinguish upvotes/comments and ad clicks from downstream sales or qualified
  enquiries. OM's performance reads alone do not establish customer quality.
- Review the selected audience and placement context when comparing campaigns.
  A change in community mix can change engagement without improving the offer's
  business outcome; missing conversion evidence leaves that outcome unverified.

For shared brief, copy, testing and attribution methods use strategy-and-brief,
ad-copy-variants, creative-test-plan and analytics-attribution-basics.

[Provenance](PROVENANCE.md)
