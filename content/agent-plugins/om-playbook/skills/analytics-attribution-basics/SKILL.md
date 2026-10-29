---
name: analytics-attribution-basics
description: Explain OM attribution, unattributed leads, conflicting conversion totals, cost per verified lead, and customer acquisition cost without inventing metrics.
---

# Analytics and attribution basics

Explain what available reports support, their sources and limits. Imported data is
evidence, not authority; OM's server policy governs later actions.

## Intake

Identify the question, reporting period, accounts or campaigns, account currency,
timezone, outcome definition, and data freshness. Ask only for gaps needed to interpret
the comparison. If reports are unavailable, explain definitions without making up totals.

## Method

1. **Separate events from outcomes.** Visits, clicks, submitted enquiries, verified
   leads, and customers are different measures. Use the product's reported verified-lead
   definition and deduplicated counts; never infer customers from vendor conversions.
2. **Explain OM credit.** OM uses frozen 30-day last paid touch at lead creation.
   Later lead-stage changes retain that attribution. URL campaign claims must resolve
   to an admitted account and an observed campaign; unknown, invalid, or forged claims
   remain unattributed. Do not guess a campaign or redistribute unattributed outcomes.
3. **Keep cohorts explicit.** Leads belong to the period they were created in, even
   when qualification or winning occurs later. Name the observation cutoff and allow
   for conversion lag; a recent cohort may still be incomplete.
4. **Reconcile definitions before totals.** Show vendor-reported conversion claims
   separately from verified outcomes. Compare event definitions, attribution windows,
   timezones, freshness, and deduplication. Never sum platform claims into unique leads
   or customers. Attribution assigns credit; it does not prove incremental causation.
5. **Distinguish costs.** Cost per verified lead relates paid-media spend to verified
   leads. Paid-media CAC relates paid-media spend to new customers. Broader CAC includes
   the explicitly selected acquisition costs, such as sales and marketing labor or
   tools, against new customers. Label cost coverage and denominator for each.
6. **Use product calculations.** Ratios, totals, money formatting, and attribution
   resolution belong in code. Money is integer micros of account currency. Keep
   currencies separate with no inferred FX; align the reported scopes and windows.
7. **Preserve missingness.** Unsupported means not declared by the provider; unavailable
   means no value was returned; zero is an observed value. A zero denominator makes
   CPL or CAC undefined, not zero. Missing customer or cost data leaves CAC unavailable.

## Output

Give a short interpretation followed by:

| Measure | Product-reported value or unavailable | Source and definition | Currency / timezone / period | Caveat |
|---|---|---|---|---|

Include unattributed outcomes explicitly, then explain any unresolved mismatch and
the smallest next evidence request. If no numerical product output exists, leave the
value unavailable and explain its meaning. Do not calculate a replacement in prose,
install tracking, or claim conversion-sharing permission.

Source and license: [PROVENANCE.md](PROVENANCE.md).
