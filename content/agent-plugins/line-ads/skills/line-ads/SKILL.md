---
name: line-ads
description: Read entitled LINE Ads accounts, campaigns and campaign report pages through OM tools.
---
Use only OM's admitted LINE catalog: list_accounts, list_campaigns, report, plus server-invoked `campaign.status.v1` and daily `report.metrics.v1`. Metrics provide impressions and clicks; spend is null and batches are provisional and stale.
Never request, accept or echo keys, signatures or credential bundles in chat. Direct owners to OM's secure credential ingress.
Select an existing connection and account; group/credentials are server-owned. Status and daily metrics reads support Taiwan/Thailand connections. Japan is reporting-only.
Request explicit report dates. Preserve currency, account timezone, vendor date range, source, retrieval time and pagination.
Missing metrics are unavailable, not zero. A campaign page is not an account total; fetch further pages only by explicit bounded reads.
Paused deployment exports exist for the host's ONE grouped exact launch card and owning outbox, with account/parent readback and saved-ID GET reconciliation. They remain unsupported for every region pending evidence and integration; admission cannot override this gap. Do not offer separate create calls or retry an uncertain create.
Do not claim usable deployment, activation, conversions or OAuth. Never invent endpoints or bypass the ONE server policy.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Identify the market (Japan, Taiwan or Thailand); objectives, audiences and
  billing options differ by market; use that market's LINE Ads help.
- Review owner-supplied regional evidence. This guidance does not establish
  OM reads for Taiwan/Thailand; check current LINE Ads (Japan) docs for Japan.

### Targeting

- Taiwan help lists website-traffic audiences via LINE Tag, mobile-app event
  audiences and LINE Official Account friend audiences. Identify the source
  behind the owner's selected audience before describing whom it reaches.
- Thailand guidance includes LINE Tag website-traffic and lookalike audiences.
  Review the supplied source audience rather than transferring Taiwan settings.

### Creative

- Review Taiwan creative in Traditional Chinese and Thailand creative in Thai;
  keep each offer consistent with its regional destination.
- Check current LINE Ads docs for that market's format and placement specs;
  a creative accepted in another market is not evidence of local eligibility.

### Budget/bidding

- Thailand describes auction buying and objective-dependent billing.
  Confirm the selected objective and billing basis in the owner's evidence.
- Check current LINE Ads docs for Taiwan's budget/bid options and current
  LINE Ads (Japan) docs for Japan; do not transfer Thailand's options or prices.

### Measurement pitfalls

- Separate website-conversion evidence from friend-add or other engagement
  evidence in the owner's regional reports; they answer different questions.
- LINE Tag website-audience membership alone does not demonstrate purchases.
  Missing regional reports in OM remain unavailable; ask for owner-supplied evidence.

For shared methods use strategy-and-brief, ad-copy-variants,
creative-test-plan and analytics-attribution-basics in om-playbook.

[Provenance](PROVENANCE.md)
