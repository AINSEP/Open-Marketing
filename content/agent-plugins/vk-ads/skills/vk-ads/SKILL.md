---
name: vk-ads
description: Read VK token-account identity and campaigns through server OM tools.
---

Use only admitted server tools: list_accounts, list_campaigns.
Connect with a sealed pasted token through the server connection flow;
never put tokens or client secrets in chat, tool arguments, logs or the agent runtime.
list_accounts identifies one token account. list_campaigns has explicit limit/offset.
Client issuance and refresh are unavailable until the existing broker supports
durable issuing/unknown state and reconciliation. No token POSTs occur in this adapter.
Statistics are unavailable until the official response envelope is captured.
Spend currency/units, timezone and campaign statistics ID mapping remain unverified.
Never infer zero spend, normalized money, PAUSED state or conversion attribution.
Admission defaults false. No creation, activation, budget edits, conversions or browser OAuth.
Host account onboarding, guarded policy egress, deadline, catalog and studio wiring remain integrator work.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Confirm which VK advertising account supplied the evidence before reviewing a campaign.
- VK Ads uses campaign → ad group → ad. A campaign shows Active while any of
  its groups is active; a group shows Active while any of its ads is active.
  See [VK campaign statuses](https://ads.vk.ru/ru/help/general/start/campaign_status).
- Do not map other platforms' levels onto this hierarchy.
  Keep recommendations tied to the owner's supplied VK account evidence.

### Targeting

- Review the owner's audience assumptions for the intended Russian market;
  identify which claims are supported by the supplied VK evidence.
- Check current VK Ads docs for audience types and selection mechanics.
  This guidance does not establish any targeting option as available.

### Creative

- Review Russian-language creative in the owner's selected format;
  keep its offer consistent with the destination.
- Check current VK Ads docs for local creative and destination requirements;
  no format names, text limits or review-time promises are supplied here.

### Budget/bidding

- Check current VK Ads docs for the bid, budget and billing options applicable
  to the owner's account; recommend only strategies VK lists for the campaign type.
- VK help lists strategies by campaign type: performance (target-action)
  campaigns offer Минимальная цена (lowest cost within the budget) and
  Предельная цена (maximum cost per action). Awareness/reach campaigns offer
  Максимум показов (maximum impressions), Фиксированная ставка (fixed bid)
  and Предельная цена (cost cap). Confirm which the owner's account offers;
  see [VK bid strategies](https://ads.vk.ru/ru/help/features/bid_strategy).
- Use owner-supplied settings when discussing a proposed budget.
  Currency and units remain unverified in OM's current adapter.

### Measurement pitfalls

- Statistics are unavailable in OM. Campaign identity or a campaign listing
  does not establish spend, results or conversion attribution.
- Review only owner-supplied VK performance evidence, with its account,
  period and stated units; check current VK Ads docs for metric definitions.
- The owner can [export a VK statistics report](https://ads.vk.ru/ru/help/statistics/report) to supply as evidence.

For shared methods use strategy-and-brief, ad-copy-variants,
creative-test-plan and analytics-attribution-basics in om-playbook.

[Provenance](PROVENANCE.md)
