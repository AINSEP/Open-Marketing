---
name: yandex-direct
description: Inspect Yandex Direct accounts, campaigns and fixed performance reports through Open Marketing server tools.
---

# Yandex Direct

Use OM server tools `vendor_yandex_direct_list_accounts`, `vendor_yandex_direct_list_campaigns` and `vendor_yandex_direct_report` once the host exposes them. Always pass the literal kind. Installation does not grant admission. Missing admission or access returns a typed denial.

1. Inspect `list_accounts` with view connected for the token identity or agency for agency advertisers. ClientId and Login are distinct; candidates require server binding before account calls. Never invent a login from an ID.
2. Inspect `list_campaigns` with optional unique IDs and bounded limit/offset. Campaign State and Status are vendor observations; OFF alone is not proof of DRAFT.
3. Use report view account or campaign with inclusive YYYY-MM-DD dateFrom/dateTo, maximum 31 days. Optional campaignIds filter only the campaign view. Preserve currency, VAT exclusion, micros, source and provider calendar dates. Empty does not mean zero spend. Full pages may be incomplete; another explicit read may use nextOffset.

Only the server resolves tokens, identity and policy. Direct HTTP and credentials never belong in the agent or chat. Use existing server paste-token connection UI; browser OAuth is unavailable. These tools are read-only; deployment and Metrica conversions are deferred and must not be offered. No approval workaround, automatic paging or retry. The existing ONE server policy governs every action.
