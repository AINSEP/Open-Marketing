---
name: yandex-direct
description: Inspect Yandex Direct accounts, campaigns and fixed performance reports through Open Marketing server tools.
---

# Yandex Direct

Use OM server tools `vendor_yandex_direct_list_accounts`, `vendor_yandex_direct_list_campaigns` and `vendor_yandex_direct_report` once the host exposes them. Always pass the literal kind. Installation does not grant admission. Missing admission or access returns a typed denial.

1. Inspect `list_accounts` with view connected for the token identity or agency for agency advertisers. ClientId and Login are distinct; candidates require server binding before account calls. Never invent a login from an ID.
2. Inspect `list_campaigns` with optional unique IDs and bounded limit/offset. Campaign State and Status are vendor observations; OFF alone is not proof of DRAFT.
3. Use report view account or campaign with inclusive YYYY-MM-DD dateFrom/dateTo, maximum 31 days. Optional campaignIds filter only the campaign view. Preserve currency, VAT exclusion, micros, source and provider calendar dates. Empty does not mean zero spend. Full pages may be incomplete; another explicit read may use nextOffset.

The server may call the declared read-only `report.metrics.v1` (daily metrics) and `campaign.status.v1` capabilities; they are not assistant tools and add no write or spend authority.

Only the server resolves tokens, identity and policy. Direct HTTP and credentials never belong in the agent or chat. Use existing server paste-token connection UI; browser OAuth is unavailable. Agent tools remain read-only. DRAFT deployment runs only inside the owning OM campaign launch card, never as a separate agent call. Metrica conversions remain deferred. No approval workaround, automatic paging or retry. The existing ONE server policy governs every action.

## Marketing guidance

This guidance is advisory; use only tools listed in the OM catalog; any launch, budget or spend change goes through OM's server approval.

### Structure

- Identify the campaign and placement context in owner-supplied Direct evidence.
  The search-query report describes Search delivery; do not generalize it
  to every placement or treat it as OM's fixed performance report.
- Check current Yandex Direct docs for other placement-specific structures.

### Targeting

- Distinguish a search query (what the user typed) from a keyword phrase
  (the phrase that triggered the impression) in supplied Direct reports.
- Autotargeting matches queries from the ad title, text and landing page
  without keywords; do not label those impressions as keyword-triggered.

### Creative

- Review Russian creative alongside the query and triggering condition;
  keep the offer consistent with its destination.
- With autotargeting, the landing page also informs query selection.
  Check current Yandex Direct docs for the selected format's creative requirements.

### Budget/bidding

- Review the owner's selected Direct goal and bidding settings together;
  check current Yandex Direct docs for available strategies and budget conditions.
- Do not import another platform's bid rules or treat a recommendation
  as an instruction to change spend; execution remains bounded by the catalog.

### Measurement pitfalls

- Direct's search-query report defaults to campaign goals and attribution;
  the report's goals and attribution model can be changed.
- Confirm those selections in reports the owner supplies before comparing
  results. OM's fixed report does not establish those report-level settings.
  Metrica conversions remain deferred in OM.

For shared methods use strategy-and-brief, ad-copy-variants,
creative-test-plan and analytics-attribution-basics in om-playbook.

[Provenance](PROVENANCE.md)
