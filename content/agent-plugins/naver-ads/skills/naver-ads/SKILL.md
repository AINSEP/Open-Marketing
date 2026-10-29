---
name: naver-ads
description: Read Naver Search Ads accounts, campaigns and campaign performance through OM server tools.
---

Use only discovered OM server tools for this plugin. Select a server-bound Search
Ads customer, keeping advertiser account numbers separate. Never request keys in
chat; direct the owner to OM's credential connection flow (own/delegated keys).
List one bounded page at a time. For reports ask for one campaign and explicit KST
calendar dates within 31 days. Describe spend as KRW including VAT. Empty reports
mean no data/access unconfirmed; never replace them with zero spend.
Admission and every dispatch use the existing ONE server policy. This package has no OAuth,
campaign launch, activation, budget edits, conversion upload or browser tracking.
Unavailable tools require integrator wiring; do not invent endpoints or call Naver directly.
Paused launch remains unavailable until exact schedule mapping, disabled creation
and the server binding are verified. Saved-reference reconciliation uses GETs only;
unknown results retain references and never authorize replay or continuation.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Group Korean search intent around the offer and destination in the owner's
  Search Ads evidence; identify the campaign type before judging its keywords.
- Naver's keyword behavior depends on campaign type. A keyword list alone
  is insufficient evidence of how a particular campaign matches or serves.

### Targeting

- Review the supplied keyword settings in their campaign-type context;
  distinguish intended search intent from evidence of actual queries.
- For Shopping matching rules, check current Naver Search Ads docs.
  Do not infer product-data matching from the presence or absence of keywords.

### Creative

- Review Korean copy relevance to the supplied keyword intent;
  keep the advertised offer consistent with the destination.
- Check current Naver Search Ads docs for the selected campaign type's
  creative fields and requirements; do not import another platform's limits.

### Budget/bidding

- An individual keyword bid takes precedence when set; otherwise the
  ad-group default bid applies, as described in Naver's keyword-addition help.
- Review both settings in owner-supplied evidence before recommending a bid;
  check current Naver Search Ads docs for other campaign-specific bid rules.

### Measurement pitfalls

- OM's campaign performance is not keyword-level evidence. Ask the owner
  for the relevant Naver detail before recommending a keyword change.
- Retain the operational report's KST dates and VAT treatment when comparing
  supplied evidence; do not explain campaign totals as a single keyword's result.

For shared methods use strategy-and-brief, ad-copy-variants,
creative-test-plan and analytics-attribution-basics in om-playbook.

[Provenance](PROVENANCE.md)
